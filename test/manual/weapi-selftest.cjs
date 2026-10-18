// 一次性自检：用和 App 里同一套算法（AES-128-CBC 两轮 + RSA 无填充）去请求网易云登录，
// 看服务端认不认这组参数。返回业务错误（手机号/密码不对）就说明加密是对的；返回参数错误则不对。
const crypto = require('node:crypto');

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';

const modPow = (base, exponent, modulus) => {
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

const aesEncrypt = (text, secret) => {
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(secret), Buffer.from(IV));
    return Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]).toString('base64');
};

const rsaNoPadding = (secret) => {
    const reversed = Buffer.from(secret).reverse();
    const message = BigInt('0x' + reversed.toString('hex'));
    const modulus = BigInt('0x' + MODULUS.replace(/^0+/, ''));
    return modPow(message, 0x10001n, modulus).toString(16).padStart(256, '0');
};

const randomSecret = () => crypto.randomBytes(16).toString('base64').slice(0, 16);

const encrypt = (payload) => {
    const text = JSON.stringify({ ...payload, csrf_token: '' });
    const secret = randomSecret();
    const params = aesEncrypt(aesEncrypt(text, PRESET_KEY), secret);
    return new URLSearchParams({ params, encSecKey: rsaNoPadding(secret) }).toString();
};

const main = async () => {
    const password = crypto.createHash('md5').update('not-a-real-password').digest('hex');
    const body = encrypt({
        phone: '13800000000',
        countrycode: '86',
        password,
        md5_password: password,
        rememberLogin: 'true',
    });
    const response = await fetch('https://music.163.com/weapi/login/cellphone?csrf_token=', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: 'https://music.163.com/',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
        },
        body,
    });
    const text = await response.text();
    console.log('status', response.status);
    console.log(text.slice(0, 300));
};

main().catch(error => console.error('failed', error));
