package com.harborfiles.android;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.security.cert.Certificate;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.HttpsURLConnection;
import org.junit.Test;
import static org.junit.Assert.*;

public class FileTransferTest {
    private static URL address() throws Exception {
        return DownloadPolicy.validate(ServerOrigin.parse("https://harbor.example"),
                "https://harbor.example/api/files/12345678-1234-4abc-8abc-1234567890ab/content?download=1");
    }

    private static final class Result implements FileTransfer.Listener {
        final CountDownLatch done = new CountDownLatch(1);
        final AtomicInteger terminals = new AtomicInteger();
        volatile long bytes = -1;
        volatile String error;
        volatile boolean cancelled;
        @Override public void onProgress(long bytes, long total) { assertTrue(bytes >= 0); }
        @Override public void onComplete(long count) { bytes = count; terminals.incrementAndGet(); done.countDown(); }
        @Override public void onError(String message) { error = message; terminals.incrementAndGet(); done.countDown(); }
        @Override public void onCancelled() { cancelled = true; terminals.incrementAndGet(); done.countDown(); }
        void await() throws Exception { assertTrue("transfer finished", done.await(3, TimeUnit.SECONDS)); assertEquals(1, terminals.get()); }
    }

    private static final class Sink implements FileTransfer.Destination {
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int opens, deletes;
        boolean deleteWorks = true;
        @Override public OutputStream open() { opens++; return bytes; }
        @Override public boolean delete() { deletes++; if (deleteWorks) bytes.reset(); return deleteWorks; }
    }

    private static class Connection extends HttpsURLConnection {
        InputStream body;
        int status = 200;
        long length;
        String encoding;
        boolean disconnected, bodyRequested;
        Connection(byte[] bytes) throws Exception { super(address()); body = new ByteArrayInputStream(bytes); length = bytes.length; }
        @Override public int getResponseCode() { return status; }
        @Override public long getContentLengthLong() { return length; }
        @Override public String getContentEncoding() { return encoding; }
        @Override public InputStream getInputStream() { bodyRequested = true; return body; }
        @Override public void disconnect() { disconnected = true; try { body.close(); } catch (IOException ignored) { } }
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() { }
        @Override public String getCipherSuite() { return "test"; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() { return null; }
    }

    @Test public void streamsExactBytesWithScopedCookieAndNoRedirects() throws Exception {
        byte[] payload = new byte[190_000];
        for (int i = 0; i < payload.length; i++) payload[i] = (byte) (i % 251);
        Connection conn = new Connection(payload);
        Sink sink = new Sink(); Result result = new Result();
        FileTransfer transfer = FileTransfer.begin(address(), "harbor_session=private", sink, result, Runnable::run, ignored -> conn);
        result.await();
        assertArrayEquals(payload, sink.bytes.toByteArray());
        assertEquals(payload.length, result.bytes);
        assertNull(result.error);
        assertFalse(transfer.isRunning());
        assertFalse(conn.getInstanceFollowRedirects());
        assertEquals("harbor_session=private", conn.getRequestProperty("Cookie"));
        assertEquals("identity", conn.getRequestProperty("Accept-Encoding"));
        assertEquals("GET", conn.getRequestMethod());
        assertTrue(conn.getConnectTimeout() > 0);
        assertTrue(conn.getReadTimeout() > 0);
        assertFalse(conn.getUseCaches());
        assertTrue(conn.disconnected);
        assertEquals(0, sink.deletes);
    }

    @Test public void redirectsAndErrorsNeverReadOrSaveResponseBodies() throws Exception {
        for (int status : new int[]{301, 302, 307, 308, 401, 403, 404, 500}) {
            Connection conn = new Connection("private response body".getBytes()); conn.status = status;
            Sink sink = new Sink(); Result result = new Result(); AtomicInteger opens = new AtomicInteger();
            FileTransfer.begin(address(), "session=secret", sink, result, Runnable::run, ignored -> { opens.incrementAndGet(); return conn; });
            result.await();
            assertEquals(1, opens.get());
            assertFalse(conn.bodyRequested);
            assertEquals(0, sink.opens);
            assertEquals(1, sink.deletes);
            assertNotNull(result.error);
            assertFalse(result.error.contains("private response"));
            assertFalse(result.error.contains("secret"));
        }
    }

