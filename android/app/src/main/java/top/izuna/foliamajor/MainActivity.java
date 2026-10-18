package top.izuna.foliamajor;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

// android/app/src/main/java/top/izuna/foliamajor/MainActivity.java
// The Android shell: one WebView that loads the built web app from a secure origin served out of the
// APK, plus the bridge that lets that web app reach the Storage Access Framework and the media
// session. Everything the app shows is the same code the desktop and web builds run.
public class MainActivity extends AppCompatActivity implements PlaybackService.TransportListener {

    private static final String TAG = "FoliaShell";
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + APP_HOST + "/assets/public/index.html";
    private static final int REQUEST_NOTIFICATIONS = 0x4f12;
    private static final int MIN_WEBVIEW_MAJOR = 100;

    private WebView webView;
    private FoliaBridge bridge;
    private WebViewAssetLoader assetLoader;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                .setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                .setAppearanceLightNavigationBars(false);

        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(ContextCompat.getColor(this, R.color.folia_background));
        container.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(container);

        WebView.setWebContentsDebuggingEnabled(
                (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        webView = new WebView(this);
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.folia_background));
        container.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // The bars are drawn over the page, so the page keeps its own padding: without this the last
        // row of a list sits under the navigation bar on a gesture device.
        //
        // The keyboard counts as an inset too. `adjustResize` cannot shrink the window while the
        // decor draws edge to edge, so without the IME inset the bottom half of the page - a search
        // field, a dialog's buttons - ends up behind the keyboard on a phone in portrait.
        ViewCompat.setOnApplyWindowInsetsListener(container, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            int bottom = Math.max(bars.bottom, ime.bottom);
            view.setPadding(bars.left, bars.top, bars.right, bottom);
            return windowInsets;
        });

        configureWebView();

        bridge = new FoliaBridge(this, webView);
        webView.addJavascriptInterface(bridge, FoliaBridge.NAME);
        PlaybackService.setTransportListener(this);

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_HOST)
                .addPathHandler("/assets/", new WebAssetHandler(this))
                .addPathHandler("/saf/", new SafStreamHandler(this, bridge.files()))
                .build();

        // 本地资源只在安装时变，WebView 的缓存却可能继续用旧包；每次启动清一次。

        webView.clearCache(true);

        // 每次启动换一个 URL 参数：WebView 会把 index.html 也缓存住，旧 HTML 指向旧的哈希文件，于是装了新 APK 却还在跑旧包。
        webView.loadUrl(START_URL + "?launch=" + System.currentTimeMillis());
        warnIfWebViewIsTooOld();
    }

    /**
     * Local addresses and the default gateway, for the page's backend discovery. A self-hosted
     * Netease/KuGou/QQ API usually runs on the same machine as the browser that deployed it - that is,
     * the gateway or a neighbour on the same /24 - and this is the only place that can see them.
     */
    JSONObject describeNetwork() {
        JSONObject result = new JSONObject();
        JSONArray addresses = new JSONArray();
        java.util.LinkedHashSet<String> guesses = new java.util.LinkedHashSet<>();
        try {
            for (java.net.NetworkInterface networkInterface : java.util.Collections.list(
                    java.net.NetworkInterface.getNetworkInterfaces())) {
                if (!networkInterface.isUp() || networkInterface.isLoopback()) continue;
                for (java.net.InetAddress address : java.util.Collections.list(
                        networkInterface.getInetAddresses())) {
                    if (!(address instanceof java.net.Inet4Address) || address.isLoopbackAddress()) continue;
                    String host = address.getHostAddress();
                    if (host == null) continue;
                    addresses.put(host);
                    int lastDot = host.lastIndexOf('.');
                    if (lastDot > 0) guesses.add(host.substring(0, lastDot) + ".1");
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "Could not enumerate network interfaces", error);
        }

        String gateway = defaultGateway();
        if (!gateway.isEmpty()) guesses.add(gateway);

        JSONArray candidates = new JSONArray();
        for (String guess : guesses) candidates.put(guess);
        try {
            result.put("addresses", addresses);
            result.put("gateway", gateway);
            result.put("candidates", candidates);
        } catch (org.json.JSONException error) {
            Log.w(TAG, "Could not describe the network", error);
        }
        return result;
    }

    private String defaultGateway() {
        try {
            android.net.ConnectivityManager manager = getSystemService(android.net.ConnectivityManager.class);
            if (manager == null) return "";
            android.net.LinkProperties properties = manager.getLinkProperties(manager.getActiveNetwork());
            if (properties == null) return "";
            for (android.net.RouteInfo route : properties.getRoutes()) {
                if (!route.isDefaultRoute()) continue;
                java.net.InetAddress address = route.getGateway();
                if (address instanceof java.net.Inet4Address) return address.getHostAddress();
            }
        } catch (Exception error) {
            Log.w(TAG, "Could not read the default gateway", error);
        }
        return "";
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadsImagesAutomatically(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setTextZoom(100);
        settings.setUserAgentString(settings.getUserAgentString() + " FoliaAndroid/" + Build.VERSION.SDK_INT);
        // A self-hosted API on the LAN is plain http; allowing mixed content is the difference
        // between "my server works" and a silently blocked fetch.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = assetLoader.shouldInterceptRequest(request.getUrl());
                return response != null ? response : super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                String host = url.getHost();
                if (url.getScheme() != null && url.getScheme().startsWith("http") && APP_HOST.equals(host)) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception error) {
                    Toast.makeText(MainActivity.this, url.toString(), Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.d(TAG, message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }
        });
    }

    private void warnIfWebViewIsTooOld() {
        PackageInfo info = WebViewCompat.getCurrentWebViewPackage(this);
        if (info == null) return;
        int major = 0;
        try {
            major = Integer.parseInt(info.versionName.split("\\.")[0]);
        } catch (RuntimeException ignored) {
            return;
        }
        if (major >= MIN_WEBVIEW_MAJOR) return;

        new AlertDialog.Builder(this)
                .setTitle(R.string.webview_outdated_title)
                .setMessage(R.string.webview_outdated_message)
                .setPositiveButton(R.string.webview_outdated_update, (dialog, which) -> {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW,
                                Uri.parse("market://details?id=com.google.android.webview")));
                    } catch (Exception ignored) {
                        // No market app: nothing else to offer.
                    }
                })
                .setNegativeButton(R.string.webview_outdated_close, null)
                .show();
    }

    @Override
    public void onTransport(String action) {
        if ("toggle".equals(action)) {
            // The service cannot know which of the two icons the user pressed without reading the
            // web app's state, so the press is forwarded as-is and the web app decides.
            evaluateJs("window.__foliaNativeTransport && window.__foliaNativeTransport('toggle')");
            return;
        }
        evaluateJs("window.__foliaNativeTransport && window.__foliaNativeTransport("
                + quoteJs(action) + ")");
    }

    private static String quoteJs(String value) {
        if (value == null) return "null";
        StringBuilder builder = new StringBuilder("'");
        for (char c : value.toCharArray()) {
            if (c == '\\' || c == '\'') builder.append('\\');
            builder.append(c);
        }
        return builder.append('\'').toString();
    }

    private void evaluateJs(String script) {
        runOnUiThread(() -> webView.evaluateJavascript(script, null));
    }

    @Override
    public void onBackPressed() {
        webView.evaluateJavascript(
                "window.__foliaNativeBackPressed ? window.__foliaNativeBackPressed() : false",
                handled -> {
                    if (!"true".equals(handled)) {
                        moveTaskToBack(true);
                    }
                });
    }

    /** Reloads the web app after a setting that only applies at boot (the server endpoints). */
    void reloadWebApp() {
        runOnUiThread(() -> {
            PlaybackService.clear(this);
            webView.reload();
        });
    }

    void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        // Asked once, on the first playback. A denied prompt is not shown again on every track:
        // the user already answered, and the system settings page is where to change it.
        if (ServerSettings.wasNotificationPermissionAsked(this)) return;
        ServerSettings.markNotificationPermissionAsked(this);
        ActivityCompat.requestPermissions(this,
                new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
    }

    String currentWebViewPackage() {
        PackageInfo info = WebViewCompat.getCurrentWebViewPackage(this);
        if (info == null) return "";
        return info.packageName + " " + info.versionName;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FoliaBridge.REQUEST_PICK_DIRECTORY) {
            bridge.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_NOTIFICATIONS) {
            Log.d(TAG, "Notification permission result: "
                    + (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED));
        }
    }

    /**
     * A player that stops when the screen turns off is not a player, but the Activity still has to
     * report the pause: skipping `super.onPause()` throws `SuperNotCalledException` and takes the
     * process down the moment playback starts.
     *
     * What actually keeps the page running in the background is that nothing here calls
     * `WebView.onPause()`. The foreground service keeps the process alive, and the WebView keeps
     * decoding and running timers while the Activity is paused.
     */
    @Override
    protected void onPause() {
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        PlaybackService.setTransportListener(null);
        if (webView != null) {
            webView.removeJavascriptInterface(FoliaBridge.NAME);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
