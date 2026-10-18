package top.izuna.foliamajor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// android/app/src/main/java/top/izuna/foliamajor/PlaybackService.java
// Keeps the process alive while audio is playing and mirrors what is playing into the system media
// session, so the lock screen, the notification shade and Bluetooth headset buttons keep working
// with the screen off. The web app stays the source of truth: this service only renders state and
// forwards transport presses back to it.
public final class PlaybackService extends Service {

    private static final String TAG = "FoliaPlayback";
    private static final String CHANNEL_ID = "folia.playback";
    private static final int NOTIFICATION_ID = 0x0F01;

    static final String ACTION_UPDATE = "top.izuna.foliamajor.action.UPDATE";
    static final String ACTION_CLEAR = "top.izuna.foliamajor.action.CLEAR";
    static final String ACTION_TRANSPORT = "top.izuna.foliamajor.action.TRANSPORT";
    static final String EXTRA_STATE = "state";
    static final String EXTRA_TRANSPORT = "transport";

    /** Set by MainActivity; receives transport presses from the system surface. */
    interface TransportListener {
        void onTransport(String action);
    }

    private static TransportListener transportListener;
    private static boolean active;

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private final ExecutorService artworkPool = Executors.newSingleThreadExecutor();

    private String title = "";
    private String artist = "";
    private String album = "";
    private long durationMs;
    private long positionMs;
    private boolean playing;
    private String artworkRequestUrl;
    private Bitmap artwork;

    static boolean isActive() {
        return active;
    }

