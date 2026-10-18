import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { PlayerState } from '../types';
import type { SongResult } from '../types';
import { getSongAlbumLabel, getSongArtistLabel, getSongCoverUrl } from '../services/onlineMusic/songMetadata';
import {
    getSupportedMediaSessionArtworkUrl,
    isMediaSessionSourceReady,
    publishMediaSessionTrack,
} from '../utils/mediaSessionSync';
import { isAndroidShell } from '../services/mobileShell/nativeBridge';
import {
    clearNativeMedia,
    publishNativeMedia,
    setNativeTransportHandlers,
} from '../services/mobileShell/mediaSessionNative';

// Bridges Folia playback state to the browser Media Session API, and to the Android shell's native
// media session (which is what keeps the notification and the lock screen working when the screen
// is off - the browser session is not enough there).
type UseMediaSessionBridgeOptions = {
    audioRef: RefObject<HTMLAudioElement | null>;
    /**
     * The deck the displayed track is playing on, or null when the picture is live.
     *
     * Metadata, clock and source have to describe the same deck. `currentSong` is already the
     * DISPLAYED track - the outgoing one for the length of a blend - while `audioRef` names the
     * active deck, which by then is the arriving track. Publishing the two together put the outgoing
     * track's title on the incoming track's duration and position, so the system panel showed one
     * song's name over another song's progress. `audioSrc` is passed to match this element.
     */
    getDisplayAudioElement?: () => HTMLAudioElement | null;
    audioSrc: string | null;
    currentSong: SongResult | null;
    cachedCoverUrl: string | null;
    playerState: PlayerState;
    isNowPlayingStageActive: boolean;
    unknownArtistLabel: string;
    mediaSessionPlayRef: RefObject<() => Promise<void>>;
    mediaSessionPauseRef: RefObject<() => void>;
    mediaSessionPrevRef: RefObject<() => void>;
    mediaSessionNextRef: RefObject<() => Promise<void> | void>;
    isNowPlayingControlDisabledRef: RefObject<boolean>;
};

/** How often the native session sees a fresh position while a track is playing. */
const NATIVE_POSITION_REFRESH_MS = 12_000;

