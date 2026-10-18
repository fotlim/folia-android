package top.izuna.foliamajor;

import android.content.Context;
import android.net.Uri;
import android.webkit.MimeTypeMap;

import androidx.documentfile.provider.DocumentFile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

// android/app/src/main/java/top/izuna/foliamajor/FoliaFileSystem.java
// Turns the Storage Access Framework into the two operations the web app needs: walk a picked
// directory, and stream one document out of it. The tree URI the picker returns is kept on every
// handle, so a handle saved today can still be resolved after the process restarts as long as the
// persisted read permission is intact.
final class FoliaFileSystem {

    private static final long DIRECTORY_CACHE_TTL_MS = 60_000L;

    private final Context context;
    /** Opaque token -> document URI, for documents the web app is allowed to stream right now. */
    private final Map<String, StreamTarget> streamTokens = new ConcurrentHashMap<>();
    /** rootUri + "|" + relative path -> listing, so one scan does not re-query every directory. */
    private final Map<String, CachedListing> listings = new HashMap<>();

    FoliaFileSystem(Context context) {
        this.context = context.getApplicationContext();
    }

    private static final class CachedListing {
        final DocumentFile[] children;
        final long at;

        CachedListing(DocumentFile[] children) {
            this.children = children;
            this.at = System.currentTimeMillis();
        }

        boolean isFresh() {
            return System.currentTimeMillis() - at < DIRECTORY_CACHE_TTL_MS;
        }
    }

    /** One document a token points at, with what the stream route needs to describe it. */
    static final class StreamTarget {
        final Uri uri;
        final String mime;
        final long size;

        StreamTarget(Uri uri, String mime, long size) {
            this.uri = uri;
            this.mime = mime;
            this.size = size;
        }
    }

    String attach(Uri uri, String mime, long size) {
        String token = UUID.randomUUID().toString();
        streamTokens.put(token, new StreamTarget(uri, mime, size));
        return token;
    }

    Uri resolveToken(String token) {
        return token == null ? null : streamTokens.get(token).uri;
    }

    StreamTarget resolveTarget(String token) {
        return token == null ? null : streamTokens.get(token);
    }

    /** Drops a stream token once the WebView has opened the stream it named. */
    void releaseToken(String token) {
        if (token != null) streamTokens.remove(token);
    }

    boolean hasPersistedPermission(Uri uri) {
        if (uri == null) return false;
        String target = normalizeUri(uri);
        try {
            for (android.content.UriPermission permission : context.getContentResolver().getPersistedUriPermissions()) {
                if (!permission.isReadPermission()) continue;
                String granted = normalizeUri(permission.getUri());
                if (granted.equals(target)) return true;
                // A document inside the picked tree is covered by the tree's own grant.
                if (target.startsWith(granted + "/") || target.startsWith(granted + "%2F")) return true;
            }
        } catch (RuntimeException error) {
            // No accessibility to the provider list: fall through to "not granted".
        }
        return false;
    }

