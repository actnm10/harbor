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
