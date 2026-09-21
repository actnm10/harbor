package com.harborfiles.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.text.format.Formatter;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;

/** Same-origin companion: passwords and CSRF remain inside Harbor's own web UI. */
public final class MainActivity extends Activity {
    static final int PICK_UPLOAD = 201;
    static final int SAVE_DOWNLOAD = 202;
    // SDK35 source defines this hidden value; it becomes public in API37.
    // https://developer.android.com/reference/android/webkit/WebChromeClient.FileChooserParams#MODE_OPEN_FOLDER
    private static final int FILE_CHOOSER_OPEN_FOLDER = 2;
    private SharedPreferences preferences;
    private WebView webView;
    private ServerOrigin origin;
    private View errorPanel;
    private ProgressBar loadingProgress;
    private boolean pageFailed;
    private volatile boolean leavingServer;
    private volatile long serverGeneration;
    private ValueCallback<Uri[]> uploadCallback;
    private long uploadGeneration;
    private PendingDownload pendingDownload;
    private FileTransfer transfer;
    private AlertDialog transferDialog;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    private record PendingDownload(String url, String mimeType, String name, long generation) {}

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
        preferences = getSharedPreferences("harbor", MODE_PRIVATE);
        String savedServer = preferences.getString("server", null);
        if (savedServer != null) {
            try {
                openServer(ServerOrigin.parse(savedServer));
                restorePickerState(savedInstanceState);
                return;
            } catch (IllegalArgumentException ignored) {
                preferences.edit().remove("server").apply();
            }
        }
        showSetup();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        if (pendingDownload != null) {
            state.putString("downloadUrl", pendingDownload.url);
            state.putString("downloadMime", pendingDownload.mimeType);
            state.putString("downloadName", pendingDownload.name);
        }
        state.putBoolean("uploadPickerOpen", uploadCallback != null);
        super.onSaveInstanceState(state);
    }

    private void restorePickerState(Bundle state) {
        if (state == null) return;
        String url = state.getString("downloadUrl");
        if (url != null) {
            try {
                DownloadPolicy.validate(origin, url);
                String mime = state.getString("downloadMime", "application/octet-stream");
                if (!mime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")) mime = "application/octet-stream";
                pendingDownload = new PendingDownload(url, mime,
                        DownloadPolicy.safeFilename(null, state.getString("downloadName", "Harbor download")), serverGeneration);
            } catch (IllegalArgumentException ignored) { /* Never restore a different server's request. */ }
        }
        if (state.getBoolean("uploadPickerOpen")) toast("Harbor reopened. Choose Upload again to select your files.");
    }

    private void applyInsets(View root) {
        // Android 15 enforces edge-to-edge. Keep both the toolbar and keyboard
        // out of the page's touch targets, including landscape display cutouts.
        root.setFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return Build.VERSION.SDK_INT >= 30 ? WindowInsets.CONSUMED : insets.consumeSystemWindowInsets();
        });
        root.requestApplyInsets();
    }

    private void showSetup() {
        setContentView(R.layout.setup_view);
        applyInsets(findViewById(R.id.setup_root));
        EditText address = findViewById(R.id.server_url);
        TextView error = findViewById(R.id.setup_error);
        findViewById(R.id.connect_button).setOnClickListener(view -> {
            if (leavingServer) return;
            try {
                ServerOrigin selected = ServerOrigin.parse(address.getText().toString());
                ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                        .hideSoftInputFromWindow(address.getWindowToken(), 0);
                openServer(selected);
            } catch (IllegalArgumentException invalid) {
                error.setText(R.string.invalid_server_url);
                error.setVisibility(View.VISIBLE);
                address.requestFocus();
            }
        });
        address.setOnEditorActionListener((view, action, event) -> {
            if (action == android.view.inputmethod.EditorInfo.IME_ACTION_GO
                    || action == android.view.inputmethod.EditorInfo.IME_ACTION_DONE) {
                findViewById(R.id.connect_button).performClick();
                return true;
            }
            return false;
        });
    }

    // Harbor's UI requires JS; origin isolation and the absence of a native bridge
    // keep it within the same boundary as the server's normal mobile browser.
    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    @SuppressWarnings("deprecation")
    private void openServer(ServerOrigin selected) {
        origin = selected;
        serverGeneration++;
        preferences.edit().putString("server", selected.toString()).apply();
        setContentView(R.layout.activity_main);
        applyInsets(findViewById(R.id.main_root));
        ((TextView) findViewById(R.id.server_label)).setText(selected.toString());
        errorPanel = findViewById(R.id.error_panel);
        loadingProgress = findViewById(R.id.loading_progress);
        webView = findViewById(R.id.web_view);
        findViewById(R.id.menu_button).setOnClickListener(this::showMenu);
        findViewById(R.id.retry_button).setOnClickListener(view -> loadHome());
        findViewById(R.id.change_server_button).setOnClickListener(view -> confirmServerChange());
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setUserAgentString(settings.getUserAgentString() + " HarborAndroid/" + BuildConfig.VERSION_NAME);
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setBuiltInZoomControls(false);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);
        final ServerOrigin trustedOrigin = selected;
        final long generation = serverGeneration;
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (generation != serverGeneration || leavingServer) return true;
                String url = request.getUrl().toString();
                if (trustedOrigin.contains(url)) return false;
                if (request.isForMainFrame() && request.hasGesture()
                        && "https".equalsIgnoreCase(request.getUrl().getScheme())) {
                    confirmExternalLink(request.getUrl());
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                // Block direct foreign requests. Harbor's server CSP additionally
                // restricts redirect targets and connections (e.g. WebSockets)
                // that WebView's interception callback does not observe.
                if (generation != serverGeneration || !trustedOrigin.contains(request.getUrl().toString())) {
                    if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)
                            || "file".equalsIgnoreCase(scheme) || "content".equalsIgnoreCase(scheme)) {
                        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked",
                                java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                    }
                }
                return null;
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
                if (generation != serverGeneration) return;
                if (!trustedOrigin.contains(url)) {
                    view.stopLoading();
                    showError("This page left the selected server. Check your Harbor address.");
                    return;
                }
                pageFailed = false;
                errorPanel.setVisibility(View.GONE);
                loadingProgress.setVisibility(View.VISIBLE);
                view.setVisibility(View.VISIBLE);
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (generation != serverGeneration) return;
                loadingProgress.setVisibility(View.GONE);
                if (!pageFailed && trustedOrigin.contains(url)) CookieManager.getInstance().flush();
            }
            @Override public void onPageCommitVisible(WebView view, String url) {
                if (generation == serverGeneration && !trustedOrigin.contains(url)) {
                    view.stopLoading();
                    showError("This page left the selected server. Check your Harbor address.");
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && generation == serverGeneration)
                    showError(getString(R.string.connection_error));
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && generation == serverGeneration && response.getStatusCode() >= 400)
                    showError("The server returned an error (" + response.getStatusCode() + "). Check the address and try again.");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (generation == serverGeneration) showError(getString(R.string.secure_connection_error));
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                if (generation == serverGeneration) {
                    hideFullscreen();
                    serverGeneration++;
                    pendingDownload = null;
                    destroyWebView();
                    showError("Android’s web viewer stopped. Tap Try again to reopen Harbor.");
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int progress) {
                if (generation == serverGeneration && !pageFailed) loadingProgress.setProgress(progress);
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (generation != serverGeneration || leavingServer) { callback.onReceiveValue(null); return true; }
                cancelFileChooser();
                int mode = params.getMode();
                if (mode != FileChooserParams.MODE_OPEN && mode != FileChooserParams.MODE_OPEN_MULTIPLE) {
                    callback.onReceiveValue(null);
                    toast(mode == FILE_CHOOSER_OPEN_FOLDER ? "Use a desktop browser for folder uploads."
                            : "This file picker mode is not supported. Choose files using Upload.");
                    return true;
                }
                uploadCallback = callback;
                uploadGeneration = generation;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                ArrayList<String> accepted = new ArrayList<>();
                for (String type : params.getAcceptTypes()) {
                    if (type.matches("[a-zA-Z0-9.+-]+/(?:[a-zA-Z0-9.+-]+|\\*)")) accepted.add(type);
                }
                if (!accepted.isEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, accepted.toArray(new String[0]));
                try { startActivityForResult(intent, PICK_UPLOAD); }
                catch (ActivityNotFoundException error) { cancelFileChooser(); toast("No file picker is available on this device."); }
                return true;
            }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) { callback.onCustomViewHidden(); return; }
                fullscreenView = view;
                fullscreenCallback = callback;
                ((FrameLayout) getWindow().getDecorView()).addView(view,
                        new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                if (Build.VERSION.SDK_INT >= 30) {
                    getWindow().getInsetsController().hide(WindowInsets.Type.systemBars());
                    getWindow().getInsetsController().setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                } else {
                    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
                }
            }
            @Override public void onHideCustomView() { hideFullscreen(); }
        });
        webView.setDownloadListener((url, userAgent, disposition, mimeType, length) ->
                requestDownload(url, disposition, mimeType));
        loadHome();
    }

    private void loadHome() {
        if (origin == null || leavingServer) return;
        if (webView == null) { openServer(origin); return; }
        webView.loadUrl(origin + "/");
    }

    private void showError(String message) {
        pageFailed = true;
        if (webView != null) webView.setVisibility(View.GONE);
        loadingProgress.setVisibility(View.GONE);
        ((TextView) findViewById(R.id.error_message)).setText(message);
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void showMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.inflate(R.menu.main_menu);
        menu.setOnMenuItemClickListener(item -> {
            if (item.getItemId() == R.id.action_change_server) confirmServerChange();
            else if (item.getItemId() == R.id.action_home) loadHome();
            else if (item.getItemId() == R.id.action_reload) {
                if (webView != null) webView.reload(); else loadHome();
            }
            return true;
        });
        menu.show();
    }

    private void confirmExternalLink(Uri uri) {
        new AlertDialog.Builder(this).setTitle("Open in your browser?")
                .setMessage("This link leaves Harbor: " + uri.getHost())
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton("Open browser", (dialog, which) -> {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
                    catch (ActivityNotFoundException error) { toast("No browser is available."); }
                }).show();
    }

    private void confirmServerChange() {
        if (leavingServer) return;
        new AlertDialog.Builder(this).setTitle(R.string.change_server)
                .setMessage("This clears this app’s saved sign-in and cancels any active transfers. You’ll sign in again on the next server.")
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.change_server, (dialog, which) -> clearServer()).show();
    }

    private void clearServer() {
        leavingServer = true;
        serverGeneration++;
        cancelFileChooser();
        pendingDownload = null;
        cancelTransfer();
        hideFullscreen();
        destroyWebView();
        origin = null;
        preferences.edit().remove("server").apply();
        WebStorage.getInstance().deleteAllData();
        CookieManager.getInstance().removeAllCookies(removed -> {
            CookieManager.getInstance().flush();
            leavingServer = false;
            if (!isFinishing() && !isDestroyed()) showSetup();
        });
    }

    private void cancelFileChooser() {
        if (uploadCallback != null) {
            uploadCallback.onReceiveValue(null);
            uploadCallback = null;
        }
    }

    private void requestDownload(String url, String disposition, String mimeType) {
        if (origin == null || leavingServer) return;
        if (pendingDownload != null || transfer != null) { toast("Finish or cancel your current download first."); return; }
        try { DownloadPolicy.validate(origin, url); }
        catch (IllegalArgumentException invalid) { toast("This download is not a Harbor file."); return; }
        String mime = mimeType != null && mimeType.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")
                ? mimeType : "application/octet-stream";
        String name = DownloadPolicy.safeFilename(disposition, "Harbor download");
        pendingDownload = new PendingDownload(url, mime, name, serverGeneration);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime).putExtra(Intent.EXTRA_TITLE, name);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try { startActivityForResult(intent, SAVE_DOWNLOAD); }
        catch (ActivityNotFoundException error) { pendingDownload = null; toast("No file save picker is available."); }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_UPLOAD) {
            ValueCallback<Uri[]> callback = uploadCallback;
            uploadCallback = null;
            if (callback == null) return;
            if (resultCode != RESULT_OK || data == null || uploadGeneration != serverGeneration || leavingServer) {
                callback.onReceiveValue(null);
                return;
            }
            LinkedHashSet<Uri> chosen = new LinkedHashSet<>();
            ClipData clips = data.getClipData();
            if (clips != null) {
                for (int i = 0; i < Math.min(clips.getItemCount(), 500); i++) chosen.add(clips.getItemAt(i).getUri());
            } else if (data.getData() != null) chosen.add(data.getData());
            chosen.removeIf(uri -> !isExternalContentUri(uri));
            callback.onReceiveValue(chosen.isEmpty() ? null : chosen.toArray(new Uri[0]));
        } else if (requestCode == SAVE_DOWNLOAD) {
            PendingDownload pending = pendingDownload;
            pendingDownload = null;
            if (pending == null || resultCode != RESULT_OK || data == null || data.getData() == null
                    || pending.generation != serverGeneration || origin == null || leavingServer) return;
            Uri destination = data.getData();
            if (!isExternalContentUri(destination)) { toast("Choose a document location using Android’s file picker."); return; }
            startDownload(pending, destination);
        }
    }

    private boolean isExternalContentUri(Uri uri) {
        if (uri == null || !"content".equalsIgnoreCase(uri.getScheme()) || uri.getAuthority() == null) return false;
        android.content.pm.ProviderInfo provider = getPackageManager().resolveContentProvider(uri.getAuthority(), 0);
        return provider == null || !getPackageName().equals(provider.packageName);
    }

    private void startDownload(PendingDownload pending, Uri destination) {
        ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        int spacing = Math.round(24 * getResources().getDisplayMetrics().density);
        FrameLayout container = new FrameLayout(this);
        container.setPadding(spacing, spacing / 2, spacing, spacing);
        container.addView(progress);
        transferDialog = new AlertDialog.Builder(this).setTitle("Saving " + pending.name)
                .setMessage("Starting download…").setView(container)
                .setNegativeButton(R.string.cancel, (dialog, which) -> cancelTransfer())
                .setOnCancelListener(dialog -> cancelTransfer()).create();
        transferDialog.setCanceledOnTouchOutside(false);
        transferDialog.show();
        long generation = serverGeneration;
        String cookie = CookieManager.getInstance().getCookie(pending.url);
        transfer = FileTransfer.start(getContentResolver(), origin, pending.url, cookie, destination,
                new FileTransfer.Listener() {
                    @Override public void onProgress(long bytes, long total) {
                        if (generation != serverGeneration || transferDialog == null) return;
                        progress.setIndeterminate(total <= 0);
                        if (total > 0) progress.setProgress((int) Math.min(100, (bytes * 100.0) / total));
                        transferDialog.setMessage(Formatter.formatFileSize(MainActivity.this, bytes)
                                + (total > 0 ? " of " + Formatter.formatFileSize(MainActivity.this, total) : ""));
                    }
                    @Override public void onComplete(long bytes) {
                        finishTransfer();
                        if (generation == serverGeneration && !isDestroyed()) toast("Download saved.");
                    }
                    @Override public void onError(String message) {
                        finishTransfer();
                        if (generation == serverGeneration && !isDestroyed())
                            new AlertDialog.Builder(MainActivity.this).setTitle("Download couldn’t finish")
                                    .setMessage(message).setPositiveButton(android.R.string.ok, null).show();
                    }
                    @Override public void onCancelled() { finishTransfer(); }
                });
    }

    private void cancelTransfer() {
        if (transfer != null) transfer.cancel();
        if (transferDialog != null) { transferDialog.dismiss(); transferDialog = null; }
    }

    private void finishTransfer() {
        transfer = null;
        if (transferDialog != null) { transferDialog.dismiss(); transferDialog = null; }
    }

    @SuppressWarnings("deprecation")
    private void hideFullscreen() {
        if (fullscreenView == null) return;
        ((ViewGroup) fullscreenView.getParent()).removeView(fullscreenView);
        fullscreenView = null;
        if (fullscreenCallback != null) { fullscreenCallback.onCustomViewHidden(); fullscreenCallback = null; }
        if (Build.VERSION.SDK_INT >= 30) getWindow().getInsetsController().show(WindowInsets.Type.systemBars());
        else getWindow().getDecorView().setSystemUiVisibility(0);
    }

    @Override @SuppressWarnings("deprecation") public void onBackPressed() { handleBack(); }

    private void handleBack() {
        if (fullscreenView != null) { hideFullscreen(); return; }
        if (webView != null && !pageFailed && origin != null && origin.contains(webView.getUrl())) {
            WebView current = webView;
            long generation = serverGeneration;
            current.evaluateJavascript("(() => { const d = document.querySelector('dialog[open]'); if (d) { if (d.dispatchEvent(new Event('cancel', { cancelable: true }))) d.close(); return true; } return false; })()", result -> {
                if (current != webView || generation != serverGeneration) return;
                if ("true".equals(result)) return;
                if (current.canGoBack()) current.goBack(); else finish();
            });
        } else finish();
    }

    private void destroyWebView() {
        if (webView == null) return;
        cancelFileChooser();
        webView.stopLoading();
        webView.setDownloadListener(null);
        webView.setWebChromeClient(null);
        webView.clearCache(true);
        webView.clearHistory();
        ((ViewGroup) webView.getParent()).removeView(webView);
        webView.destroy();
        webView = null;
    }

    @Override protected void onPause() {
        if (webView != null) { webView.onPause(); CookieManager.getInstance().flush(); }
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }
    @Override protected void onDestroy() {
        serverGeneration++;
        pendingDownload = null;
        cancelTransfer();
        hideFullscreen();
        destroyWebView();
        super.onDestroy();
    }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
}
