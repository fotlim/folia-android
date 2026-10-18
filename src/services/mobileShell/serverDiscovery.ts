// src/services/mobileShell/serverDiscovery.ts
// Finds the user's self-hosted music backends instead of asking for them.
//
// The NetEase / KuGou / QQ APIs are separate Node deployments that the user runs themselves - on the
// same machine as Folia, on a NAS, or on a small server. Their defaults are known (3000 for
// NeteaseCloudMusicApi, 3400 for KuGouMusicApi, 3200 for qq-music-api), so a short parallel probe of
// the addresses a phone can actually reach finds them: the default gateway, the gateway's /24, the
// emulator host alias and loopback. What is found is written back to the shell's settings, so the
// next launch starts from it without probing again.

import { callNative, isAndroidShell } from './nativeBridge';
import type { RuntimeServerProvider } from '../runtimeConfig';
import { getRuntimeServerToken } from '../runtimeConfig';

export interface DiscoveredServers {
    netease: string;
    kugou: string;
    qq: string;
}

export interface DiscoveryState {
    status: 'idle' | 'probing' | 'done';
    servers: DiscoveredServers;
    /** Addresses that answered, for the settings row. */
    hosts: string[];
}

const STORAGE_KEY = 'folia_mobile_servers_v1';
const PROBE_TIMEOUT_MS = 1500;

const PROVIDER_PORTS: Record<RuntimeServerProvider, number[]> = {
    netease: [3000, 3300, 3001],
    kugou: [3400, 3401],
    qq: [3200, 3201],
};

// A cheap route that every one of these services answers with JSON (or with a 4xx carrying JSON).
const HEALTH_PATH: Record<RuntimeServerProvider, string> = {
    netease: '/login/status',
    kugou: '/search?keywords=folia&page=1&pagesize=1',
    qq: '/',
};

const EMPTY: DiscoveredServers = { netease: '', kugou: '', qq: '' };

let state: DiscoveryState = { status: 'idle', servers: { ...EMPTY }, hosts: [] };
const listeners = new Set<(next: DiscoveryState) => void>();

const emit = (): void => {
    for (const listener of listeners) {
        try {
            listener(state);
        } catch (error) {
            console.warn('[MobileShell] Server discovery listener failed', error);
        }
    }
};

export const getDiscoveryState = (): DiscoveryState => state;

export const onDiscoveryStateChange = (listener: (next: DiscoveryState) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

const readStored = (): DiscoveredServers | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<DiscoveredServers>;
        const servers = {
            netease: typeof parsed.netease === 'string' ? parsed.netease : '',
            kugou: typeof parsed.kugou === 'string' ? parsed.kugou : '',
            qq: typeof parsed.qq === 'string' ? parsed.qq : '',
        };
        return Object.values(servers).some(Boolean) ? servers : null;
    } catch {
        return null;
    }
};

const store = (servers: DiscoveredServers): void => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
    } catch (error) {
        console.warn('[MobileShell] Could not remember the discovered servers', error);
    }
};

/**
 * Publishes the addresses to everything that reads them: the runtime config the providers consult,
 * the shell's own settings (so the next boot has them before the page even runs), and the NetEase
 * module's cache, which resolves its base once.
 */
const applyServers = (servers: DiscoveredServers): void => {
    if (typeof window === 'undefined') return;
    const config = window.__FOLIA_RUNTIME_CONFIG__ ?? (window.__FOLIA_RUNTIME_CONFIG__ = {});
    config.servers = {
        netease: servers.netease || undefined,
        kugou: servers.kugou || undefined,
        qq: servers.qq || undefined,
    };
    store(servers);

    if (isAndroidShell()) {
        void callNative('servers.save', { ...servers }, 10_000).catch(error => {
            console.warn('[MobileShell] Could not persist the discovered servers', error);
        });
    }

    if (servers.netease) {
        // Loaded lazily: the provider module is large and this only runs when a backend was found.
        void import('../onlineMusic/netease/netease')
            .then(module => module.resetNeteaseApiBaseCache())
            .catch(() => undefined);
    }

    window.dispatchEvent(new CustomEvent('folia-servers-updated', { detail: servers }));
};

const probe = async (base: string, path: string): Promise<boolean> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const response = await fetch(`${base}${path}`, {
            signal: controller.signal,
            cache: 'no-store',
            // The app talks to these servers cross-origin, so a backend that cannot answer a CORS
            // request is no use to it - a probe that ignored that would pick a server the player
            // then fails against.
            mode: 'cors',
            credentials: 'omit',
        });
        // Any non-5xx answer means something is listening and speaking the protocol.
        return response.status < 500;
    } catch {
        return false;
    } finally {
        window.clearTimeout(timer);
    }
};