    @Test public void rejectsIncompleteCompressedOrOversizedBodiesAndDeletesDestination() throws Exception {
        for (int scenario = 0; scenario < 3; scenario++) {
            Connection conn = new Connection(new byte[]{1, 2, 3});
            if (scenario == 0) conn.length = 5;
            if (scenario == 1) conn.length = 2;
            if (scenario == 2) conn.encoding = "gzip";
            Sink sink = new Sink(); Result result = new Result();
            FileTransfer.begin(address(), "session=secret", sink, result, Runnable::run, ignored -> conn);
            result.await();
            assertNotNull(result.error);
            assertEquals(1, sink.deletes);
            assertEquals(0, sink.bytes.size());
        }
    }

    @Test public void supportsUnknownLengthAndEmptyFiles() throws Exception {
        for (byte[] payload : new byte[][]{new byte[0], new byte[]{0, 1, 2}}) {
            Connection conn = new Connection(payload); conn.length = -1;
            Sink sink = new Sink(); Result result = new Result();
            FileTransfer.begin(address(), "session=secret", sink, result, Runnable::run, ignored -> conn);
            result.await();
            assertArrayEquals(payload, sink.bytes.toByteArray());
            assertEquals(payload.length, result.bytes);
        }
    }

    @Test public void cancellationInterruptsPendingReadDeletesPartialAndCallsBackOnce() throws Exception {
        CountDownLatch reading = new CountDownLatch(1);
        Connection conn = new Connection(new byte[0]); conn.length = -1;
        conn.body = new InputStream() {
            @Override public int read() throws IOException {
                reading.countDown();
                try { new CountDownLatch(1).await(); }
                catch (InterruptedException interrupted) { throw new IOException("interrupted"); }
                return -1;
            }
        };
        Sink sink = new Sink(); Result result = new Result();
        FileTransfer transfer = FileTransfer.begin(address(), "session=secret", sink, result, Runnable::run, ignored -> conn);
        assertTrue(reading.await(2, TimeUnit.SECONDS));
        transfer.cancel(); transfer.cancel();
        result.await();
        assertTrue(result.cancelled);
        assertNull(result.error);
        assertFalse(transfer.isRunning());
        assertEquals(1, sink.deletes);
        assertTrue(conn.disconnected);
        transfer.cancel();
        assertEquals(1, result.terminals.get());
    }

    @Test public void reportsFailedCleanupWithoutLeakingProviderErrors() throws Exception {
        Connection conn = new Connection(new byte[0]); conn.status = 500;
        Sink sink = new Sink(); sink.deleteWorks = false; Result result = new Result();
        FileTransfer.begin(address(), "session=secret", sink, result, Runnable::run, ignored -> conn);
        result.await();
        assertTrue(result.error.contains("could not be removed"));
        assertEquals(1, sink.deletes);
    }

    @Test public void missingOrUnsafeCookieFailsAsynchronouslyAndCleansUpBeforeAnyNetwork() throws Exception {
        for (String cookie : new String[]{null, "", "session=secret\r\nHost: evil", "session=\u0000secret"}) {
            Sink sink = new Sink(); Result result = new Result();
            FileTransfer.begin(address(), cookie, sink, result, Runnable::run,
                    ignored -> { throw new AssertionError("network was accessed"); });
            result.await();
            assertNotNull(result.error);
            assertTrue(result.error.toLowerCase().contains("sign in"));
            assertEquals(0, sink.opens);
            assertEquals(1, sink.deletes);
        }
    }
}
