package top.izuna.foliamajor;

import android.content.Context;
import android.content.res.AssetManager;
import android.webkit.WebResourceResponse;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

// android/app/src/main/java/top/izuna/foliamajor/WebAssetHandler.java
// Serves the packaged web build. The path arrives either with the registered prefix or already
// stripped depending on the WebView version, so both forms resolve to the same APK asset.
final class WebAssetHandler implements WebViewAssetLoader.PathHandler {

    private static final Map<String, String> MIME_TYPES = new HashMap<>();

    static {
        MIME_TYPES.put("html", "text/html");
        MIME_TYPES.put("js", "text/javascript");
        MIME_TYPES.put("mjs", "text/javascript");
        MIME_TYPES.put("css", "text/css");
        MIME_TYPES.put("json", "application/json");
        MIME_TYPES.put("webmanifest", "application/manifest+json");
        MIME_TYPES.put("svg", "image/svg+xml");
        MIME_TYPES.put("png", "image/png");
        MIME_TYPES.put("jpg", "image/jpeg");
        MIME_TYPES.put("jpeg", "image/jpeg");
        MIME_TYPES.put("webp", "image/webp");
        MIME_TYPES.put("gif", "image/gif");
        MIME_TYPES.put("ico", "image/x-icon");
        MIME_TYPES.put("woff", "font/woff");
        MIME_TYPES.put("woff2", "font/woff2");
        MIME_TYPES.put("ttf", "font/ttf");
        MIME_TYPES.put("otf", "font/otf");
        MIME_TYPES.put("wasm", "application/wasm");
        MIME_TYPES.put("txt", "text/plain");
        MIME_TYPES.put("map", "application/json");
        MIME_TYPES.put("webm", "video/webm");
        MIME_TYPES.put("mp4", "video/mp4");
        MIME_TYPES.put("mp3", "audio/mpeg");
    }

    private final AssetManager assets;
    private final Context context;

    WebAssetHandler(Context context) {
        this.context = context.getApplicationContext();
        this.assets = this.context.getAssets();
    }

    static String mimeTypeFor(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0 || dot == path.length() - 1) return "application/octet-stream";
        String extension = path.substring(dot + 1).toLowerCase(Locale.ROOT);
        String mime = MIME_TYPES.get(extension);
        return mime != null ? mime : "application/octet-stream";
    }

    @Override
    public WebResourceResponse handle(String path) {
        String assetPath = path == null ? "" : path;
        while (assetPath.startsWith("/")) {
            assetPath = assetPath.substring(1);
        }
        if (assetPath.startsWith("assets/")) {
            assetPath = assetPath.substring("assets/".length());
        }
        if (assetPath.isEmpty()) {
            assetPath = "public/index.html";
        }

        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache, no-store, must-revalidate");

        // The runtime configuration is generated per request from the device's own settings, so a
        // server address changed in the shell reaches the app on the next reload.
        if ("public/runtime-config.js".equals(assetPath)) {
            byte[] body = ServerSettings.buildRuntimeConfigJs(context).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            return new WebResourceResponse("text/javascript", "utf-8", 200, "OK", headers,
                    new ByteArrayInputStream(body));
        }

        try {
            InputStream stream = assets.open(assetPath);
            return new WebResourceResponse(mimeTypeFor(assetPath), "utf-8", 200, "OK", headers, stream);
        } catch (IOException missing) {
            // Unknown paths are the app's own business: answer a 404 rather than letting the WebView
            // try the network, which would look like a dead app on an offline phone.
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers,
                    new ByteArrayInputStream(new byte[0]));
        }
    }
}
