// src/services/mobileShell/safHandleCodec.ts
// The local library keeps its picked directory handles in IndexedDB. Real File System Access handles
// are structured-cloneable; the Android handles are class instances and are not, so they are stored
// as their root URI plus relative path and rebuilt on the way out.

import { SAF_HANDLE_MARKER, isSafDirectoryHandle, isSafFileHandle, reviveSafHandle } from './safDirectoryHandles';

const encodeHandle = (handle: unknown): unknown => {
    if (isSafDirectoryHandle(handle) || isSafFileHandle(handle)) {
        return {
            [SAF_HANDLE_MARKER]: true,
            kind: handle.kind,
            name: handle.name,
            path: handle.path,
            rootUri: handle.__foliaSafRootUri,
        };
    }
    return handle;
};

export const serializeSafHandles = (
    handles: Record<string, FileSystemDirectoryHandle>,
): Record<string, unknown> => {
    const encoded: Record<string, unknown> = {};
    for (const [key, handle] of Object.entries(handles)) {
        encoded[key] = encodeHandle(handle);
    }
    return encoded;
};

export const deserializeSafHandles = (
    stored: Record<string, unknown> | null | undefined,
): Record<string, FileSystemDirectoryHandle> => {
    const handles: Record<string, FileSystemDirectoryHandle> = {};
    if (!stored) return handles;
    for (const [key, value] of Object.entries(stored)) {
        handles[key] = reviveSafHandle(value) as FileSystemDirectoryHandle;
    }
    return handles;
};
