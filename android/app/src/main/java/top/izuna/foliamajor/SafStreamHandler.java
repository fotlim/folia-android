package top.izuna.foliamajor;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

// android/app/src/main/java/top/izuna/foliamajor/SafStreamHandler.java
// Streams one document out of a picked SAF tree as an ordinary HTTP response, so the web app can turn
// it into a File/Blob with fetch() instead of pushing base64 through the JavaScript bridge. Only
// tokens the bridge just handed out are readable, and a token names exactly one document.
final class SafStreamHandler implements WebViewAssetLoader.PathHandler {

    private final FoliaFileSystem files;
    private final Context context;

    SafStreamHandler(Context context, FoliaFileSystem files) {
        this.context = context.getApplicationContext();
        this.files = files;
    }

    @Override
    public WebResourceResponse handle(String path) {
        String token = path == null ? "" : path;
        while (token.startsWith("/")) {
            token = token.substring(1);
        }
        if (token.startsWith("saf/")) {
            token = token.substring("saf/".length());
        }

        FoliaFileSystem.StreamTarget target = files.resolveTarget(token);
        if (target == null) {
            return empty(404, "Not Found", "text/plain");
        }

        try {
            InputStream stream = context.getContentResolver().openInputStream(target.uri);
            if (stream == null) {
                return empty(404, "Not Found", "text/plain");
            }
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("Access-Control-Allow-Origin", "*");
            if (target.size > 0) {
                // A known length lets Chromium size its blob and report progress instead of waiting
                // for EOF on a stream that some providers close lazily.
                headers.put("Content-Length", Long.toString(target.size));
            }
            return new WebResourceResponse(target.mime, null, 200, "OK", headers, stream);
        } catch (java.io.FileNotFoundException missing) {
            return empty(404, "Not Found", "text/plain");
        } catch (IOException | SecurityException error) {
            // A lost persisted grant lands here; 403 lets the page say "permission" rather than
            // "file missing", which are different fixes for the user.
            return empty(403, "Forbidden", "text/plain");
        }
    }

    private static WebResourceResponse empty(int status, String reason, String mime) {
        return new WebResourceResponse(mime, "utf-8", status, reason, new HashMap<>(),
                new ByteArrayInputStream(new byte[0]));
    }
}
