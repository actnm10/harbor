package com.harborfiles.android;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;

/** HTTPS fixture entirely inside the emulator. No production server or credentials. */
final class LoopbackHttpsFixture implements AutoCloseable {
    static final String COOKIE = "harbor_fixture=instrumentation-session";
    static final String CSRF = "instrumentation-csrf-token";
    static final String DOWNLOAD_PATH = "/api/files/00000000-0000-4000-8000-000000000001/content?download=1";
    static final byte[] FILE_BYTES = new byte[] {0, 1, 2, 10, 13, 42, 100, (byte) 200, (byte) 255};
    final List<Request> requests = new CopyOnWriteArrayList<>();
    final AtomicInteger acceptedWrites = new AtomicInteger();
    final AtomicInteger rejectedWrites = new AtomicInteger();
    private final Context testContext;
    private final SSLServerSocket socket;
    private final ExecutorService workers = Executors.newCachedThreadPool(task -> {
        Thread thread = new Thread(task, "harbor-loopback-fixture"); thread.setDaemon(true); return thread;
    });

    LoopbackHttpsFixture(Context testContext) throws Exception {
        this.testContext = testContext;
        byte[] keyBytes;
        try (InputStream input = testContext.getAssets().open("localhost-key.pk8")) { keyBytes = readAll(input, 16384); }
        PrivateKey key = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(keyBytes));
        Collection<? extends Certificate> chain;
        try (InputStream input = testContext.getAssets().open("localhost-chain.pem")) {
            chain = CertificateFactory.getInstance("X.509").generateCertificates(input);
        }
        char[] password = "public-test-fixture".toCharArray();
        KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType()); store.load(null, password);
        store.setKeyEntry("loopback", key, password, chain.toArray(new Certificate[0]));
        KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        managers.init(store, password);
        SSLContext context = SSLContext.getInstance("TLS"); context.init(managers.getKeyManagers(), null, null);
        socket = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(0, 20, InetAddress.getByName("127.0.0.1"));
        workers.execute(() -> {
            while (!socket.isClosed()) {
                try { Socket client = socket.accept(); workers.execute(() -> serve(client)); }
                catch (IOException error) { if (!socket.isClosed()) throw new RuntimeException(error); }
            }
        });
    }

    String origin() { return "https://127.0.0.1:" + socket.getLocalPort(); }
    String mismatchedOrigin() { return "https://localhost:" + socket.getLocalPort(); }

    private void serve(Socket client) {
        try (Socket ignored = client) {
            client.setSoTimeout(10000);
            InputStream input = client.getInputStream();
            String first = line(input); if (first == null || first.isEmpty()) return;
            String[] fields = first.split(" ", 3); if (fields.length != 3) return;
            Map<String, String> headers = new LinkedHashMap<>();
            int headerBytes = first.length();
            for (String line; (line = line(input)) != null && !line.isEmpty();) {
                headerBytes += line.length(); if (headerBytes > 65536) throw new IOException("Fixture headers too large");
                int colon = line.indexOf(':');
                if (colon > 0) headers.put(line.substring(0, colon).toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
            }
            int length = Integer.parseInt(headers.getOrDefault("content-length", "0"));
            if (length < 0 || length > 1024 * 1024) throw new IOException("Fixture body too large");
            byte[] body = new byte[length]; int read = 0;
            while (read < length) { int count = input.read(body, read, length - read); if (count < 0) throw new IOException("Short fixture body"); read += count; }
            Request request = new Request(fields[0], fields[1], headers, body); requests.add(request);
            reply(client.getOutputStream(), request);
        } catch (IOException ignored) {
            // A canceled navigation or intentionally rejected TLS certificate closes
            // the socket before HTTP. Tests assert resulting UI and accepted requests.
        }
    }

    private void reply(OutputStream output, Request request) throws IOException {
        if ((request.path.startsWith("/vendor/pdfjs/") || request.path.equals("/fixture-pdf-engine.js"))
                && !request.path.contains("..") && request.path.matches("/[A-Za-z0-9_./-]+")) {
            try (InputStream input = testContext.getAssets().open(request.path.substring(1))) {
                String mime = request.path.endsWith(".mjs") || request.path.endsWith(".js") ? "text/javascript" : "application/octet-stream";
                send(output, 200, mime, Collections.emptyMap(), readAll(input, 16 * 1024 * 1024)); return;
            }
        }
        if (request.path.equals("/") || request.path.startsWith("/?")) {
            send(output, 200, "text/html; charset=utf-8", Collections.emptyMap(), HTML.getBytes(StandardCharsets.UTF_8)); return;
        }
        if (request.path.equals("/api/login") && request.method.equals("POST")) {
            send(output, 200, "application/json", Collections.singletonMap("Set-Cookie", COOKIE + "; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict"), utf8("{\"ok\":true}")); return;
        }
        boolean signedIn = request.headers.getOrDefault("cookie", "").contains(COOKIE);
        if (request.path.equals("/api/session")) {
            send(output, signedIn ? 200 : 401, "application/json", Collections.emptyMap(), utf8(signedIn ? "{\"csrfToken\":\"" + CSRF + "\"}" : "{\"error\":\"Sign in\"}")); return;
        }
        if (request.path.equals("/api/write") || request.path.startsWith("/api/upload?")) {
            boolean allowed = signedIn && CSRF.equals(request.headers.get("x-csrf-token"));
            if (allowed) acceptedWrites.incrementAndGet(); else rejectedWrites.incrementAndGet();
            send(output, allowed ? 200 : 403, "application/json", Collections.emptyMap(), utf8(allowed ? "{\"saved\":true,\"size\":" + request.body.length + "}" : "{\"error\":\"Invalid security token\"}")); return;
        }
        if (request.path.equals(DOWNLOAD_PATH)) {
            send(output, signedIn ? 200 : 401, "application/octet-stream", Collections.singletonMap("Content-Disposition", "attachment; filename=\"fixture.bin\""), signedIn ? FILE_BYTES : new byte[0]); return;
        }
        send(output, 404, "text/plain", Collections.emptyMap(), utf8("Fixture route not found"));
    }

    private static void send(OutputStream output, int status, String type, Map<String, String> headers, byte[] body) throws IOException {
        StringBuilder head = new StringBuilder("HTTP/1.1 ").append(status).append(status == 200 ? " OK\r\n" : " Error\r\n")
            .append("Content-Type: ").append(type).append("\r\nContent-Length: ").append(body.length)
            .append("\r\nCache-Control: no-store\r\nConnection: close\r\n");
        headers.forEach((name, value) -> head.append(name).append(": ").append(value).append("\r\n"));
        output.write(head.append("\r\n").toString().getBytes(StandardCharsets.US_ASCII)); output.write(body); output.flush();
    }

    private static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static String line(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        for (int value; (value = input.read()) != -1;) {
            if (value == '\n') return output.toString(StandardCharsets.US_ASCII.name()).replace("\r", "");
            if (output.size() >= 16384) throw new IOException("Fixture line too large"); output.write(value);
        }
        return output.size() == 0 ? null : output.toString(StandardCharsets.US_ASCII.name());
    }
    private static byte[] readAll(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[4096];
        for (int size; (size = input.read(buffer)) != -1;) { if (output.size() + size > limit) throw new IOException("Fixture asset too large"); output.write(buffer, 0, size); }
        return output.toByteArray();
    }

    @Override public void close() throws IOException { socket.close(); workers.shutdownNow(); }
    static final class Request {
        final String method, path; final Map<String, String> headers; final byte[] body;
        Request(String method, String path, Map<String, String> headers, byte[] body) { this.method = method; this.path = path; this.headers = headers; this.body = body; }
    }

    private static final String HTML = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harbor local test</title></head>
        <body><h1>Harbor test space</h1><p id="fixture-status">Opening…</p>
        <button id="fixture-signin">Sign in</button><button id="fixture-write">Save fixture</button>
        <button id="fixture-open-dialog">Open details</button>
        <dialog id="fixture-dialog"><p>File details</p><button id="fixture-close-dialog">Close</button></dialog>
        <label>Choose fixture<input type="file" id="fixture-file"></label>
        <a id="fixture-download" href="/api/files/00000000-0000-4000-8000-000000000001/content?download=1" download="fixture.bin">Download</a>
        <script>
        window.fixtureReady=false;window.fixtureCsrf='';
        async function session(){const r=await fetch('/api/session');const data=await r.json();window.fixtureCsrf=data.csrfToken||'';document.getElementById('fixture-status').textContent=r.ok?'Signed in':'Signed out';window.fixtureReady=true;}
        document.getElementById('fixture-signin').onclick=async()=>{await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await session();};
        document.getElementById('fixture-write').onclick=async()=>{const r=await fetch('/api/write',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':window.fixtureCsrf},body:JSON.stringify({name:'fixture'})});document.getElementById('fixture-status').textContent=r.ok?'Saved':'Rejected';};
        document.getElementById('fixture-open-dialog').onclick=()=>document.getElementById('fixture-dialog').showModal();
        document.getElementById('fixture-close-dialog').onclick=()=>document.getElementById('fixture-dialog').close();
        document.getElementById('fixture-file').onchange=async event=>{const f=event.target.files[0];if(!f)return;const r=await fetch('/api/upload?parent=root&name='+encodeURIComponent(f.name),{method:'PUT',headers:{'X-CSRF-Token':window.fixtureCsrf,'Content-Type':'application/octet-stream'},body:f});window.fixtureUpload=await r.json();};
        session();
        </script></body></html>
        """;
}
