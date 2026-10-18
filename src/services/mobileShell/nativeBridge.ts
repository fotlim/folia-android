// src/services/mobileShell/nativeBridge.ts
// The only place that talks to the Android shell's JavaScript interface. The shell answers every
// call on its own thread and hands the result back through `window.__foliaNativeSettle`, so each
// request here is a promise with a callback id and can be abandoned by a timeout.

export interface NativeSettlement {
    ok: boolean;
    payload: string;
}

interface NativeHost {
    invoke: (method: string, paramsJson: string, callbackId: string) => void;
}

type NativeListener = (payload: unknown) => void;

const DEFAULT_TIMEOUT_MS = 120_000;
const pending = new Map<string, { settle: (settlement: NativeSettlement) => void; timer: number }>();
const listeners = new Map<string, Set<NativeListener>>();
let sequence = 0;
let installed = false;

const host = (): NativeHost | undefined => (
    typeof window === 'undefined'
        ? undefined
        : (window as unknown as { FoliaNative?: NativeHost }).FoliaNative
);

/** True inside the Android shell, false in a browser, the PWA and Electron. */
export const isAndroidShell = (): boolean => typeof host()?.invoke === 'function';

export const installNativeBridge = (): void => {
    if (installed || typeof window === 'undefined') return;
    installed = true;

    const globalWindow = window as unknown as Record<string, unknown>;

    globalWindow.__foliaNativeSettle = (callbackId: string, ok: boolean, payload: string) => {
        const entry = pending.get(callbackId);
        if (!entry) return;
        pending.delete(callbackId);
        window.clearTimeout(entry.timer);
        entry.settle({ ok, payload });
    };

    globalWindow.__foliaNativeTransport = (action: string) => {
        dispatchNativeEvent('transport', action);
    };

    globalWindow.__foliaNativeBackPressed = () => dispatchNativeEvent('back', null);

    globalWindow.__foliaNativeEvent = (event: string, payload: string) => {
        let parsed: unknown = payload;
        try {
            parsed = payload ? JSON.parse(payload) : null;
        } catch {
            // A plain string is a legitimate payload.
        }
        dispatchNativeEvent(event, parsed);
    };
};

const dispatchNativeEvent = (event: string, payload: unknown): boolean => {
    const handlers = listeners.get(event);
    if (!handlers || handlers.size === 0) return false;
    handlers.forEach(handler => {
        try {
            handler(payload);
        } catch (error) {
            console.warn(`[MobileShell] Native event "${event}" handler failed`, error);
        }
    });
    return true;
};

export const onNativeEvent = (event: string, handler: NativeListener): (() => void) => {
    const handlers = listeners.get(event) ?? new Set<NativeListener>();
    handlers.add(handler);
    listeners.set(event, handlers);
    return () => {
        handlers.delete(handler);
    };
};

/**
 * Calls a shell method. Rejects with the shell's error message so callers can show it; a timeout is
 * a rejection too, because a directory listing that never returns must not leave a pending promise
 * behind for the rest of the session.
 */
export const callNative = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> => {
    const nativeHost = host();
    if (!nativeHost) return Promise.reject(new Error('Not running inside the Android shell'));

    sequence += 1;
    const callbackId = `folia-${sequence}`;

    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            pending.delete(callbackId);
            reject(new Error(`Native call "${method}" timed out`));
        }, timeoutMs);

        pending.set(callbackId, {
            timer,
            settle: ({ ok, payload }) => {
                if (!ok) {
                    let message = payload;
                    try {
                        const parsed = JSON.parse(payload) as { message?: string };
                        if (parsed?.message) message = parsed.message;
                    } catch {
                        // Keep the raw payload.
                    }
                    reject(new Error(message || `Native call "${method}" failed`));
                    return;
                }
                try {
                    resolve((payload ? JSON.parse(payload) : null) as T);
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            },
        });

        nativeHost.invoke(method, JSON.stringify(params), callbackId);
    });
};

export interface AndroidDeviceInfo {
    sdkInt: number;
    model: string;
    manufacturer: string;
    webViewPackage: string;
    notificationsEnabled: boolean;
}
