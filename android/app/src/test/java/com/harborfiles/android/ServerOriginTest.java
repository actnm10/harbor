package com.harborfiles.android;

import org.junit.Test;
import static org.junit.Assert.*;

public class ServerOriginTest {
    @Test public void canonicalizesHttpsOriginAndDefaultPort() {
        assertEquals("https://harbor.example", ServerOrigin.parse(" HTTPS://Harbor.Example:443/ ").toString());
        assertEquals("https://harbor.example:8443", ServerOrigin.parse("https://Harbor.Example:8443").toString());
        assertEquals("https://[::1]:8443", ServerOrigin.parse("https://[::1]:8443/").toString());
        assertEquals(ServerOrigin.parse("https://harbor.example"), ServerOrigin.parse("https://harbor.example:443/"));
    }

    @Test public void rejectsAddressComponentsAndAmbiguousAuthority() {
        for (String value : new String[]{"http://harbor.example", "//harbor.example", "https://user@harbor.example",
                "https://user:secret@harbor.example", "https://harbor.example/app", "https://harbor.example//",
                "https://harbor.example?", "https://harbor.example#", "https://harbor.example:0",
                "https://harbor.example:65536", "https://harbor.example:", "https://harbor.example.",
                "https://harbor.example\\@evil.example", "https://harbor%2eexample", "https://harbor.example\n.evil",
                "https:///harbor.example", "https://[fe80::1%25eth0]", "javascript:https://harbor.example"}) {
            assertThrows(value, IllegalArgumentException.class, () -> ServerOrigin.parse(value));
        }
        assertThrows(IllegalArgumentException.class, () -> ServerOrigin.parse(null));
    }

    @Test public void navigationRequiresCompleteSchemeHostAndEffectivePort() {
        ServerOrigin origin = ServerOrigin.parse("https://harbor.example");
        assertTrue(origin.contains("https://HARBOR.example:443/api/files?q=hello#view"));
        assertTrue(origin.contains("https://harbor.example/"));
        for (String value : new String[]{"https://harbor.example.evil/", "https://evilharbor.example/",
                "https://harbor.example@evil.example/", "https://evil@harbor.example/", "http://harbor.example/",
                "https://harbor.example:444/", "file://harbor.example/", "content://harbor.example/",
                "https://harbor.example\\evil", "https://harbor.example./", "https://harbor.example:/", null}) {
            assertFalse(String.valueOf(value), origin.contains(value));
        }
    }
}