export const useMediaSessionBridge = ({
    audioRef,
    getDisplayAudioElement,
    audioSrc,
    currentSong,
    cachedCoverUrl,
    playerState,
    isNowPlayingStageActive,
    unknownArtistLabel,
    mediaSessionPlayRef,
    mediaSessionPauseRef,
    mediaSessionPrevRef,
    mediaSessionNextRef,
    isNowPlayingControlDisabledRef,
}: UseMediaSessionBridgeOptions) => {
    const browserMediaSession = typeof navigator !== 'undefined' && 'mediaSession' in navigator
        ? navigator.mediaSession
        : null;
    // The Android shell's session still exists when the WebView has no `navigator.mediaSession` of
    // its own, so the guards below test both surfaces.
    const wantsMediaSession = Boolean(browserMediaSession) || isAndroidShell();
    const audioPlayingRef = useRef(false);

    useEffect(() => {
        if (!wantsMediaSession) {
            return;
        }

        const setActionHandlerSafely = (
            action: MediaSessionAction,
            handler: MediaSessionActionHandler | null
        ) => {
            if (!browserMediaSession) return;
            try {
                browserMediaSession.setActionHandler(action, handler);
            } catch (e) {
                console.warn(`[MediaSession] Failed to bind ${action} handler`, e);
            }
        };

        const play = async () => {
            if (isNowPlayingControlDisabledRef.current || !audioRef.current) {
                return;
            }
            try {
                await mediaSessionPlayRef.current();
            } catch (e) {
                console.error('MediaSession play failed', e);
            }
        };
        const pause = () => {
            if (isNowPlayingControlDisabledRef.current || !audioRef.current) {
                return;
            }
            mediaSessionPauseRef.current();
        };
        const previous = () => {
            if (isNowPlayingControlDisabledRef.current) return;
            mediaSessionPrevRef.current();
        };
        const next = () => {
            if (isNowPlayingControlDisabledRef.current) return;
            void mediaSessionNextRef.current();
        };
        // The notification shows one button that swaps between play and pause; the web app decides
        // which one that press means.
        const toggle = () => (audioRef.current && !audioRef.current.paused ? pause() : play());

        setActionHandlerSafely('play', () => { void play(); });
        setActionHandlerSafely('pause', pause);
        setActionHandlerSafely('previoustrack', previous);
        setActionHandlerSafely('nexttrack', next);

        setNativeTransportHandlers({ play, pause, toggle, next, previous });

        return () => {
            setActionHandlerSafely('play', null);
            setActionHandlerSafely('pause', null);
            setActionHandlerSafely('previoustrack', null);
            setActionHandlerSafely('nexttrack', null);
            setNativeTransportHandlers(null);
        };
    }, [audioRef, browserMediaSession, isNowPlayingControlDisabledRef, mediaSessionNextRef, mediaSessionPauseRef, mediaSessionPlayRef, mediaSessionPrevRef, wantsMediaSession]);

    useEffect(() => {
        if (!wantsMediaSession) {
            return;
        }

        if (!currentSong) {
            if (browserMediaSession) {
                try {
                    browserMediaSession.setPositionState();
                    browserMediaSession.metadata = null;
                } catch (e) {
                    console.warn('[MediaSession] Failed to clear metadata', e);
                }
            }
            clearNativeMedia();
            return;
        }

        // The displayed track's own deck, so the position published below belongs to the title
        // published beside it. Falls back to the active deck whenever no blend is holding a picture.
        const audio = getDisplayAudioElement?.() ?? audioRef.current;
        if (!audio || !audioSrc) {
            return;
        }

        let disposed = false;
        const sourceArtworkUrl = cachedCoverUrl || getSongCoverUrl(currentSong) || '';
        let artworkUrl = getSupportedMediaSessionArtworkUrl(sourceArtworkUrl, document.baseURI);
        let disposableArtworkUrl: string | null = null;

        const publishNative = () => {
            if (!isAndroidShell() || disposed) return;
            audioPlayingRef.current = !audio.paused;
            publishNativeMedia({
                title: currentSong.name,
                artist: getSongArtistLabel(currentSong) || unknownArtistLabel,
                album: getSongAlbumLabel(currentSong),
                durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0,
                positionMs: Number.isFinite(audio.currentTime) ? Math.round(audio.currentTime * 1000) : 0,
                playing: !audio.paused,
                artworkUrl: sourceArtworkUrl,
            });
        };

        const publish = () => {
            if (disposed || !isMediaSessionSourceReady(audio, audioSrc, document.baseURI)) {
                return;
            }

            if (browserMediaSession) {
                try {
                    publishMediaSessionTrack(browserMediaSession, audio, {
                        title: currentSong.name,
                        artist: getSongArtistLabel(currentSong) || unknownArtistLabel,
                        album: getSongAlbumLabel(currentSong),
                        artworkUrl,
                    });
                } catch (e) {
                    console.warn('[MediaSession] Failed to update metadata', e);
                }
            }
            publishNative();
        };

        // MediaMetadata rejects Electron's custom protocol, so expose that image through a
        // short-lived blob URL while this track owns the platform media session.
        const prepareUnsupportedArtwork = async () => {
            if (!sourceArtworkUrl || artworkUrl) return;

            try {
                const response = await fetch(sourceArtworkUrl);
                if (!response.ok) throw new Error(`Artwork request failed: ${response.status}`);
                const artworkBlob = await response.blob();
                if (artworkBlob.size <= 0 || !artworkBlob.type.startsWith('image/')) {
                    throw new Error('Artwork response is not a valid image');
                }

                const objectUrl = URL.createObjectURL(artworkBlob);
                if (disposed) {
                    URL.revokeObjectURL(objectUrl);
                    return;
                }
                disposableArtworkUrl = objectUrl;
                artworkUrl = objectUrl;
                publish();
            } catch (e) {
                if (!disposed) console.warn('[MediaSession] Failed to prepare artwork', e);
            }
        };

        audio.addEventListener('loadedmetadata', publish);
        audio.addEventListener('durationchange', publish);
        // Re-publish after playback starts in case Chromium delivered a late clear from the old source.
        audio.addEventListener('playing', publish);
        // The notification's play/pause icon is drawn from the shell's own state, so transport
        // changes have to reach it too - not only track changes.
        audio.addEventListener('play', publishNative);
        audio.addEventListener('pause', publishNative);
        publish();
        void prepareUnsupportedArtwork();

        // The system extrapolates the position from the playback state, but only from the last one
        // it was given; a periodic refresh keeps a long track from drifting on the lock screen.
        const positionTimer = isAndroidShell()
            ? window.setInterval(() => {
                if (!disposed && !audio.paused) publishNative();
            }, NATIVE_POSITION_REFRESH_MS)
            : null;

        return () => {
            disposed = true;
            audio.removeEventListener('loadedmetadata', publish);
            audio.removeEventListener('durationchange', publish);
            audio.removeEventListener('playing', publish);
            audio.removeEventListener('play', publishNative);
            audio.removeEventListener('pause', publishNative);
            if (positionTimer !== null) window.clearInterval(positionTimer);
            if (disposableArtworkUrl) URL.revokeObjectURL(disposableArtworkUrl);
        };
    }, [audioRef, audioSrc, browserMediaSession, cachedCoverUrl, currentSong, getDisplayAudioElement, unknownArtistLabel, wantsMediaSession]);

    useEffect(() => {
        if (!browserMediaSession) {
            return;
        }

        try {
            browserMediaSession.playbackState = isNowPlayingStageActive
                ? 'none'
                : currentSong
                    ? (playerState === PlayerState.PLAYING ? 'playing' : 'paused')
                    : 'none';
        } catch (e) {
            console.warn('[MediaSession] Failed to update playback state', e);
        }
    }, [browserMediaSession, currentSong, isNowPlayingStageActive, playerState]);
};
