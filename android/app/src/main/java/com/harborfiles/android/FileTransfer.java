package com.harborfiles.android;

import android.content.ContentResolver;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.Objects;
import java.util.concurrent.Executor;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;

/**
 * One foreground download. The caller owns its lifecycle and must cancel when leaving its server.
 * Public-start callbacks run on Android's main thread. No credentials or response bodies are logged.
 */
public final class FileTransfer {
    public interface Listener {
        void onProgress(long bytes, long totalBytes);
        void onComplete(long bytes);
        void onError(String message);
        void onCancelled();
    }

    interface Destination {
        OutputStream open() throws IOException;
        boolean delete() throws IOException;
    }

    interface ConnectionFactory { HttpsURLConnection open(URL url) throws IOException; }

    private final Object lock = new Object();
    private final URL url;
    private String cookie;
    private final Destination destination;
    private final Listener listener;
    private final Executor callbacks;
    private final ConnectionFactory connections;
    private final Thread worker;
    private boolean running = true;
    private boolean cancelled;
    private HttpsURLConnection connection;
    private InputStream input;
    private OutputStream output;

    public static FileTransfer start(ContentResolver resolver, ServerOrigin origin, String address,
            String cookie, Uri destination, Listener listener) {
        Objects.requireNonNull(resolver, "resolver");
        Objects.requireNonNull(destination, "destination");
        if (!"content".equals(destination.getScheme()) || destination.getAuthority() == null) {
            throw new IllegalArgumentException("Choose a document location to save the file.");
        }
        URL url = DownloadPolicy.validate(origin, address);
        Handler main = new Handler(Looper.getMainLooper());
        Destination sink = new Destination() {
            @Override public OutputStream open() throws IOException {
                OutputStream stream = resolver.openOutputStream(destination, "wt");
                if (stream == null) throw new IOException("The document provider did not open the file.");
                return stream;
            }
            @Override public boolean delete() throws IOException {
                return DocumentsContract.deleteDocument(resolver, destination);
            }
        };
        return begin(url, cookie, sink, listener, action -> main.post(action),
                target -> (HttpsURLConnection) target.openConnection());
    }

    // Dependency boundaries allow JVM tests to exercise transfer and cancellation without Android I/O.
    static FileTransfer begin(URL url, String cookie, Destination destination, Listener listener,
            Executor callbacks, ConnectionFactory connections) {
        if (url == null || !"https".equalsIgnoreCase(url.getProtocol())) {
            throw new IllegalArgumentException("Downloads require HTTPS.");
        }
        FileTransfer transfer = new FileTransfer(url, cookie, destination, listener, callbacks, connections);
        transfer.worker.start();
        return transfer;
    }

    private FileTransfer(URL url, String cookie, Destination destination, Listener listener,
            Executor callbacks, ConnectionFactory connections) {
        this.url = url;
        this.cookie = cookie;
        this.destination = Objects.requireNonNull(destination);
        this.listener = Objects.requireNonNull(listener);
        this.callbacks = Objects.requireNonNull(callbacks);
        this.connections = Objects.requireNonNull(connections);
        worker = new Thread(this::run, "harbor-download");
        worker.setDaemon(true);
    }

    public boolean isRunning() { synchronized (lock) { return running; } }

    /** Nonblocking: teardown happens on a separate thread, including potentially slow provider I/O. */
    public void cancel() {
        final HttpsURLConnection activeConnection;
        final InputStream activeInput;
        final OutputStream activeOutput;
        synchronized (lock) {
            if (!running || cancelled) return;
            cancelled = true;
            activeConnection = connection;
            activeInput = input;
            activeOutput = output;
        }
        worker.interrupt();
        Thread abort = new Thread(() -> {
            disconnect(activeConnection);
            closeQuietly(activeInput);
            closeQuietly(activeOutput);
        }, "harbor-download-cancel");
        abort.setDaemon(true);
        abort.start();
    }

    private void checkCancelled() throws InterruptedIOException {
        synchronized (lock) {
            if (cancelled) throw new InterruptedIOException("Download canceled.");
        }
    }

