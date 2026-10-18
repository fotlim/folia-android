import { callNative, isAndroidShell } from './nativeBridge';

// src/services/mobileShell/directNetease.ts
// 没有部署任何后端时的直连通道：由原生层去请求 music.163.com 的公开接口（浏览器里这一跳会被 CORS
// 挡住，原生不受限），再把 JSON 交回网页层。覆盖匿名就能用的那几项——搜索、歌曲详情、歌词、歌单、
// 播放地址；登录与高码率仍然需要网关，遇到不支持的路径时明确抛错，让上层走原来的「未配置」提示。

interface NativeHttpResult {
    status: number;
    body: string;
}

const PUBLIC_ORIGIN = 'https://music.163.com';

/**
 * NeteaseCloudMusicApi 的路径 → 网易云自己的公开接口。参数名不一样（`keywords` ↔ `s`，`ids` 要 JSON
 * 数组），所以不能只挪域名。
 */
const mapEndpoint = (pathname: string, search: URLSearchParams): string | null => {
    switch (pathname) {
        case '/search':
        case '/cloudsearch': {
            const keywords = search.get('keywords') ?? search.get('s') ?? '';
            return `/api/search/get/web?s=${encodeURIComponent(keywords)}`
                + `&type=${search.get('type') ?? '1'}`
                + `&limit=${search.get('limit') ?? '30'}`
                + `&offset=${search.get('offset') ?? '0'}`;
        }
        case '/song/lyric':
            return `/api/song/lyric?id=${encodeURIComponent(search.get('id') ?? '')}&lv=1&kv=1&tv=-1`;
        case '/song/detail':
            return `/api/song/detail/?ids=${encodeURIComponent(search.get('ids') ?? '')}&csrf_token=`;
        case '/song/url':
        case '/song/url/v1': {
            const firstId = (search.get('id') ?? '').split(',')[0]?.trim() ?? '';
            if (!firstId) return null;
            const level = search.get('level') ?? 'standard';
            return `/api/song/enhance/player/url/v1?ids=${encodeURIComponent(`[${firstId}]`)}`
                + `&level=${encodeURIComponent(level)}&encodeType=flac`;
        }
        case '/playlist/detail':
            return `/api/v6/playlist/detail?id=${encodeURIComponent(search.get('id') ?? '')}&n=1000`;
        case '/playlist/track/all': {
            const id = search.get('id') ?? '';
            return `/api/v6/playlist/detail?id=${encodeURIComponent(id)}&n=1000`;
        }
        case '/album':
            return `/api/v1/album/${encodeURIComponent(search.get('id') ?? '')}`;
        case '/artist/songs':
            return `/api/v1/artist/${encodeURIComponent(search.get('id') ?? '')}`;
        default:
            return null;
    }
};

export const isDirectNeteaseAvailable = (): boolean => isAndroidShell();

/** 会不会是「直连能处理」的路径；用来决定要不要走原生而不报错。 */
export const canServeNeteaseDirectly = (endpoint: string): boolean => {
    if (!isDirectNeteaseAvailable()) return false;
    try {
        const parsed = new URL(`http://local${endpoint}`);
        return mapEndpoint(parsed.pathname, parsed.searchParams) !== null;
    } catch {
        return false;
    }
};

export const requestNeteaseDirectly = async (endpoint: string): Promise<unknown> => {
    const parsed = new URL(`http://local${endpoint}`);
    const path = mapEndpoint(parsed.pathname, parsed.searchParams);
    if (!path) {
        throw new Error(`The public NetEase endpoints cannot serve ${parsed.pathname}`);
    }

    const result = await callNative<NativeHttpResult>('net.http', { url: `${PUBLIC_ORIGIN}${path}` }, 25_000);
    if (result.status !== 200) {
        throw new Error(`music.163.com answered ${result.status} for ${parsed.pathname}`);
    }
    const payload = JSON.parse(result.body) as unknown;

    // 匿名请求拿不到 VIP 歌曲的直链（接口回 url:null、code:-110）。免费歌曲还能走网易云自己的
    // outer 链接（302 到 mp3），所以这里补一手；VIP 歌曲依然无声可放，提示交回上层。
    if (parsed.pathname === '/song/url' || parsed.pathname === '/song/url/v1') {
        const data = (payload as { data?: Array<{ id?: number; url?: string | null }> }).data;
        for (const entry of data ?? []) {
            if (!entry?.url && entry?.id) {
                entry.url = `${PUBLIC_ORIGIN}/song/media/outer/url?id=${entry.id}.mp3`;
            }
        }
    }

    return payload;
};
