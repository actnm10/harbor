# Harbor for Android — 0.1.5-alpha

An Android companion for your own Harbor server. It opens Harbor's mobile file browser inside a native app, with Android's document pickers for uploads and downloads. Files, passwords, and previews stay on your Harbor server. There is no additional cloud account.

## Install and connect

1. Install the supplied `harbor-android-0.1.5-alpha.apk` on Android **10 or newer**. Android may ask you to allow installation from the app you opened the APK with.
2. Open **Harbor**, enter your server's full **HTTPS** address, and tap **Connect**. Use the same address configured as `APP_ORIGIN` on the server, without a folder path.
3. Sign in with your existing Harbor username and password. Usernames are case-sensitive.

Keep Android System WebView and Chrome updated. This update also switches Harbor's server PDF viewer to PDF.js's compatibility build, fixing PDF/PowerPoint rendering on WebView 133. Update the Harbor server from this source before testing previews on an older WebView. The app requires a valid server certificate; plain HTTP and invalid/self-signed certificates are refused.

## Using the app

- Browse folders, search, rename, delete, and manage files with Harbor's existing controls.
- Tap **Upload** to choose one or more files from Android's document picker. Keep Harbor open while uploads run.
- Use a desktop browser to upload whole folders. The Android app cancels folder-picker requests rather than uploading their contents without the folder structure.
- Tap a supported file to preview images, audio/video, text, Word, PDFs, Excel worksheets, and PowerPoint slides. Available formats and limits depend on your server version; PowerPoint needs the optional renderer service.
- Tap **Download** and choose where Android should save the file. A progress dialog offers cancellation. Downloads stream to the chosen location without buffering the whole file in memory. Keep the app open until it finishes.
- With Harbor server 0.1.5-alpha or newer, download selected files or a folder as a ZIP using the same save picker. Archives have an exact download size and retain safe Unicode names and empty folders. The server reports conflicting or unsupported names before starting the download.
- Android Back closes an open preview first, then moves through folder history. Video supports fullscreen playback where the device's codecs allow it.
- Use Harbor's theme toggle for the file browser. The native connection screen and toolbar follow the phone's light/dark setting, using the same slate palette.
- The toolbar menu offers **All files**, **Reload**, and **Change server**. Changing servers cancels transfers and clears the app's saved web sign-in and local web settings before reconnecting. To sign out without changing servers, use Harbor's existing sign-out control.

This first version focuses on foreground file access. It does not provide automatic camera backup, offline synchronization, background/resumable transfers, or a Share-to-Harbor target. Leaving or restarting the app can interrupt uploads. Canceled/failed downloads remove the newly created partial document when the chosen document provider supports deletion; otherwise the app asks you to remove it.

The supplied test APK uses the release build profile (WebView debugging disabled) with a development signing certificate. Keep using APKs signed by the same builder to update it in place. A future production signing key may require uninstalling the test app first, which clears its local sign-in but does not delete server files or files you saved elsewhere. Force-stopping the app or powering off the phone during a download can leave a partial file at the chosen destination; remove it before retrying.

## Build

Open this directory in Android Studio, or install JDK **17 or newer**, Android SDK Platform **35**, and Build Tools **35.0.0**. Set `ANDROID_HOME` to the SDK directory or add its path in an untracked `local.properties` file. The included wrapper uses Gradle **8.11.1**, with a pinned distribution checksum; Android Gradle Plugin is **8.10.1**.

```sh
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

On Windows use `gradlew.bat`. The test APK is generated at `app/build/outputs/apk/debug/app-debug.apk`. The release build deliberately has no embedded signing credentials; configure your own signing key for production distribution.

## Device tests

With a disposable emulator attached:

```sh
./gradlew :app:connectedQaAndroidTest
```

The `qa` build has a separate app id, `com.harborfiles.android.qa`. Its test fixture runs a local HTTPS server and trusts a **test-only** certificate only for `127.0.0.1`. The QA build generates its certificate and key locally using the JDK's tools, into ignored build output; no private test key is committed or distributed in the source. The normal debug/release APKs have no fixture CA or custom trust configuration and do not run this generator. Never distribute a QA APK as the app.

Unit tests cover URL/origin boundaries, bounded archive selections, download names, streaming responses, cancellation, and partial-file cleanup. Device tests exercise the actual Android WebView, authenticated ZIP downloads, unsupported folder-chooser cancellation, and lifecycle. See `VALIDATION.md` in this directory for recorded results and remaining physical-device checks.

## Implementation

The native app loads the selected server origin directly, so Harbor's existing Secure/HttpOnly cookies, CSRF tokens, and same-origin write checks keep working. It introduces no password store, JavaScript-to-native bridge, device token API, or server CORS exception. Native navigation and direct-resource checks reject other origins; Harbor's server Content Security Policy additionally restricts resource redirects and connections that WebView's request hook cannot intercept. Connect only to a Harbor server you trust. External HTTPS links require a user gesture and confirmation before opening in the system browser. Native authenticated downloads accept only Harbor's exact file-download route or its archive route with 1–100 distinct UUID selections and disable redirects before adding the session cookie.

No broad storage, photo-library, camera, or notification permission is requested. The system document picker grants access to user-selected documents. WebView file/content navigation, mixed content, and certificate bypasses are disabled. App backups are disabled; native preferences store only the selected server address. WebView stores the normal session cookie and browser settings until logout/expiry, server change, or app-data removal. WebView inspection is enabled only for development builds.

Design references: [Android WebView](https://developer.android.com/develop/ui/views/layout/webapps/webview), [safe URI loading](https://developer.android.com/privacy-and-security/risks/unsafe-uri-loading), [WebView file access risks](https://developer.android.com/privacy-and-security/risks/webview-unsafe-file-inclusion), and [system document access](https://developer.android.com/training/data-storage/shared/documents-files).
