// src/services/mobileShell/safDirectoryHandles.ts
// Android has no `showDirectoryPicker`. This module provides one backed by the Storage Access
// Framework, shaped like the File System Access API the local library already speaks
// (`values()`, `getDirectoryHandle`, `getFileHandle`, `getFile`, `queryPermission`), so the import,
// rescan and playback paths keep working unchanged.

import { callNative } from './nativeBridge';

// Same origin as the page: in the shell that is the appasset host, whose `/saf/` route streams the
// document the bridge just registered. Resolving against the origin (not a hard-coded host) also
// means the shim can be exercised from a plain http server in tests.
const streamUrl = (token: string): string => `${window.location.origin}/saf/${token}`;

type NativeEntry = { name: string; dir: boolean; size: number; modified: number };
type NativeListing = { ok: boolean; reason?: string; name?: string; entries?: NativeEntry[] };
type NativeOpened = { ok: boolean; reason?: string; name?: string; size?: number; modified?: number; mime?: string; token?: string };

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    alac: 'audio/mp4',
    ape: 'audio/x-ape',
    wv: 'audio/x-wavpack',
    tta: 'audio/x-tta',
    wma: 'audio/x-ms-wma',
    aif: 'audio/aiff',
    aiff: 'audio/aiff',
    caf: 'audio/x-caf',
    lrc: 'text/plain',
    vtt: 'text/vtt',
    ttml: 'application/ttml+xml',
    qrc: 'text/plain',
    yrc: 'text/plain',
    krc: 'text/plain',
};

const mimeFor = (name: string): string => {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return 'application/octet-stream';
    return AUDIO_MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
};

/** The persisted form of a handle: enough to rebuild it after a restart. */
export const SAF_HANDLE_MARKER = '__foliaSafRoot';

/*
 * One song is read several times in a row - metadata at import, then again when it is played, then
 * for its cover - and each read is a ContentResolver stream through the shell. Keeping the last few
 * decoded Files for half a minute removes those repeats; the blobs behind them live on disk in
 * Chromium's blob store, so this is a reference cache, not a copy of the audio in the JS heap.
 */
const FILE_CACHE_TTL_MS = 30_000;
const FILE_CACHE_LIMIT = 4;
const fileCache = new Map<string, { at: number; file: Promise<File> }>();

const PERMISSION_CACHE_TTL_MS = 15_000;
const permissionCache = new Map<string, { at: number; granted: boolean }>();

const cacheKey = (rootUri: string, path: string) => `${rootUri}\u0000${path}`;

