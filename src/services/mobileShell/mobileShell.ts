// src/services/mobileShell/mobileShell.ts
// Installs everything the Android shell needs before React mounts: the native bridge, the directory
// picker the local library expects, the hardware back button and a first-run notification permission
// prompt. A browser or the Electron app calls `installMobileShell` and it does nothing at all.

import { callNative, installNativeBridge, isAndroidShell, onNativeEvent } from './nativeBridge';
import { installAndroidDirectoryPicker } from './safDirectoryHandles';
import { installNativeTransportListener } from './mediaSessionNative';
import { discoverServers, watchForNetworkReturn } from './serverDiscovery';
// Phone-shaped layout adjustments, scoped to `html[data-folia-shell='android']` so no other build
// sees them.
import './mobileShell.css';

const OVERLAY_SELECTOR = '[role="dialog"], [aria-modal="true"], [data-folia-overlay]';

const visibleOverlayCount = (): number => {
    if (typeof document === 'undefined') return 0;
    return Array.from(document.querySelectorAll(OVERLAY_SELECTOR))
        .filter(element => (element as HTMLElement).offsetParent !== null).length;
};

const pressEscape = (): void => {
    const keyboardEvent = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', keyboardEvent));
    window.dispatchEvent(new KeyboardEvent('keydown', keyboardEvent));
    window.dispatchEvent(new KeyboardEvent('keyup', keyboardEvent));
    document.dispatchEvent(new KeyboardEvent('keyup', keyboardEvent));
};

/**
 * Android's back gesture is the same gesture that closes a sheet everywhere else, so it presses
 * Escape first. With nothing open it sends the app to the background instead of finishing it, which
 * keeps playback and the notification alive.
 */
export const installAndroidBackHandler = (): void => {
    if (typeof window === 'undefined') return;
    const globalWindow = window as unknown as Record<string, unknown>;
    globalWindow.__foliaNativeBackPressed = () => {
        const openOverlays = visibleOverlayCount();
        pressEscape();
        if (openOverlays === 0) {
            void callNative('app.background', {}, 5_000).catch(() => undefined);
        }
        return true;
    };
};

/** Asks for POST_NOTIFICATIONS the first time audio is about to become a foreground service. */
export const ensureNotificationPermission = (): void => {
    if (!isAndroidShell()) return;
    void callNative('notifications.request', {}, 10_000)
        .then(result => {
            const enabled = (result as { notificationsEnabled?: boolean } | null)?.notificationsEnabled;
            if (enabled === false) {
                console.info('[MobileShell] Notifications are disabled; the playback notification is hidden');
            }
        })
        .catch(error => console.warn('[MobileShell] Notification permission request failed', error));
};

let installed = false;

export const installMobileShell = (): void => {
    if (installed || !isAndroidShell()) return;
    installed = true;

    installNativeBridge();
    installAndroidDirectoryPicker();
    installAndroidBackHandler();
    installNativeTransportListener();

    document.documentElement.dataset.foliaShell = 'android';

    // 触屏上那颗灯泡（Ponder 按钮）和面板里的入口重复，手机壳内不再显示。
    void import('../../stores/usePonderStore')
        .then(module => module.usePonderStore.getState().setShowPonderTouchButton(false))
        .catch(error => console.warn('[MobileShell] Could not hide the Ponder touch button', error));

    onNativeEvent('back', () => {
        const globalWindow = window as unknown as { __foliaNativeBackPressed?: () => boolean };
        globalWindow.__foliaNativeBackPressed?.();
    });

    void callNative('device.info', {}, 10_000)
        .then(info => console.info('[MobileShell] Android device', info))
        .catch(error => console.warn('[MobileShell] Could not read device info', error));

    // The online providers need a backend the user hosts; find it instead of asking. This runs in
    // the background - the first screen does not wait for it, and local music never depends on it.
    void discoverServers();
    watchForNetworkReturn();
};

export { isAndroidShell };
