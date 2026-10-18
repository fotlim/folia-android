// src/services/localLibraryAvailability.ts
// Centralizes the secure-context requirement for browser local-library access.

import { isAndroidShell } from './mobileShell/nativeBridge';

export interface LocalLibraryAvailability {
  supported: boolean;
  reason: 'insecure-http' | 'file-system-api-unavailable' | null;
}

export const getLocalLibraryAvailability = (): LocalLibraryAvailability => {
  if (typeof window === 'undefined') return { supported: false, reason: 'file-system-api-unavailable' };
  if (window.electron) return { supported: true, reason: null };
  // The Android shell serves the app from a secure origin and provides `showDirectoryPicker` backed
  // by the Storage Access Framework, so the local library works there even though the page is not
  // a browser tab.
  if (isAndroidShell()) return { supported: true, reason: null };
  const currentLocation = window.location;
  if (!currentLocation) return { supported: false, reason: 'file-system-api-unavailable' };
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(currentLocation.hostname);
  if (!(currentLocation.protocol === 'https:' || isLocalhost) || !window.isSecureContext) {
    return { supported: false, reason: 'insecure-http' };
  }
  if (!('showDirectoryPicker' in window) || typeof navigator.storage?.getDirectory !== 'function') {
    return { supported: false, reason: 'file-system-api-unavailable' };
  }
  return { supported: true, reason: null };
};
