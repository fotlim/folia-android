// src/services/onlineMusic/providerEnablement.ts
// Which online-platform adapters a build exposes. Every adapter stays registered and implemented;
// this is only the door: the Android build ships with NetEase alone (`VITE_ONLINE_PROVIDERS=netease`)
// while the desktop and web builds leave the variable unset and keep everything.
//
// Adding KuGou or QQ back later is a one-word change in the Android build env - the adapter, the UI
// and the discovery probe all read this list, so nothing else has to be touched.

import type { OnlineProviderId } from '../../types/onlineMusic';

const readConfiguredList = (value: unknown): readonly string[] | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    return value.split(',').map(entry => entry.trim()).filter(Boolean);
};

/** `null` means "no gate in this build": every registered adapter is offered. */
export const getConfiguredOnlineProviders = (): readonly string[] | null => (
    readConfiguredList((import.meta as ImportMeta & { env?: Record<string, unknown> }).env?.VITE_ONLINE_PROVIDERS)
);

export const isOnlineProviderEnabled = (providerId: OnlineProviderId): boolean => {
    const configured = getConfiguredOnlineProviders();
    if (!configured) return true;
    return configured.includes(providerId);
};
