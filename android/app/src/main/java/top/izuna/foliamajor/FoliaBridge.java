package top.izuna.foliamajor;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// android/app/src/main/java/top/izuna/foliamajor/FoliaBridge.java
// The only door between the web app and Android. Every call is asynchronous: JS hands over a callback
// id, the work runs off the WebView's JS thread, and the answer comes back through
// window.__foliaNativeSettle, so a directory listing never blocks the UI.
public final class FoliaBridge {

    public static final String NAME = "FoliaNative";
    static final int REQUEST_PICK_DIRECTORY = 0x4f11;

    private final MainActivity activity;
    private final WebView webView;
    private final FoliaFileSystem files;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Handler main = new Handler(Looper.getMainLooper());

    private String pendingPickCallbackId;

    FoliaBridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.files = new FoliaFileSystem(activity);
    }

    FoliaFileSystem files() {
        return files;
    }

    private void settle(String callbackId, boolean ok, String payload) {
        String script = "window.__foliaNativeSettle("
                + JSONObject.quote(callbackId) + ","
                + (ok ? "true" : "false") + ","
                + JSONObject.quote(payload == null ? "null" : payload)
                + ");";
        main.post(() -> webView.evaluateJavascript(script, null));
    }

    @JavascriptInterface
    public void invoke(String method, String paramsJson, String callbackId) {
        final JSONObject params;
        try {
            params = new JSONObject(paramsJson == null || paramsJson.isEmpty() ? "{}" : paramsJson);
        } catch (JSONException error) {
            settle(callbackId, false, errorJson(error));
            return;
        }

        if ("saf.pick".equals(method)) {
            main.post(() -> startDirectoryPicker(callbackId));
            return;
        }

        pool.execute(() -> {
            try {
                JSONObject result = dispatch(method, params);
                if (result == null) return;
                settle(callbackId, true, result.toString());
            } catch (Exception error) {
                settle(callbackId, false, errorJson(error));
            }
        });
    }

    private JSONObject dispatch(String method, JSONObject params) throws Exception {
        switch (method) {
            case "device.info":
                return deviceInfo();
            case "saf.list":
                return files.list(params.optString("root"), params.optString("path"));
            case "saf.open":
                return files.open(params.optString("root"), params.optString("path"));
            case "saf.check":
                return new JSONObject().put("granted", files.hasPersistedPermission(Uri.parse(params.optString("root"))));
            case "saf.release":
                files.releaseToken(params.optString("token"));
                return new JSONObject().put("ok", true);
            case "media.update": {
                JSONObject state = params.optJSONObject("state");
                PlaybackService.update(activity, state == null ? "{}" : state.toString());
                main.post(() -> activity.ensureNotificationPermission());
                return new JSONObject().put("ok", true);
            }
            case "media.clear":
                PlaybackService.clear(activity);
                return new JSONObject().put("ok", true);
            case "servers.openSettings":
                main.post(() -> ServerSettings.showDialog(activity));
                return new JSONObject().put("ok", true);
            case "servers.read": {
                JSONObject servers = new JSONObject();
                servers.put("netease", ServerSettings.netease(activity));
                servers.put("neteaseToken", ServerSettings.neteaseToken(activity));
                servers.put("kugou", ServerSettings.kugou(activity));
                servers.put("qq", ServerSettings.qq(activity));
                return servers;
            }
            case "servers.saveToken": {
                // The gateway hands out one device token; it is stored natively so runtime-config.js
                // carries it on the next launch without the page having to remember it.
                ServerSettings.saveNeteaseToken(activity, params.optString("token", ""));
                return new JSONObject().put("ok", true);
            }
            case "servers.save": {
                // Runtime discovery writes back what it found, so the next boot points at the same
                // backend without probing again.
                ServerSettings.save(
                        activity,
                        params.optString("netease", ""),
                        params.optString("kugou", ""),
                        params.optString("qq", ""));
                return new JSONObject().put("ok", true);
            }
            case "device.network":
                return activity.describeNetwork();
            case "notifications.request":
                main.post(() -> activity.ensureNotificationPermission());
                return new JSONObject().put("requested", true);
            case "app.background":
                main.post(() -> activity.moveTaskToBack(true));
                return new JSONObject().put("ok", true);
            default:
                throw new IllegalArgumentException("Unknown native method: " + method);
        }
    }

    private JSONObject deviceInfo() throws JSONException {
        JSONObject info = new JSONObject();
        info.put("sdkInt", Build.VERSION.SDK_INT);
        info.put("model", Build.MODEL == null ? "" : Build.MODEL);
        info.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        String webViewPackage = activity.currentWebViewPackage();
        info.put("webViewPackage", webViewPackage == null ? "" : webViewPackage);
        NotificationManager manager = activity.getSystemService(NotificationManager.class);
        info.put("notificationsEnabled", manager != null && manager.areNotificationsEnabled());
        return info;
    }

    private void startDirectoryPicker(String callbackId) {
        pendingPickCallbackId = callbackId;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        try {
            activity.startActivityForResult(intent, REQUEST_PICK_DIRECTORY);
        } catch (ActivityNotFoundException error) {
            pendingPickCallbackId = null;
            settle(callbackId, false, errorJson(error));
        }
    }

    /** Called from MainActivity once the system picker answers. */
    void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_PICK_DIRECTORY) return;
        String callbackId = pendingPickCallbackId;
        pendingPickCallbackId = null;
        if (callbackId == null) return;

        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            settle(callbackId, true, "{\"canceled\":true}");
            return;
        }

        Uri uri = data.getData();
        try {
            int takeFlags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            activity.getContentResolver().takePersistableUriPermission(
                    uri, takeFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException error) {
            settle(callbackId, false, errorJson(error));
            return;
        }

        String name = FoliaFileSystem.baseNameOf(Uri.decode(uri.getLastPathSegment() == null ? "" : uri.getLastPathSegment()));
        if (name.isEmpty() || name.contains(":")) {
            name = Uri.decode(uri.getLastPathSegment() == null ? "" : uri.getLastPathSegment());
            int colon = name.indexOf(':');
            if (colon >= 0) name = name.substring(colon + 1);
        }
        try {
            settle(callbackId, true, new JSONObject()
                    .put("canceled", false)
                    .put("uri", uri.toString())
                    .put("name", name)
                    .toString());
        } catch (JSONException error) {
            settle(callbackId, false, errorJson(error));
        }
    }

    static String errorJson(Throwable error) {
        try {
            return new JSONObject()
                    .put("message", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage())
                    .put("name", error.getClass().getSimpleName())
                    .toString();
        } catch (JSONException ignored) {
            return "{\"message\":\"native error\"}";
        }
    }

    static JSONArray emptyArray() {
        return new JSONArray();
    }

    static void openNotificationSettings(Activity activity) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
        try {
            activity.startActivity(intent);
        } catch (ActivityNotFoundException ignored) {
            // Older shells without that settings screen simply do nothing.
        }
    }
}
