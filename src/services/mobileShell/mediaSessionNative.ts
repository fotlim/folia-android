// src/services/mobileShell/mediaSessionNative.ts
// In a browser the page publishes to `navigator.mediaSession`. Inside the Android shell that surface
// belongs to the native media session instead, because only a foreground service keeps the WebView
// (and therefore the queue, the decoders and the timers) alive once the screen goes off.

import { callNative, isAndroidShell, onNativeEvent } from './nativeBridge';

export interface NativeMediaState {
    title: string;
    artist: string;
    album: string;
    durationMs: number;
    positionMs: number;
    playing: boolean;
    artworkUrl?: string;
}

export type NativeTransportAction = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'stop';

interface TransportHandlers {
    play: () => void | Promise<void>;
    pause: () => void;
    toggle: () => void | Promise<void>;
    next: () => void | Promise<void>;
    previous: () => void;
}

const MIN_PUSH_INTERVAL_MS = 900;
const POSITION_REFRESH_MS = 15_000;
const MAX_ARTWORK_BYTES = 2_000_000;
const ARTWORK_MAX_EDGE = 512;

let lastPushAt = 0;
let lastSnapshotKey = '';
let queuedPush: number | null = null;
let positionTimer: number | null = null;
let latestState: NativeMediaState | null = null;
let handlers: TransportHandlers | null = null;
let artworkCache: { source: string; dataUrl: string } | null = null;

/** Registers what a lock-screen or headset press should do in the web app. */
export const setNativeTransportHandlers = (next: TransportHandlers | null): void => {
    handlers = next;
};

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the artwork'));
    reader.readAsDataURL(blob);
});

const downscaleToDataUrl = async (blob: Blob): Promise<string> => {
    if (typeof createImageBitmap !== 'function') return blobToDataUrl(blob);
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, ARTWORK_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
        bitmap.close();
        return blobToDataUrl(blob);
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/png');
};

/**
 * The notification needs pixels, not a URL: `blob:` URLs mean nothing outside the page. A plain
 * http(s) URL is left to the service, which can download it without CORS in the way.
 */
const resolveArtworkDataUrl = async (url: string | undefined): Promise<string> => {
    if (!url) return '';
    if (url.startsWith('data:')) return url;
    if (artworkCache?.source === url) return artworkCache.dataUrl;
    if (!url.startsWith('blob:') && !url.startsWith('http')) return '';

    try {
        const response = await fetch(url);
        if (!response.ok) return '';
        const blob = await response.blob();
        if (!blob.type.startsWith('image/') || blob.size === 0 || blob.size > MAX_ARTWORK_BYTES) return '';
        const dataUrl = blob.size > 200_000 ? await downscaleToDataUrl(blob) : await blobToDataUrl(blob);
        artworkCache = { source: url, dataUrl };
        return dataUrl;
    } catch (error) {
        console.warn('[MobileShell] Could not prepare the notification artwork', error);
        return '';
    }
};

const pushState = async (state: NativeMediaState | null): Promise<void> => {
    if (!isAndroidShell()) return;
    if (!state) {
        latestState = null;
        await callNative('media.clear', {}, 10_000).catch(() => undefined);
        return;
    }

    const artworkDataUrl = await resolveArtworkDataUrl(state.artworkUrl);
    const payload = { ...state, artworkDataUrl };
    lastPushAt = Date.now();
    await callNative('media.update', { state: payload }, 10_000).catch(error => {
        console.warn('[MobileShell] Could not update the media session', error);
    });
};

/**
 * Publishes what is playing. Calls arriving back-to-back collapse into one, and while a track is
 * playing the position is refreshed periodically so the system progress bar does not drift.
 */
export const publishNativeMedia = (state: NativeMediaState | null): void => {
    if (!isAndroidShell()) return;

    latestState = state;
    const key = state
        ? `${state.title}|${state.artist}|${state.album}|${state.playing}|${Math.round(state.durationMs)}|${state.artworkUrl ?? ''}`
        : 'none';
    const stateChanged = key !== lastSnapshotKey;
    lastSnapshotKey = key;

    const run = () => {
        queuedPush = null;
        void pushState(latestState);
    };

    const wait = Math.max(0, MIN_PUSH_INTERVAL_MS - (Date.now() - lastPushAt));
    if (stateChanged) {
        if (queuedPush !== null) window.clearTimeout(queuedPush);
        if (wait === 0) run();
        else queuedPush = window.setTimeout(run, wait);
    }

    if (positionTimer !== null) {
        window.clearTimeout(positionTimer);
        positionTimer = null;
    }
    if (state?.playing) {
        positionTimer = window.setTimeout(() => {
            positionTimer = null;
            if (latestState?.playing) void pushState(latestState);
        }, POSITION_REFRESH_MS);
    }
};

export const clearNativeMedia = (): void => {
    publishNativeMedia(null);
};

/** Wires the shell's transport presses to the app's own playback controls. */
export const installNativeTransportListener = (): (() => void) => (
    onNativeEvent('transport', action => {
        if (!handlers) return;
        switch (action as NativeTransportAction) {
            case 'play':
                void handlers.play();
                break;
            case 'pause':
                handlers.pause();
                break;
            case 'toggle':
                void handlers.toggle();
                break;
            case 'next':
                void handlers.next();
                break;
            case 'previous':
                handlers.previous();
                break;
            case 'stop':
                handlers.pause();
                break;
            default:
                break;
        }
    })
);
