// 当前文件：读取 Docker 注入的 Web 运行时配置，并兼容既有 Vite 构建变量。

export type WebAiProvider = 'gemini' | 'openai';

/** The three online-music backends a deployment can point the app at. */
export type RuntimeServerProvider = 'netease' | 'kugou' | 'qq';

export interface RuntimeServerEndpoints {
    netease?: string;
    kugou?: string;
    qq?: string;
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
