package top.izuna.foliamajor;

import android.net.Uri;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

// android/app/src/main/java/top/izuna/foliamajor/DirectHttp.java
// The web app runs on https://appassets.androidplatform.net, so calling music.163.com from JS is a
// cross-origin request that the site does not answer. This makes the same GET from the native side
// and hands the body back, which is what lets the Android build search and read lyrics without any
// deployed backend. Only that one host is allowed: the bridge is a door, not a general proxy.
final class DirectHttp {

    private static final String ALLOWED_HOST = "music.163.com";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Version/4.0 Chrome/120.0 Mobile Safari/537.36";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 20_000;

    private DirectHttp() {
    }

    static JSONObject get(String url, String cookie) throws Exception {
        Uri parsed = Uri.parse(url == null ? "" : url);
        if (!ALLOWED_HOST.equals(parsed.getHost())) {
            throw new SecurityException("Only " + ALLOWED_HOST + " may be fetched directly");
        }
        if (!"https".equals(parsed.getScheme())) {
            throw new SecurityException("Direct requests must use https");
        }

        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", USER_AGENT);
            connection.setRequestProperty("Referer", "https://music.163.com/");
            connection.setRequestProperty("Accept", "application/json, text/plain, */*");
            connection.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
            if (cookie != null && !cookie.trim().isEmpty()) {
                connection.setRequestProperty("Cookie", cookie.trim());
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = stream == null ? "" : read(stream);
            return new JSONObject().put("status", status).put("body", body);
        } finally {
            connection.disconnect();
        }
    }

    private static String read(InputStream stream) throws Exception {
        try (InputStream input = stream; ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[8192];
            int read;
            while ((read = input.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            return buffer.toString(StandardCharsets.UTF_8.name());
        }
    }
}
