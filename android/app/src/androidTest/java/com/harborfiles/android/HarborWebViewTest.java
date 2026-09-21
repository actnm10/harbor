package com.harborfiles.android;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.filters.LargeTest;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
@LargeTest
public final class HarborWebViewTest {
    private Instrumentation instrumentation;
    private Context target;
    private LoopbackHttpsFixture fixture;
    private ActivityScenario<MainActivity> scenario;

    @Before public void prepare() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        target = instrumentation.getTargetContext();
        assertTrue("Certificate trust must be confined to the separate QA application", target.getPackageName().endsWith(".qa"));
        target.getSharedPreferences("harbor", Context.MODE_PRIVATE).edit().clear().commit();
        clearCookies();
        fixture = new LoopbackHttpsFixture(instrumentation.getContext());
        target.getContentResolver().delete(FixtureDocumentProvider.UPLOAD, null, null);
        target.getContentResolver().delete(FixtureDocumentProvider.DOWNLOAD, null, null);
    }

    @After public void cleanup() throws Exception {
        if (scenario != null) scenario.close();
        if (fixture != null) fixture.close();
        if (target != null) target.getSharedPreferences("harbor", Context.MODE_PRIVATE).edit().clear().commit();
        if (instrumentation != null) clearCookies();
    }

    @Test public void httpsSessionUsesHttpOnlyCookieAndSameOriginCsrf() throws Exception {
        launch(fixture.origin());
        waitJs("window.fixtureReady === true");
        scenario.onActivity(activity -> {
            WebView web = activity.findViewById(R.id.web_view);
            assertFalse(web.getSettings().getAllowFileAccess());
            assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, web.getSettings().getMixedContentMode());
            assertFalse(CookieManager.getInstance().acceptThirdPartyCookies(web));
        });
        signIn();
        assertEquals("", textJs("document.cookie"));
        assertEquals(LoopbackHttpsFixture.CSRF, textJs("window.fixtureCsrf"));
        clickJs("fixture-write"); waitJs("document.getElementById('fixture-status').textContent === 'Saved'");
        assertEquals(1, fixture.acceptedWrites.get());
        LoopbackHttpsFixture.Request write = fixture.requests.stream().filter(request -> request.path.equals("/api/write")).findFirst().orElseThrow();
        assertTrue(write.headers.get("cookie").contains(LoopbackHttpsFixture.COOKIE));
        assertEquals(LoopbackHttpsFixture.CSRF, write.headers.get("x-csrf-token"));
        assertEquals("{\"name\":\"fixture\"}", new String(write.body, StandardCharsets.UTF_8));
        eval("window.fixtureCsrf='wrong';document.getElementById('fixture-write').click()");
        waitJs("document.getElementById('fixture-status').textContent === 'Rejected'");
        assertEquals(1, fixture.acceptedWrites.get()); assertEquals(1, fixture.rejectedWrites.get());
    }

    @Test public void otherOriginsAreBlockedBeforeReceivingCookiesOrRequests() throws Exception {
        launch(fixture.origin()); signIn();
        try (LoopbackHttpsFixture other = new LoopbackHttpsFixture(instrumentation.getContext())) {
            eval("window.fixtureBlocked=false;const image=new Image();image.onerror=()=>window.fixtureBlocked=true;image.src="
                    + JSONObject.quote(other.origin() + "/cross-origin-probe") + ";document.body.append(image)");
            waitJs("window.fixtureBlocked === true");
            assertEquals("Cross-origin resources must be stopped before the network", 0, other.requests.size());
            assertEquals(fixture.origin() + "/", textJs("location.href"));
        }
    }

    @Test public void setupRejectsInsecureAndAmbiguousServerAddresses() throws Exception {
        scenario = ActivityScenario.launch(MainActivity.class);
        capture("native-setup");
        for (String invalid : new String[] { "http://127.0.0.1", "javascript:alert(1)", "https://user:secret@example.com", "https://example.com/private", "https://example.com?token=x" }) {
            scenario.onActivity(activity -> {
                ((EditText) activity.findViewById(R.id.server_url)).setText(invalid);
                activity.findViewById(R.id.connect_button).performClick();
                assertEquals(View.VISIBLE, activity.findViewById(R.id.setup_error).getVisibility());
                assertNull(activity.findViewById(R.id.web_view));
            });
            assertNull(target.getSharedPreferences("harbor", Context.MODE_PRIVATE).getString("server", null));
        }
    }

    @Test public void invalidTlsCertificateShowsErrorInsteadOfLoadingThePage() throws Exception {
        launch(fixture.mismatchedOrigin());
        await("secure connection error", () -> {
            AtomicBoolean shown = new AtomicBoolean();
            scenario.onActivity(activity -> shown.set(activity.findViewById(R.id.error_panel).getVisibility() == View.VISIBLE));
            return shown.get();
        });
        scenario.onActivity(activity -> {
            assertEquals(View.GONE, activity.findViewById(R.id.web_view).getVisibility());
            assertTrue(((TextView) activity.findViewById(R.id.error_message)).getText().length() > 0);
        });
        assertTrue("TLS rejection must happen before fixture HTTP is accepted", fixture.requests.isEmpty());
    }

    @Test public void orientationAndActivityRecreationKeepTheAuthenticatedSession() throws Exception {
        launch(fixture.origin()); signIn();
        eval("window.fixtureRotationMarker='still-here';location.hash='folder=fixture'");
        scenario.onActivity(activity -> activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
        await("landscape configuration", () -> {
            AtomicBoolean landscape = new AtomicBoolean();
            scenario.onActivity(activity -> landscape.set(activity.getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE));
            return landscape.get();
        });
        assertEquals("still-here", textJs("window.fixtureRotationMarker"));
        assertEquals("#folder=fixture", textJs("location.hash"));
        scenario.recreate();
        waitJs("window.fixtureReady === true && document.getElementById('fixture-status').textContent === 'Signed in'");
        assertEquals(LoopbackHttpsFixture.CSRF, textJs("window.fixtureCsrf"));
        assertEquals("", textJs("document.cookie"));
    }

    @Test public void nativeBackClosesWebDialogBeforeLeavingFiles() throws Exception {
        launch(fixture.origin()); waitJs("window.fixtureReady === true");
        clickJs("fixture-open-dialog"); waitJs("document.getElementById('fixture-dialog').open === true");
        eval("window.fixtureCancelSeen=0;window.fixtureCancel=e=>{window.fixtureCancelSeen++;e.preventDefault()};document.getElementById('fixture-dialog').addEventListener('cancel',window.fixtureCancel)");
        scenario.onActivity(MainActivity::onBackPressed);
        waitJs("window.fixtureCancelSeen === 1");
        assertEquals("true", eval("document.getElementById('fixture-dialog').open"));
        eval("document.getElementById('fixture-dialog').removeEventListener('cancel',window.fixtureCancel)");
        scenario.onActivity(MainActivity::onBackPressed);
        waitJs("document.getElementById('fixture-dialog').open === false");
        scenario.onActivity(activity -> assertFalse(activity.isFinishing()));
        assertEquals(fixture.origin() + "/", textJs("location.href"));
    }

    @Test public void pickerContentUriUploadsActualBytesThroughWebJavascript() throws Exception {
        launch(fixture.origin()); signIn();
        try (OutputStream output = target.getContentResolver().openOutputStream(FixtureDocumentProvider.UPLOAD, "wt")) {
            output.write(LoopbackHttpsFixture.FILE_BYTES);
        }
        Intent result = new Intent().setData(FixtureDocumentProvider.UPLOAD).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Instrumentation.ActivityMonitor monitor = pickerMonitor(Intent.ACTION_OPEN_DOCUMENT, result);
        try {
            tapWebElement("fixture-file");
            await("upload picker callback", () -> monitor.getHits() > 0);
            waitJs("window.fixtureUpload && window.fixtureUpload.saved === true");
        } finally { instrumentation.removeMonitor(monitor); }
        LoopbackHttpsFixture.Request upload = fixture.requests.stream().filter(request -> request.path.startsWith("/api/upload?")).findFirst().orElseThrow();
        assertArrayEquals(LoopbackHttpsFixture.FILE_BYTES, upload.body);
        assertTrue(upload.headers.get("cookie").contains(LoopbackHttpsFixture.COOKIE));
        assertEquals(LoopbackHttpsFixture.CSRF, upload.headers.get("x-csrf-token"));
        assertEquals(1, fixture.acceptedWrites.get());
    }

    @Test public void downloadPickerWritesAuthenticatedBytesToSelectedDocument() throws Exception {
        launch(fixture.origin()); signIn();
        Intent result = new Intent().setData(FixtureDocumentProvider.DOWNLOAD).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        Instrumentation.ActivityMonitor monitor = pickerMonitor(Intent.ACTION_CREATE_DOCUMENT, result);
        try {
            tapWebElement("fixture-download");
            await("save picker callback", () -> monitor.getHits() > 0);
            await("downloaded document bytes", () -> Arrays.equals(LoopbackHttpsFixture.FILE_BYTES, downloadedBytes()));
        } finally { instrumentation.removeMonitor(monitor); }
        assertArrayEquals(LoopbackHttpsFixture.FILE_BYTES, downloadedBytes());
        assertTrue(fixture.requests.stream().filter(request -> request.path.equals(LoopbackHttpsFixture.DOWNLOAD_PATH))
                .allMatch(request -> request.headers.getOrDefault("cookie", "").contains(LoopbackHttpsFixture.COOKIE)));
    }

    @Test public void shippedPdfJsRendersRealPdfAndSelectableTextOnAndroidWebView() throws Exception {
        launch(fixture.origin()); waitJs("window.fixtureReady === true");
        String harborPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
        eval("window.fixtureCspViolations=[];document.addEventListener('securitypolicyviolation',event=>window.fixtureCspViolations.push(event.violatedDirective+' '+event.blockedURI));"
                + "const policy=document.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content=" + JSONObject.quote(harborPolicy) + ";document.head.append(policy)");
        eval("const script=document.createElement('script');script.src='/fixture-pdf-engine.js';document.body.append(script)");
        waitJs("window.fixturePdf === 'done' || window.fixturePdf === 'error'");
        assertEquals(textJs("window.fixturePdfError || ''"), "done", textJs("window.fixturePdf"));
        JSONObject result = new JSONObject(textJs("JSON.stringify(window.fixturePdfResult)"));
        assertEquals("6.3.289", result.getString("version"));
        assertEquals(1, result.getInt("pages"));
        assertTrue(result.getString("text").contains("Harbor PDF fixture"));
        assertEquals(300, result.getInt("width")); assertEquals(144, result.getInt("height"));
        assertTrue("Real PDF text must paint visible pixels", result.getInt("darkPixels") > 100);
        assertEquals("PDF rendering must respect Harbor's CSP", "[]", textJs("JSON.stringify(window.fixtureCspViolations)"));
        assertTrue(fixture.requests.stream().anyMatch(request -> request.path.equals("/vendor/pdfjs/pdf.min.mjs")));
        assertTrue(fixture.requests.stream().anyMatch(request -> request.path.equals("/vendor/pdfjs/pdf.worker.min.mjs")));
        capture("native-pdf-engine");
    }

    @Test public void recreatedActivityAcceptsTheAlreadyOpenedSavePickerResult() throws Exception {
        launch(fixture.origin()); signIn();
        IntentFilter filter = new IntentFilter(Intent.ACTION_CREATE_DOCUMENT);
        filter.addCategory(Intent.CATEGORY_OPENABLE); filter.addDataType("*/*");
        Instrumentation.ActivityMonitor monitor = new Instrumentation.ActivityMonitor(filter, null, true);
        instrumentation.addMonitor(monitor);
        try {
            tapWebElement("fixture-download"); await("pending save picker", () -> monitor.getHits() > 0);
            scenario.recreate(); waitJs("window.fixtureReady === true");
            scenario.onActivity(activity -> activity.onActivityResult(MainActivity.SAVE_DOWNLOAD, Activity.RESULT_OK,
                    new Intent().setData(FixtureDocumentProvider.DOWNLOAD).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)));
            await("restored picker download", () -> Arrays.equals(LoopbackHttpsFixture.FILE_BYTES, downloadedBytes()));
        } finally { instrumentation.removeMonitor(monitor); }
        assertArrayEquals(LoopbackHttpsFixture.FILE_BYTES, downloadedBytes());
    }

    @Test public void changingServerClearsCookiesAndPrivateStorageBeforeReconnecting() throws Exception {
        launch(fixture.origin()); signIn();
        eval("localStorage.setItem('private-fixture','previous-server-data')");
        clearServerAndWait();
        assertNull(target.getSharedPreferences("harbor", Context.MODE_PRIVATE).getString("server", null));
        AtomicReference<String> cookie = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> cookie.set(CookieManager.getInstance().getCookie(fixture.origin())));
        assertTrue(cookie.get() == null || cookie.get().isEmpty());
        try (LoopbackHttpsFixture other = new LoopbackHttpsFixture(instrumentation.getContext())) {
            connectFromSetup(other.origin());
            waitJs("window.fixtureReady === true && document.getElementById('fixture-status').textContent === 'Signed out'");
            assertTrue(other.requests.stream().anyMatch(request -> request.path.equals("/")));
            assertTrue("A different port on the same cookie host must not receive the old session",
                    other.requests.stream().allMatch(request -> request.headers.getOrDefault("cookie", "").isEmpty()));
            clearServerAndWait();
            connectFromSetup(fixture.origin());
            waitJs("window.fixtureReady === true");
            assertEquals("null", eval("localStorage.getItem('private-fixture')"));
            assertEquals("Signed out", textJs("document.getElementById('fixture-status').textContent"));
        }
    }

    private void launch(String origin) {
        target.getSharedPreferences("harbor", Context.MODE_PRIVATE).edit().putString("server", origin).commit();
        scenario = ActivityScenario.launch(MainActivity.class);
    }
    private void connectFromSetup(String origin) {
        scenario.onActivity(activity -> {
            ((EditText) activity.findViewById(R.id.server_url)).setText(origin);
            activity.findViewById(R.id.connect_button).performClick();
        });
    }
    private void clearServerAndWait() throws Exception {
        // Invoke the confirmed action directly to test its real asynchronous cleanup
        // without coupling this lifecycle regression to platform alert-dialog internals.
        scenario.onActivity(activity -> {
            try {
                java.lang.reflect.Method clear = MainActivity.class.getDeclaredMethod("clearServer");
                clear.setAccessible(true); clear.invoke(activity);
            } catch (ReflectiveOperationException error) { throw new AssertionError(error); }
        });
        await("cleared server setup", () -> {
            AtomicBoolean visible = new AtomicBoolean();
            scenario.onActivity(activity -> visible.set(activity.findViewById(R.id.setup_root) != null));
            return visible.get();
        });
    }
    private void signIn() throws Exception {
        waitJs("window.fixtureReady === true"); clickJs("fixture-signin");
        waitJs("document.getElementById('fixture-status').textContent === 'Signed in'");
    }
    private void clickJs(String id) throws Exception { eval("document.getElementById(" + JSONObject.quote(id) + ").click()"); }
    private String eval(String expression) throws Exception {
        CountDownLatch complete = new CountDownLatch(1); AtomicReference<String> result = new AtomicReference<>();
        scenario.onActivity(activity -> {
            WebView web = activity.findViewById(R.id.web_view);
            assertNotNull("The native activity must expose its active WebView", web);
            web.evaluateJavascript(expression, value -> { result.set(value); complete.countDown(); });
        });
        assertTrue("JavaScript callback timed out", complete.await(5, TimeUnit.SECONDS)); return result.get();
    }
    private String textJs(String expression) throws Exception { return String.valueOf(new JSONTokener(eval(expression)).nextValue()); }
    private void waitJs(String expression) throws Exception { await("JavaScript condition: " + expression, () -> "true".equals(eval("Boolean(" + expression + ")"))); }
    private void clearCookies() throws Exception {
        CountDownLatch complete = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> CookieManager.getInstance().removeAllCookies(value -> { CookieManager.getInstance().flush(); complete.countDown(); }));
        assertTrue("Cookie reset timed out", complete.await(5, TimeUnit.SECONDS));
    }
    private Instrumentation.ActivityMonitor pickerMonitor(String action, Intent result) throws Exception {
        IntentFilter filter = new IntentFilter(action); filter.addCategory(Intent.CATEGORY_OPENABLE); filter.addDataType("*/*");
        Instrumentation.ActivityMonitor monitor = new Instrumentation.ActivityMonitor(filter, new Instrumentation.ActivityResult(Activity.RESULT_OK, result), true);
        instrumentation.addMonitor(monitor); return monitor;
    }
    private void tapWebElement(String id) throws Exception {
        String expression = "(()=>{const e=document.getElementById(" + JSONObject.quote(id) + ");e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return JSON.stringify([r.left+r.width/2,r.top+r.height/2,innerWidth]);})()";
        JSONArray rect = new JSONArray(textJs(expression)); float[] point = new float[2];
        scenario.onActivity(activity -> {
            WebView web = activity.findViewById(R.id.web_view); int[] location = new int[2]; web.getLocationOnScreen(location);
            float scale = (float) (web.getWidth() / rect.optDouble(2));
            point[0] = location[0] + (float) rect.optDouble(0) * scale;
            point[1] = location[1] + (float) rect.optDouble(1) * scale;
        });
        long now = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, point[0], point[1], 0);
        MotionEvent up = MotionEvent.obtain(now, now + 60, MotionEvent.ACTION_UP, point[0], point[1], 0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN); up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try { instrumentation.sendPointerSync(down); instrumentation.sendPointerSync(up); } finally { down.recycle(); up.recycle(); }
        instrumentation.waitForIdleSync();
    }
    private byte[] downloadedBytes() {
        try (InputStream input = target.getContentResolver().openInputStream(FixtureDocumentProvider.DOWNLOAD)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[1024];
            for (int size; (size = input.read(buffer)) != -1;) { if (output.size() + size > 1024 * 1024) return new byte[0]; output.write(buffer, 0, size); }
            return output.toByteArray();
        } catch (Exception ignored) { return new byte[0]; }
    }
    private interface Condition { boolean ready() throws Exception; }
    private void capture(String name) throws Exception {
        instrumentation.waitForIdleSync();
        Bitmap screenshot = instrumentation.getUiAutomation().takeScreenshot();
        if (screenshot == null) return;
        String exportedOutput = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir");
        File directory = exportedOutput == null ? target.getExternalFilesDir("qa-screenshots") : new File(exportedOutput);
        if (directory == null) { screenshot.recycle(); return; }
        if (!directory.exists() && !directory.mkdirs()) throw new java.io.IOException("Could not create QA screenshot directory");
        android.util.Log.i("HarborFixture", "Screenshot output: " + directory.getAbsolutePath());
        try (OutputStream output = new FileOutputStream(new File(directory, name + ".png"))) {
            screenshot.compress(Bitmap.CompressFormat.PNG, 100, output);
        } finally { screenshot.recycle(); }
    }
    private static void await(String description, Condition condition) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 15000;
        while (SystemClock.elapsedRealtime() < deadline) { if (condition.ready()) return; SystemClock.sleep(40); }
        fail("Timed out waiting for " + description);
    }
}
