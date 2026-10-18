import { callNative, isAndroidShell } from './nativeBridge';

// src/services/mobileShell/neteaseWeapi.ts
// 网易云的登录接口只认 weapi 加密：AES-128-CBC 两轮再 RSA 加密一次会话密钥，参数名是 params/
// encSecKey。RSA 用的是「无填充」，Web Crypto 不提供这种模式，所以这里用 BigInt 自己做模幂。
// 加密都在本机算，请求经原生通道发出（浏览器直连 music.163.com 会被 CORS 挡），登录态就是响应里
// 的 MUSIC_U，存在设备上，之后的请求带上它。

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const PUBLIC_MODULUS =
    '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const PUBLIC_EXPONENT = 0x10001n;
const MESSAGE_NONCE = '36u9x1x99u1x6x0y0y2x1u9y2u0x9y0';

const COOKIE_KEY = 'folia_netease_cookie_v1';

const textEncoder = new TextEncoder();

const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary);
};

const aesEncrypt = async (text: string, secret: string): Promise<string> => {
    const key = await crypto.subtle.importKey(
        'raw',
        textEncoder.encode(secret),
        { name: 'AES-CBC' },
        false,
        ['encrypt'],
    );
    // Web Crypto's AES-CBC adds PKCS#7 padding itself, which is what the server expects.
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: textEncoder.encode(IV) },
        key,
        textEncoder.encode(text),
    );
    return toBase64(new Uint8Array(encrypted));
};

const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
    let result = 1n;
    let value = base % modulus;
    let power = exponent;
    while (power > 0n) {
        if (power & 1n) result = (result * value) % modulus;
        value = (value * value) % modulus;
        power >>= 1n;
    }
    return result;
};

/** RSA/ECB/NoPadding：把密钥字节倒序当大整数，模幂之后再补成 256 位十六进制。 */
const rsaNoPadding = (secret: string): string => {
    const reversed = Array.from(secret).reverse().join('');
    const message = BigInt('0x' + Array.from(textEncoder.encode(reversed))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join(''));
    const modulus = BigInt('0x' + PUBLIC_MODULUS.replace(/^0+/, ''));
    return modPow(message, PUBLIC_EXPONENT, modulus).toString(16).padStart(256, '0');
};

const randomSecret = (): string => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes).map(byte => alphabet[byte % alphabet.length]).join('');
};

/** 把一个请求体包成 weapi 的 `params`/`encSecKey` 两个字段。 */
export const encryptWeapi = async (payload: Record<string, unknown>): Promise<URLSearchParams> => {
    const text = JSON.stringify({ ...payload, csrf_token: '' });
    const secret = randomSecret();
    const once = await aesEncrypt(text, PRESET_KEY);
    const params = await aesEncrypt(once, secret);
    return new URLSearchParams({ params, encSecKey: rsaNoPadding(secret) });
};

export const readStoredCookie = (): string => {
    try {
        return localStorage.getItem(COOKIE_KEY) ?? '';
    } catch {
        return '';
    }
};

const storeCookie = (cookie: string): void => {
    try {
        localStorage.setItem(COOKIE_KEY, cookie);
    } catch {
        // 存不下就算了：这次登录在这一个会话里仍然有效。
    }
};

/** 从响应的 Set-Cookie 里挑出会话 Cookie（MUSIC_U 必须留，其他有就一起带走）。 */
const mergeCookies = (setCookie: readonly string[]): string => {
    const jar = new Map<string, string>();
    for (const item of [readStoredCookie()]) {
        if (!item) continue;
        for (const part of item.split(';')) {
            const index = part.indexOf('=');
            if (index > 0) jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
        }
    }
    for (const line of setCookie) {
        const [pair] = line.split(';');
        const index = pair.indexOf('=');
        if (index <= 0) continue;
        jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    const merged = Array.from(jar.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
    storeCookie(merged);
    return merged;
};

interface NativeHttpResult {
    status: number;
    body: string;
    setCookie?: string[];
}

const postWeapi = async (path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!isAndroidShell()) throw new Error('The direct NetEase channel only exists inside the Android shell');
    const body = (await encryptWeapi(payload)).toString();
    const result = await callNative<NativeHttpResult>('net.http', {
        url: `https://music.163.com${path}?csrf_token=`,
        method: 'POST',
        body,
        contentType: 'application/x-www-form-urlencoded',
        cookie: readStoredCookie(),
    }, 25_000);
    mergeCookies(result.setCookie ?? []);
    try {
        return JSON.parse(result.body) as Record<string, unknown>;
    } catch {
        return { code: result.status, message: result.body.slice(0, 200) };
    }
};

/** 手机号 + 密码登录（网易云的 `/weapi/login/cellphone`）。 */
export const weapiLoginCellphone = async (phone: string, password: string, countrycode = '86') => {
    const md5 = await md5Hex(password);
    return postWeapi('/weapi/login/cellphone', {
        phone,
        countrycode,
        password: md5,
        md5_password: md5,
        rememberLogin: 'true',
    });
};

/** 手机号 + 短信验证码登录。 */
export const weapiLoginCaptcha = async (phone: string, captcha: string, countrycode = '86') => {
    return postWeapi('/weapi/login/cellphone', { phone, countrycode, captcha, rememberLogin: 'true' });
};

/** 发短信验证码。 */
export const weapiSendCaptcha = async (phone: string, countrycode = '86') => {
    return postWeapi('/weapi/sms/captcha/sent', { cellphone: phone, ctcode: countrycode });
};

export const weapiLogout = async (): Promise<void> => {
    await postWeapi('/weapi/logout', {}).catch(() => undefined);
    storeCookie('');
};

/** 密码要先取 MD5 再交给 weapi；Web Crypto 不提供 MD5，所以这里自己算（RFC 1321）。 */
export const md5Hex = async (text: string): Promise<string> => {
    const bytes = textEncoder.encode(text);
    const bitLength = bytes.length * 8;
    const paddedLength = (((bytes.length + 8) >>> 6) + 1) << 6;
    const buffer = new Uint8Array(paddedLength);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setUint32(paddedLength - 8, bitLength >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

    const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const table = new Uint32Array(64);
    for (let index = 0; index < 64; index += 1) {
        table[index] = Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0;
    }
    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    for (let offset = 0; offset < paddedLength; offset += 64) {
        const words = new Uint32Array(16);
        for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, true);
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;
        for (let index = 0; index < 64; index += 1) {
            let f: number;
            let g: number;
            if (index < 16) {
                f = (b & c) | (~b & d);
                g = index;
            } else if (index < 32) {
                f = (d & b) | (~d & c);
                g = (5 * index + 1) % 16;
            } else if (index < 48) {
                f = b ^ c ^ d;
                g = (3 * index + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * index) % 16;
            }
            const sum = (a + f + table[index] + words[g]) >>> 0;
            const shift = shifts[(index >> 4) * 4 + (index % 4)];
            const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
            a = d;
            d = c;
            c = b;
            b = (b + rotated) >>> 0;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }

    const toHex = (value: number): string => {
        let out = '';
        for (let index = 0; index < 4; index += 1) {
            out += ((value >>> (index * 8)) & 0xff).toString(16).padStart(2, '0');
        }
        return out;
    };
    return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
};

export { MESSAGE_NONCE };