    private void run() {
        long bytes = 0;
        Exception failure = null;
        HttpsURLConnection current = null;
        try {
            checkCancelled();
            try { validateCookie(cookie); }
            catch (IllegalArgumentException invalidSession) { throw new DownloadFailure(invalidSession.getMessage()); }
            current = connections.open(url);
            synchronized (lock) { connection = current; }
            checkCancelled();
            current.setInstanceFollowRedirects(false);
            current.setConnectTimeout(15000);
            current.setReadTimeout(30000);
            current.setUseCaches(false);
            current.setRequestMethod("GET");
            current.setRequestProperty("Accept-Encoding", "identity");
            current.setRequestProperty("Cookie", cookie);
            int status = current.getResponseCode();
            checkCancelled();
            if (status != 200) {
                if (status == 401 || status == 403) throw new DownloadFailure("Your session expired or access was denied. Sign in and try again.");
                if (status == 404) throw new DownloadFailure("This file is no longer available.");
                if (status >= 300 && status < 400) throw new DownloadFailure("The server redirected this download. Check your Harbor server address.");
                throw new DownloadFailure("The server could not download this file. Try again.");
            }
            String encoding = current.getContentEncoding();
            if (encoding != null && !encoding.equalsIgnoreCase("identity")) {
                throw new DownloadFailure("The server returned an unsupported download response.");
            }
            long total = current.getContentLengthLong();
            try (InputStream source = current.getInputStream()) {
                synchronized (lock) { input = source; }
                checkCancelled();
                try (OutputStream sink = destination.open()) {
                    synchronized (lock) { output = sink; }
                    checkCancelled();
                    byte[] buffer = new byte[64 * 1024];
                    long lastProgress = 0;
                    postProgress(0, total);
                    while (true) {
                        checkCancelled();
                        int read = source.read(buffer);
                        checkCancelled();
                        if (read < 0) {
                            break;
                        }
                        if (read == 0) {
                            continue;
                        }
                        if (bytes > Long.MAX_VALUE - read || (total >= 0 && bytes + read > total)) {
                            throw new DownloadFailure("The download response was incomplete or invalid. Try again.");
                        }
                        sink.write(buffer, 0, read);
                        bytes += read;
                        long now = System.nanoTime();
                        if (now - lastProgress >= 100_000_000L) {
                            postProgress(bytes, total);
                            lastProgress = now;
                        }
                    }
                    if (total >= 0 && bytes != total) throw new DownloadFailure("The connection ended before the download finished. Try again.");
                    sink.flush();
                }
            }
        } catch (Exception error) {
            failure = error;
        } finally {
            disconnect(current);
            synchronized (lock) {
                connection = null;
                input = null;
                output = null;
                cookie = null;
            }
        }

        boolean complete;
        synchronized (lock) {
            complete = failure == null && !cancelled;
            if (complete) running = false;
        }
        if (complete) {
            long completedBytes = bytes;
            callbacks.execute(() -> listener.onComplete(completedBytes));
            return;
        }

        boolean deleted;
        try { deleted = destination.delete(); }
        catch (Exception ignored) { deleted = false; }
        boolean wasCancelled;
        synchronized (lock) { wasCancelled = cancelled; running = false; }
        if (!deleted) {
            callbacks.execute(() -> listener.onError("Download stopped, but the incomplete file could not be removed. Delete it from the location you selected."));
        } else if (wasCancelled) {
            callbacks.execute(listener::onCancelled);
        } else {
            String message = friendlyError(failure);
            callbacks.execute(() -> listener.onError(message));
        }
    }

    private void postProgress(long bytes, long total) {
        callbacks.execute(() -> {
            synchronized (lock) { if (!running || cancelled) return; }
            listener.onProgress(bytes, total);
        });
    }

    private static String friendlyError(Exception error) {
        if (error instanceof DownloadFailure) return error.getMessage();
        if (error instanceof SSLException) return "A secure connection could not be verified. Check the server certificate.";
        if (error instanceof SocketTimeoutException) return "The download connection timed out. Check your connection and try again.";
        return "The download could not finish. Check your connection and available storage, then try again.";
    }

    private static void validateCookie(String value) {
        if (value == null || value.isEmpty() || value.length() > 16384) {
            throw new IllegalArgumentException("Sign in before downloading files.");
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 32 || c == 127) throw new IllegalArgumentException("The saved session is invalid. Sign in again.");
        }
    }

    private static void disconnect(HttpsURLConnection connection) {
        if (connection != null) try { connection.disconnect(); } catch (RuntimeException ignored) { }
    }
    private static void closeQuietly(Closeable stream) {
        if (stream != null) try { stream.close(); } catch (Exception ignored) { }
    }
    private static final class DownloadFailure extends IOException {
        DownloadFailure(String message) { super(message); }
    }
}
