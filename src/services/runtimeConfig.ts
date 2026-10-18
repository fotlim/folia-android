// 当前文件：读取 Docker 注入的 Web 运行时配置，并兼容既有 Vite 构建变量。

export type WebAiProvider = 'gemini' | 'openai';

/** The three online-music backends a deployment can point the app at. */
export type RuntimeServerProvider = 'netease' | 'kugou' | 'qq';

export interface RuntimeServerEndpoints {
    netease?: string;
    kugou?: string;
    qq?: string;
    /** 自建网关发的设备令牌；只对 netease 生效。 */
    neteaseToken?: string;
}

const normalizeAiProvider = (value: unknown): WebAiProvider => (
    value === 'openai' ? 'openai' : 'gemini'
);

export const getWebAiProvider = (): WebAiProvider => {
    if (typeof window !== 'undefined') {
        const runtimeValue = window.__FOLIA_RUNTIME_CONFIG__?.aiProvider;
        if (runtimeValue) return normalizeAiProvider(runtimeValue);
    }

    return normalizeAiProvider(import.meta.env.VITE_AI_PROVIDER);
};

const normalizeEndpoint = (value: unknown): string | null => (
    typeof value === 'string' && value.trim() ? value.trim().replace(/\/+$/, '') : null
);

/**
 * Reads a backend address injected at runtime (the Android shell regenerates runtime-config.js from
 * its own settings screen; Docker writes the same object). Returns null when the build's Vite
 * variable is the only source, which every caller treats as "not configured here".
 */
export const getRuntimeServerEndpoint = (provider: RuntimeServerProvider): string | null => {
    if (typeof window === 'undefined') return null;
    const servers = window.__FOLIA_RUNTIME_CONFIG__?.servers as RuntimeServerEndpoints | undefined;
    return normalizeEndpoint(servers?.[provider]);
};

/**
 * 设备令牌：自建网关用它认出「同一台设备的 Cookie 罐」。没有令牌的旧部署就是空串，请求照旧不带
 * Authorization，所以这条通道对现有网页/桌面部署没有影响。
 */
export const getRuntimeServerToken = (provider: RuntimeServerProvider): string | null => {
    if (typeof window === 'undefined') return null;
    const servers = window.__FOLIA_RUNTIME_CONFIG__?.servers as RuntimeServerEndpoints | undefined;
    const token = provider === 'netease' ? servers?.neteaseToken : undefined;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
};

export const getRuntimeServerEndpoints = (): RuntimeServerEndpoints => {
    const servers = typeof window === 'undefined'
        ? undefined
        : window.__FOLIA_RUNTIME_CONFIG__?.servers as RuntimeServerEndpoints | undefined;
    return {
        netease: normalizeEndpoint(servers?.netease) ?? '',
        kugou: normalizeEndpoint(servers?.kugou) ?? '',
        qq: normalizeEndpoint(servers?.qq) ?? '',
    };
};