const firstReachable = async (bases: string[], path: string): Promise<string> => {
    if (bases.length === 0) return '';
    const results = await Promise.all(bases.map(async (base, index) => ({
        index,
        base,
        ok: await probe(base, path),
    })));
    const winner = results.filter(result => result.ok).sort((left, right) => left.index - right.index)[0];
    return winner?.base ?? '';
};

interface NativeNetwork {
    addresses?: string[];
    gateway?: string;
    candidates?: string[];
}

const candidateHosts = async (): Promise<string[]> => {
    const hosts: string[] = [];
    const add = (host: string | undefined): void => {
        if (!host) return;
        const trimmed = host.trim();
        if (!trimmed || hosts.includes(trimmed)) return;
        hosts.push(trimmed);
    };

    // Loopback first? No: on Android it is the phone, where nobody runs these APIs. On the emulator
    // and in WSA the host machine is reachable through a fixed alias instead.
    add('10.0.2.2');
    add('127.0.0.1');

    try {
        const network = await callNative<NativeNetwork>('device.network', {}, 8_000);
        add(network.gateway);
        for (const candidate of network.candidates ?? []) add(candidate);
    } catch (error) {
        console.warn('[MobileShell] Could not read the network layout; probing what is left', error);
    }

    // A gateway is the most likely host; keep the list short so probing stays under a couple of
    // seconds even on a bad Wi-Fi.
    return hosts.slice(0, 4);
};

export const discoverServers = async (options: { force?: boolean } = {}): Promise<DiscoveredServers> => {
    if (!isAndroidShell()) return { ...EMPTY };

    if (!options.force) {
        const stored = readStored();
        if (stored) {
            state = { status: 'done', servers: stored, hosts: [] };
            applyServers(stored);
            emit();
            void ensureDeviceToken(stored.netease);
            return stored;
        }
    }

    state = { status: 'probing', servers: { ...EMPTY }, hosts: state.hosts };
    emit();

    const hosts = await candidateHosts();
    const servers: DiscoveredServers = { ...EMPTY };
    await Promise.all((Object.keys(PROVIDER_PORTS) as RuntimeServerProvider[]).map(async provider => {
        const bases = hosts.flatMap(host => PROVIDER_PORTS[provider].map(port => `http://${host}:${port}`));
        servers[provider] = await firstReachable(bases, HEALTH_PATH[provider]);
    }));

    state = {
        status: 'done',
        servers,
        hosts: hosts.filter(Boolean),
    };
    if (Object.values(servers).some(Boolean)) {
        applyServers(servers);
        void ensureDeviceToken(servers.netease);
    }
    emit();

    if (Object.values(servers).some(Boolean)) {
        console.info('[MobileShell] Discovered music backends', servers);
    } else {
        console.info('[MobileShell] No music backend answered on this network; local music still works');
    }
    return servers;
};

/**
 * The gateway keeps one Cookie jar per device. Registering is anonymous and happens on its own, so
 * the user never sees a server-configuration step: scanning the QR in the app is the only thing they
 * do. A plain NeteaseCloudMusicApi instance has no /auth/register and simply answers 404 - then we
 * leave the token empty and the request goes out without an Authorization header, as before.
 */
const ensureDeviceToken = async (neteaseBase: string): Promise<void> => {
    if (!neteaseBase) return;
    if (typeof window === 'undefined') return;
    if (getRuntimeServerToken('netease')) return;

    try {
        const response = await fetch(`${neteaseBase}/auth/register`, {
            method: 'POST',
            mode: 'cors',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (!response.ok) return;
        const payload = await response.json() as { token?: string };
        const token = typeof payload.token === 'string' ? payload.token.trim() : '';
        if (!token) return;

        const config = window.__FOLIA_RUNTIME_CONFIG__ ?? (window.__FOLIA_RUNTIME_CONFIG__ = {});
        config.servers = { ...(config.servers ?? {}), neteaseToken: token };
        try {
            localStorage.setItem('folia_mobile_netease_token', token);
        } catch {
            // Storage may be full; the native copy below is the durable one.
        }
        if (isAndroidShell()) {
            await callNative('servers.saveToken', { token }, 10_000).catch(() => undefined);
        }
        // The NetEase module resolves its base (and headers) once; make the next call see the token.
        void import('../onlineMusic/netease/netease')
            .then(module => module.resetNeteaseApiBaseCache())
            .catch(() => undefined);
        console.info('[MobileShell] Registered a device token with the music gateway');
    } catch (error) {
        console.warn('[MobileShell] Music gateway did not hand out a device token', error);
    }
};

/** Re-probes once the phone is back on a network, if discovery never found anything. */
export const watchForNetworkReturn = (): void => {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => {
        if (state.status === 'done' && !Object.values(state.servers).some(Boolean)) {
            void discoverServers({ force: true });
        }
    });
};
