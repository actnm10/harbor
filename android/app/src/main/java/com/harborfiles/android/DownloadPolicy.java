package com.harborfiles.android;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/** Boundaries for native authenticated downloads; filenames are display names, never paths. */
public final class DownloadPolicy {
    private static final Pattern CONTENT_PATH = Pattern.compile(
            "/api/files/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/content");

    private DownloadPolicy() {}

    public static URL validate(ServerOrigin origin, String address) {
        if (origin == null || !origin.contains(address)) {
            throw new IllegalArgumentException("Downloads must come from the connected Harbor server.");
        }
        URI uri = ServerOrigin.networkUri(address);
        if (!CONTENT_PATH.matcher(uri.getRawPath()).matches()
                || !"download=1".equals(uri.getRawQuery()) || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("This is not a Harbor file download link.");
        }
        try { return uri.toURL(); }
        catch (Exception error) { throw new IllegalArgumentException("This download address is invalid."); }
    }

    public static String safeFilename(String contentDisposition, String fallback) {
        String plain = null;
        String extended = null;
        if (contentDisposition != null && contentDisposition.length() <= 8192) {
            for (String part : splitParameters(contentDisposition)) {
                int equals = part.indexOf('=');
                if (equals < 0) continue;
                String key = part.substring(0, equals).trim();
                String value = unquote(part.substring(equals + 1).trim());
                if (value == null) continue;
                if (key.equalsIgnoreCase("filename") && plain == null) plain = value;
                if (key.equalsIgnoreCase("filename*") && extended == null) extended = decodeExtended(value);
            }
        }
        String result = sanitize(extended != null ? extended : plain);
        if (result.isEmpty()) result = sanitize(fallback);
        return result.isEmpty() ? "download" : result;
    }

    private static List<String> splitParameters(String value) {
        List<String> parts = new ArrayList<>();
        boolean quoted = false, escaped = false;
        int start = 0;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (escaped) { escaped = false; continue; }
            if (quoted && c == '\\') { escaped = true; continue; }
            if (c == '"') quoted = !quoted;
            if (c == ';' && !quoted) { parts.add(value.substring(start, i)); start = i + 1; }
        }
        parts.add(value.substring(start));
        return parts;
    }

    private static String unquote(String value) {
        if (!value.startsWith("\"")) return value;
        if (value.length() < 2 || !value.endsWith("\"")) return null;
        StringBuilder result = new StringBuilder();
        for (int i = 1; i < value.length() - 1; i++) {
            char c = value.charAt(i);
            if (c == '\\') {
                if (++i >= value.length() - 1) return null;
                c = value.charAt(i);
            } else if (c == '"') return null;
            result.append(c);
        }
        return result.toString();
    }

    private static String decodeExtended(String value) {
        int first = value.indexOf('\'');
        int second = first < 0 ? -1 : value.indexOf('\'', first + 1);
        if (first < 0 || second < 0 || !value.substring(0, first).equalsIgnoreCase("UTF-8")) return null;
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int i = second + 1; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '%') {
                if (i + 2 >= value.length()) return null;
                int high = Character.digit(value.charAt(++i), 16);
                int low = Character.digit(value.charAt(++i), 16);
                if (high < 0 || low < 0) return null;
                bytes.write(high * 16 + low);
            } else {
                if (c > 127) return null;
                bytes.write(c);
            }
        }
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
        } catch (CharacterCodingException ignored) { return null; }
    }

    private static String sanitize(String name) {
        if (name == null) return "";
        StringBuilder result = new StringBuilder();
        int bytes = 0;
        // A conservative byte limit also works with providers backed by common local filesystems.
        for (int i = 0; i < name.length() && bytes < 180; ) {
            int cp = name.codePointAt(i);
            i += Character.charCount(cp);
            int type = Character.getType(cp);
            if (cp == '/' || cp == '\\' || type == Character.CONTROL || type == Character.FORMAT
                    || type == Character.SURROGATE || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR) cp = '_';
            int width = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
            if (bytes + width > 180) break;
            result.appendCodePoint(cp);
            bytes += width;
        }
        String safe = result.toString().trim();
        while (safe.startsWith(".")) safe = safe.substring(1);
        while (safe.endsWith(".") || safe.endsWith(" ")) safe = safe.substring(0, safe.length() - 1);
        return safe.trim();
    }
}