    /**
     * Persisted permissions come back with a trailing slash on some ROMs and percent-encoded on
     * others, and a strict `equals` used to report "permission lost" for a folder that was in fact
     * still granted - which surfaced as "cannot play local file" on the second launch.
     */
    private static String normalizeUri(Uri uri) {
        String value = Uri.decode(uri.toString());
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    /** NFC first: a file written on one system can come back decomposed on another. */
    private static String normalizeName(String name) {
        return java.text.Normalizer.normalize(name, java.text.Normalizer.Form.NFC);
    }

    static String mimeTypeOf(String name) {
        if (name == null) return "application/octet-stream";
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "application/octet-stream";
        String extension = name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        if (mime != null) return mime;
        switch (extension) {
            case "flac": return "audio/flac";
            case "m4a": return "audio/mp4";
            case "opus": return "audio/ogg";
            case "lrc":
            case "krc":
            case "yrc":
            case "qrc":
            case "ttml":
            case "vtt": return "text/plain";
            default: return "application/octet-stream";
        }
    }

    private DocumentFile rootOf(String rootUri) {
        if (rootUri == null || rootUri.isEmpty()) return null;
        try {
            return DocumentFile.fromTreeUri(context, Uri.parse(rootUri));
        } catch (RuntimeException error) {
            return null;
        }
    }

    private DocumentFile directoryOf(String rootUri, String relativePath) {
        DocumentFile current = rootOf(rootUri);
        if (current == null) return null;
        if (relativePath == null || relativePath.isEmpty()) return current;
        for (String segment : relativePath.split("/")) {
            if (segment.isEmpty()) continue;
            DocumentFile next = findChild(current, segment);
            if (next == null || !next.isDirectory()) return null;
            current = next;
        }
        return current;
    }

    private DocumentFile findChild(DocumentFile directory, String name) {
        DocumentFile[] children = childrenOf(directory);
        String wanted = normalizeName(name);
        DocumentFile match = null;
        for (DocumentFile child : children) {
            String childName = child.getName();
            if (childName == null) continue;
            if (name.equals(childName)) {
                match = child;
                break;
            }
            if (match == null && wanted.equals(normalizeName(childName))) {
                match = child;
            }
        }
        if (match == null) {
            // Last resort: some providers case-fold names differently than the picker reported them.
            for (DocumentFile child : children) {
                String childName = child.getName();
                if (childName != null && name.equalsIgnoreCase(childName)) {
                    match = child;
                    break;
                }
            }
        }
        return match;
    }

    private DocumentFile[] childrenOf(DocumentFile directory) {
        String key = directory.getUri().toString();
        CachedListing cached = listings.get(key);
        if (cached != null && cached.isFresh()) return cached.children;
        DocumentFile[] children;
        try {
            children = directory.listFiles();
        } catch (RuntimeException error) {
            children = new DocumentFile[0];
        }
        listings.put(key, new CachedListing(children));
        return children;
    }

    /** Lists one directory of a picked tree. Entries are sorted so a rescan sees a stable order. */
    JSONObject list(String rootUri, String relativePath) throws JSONException {
        JSONObject result = new JSONObject();
        DocumentFile directory = directoryOf(rootUri, relativePath);
        if (directory == null) {
            result.put("ok", false);
            result.put("reason", "missing");
            return result;
        }

        DocumentFile[] children = childrenOf(directory);
        java.util.Arrays.sort(children, (left, right) -> {
            String a = left.getName() == null ? "" : left.getName();
            String b = right.getName() == null ? "" : right.getName();
            return a.compareTo(b);
        });

        JSONArray entries = new JSONArray();
        for (DocumentFile child : children) {
            String name = child.getName();
            if (name == null) continue;
            JSONObject entry = new JSONObject();
            entry.put("name", name);
            entry.put("dir", child.isDirectory());
            entry.put("size", child.isDirectory() ? 0L : child.length());
            entry.put("modified", child.lastModified());
            entries.put(entry);
        }

        result.put("ok", true);
        result.put("name", directory.getName() == null ? "" : directory.getName());
        result.put("entries", entries);
        return result;
    }

    /** Resolves one file of a picked tree and registers a stream token for it. */
    JSONObject open(String rootUri, String relativePath) throws JSONException {
        JSONObject result = new JSONObject();
        DocumentFile directory = directoryOf(rootUri, parentOf(relativePath));
        String fileName = baseNameOf(relativePath);
        DocumentFile file = directory == null || fileName.isEmpty() ? null : findChild(directory, fileName);
        // `isFile()` is not the test to use here: it goes through the provider's document flags and
        // reports false for files whose MIME type the provider cannot determine, which made valid
        // audio look missing. Anything that is not a directory is a file we can try to stream.
        if (file == null || file.isDirectory()) {
            result.put("ok", false);
            result.put("reason", directory == null ? "directory-missing" : "missing");
            return result;
        }

        String displayName = file.getName() == null ? fileName : file.getName();
        String mime = mimeTypeOf(displayName);
        long size = file.length();
        result.put("ok", true);
        result.put("name", displayName);
        result.put("size", size);
        result.put("modified", file.lastModified());
        result.put("mime", mime);
        result.put("token", attach(file.getUri(), mime, size));
        return result;
    }

    static String parentOf(String relativePath) {
        if (relativePath == null) return "";
        int slash = relativePath.lastIndexOf('/');
        return slash < 0 ? "" : relativePath.substring(0, slash);
    }

    static String baseNameOf(String relativePath) {
        if (relativePath == null) return "";
        int slash = relativePath.lastIndexOf('/');
        return slash < 0 ? relativePath : relativePath.substring(slash + 1);
    }
}