const rememberFile = (key: string, file: Promise<File>): void => {
    fileCache.set(key, { at: Date.now(), file });
    if (fileCache.size <= FILE_CACHE_LIMIT) return;
    const oldest = [...fileCache.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    if (oldest) fileCache.delete(oldest[0]);
};

const readDocument = async (
    rootUri: string,
    path: string,
    name: string,
    opened: NativeOpened,
): Promise<File> => {
    let response: Response;
    try {
        response = await fetch(streamUrl(opened.token as string), { cache: 'no-store' });
    } finally {
        // The token is single-use: the stream has been opened (or refused) by now.
        void callNative('saf.release', { token: opened.token }).catch(() => undefined);
    }

    if (!response.ok) {
        // 403 means the persisted grant is gone; 404 means the file itself is gone. They need
        // different fixes, so they get different errors instead of one "could not be read".
        if (response.status === 403) {
            throw new DOMException(
                `Access to "${name}" was revoked. Pick the folder again in the local library`,
                'NotAllowedError',
            );
        }
        throw new DOMException(`The file "${name}" is no longer available`, 'NotFoundError');
    }

    const blob = await response.blob();
    return new File([blob], name, {
        type: opened.mime || mimeFor(name),
        lastModified: opened.modified && opened.modified > 0 ? opened.modified : Date.now(),
    });
};

export class SafFileHandle {
    readonly kind = 'file' as const;
    readonly name: string;

    constructor(
        private readonly rootUri: string,
        readonly path: string,
    ) {
        this.name = path.slice(path.lastIndexOf('/') + 1);
    }

    get __foliaSafRootUri(): string {
        return this.rootUri;
    }

    async getFile(): Promise<File> {
        const key = cacheKey(this.rootUri, this.path);
        const cached = fileCache.get(key);
        if (cached && Date.now() - cached.at < FILE_CACHE_TTL_MS) {
            return cached.file;
        }

        const pending = (async () => {
            const opened = await callNative<NativeOpened>('saf.open', { root: this.rootUri, path: this.path });
            if (!opened.ok || !opened.token) {
                if (opened.reason === 'directory-missing') {
                    throw new DOMException(
                        `The folder for "${this.name}" is no longer available`,
                        'NotFoundError',
                    );
                }
                throw new DOMException(`The file "${this.name}" is no longer available`, 'NotFoundError');
            }
            return readDocument(this.rootUri, this.path, opened.name || this.name, opened);
        })();

        rememberFile(key, pending);
        try {
            return await pending;
        } catch (error) {
            // A failed read must not be remembered as the answer for the next 30 seconds.
            fileCache.delete(key);
            throw error;
        }
    }

    async queryPermission(): Promise<PermissionState> {
        return 'granted';
    }

    async requestPermission(): Promise<PermissionState> {
        return 'granted';
    }

    async isSameEntry(other: unknown): Promise<boolean> {
        return other instanceof SafFileHandle && other.rootUri === this.rootUri && other.path === this.path;
    }
}

export class SafDirectoryHandle {
    readonly kind = 'directory' as const;
    readonly name: string;

    private listing: { at: number; entries: NativeEntry[] } | null = null;

    constructor(
        private readonly rootUri: string,
        readonly path: string,
        name?: string,
    ) {
        this.name = name ?? (path ? path.slice(path.lastIndexOf('/') + 1) : 'library');
    }

    get __foliaSafRootUri(): string {
        return this.rootUri;
    }

    private childPath(name: string): string {
        return this.path ? `${this.path}/${name}` : name;
    }

    private async readEntries(): Promise<NativeEntry[]> {
        const now = Date.now();
        if (this.listing && now - this.listing.at < 15_000) return this.listing.entries;

        const result = await callNative<NativeListing>('saf.list', { root: this.rootUri, path: this.path });
        if (!result.ok || !result.entries) {
            throw new DOMException(`The directory "${this.name}" is no longer available`, 'NotFoundError');
        }
        this.listing = { at: now, entries: result.entries };
        return result.entries;
    }

    async *values(): AsyncGenerator<SafFileHandle | SafDirectoryHandle> {
        for (const entry of await this.readEntries()) {
            yield entry.dir
                ? new SafDirectoryHandle(this.rootUri, this.childPath(entry.name), entry.name)
                : new SafFileHandle(this.rootUri, this.childPath(entry.name));
        }
    }

    async *keys(): AsyncGenerator<string> {
        for (const entry of await this.readEntries()) yield entry.name;
    }

    async *entries(): AsyncGenerator<[string, SafFileHandle | SafDirectoryHandle]> {
        for (const entry of await this.readEntries()) {
            yield [
                entry.name,
                entry.dir
                    ? new SafDirectoryHandle(this.rootUri, this.childPath(entry.name), entry.name)
                    : new SafFileHandle(this.rootUri, this.childPath(entry.name)),
            ];
        }
    }

    async getDirectoryHandle(name: string): Promise<SafDirectoryHandle> {
        const entry = (await this.readEntries()).find(candidate => candidate.name === name && candidate.dir);
        if (!entry) throw new DOMException(`Directory "${name}" not found`, 'NotFoundError');
        return new SafDirectoryHandle(this.rootUri, this.childPath(name), name);
    }

    async getFileHandle(name: string): Promise<SafFileHandle> {
        const entry = (await this.readEntries())
            .find(candidate => !candidate.dir && candidate.name === name)
            // The provider can return a decomposed name where the picker reported a composed one.
            ?? (await this.readEntries())
                .find(candidate => !candidate.dir && candidate.name.normalize('NFC') === name.normalize('NFC'));
        if (!entry) throw new DOMException(`File "${name}" not found`, 'NotFoundError');
        return new SafFileHandle(this.rootUri, this.childPath(entry.name));
    }

    async queryPermission(): Promise<PermissionState> {
        const cached = permissionCache.get(this.rootUri);
        if (cached && Date.now() - cached.at < PERMISSION_CACHE_TTL_MS) {
            return cached.granted ? 'granted' : 'prompt';
        }
        try {
            const result = await callNative<{ granted: boolean }>('saf.check', { root: this.rootUri });
            permissionCache.set(this.rootUri, { at: Date.now(), granted: result.granted });
            return result.granted ? 'granted' : 'prompt';
        } catch (error) {
            console.warn('[MobileShell] Could not check the folder permission', error);
            return 'prompt';
        }
    }

    async requestPermission(): Promise<PermissionState> {
        return this.queryPermission();
    }

    async isSameEntry(other: unknown): Promise<boolean> {
        return other instanceof SafDirectoryHandle && other.rootUri === this.rootUri && other.path === this.path;
    }
}

export const isSafDirectoryHandle = (value: unknown): value is SafDirectoryHandle => (
    value instanceof SafDirectoryHandle
    || (typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'directory'
        && typeof (value as { __foliaSafRootUri?: unknown }).__foliaSafRootUri === 'string')
);

export const isSafFileHandle = (value: unknown): value is SafFileHandle => (
    value instanceof SafFileHandle
    || (typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'file'
        && typeof (value as { __foliaSafRootUri?: unknown }).__foliaSafRootUri === 'string')
);

/** Revives a handle persisted by `serializeSafHandles`, keeping values that were never ours. */
export const reviveSafHandle = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (record[SAF_HANDLE_MARKER] !== true) return value;
    const rootUri = typeof record.rootUri === 'string' ? record.rootUri : '';
    if (!rootUri) return value;
    const path = typeof record.path === 'string' ? record.path : '';
    const name = typeof record.name === 'string' ? record.name : undefined;

    return record.kind === 'file'
        ? new SafFileHandle(rootUri, path)
        : new SafDirectoryHandle(rootUri, path, name);
};

/**
 * Installs `window.showDirectoryPicker`. The picker itself is the system's document picker, so the
 * permission it grants is the one the platform persists across reboots.
 */
export const installAndroidDirectoryPicker = (): void => {
    if (typeof window === 'undefined') return;

    const showDirectoryPicker = async (): Promise<SafDirectoryHandle> => {
        const picked = await callNative<{ canceled: boolean; uri?: string; name?: string }>('saf.pick', {}, 300_000);
        if (picked.canceled || !picked.uri) {
            throw new DOMException('The user aborted a request.', 'AbortError');
        }
        return new SafDirectoryHandle(picked.uri, '', picked.name || 'library');
    };

    Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        writable: true,
        value: showDirectoryPicker,
    });
};
