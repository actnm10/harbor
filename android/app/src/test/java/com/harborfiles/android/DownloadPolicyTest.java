package com.harborfiles.android;

import java.nio.charset.StandardCharsets;
import org.junit.Test;
import static org.junit.Assert.*;

public class DownloadPolicyTest {
    private static final ServerOrigin ORIGIN = ServerOrigin.parse("https://harbor.example");
    private static final String PATH = "/api/files/12345678-1234-4abc-8abc-1234567890ab/content";

    @Test public void acceptsOnlyExplicitFileDownloads() {
        String address = ORIGIN + PATH + "?download=1";
        assertEquals(address, DownloadPolicy.validate(ORIGIN, address).toString());
        for (String suffix : new String[]{"", "?", "?download=0", "?download=1&", "?download=1&download=1",
                "?download=1&next=https://evil.example", "?%64ownload=1", "?download=%31", "?download=1#x"}) {
            assertThrows(suffix, IllegalArgumentException.class, () -> DownloadPolicy.validate(ORIGIN, ORIGIN + PATH + suffix));
        }
    }

    @Test public void rejectsEncodedPathsTraversalAndOriginConfusion() {
        for (String address : new String[]{"https://evil.example" + PATH, "http://harbor.example" + PATH,
                "https://harbor.example:8443" + PATH, "https://user@harbor.example" + PATH,
                ORIGIN + PATH + "/", ORIGIN + "/x/.." + PATH, ORIGIN + PATH.replace("/api/", "/%61pi/"),
                ORIGIN + PATH.replace("/files/", "/files%2f"), ORIGIN + PATH.replace("/content", "/preview.pdf"),
                ORIGIN + PATH.replace("12345678", "not-an-id"), ORIGIN + "/api/login"}) {
            assertThrows(address, IllegalArgumentException.class, () -> DownloadPolicy.validate(ORIGIN, address + "?download=1"));
        }
    }

    @Test public void acceptsOnlyBoundedCanonicalArchiveSelections() {
        String first = "12345678-1234-4abc-8abc-1234567890ab";
        String second = "22345678-1234-4ABC-8ABC-1234567890AB";
        String address = ORIGIN + "/api/archive?ids=" + first + "," + second + "&download=1";
        assertEquals(address, DownloadPolicy.validate(ORIGIN, address).toString());
        StringBuilder hundred = new StringBuilder();
        for (int i = 0; i < 100; i++) {
            if (i > 0) hundred.append(',');
            hundred.append(String.format(java.util.Locale.ROOT, "%08x-1234-4abc-8abc-1234567890ab", i));
        }
        String limit = ORIGIN + "/api/archive?ids=" + hundred + "&download=1";
        assertEquals(limit, DownloadPolicy.validate(ORIGIN, limit).toString());
        assertThrows(IllegalArgumentException.class, () -> DownloadPolicy.validate(ORIGIN,
                ORIGIN + "/api/archive?ids=" + hundred + "," + first + "&download=1"));
        for (String query : new String[]{"", "ids=", "ids=" + first, "download=1&ids=" + first,
                "ids=" + first + "&download=0", "ids=" + first + "&download=%31",
                "ids=" + first + ",&download=1", "ids=" + first + "%2C" + second + "&download=1",
                "ids=" + first + "," + first.toUpperCase(java.util.Locale.ROOT) + "&download=1",
                "ids=../escape&download=1", "ids=" + first + "&download=1&next=https://evil.example",
                "ids=" + first + "&download=1&ids=" + second, "ids=" + first + "&download=1#fragment"}) {
            assertThrows(query, IllegalArgumentException.class,
                    () -> DownloadPolicy.validate(ORIGIN, ORIGIN + "/api/archive?" + query));
        }
        for (String path : new String[]{"/api/archive/", "/api/%61rchive", "/x/../api/archive"}) {
            assertThrows(path, IllegalArgumentException.class,
                    () -> DownloadPolicy.validate(ORIGIN, ORIGIN + path + "?ids=" + first + "&download=1"));
        }
        assertThrows(IllegalArgumentException.class, () -> DownloadPolicy.validate(ORIGIN,
                "https://evil.example/api/archive?ids=" + first + "&download=1"));
    }

    @Test public void unicodeExtendedFilenameTakesPrecedenceWithoutFormDecoding() {
        assertEquals("京都 + 100%.txt", DownloadPolicy.safeFilename(
                "attachment; filename=ascii.txt; filename*=UTF-8''%E4%BA%AC%E9%83%BD%20+%20100%25.txt", "fallback"));
        assertEquals("a; \"quote\".txt", DownloadPolicy.safeFilename("attachment; filename=\"a; \\\"quote\\\".txt\"", "fallback"));
        assertEquals("plain.txt", DownloadPolicy.safeFilename("attachment; filename=plain.txt; filename*=UTF-8''%ff", "fallback"));
        assertEquals("plain.txt", DownloadPolicy.safeFilename("attachment; filename=plain.txt; filename*=UTF-8''%xx", "fallback"));
    }

    @Test public void filenamesCannotBecomePathsOrHideControlCharacters() {
        String name = DownloadPolicy.safeFilename("attachment; filename*=UTF-8''..%2F..%5Csecret%00%0A%E2%80%AE.txt", null);
        assertFalse(name.contains("/"));
        assertFalse(name.contains("\\"));
        assertFalse(name.contains("\u202e"));
        assertFalse(name.contains("\n"));
        assertFalse(name.startsWith("."));
        assertEquals("download", DownloadPolicy.safeFilename(null, "..."));
        assertEquals("fallback.txt", DownloadPolicy.safeFilename("attachment; filename=\"unterminated", "fallback.txt"));
        assertEquals("download", DownloadPolicy.safeFilename(null, null));
        String bounded = DownloadPolicy.safeFilename(null, "📁".repeat(1000));
        assertTrue(bounded.getBytes(StandardCharsets.UTF_8).length <= 180);
        assertFalse(bounded.isEmpty());
        assertFalse(Character.isHighSurrogate(bounded.charAt(bounded.length() - 1)));
    }
}
