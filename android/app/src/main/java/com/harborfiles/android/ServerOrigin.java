package com.harborfiles.android;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** A parsed HTTPS origin. No DNS lookup or network access occurs during validation. */
public final class ServerOrigin {
    private final String host;
    private final int port;
    private final String canonical;

    private ServerOrigin(URI uri) {
        host = uri.getHost().toLowerCase(Locale.ROOT);
        port = effectivePort(uri);
        canonical = "https://" + host + (port == 443 ? "" : ":" + port);
    }

    public static ServerOrigin parse(String address) {
        if (address == null) throw new IllegalArgumentException("Enter your Harbor HTTPS address.");
        URI uri = networkUri(address.trim());
        String path = uri.getRawPath();
        if ((path != null && !path.isEmpty() && !path.equals("/"))
                || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("Use just the server address, without a page, query, or fragment.");
        }
        return new ServerOrigin(uri);
    }

    public boolean contains(String address) {
        try {
            URI uri = networkUri(address);
            return host.equalsIgnoreCase(uri.getHost()) && port == effectivePort(uri);
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    static URI networkUri(String address) {
        if (address == null || address.length() > 8192 || address.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("Enter a valid HTTPS address.");
        }
        for (int i = 0; i < address.length(); i++) {
            if (Character.isWhitespace(address.charAt(i)) || Character.isISOControl(address.charAt(i))) {
                throw new IllegalArgumentException("The server address contains invalid characters.");
            }
        }
        final URI uri;
        try { uri = new URI(address); }
        catch (URISyntaxException error) { throw new IllegalArgumentException("Enter a valid HTTPS address."); }
        String authority = uri.getRawAuthority();
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.isOpaque()
                || authority == null || host == null || host.isEmpty()
                || uri.getRawUserInfo() != null || authority.indexOf('%') >= 0
                || authority.endsWith(":") || host.endsWith(".")
                || uri.getPort() == 0 || uri.getPort() > 65535 || uri.getPort() < -1) {
            throw new IllegalArgumentException("Use an HTTPS server address without a username or password.");
        }
        return uri;
    }

    private static int effectivePort(URI uri) { return uri.getPort() == -1 ? 443 : uri.getPort(); }

    @Override public String toString() { return canonical; }
    @Override public boolean equals(Object other) {
        return other instanceof ServerOrigin && canonical.equals(((ServerOrigin) other).canonical);
    }
    @Override public int hashCode() { return canonical.hashCode(); }
}
