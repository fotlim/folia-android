package top.izuna.foliamajor;

import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

// android/app/src/main/java/top/izuna/foliamajor/DirectHttp.java
// The web app runs on https://appassets.androidplatform.net, so calling music.163.com from JS is a
// cross-origin request that the site does not answer. This makes the same request from the native
// side and hands the body back, which is what lets the Android build talk to NetEase without any
// deployed backend. Only that one host is allowed: the bridge is a door, not a general proxy.
//
// POST is here for the encrypted NetEase endpoints (weapi): the page cannot send them itself because
// the signature needs a body and because the answer's Set-Cookie has to be read, which a browser
// hides from scripts.
final class DirectHttp {

    private static final String ALLOWED_HOST = "music.163.com";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Version/4.0 Chrome/120.0 Mobile Safari/537.36";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 20_000;

    private DirectHttp() {
    }

    static JSONObject request(JSONObject params) throws Exception {
        String url = params.optString("url", "");
        String method = params.optString("method", "GET").toUpperCase();
        String body = params.optString("body", "");
        String contentType = params.optString("contentType", "");
        String cookie = params.optString("cookie", "");

        Uri parsed = Uri.parse(url);
        if (!ALLOWED_HOST.equals(parsed.getHost())) {
            throw new SecurityException("Only " + ALLOWED_HOST + " may be fetched directly");
        }
        if (!"https".equals(parsed.getScheme())) {
            throw new SecurityException("Direct requests must use https");
        }

        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", USER_AGENT);
            connection.setRequestProperty("Referer", "https://music.163.com/");
            connection.setRequestProperty("Accept", "application/json, text/plain, */*");
            connection.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
            if (!contentType.isEmpty()) {
                connection.setRequestProperty("Content-Type", contentType);
            }
            if (!cookie.isEmpty()) {
                connection.setRequestProperty("Cookie", cookie);
            }
            JSONObject extra = params.optJSONObject("headers");
            if (extra != null) {
                for (java.util.Iterator<String> keys = extra.keys(); keys.hasNext(); ) {
                    String key = keys.next();
                    connection.setRequestProperty(key, extra.optString(key, ""));
                }
            }

            if (!"GET".equals(method) && !"HEAD".equals(method) && !body.isEmpty()) {
                connection.setDoOutput(true);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }

            int status = connection.getResponseCode();

            // Every Set-Cookie line, so the page can keep the NetEase session on the device.
            JSONArray cookies = new JSONArray();
            for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
                String name = entry.getKey();
                if (name == null || !"set-cookie".equalsIgnoreCase(name)) continue;
                for (String value : entry.getValue()) {
                    cookies.put(value);
                }
            }

            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String responseBody = stream == null ? "" : read(stream);
            return new JSONObject()
                    .put("status", status)
                    .put("body", responseBody)
                    .put("setCookie", cookies);
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