    static void setTransportListener(TransportListener listener) {
        transportListener = listener;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        active = true;
        createChannel();
        session = new MediaSession(this, "Folia");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { dispatch("play"); }
            @Override public void onPause() { dispatch("pause"); }
            @Override public void onSkipToNext() { dispatch("next"); }
            @Override public void onSkipToPrevious() { dispatch("previous"); }
            @Override public void onStop() { dispatch("stop"); }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            return START_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_CLEAR.equals(action)) {
            stopPlayback();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_TRANSPORT.equals(action)) {
            dispatch(intent.getStringExtra(EXTRA_TRANSPORT));
            return START_STICKY;
        }
        if (ACTION_UPDATE.equals(action)) {
            applyState(intent.getStringExtra(EXTRA_STATE));
            if (!playing) {
                // Nothing is sounding: keep the notification (the user may resume from it) but stop
                // holding the process in the foreground.
                stopForeground(false);
            }
            return START_STICKY;
        }
        return START_STICKY;
    }

    private void dispatch(String action) {
        if (action == null || transportListener == null) return;
        transportListener.onTransport(action);
    }

    private void applyState(String stateJson) {
        if (stateJson == null) return;
        try {
            JSONObject state = new JSONObject(stateJson);
            title = state.optString("title", getString(R.string.unknown_track));
            artist = state.optString("artist", "");
            album = state.optString("album", "");
            durationMs = state.optLong("durationMs", 0L);
            positionMs = state.optLong("positionMs", 0L);
            playing = state.optBoolean("playing", false);
            String dataUrl = state.optString("artworkDataUrl", "");
            String requestUrl = state.optString("artworkUrl", "");
            updateArtwork(dataUrl, requestUrl);
        } catch (Exception error) {
            Log.w(TAG, "Ignoring malformed playback state", error);
        }

        publish();
        if (playing) {
            acquireWakeLock();
            startForegroundCompat();
        } else {
            releaseWakeLock();
        }
    }

    private void updateArtwork(String dataUrl, String requestUrl) {
        if (dataUrl != null && dataUrl.startsWith("data:")) {
            Bitmap decoded = decodeDataUrl(dataUrl);
            if (decoded != null) {
                artwork = decoded;
                artworkRequestUrl = null;
                return;
            }
        }

        if (requestUrl == null || requestUrl.isEmpty()) {
            // The new track has no cover: keeping the previous one would label this song with the
            // last song's art.
            artwork = null;
            artworkRequestUrl = null;
            return;
        }

        if (requestUrl.equals(artworkRequestUrl)) {
            return;
        }

        artworkRequestUrl = requestUrl;
        artwork = null;
        if (!requestUrl.startsWith("http://") && !requestUrl.startsWith("https://")) {
            return;
        }

        artworkPool.execute(() -> {
            Bitmap downloaded = downloadBitmap(requestUrl);
            if (downloaded != null) {
                artwork = downloaded;
                publish();
            }
        });
    }

    private static Bitmap decodeDataUrl(String dataUrl) {
        try {
            int comma = dataUrl.indexOf(',');
            if (comma < 0) return null;
            byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Exception error) {
            Log.w(TAG, "Could not decode artwork data URL", error);
            return null;
        }
    }

    private static Bitmap downloadBitmap(String address) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(address).openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(10000);
            connection.setInstanceFollowRedirects(true);
            try (InputStream stream = connection.getInputStream()) {
                return BitmapFactory.decodeStream(stream);
            }
        } catch (Exception error) {
            Log.w(TAG, "Could not fetch artwork", error);
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private Notification buildNotification() {
        int playPauseIcon = playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        int playPauseTitle = playing ? R.string.action_pause : R.string.action_play;

        PendingIntent previous = transportIntent("previous", 1);
        PendingIntent toggle = transportIntent("toggle", 2);
        PendingIntent next = transportIntent("next", 3);

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_folia)
                .setContentTitle(title.isEmpty() ? getString(R.string.unknown_track) : title)
                .setContentText(artist)
                .setSubText(album.isEmpty() ? null : album)
                .setContentIntent(contentIntent())
                .setOngoing(playing)
                .setOnlyAlertOnce(true)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous,
                        getString(R.string.action_previous), previous).build())
                .addAction(new Notification.Action.Builder(playPauseIcon,
                        getString(playPauseTitle), toggle).build())
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next,
                        getString(R.string.action_next), next).build())
                .setStyle(new Notification.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2));

        if (durationMs > 0) {
            builder.setProgress(1000, (int) Math.min(1000, Math.max(0, positionMs * 1000 / durationMs)), false);
        }
        if (artwork != null) {
            builder.setLargeIcon(artwork);
        }
        return builder.build();
    }

    private PendingIntent transportIntent(String action, int requestCode) {
        Intent intent = new Intent(this, PlaybackService.class)
                .setAction(ACTION_TRANSPORT)
                .putExtra(EXTRA_TRANSPORT, action);
        return PendingIntent.getService(this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent contentIntent() {
        Intent intent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void publish() {
        if (session == null) return;

        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title.isEmpty() ? getString(R.string.unknown_track) : title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        if (artwork != null) {
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
        }
        session.setMetadata(metadata.build());

        PlaybackState.Builder state = new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT
                        | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_STOP)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        positionMs, playing ? 1f : 0f);
        session.setPlaybackState(state.build());

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification());
        }
    }

    private void startForegroundCompat() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.playback_channel_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.playback_channel_description));
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    // Audio focus belongs to the WebView. Chromium's media stack asks for it when an <audio> element
    // starts, and a second request from the same app - this service asking for AUDIOFOCUS_GAIN while
    // the page holds a transient one - makes the system re-key focus: the page's AudioFocusDelegate
    // is told it lost it and Chromium pauses playback about 70ms in. The service therefore only
    // renders state; it never negotiates focus.
    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) return;
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Folia:playback");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    private void stopPlayback() {
        releaseWakeLock();
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        stopForeground(true);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(NOTIFICATION_ID);
        playing = false;
        active = false;
    }

    @Override
    public void onDestroy() {
        stopPlayback();
        artworkPool.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Playing audio is exactly what the user expects to survive a swipe away from Recents.
        if (!playing) {
            stopSelf();
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /**
     * Sends a state update. Only a playing state starts the service as a foreground service: an
     * update that arrives while the app is in the background must not become a foreground start,
     * and a startForegroundService that never reaches startForeground is a crash five seconds later.
     */
    static void update(Context context, String stateJson) {
        boolean playing = false;
        try {
            playing = new JSONObject(stateJson == null ? "{}" : stateJson).optBoolean("playing", false);
        } catch (Exception ignored) {
            // Unparsable state is treated as "not playing".
        }

        Intent intent = new Intent(context, PlaybackService.class)
                .setAction(ACTION_UPDATE)
                .putExtra(EXTRA_STATE, stateJson);
        try {
            if (playing && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception error) {
            // A background start restriction is not worth a crash: the notification simply misses
            // this update and the next foreground one puts it right.
            Log.w(TAG, "Could not deliver a playback update", error);
        }
    }

    static void clear(Context context) {
        Intent intent = new Intent(context, PlaybackService.class).setAction(ACTION_CLEAR);
        try {
            // Never a foreground start: clearing only stops what may already be running.
            context.startService(intent);
        } catch (Exception error) {
            Log.w(TAG, "Could not clear the playback notification", error);
        }
    }
}
