# Android 0.1alpha validation

Test environment: Windows host, JBR 21, Gradle 8.11.1, Android Gradle Plugin 8.10.1, SDK/target 35, minimum SDK 29. A fresh Android 16 / API 36 emulator used Android System WebView **133.0.6943.137**. Tests used synthetic files/accounts and a test-only loopback HTTPS certificate; no production credentials or user files were used.

## Automated checks

- **14 JVM tests passed:** exact HTTPS origins and ports; malformed/credential-bearing URL rejection; exact native download routes; safe Unicode filenames; byte-exact streaming; redirects and error responses; absent/invalid session cookies; truncation; cancellation and failed partial-file cleanup.
- **11 Android instrumentation tests passed:** real HTTPS page loading; HttpOnly session cookie and CSRF writes; direct foreign-resource blocking; invalid server input; TLS rejection; cookie persistence across activity recreation; rotation; Back handling with a cancel-preventing busy dialog; actual WebView file-picker uploads; authenticated native downloads; save-picker recreation; server changes clearing cookies and local storage; and the actual shipped PDF.js browser/worker rendering a real PDF with extracted text and painted canvas pixels. Related assertions are grouped into eleven test methods.
- **19 focused server/frontend tests passed** after the PDF compatibility change. A disposable HTTP server additionally delivered both exact viewer assets for GET/HEAD with JavaScript MIME types and `nosniff`; excluded QuickJS URLs still returned 404.
- The release-profile APK builds successfully, and release lint reports no errors. Nonblocking lint warnings concern available tooling/test-library updates, unused resources, view backgrounds, and the setup field's simultaneous label/hint.
- Native setup and PDF test screenshots were visually reviewed for layout, insets, and rendered text.

After deleting the generated credential files, the QA build created fresh loopback-only keys and certificates with the local JDK and passed all **11 instrumentation tests** again. The PDF test applied Harbor’s exact Content-Security-Policy and recorded **zero policy violations** while rendering real text and canvas pixels. Gradle task-graph checks confirmed that all JVM tests and normal debug/release builds exclude QA credential generation.

The original PDF.js standard bundle failed on WebView 133 because a typed-array method was missing. Both browser and worker now use the **unmodified official PDF.js 6.3.289 compatibility bundles**. Their matching package bytes and license notices are retained. This change must be deployed on the server to benefit an installed Android app.

## Distribution boundary

The supplied app is built using the release profile and signed with a local development certificate for installation testing. The normal app id is `com.harborfiles.android`; the separate instrumented build uses `.qa`. The distributable must have debugging disabled, only the Internet permission, and no QA certificate, test server key, test provider, or custom certificate trust. Signing keys and build caches are excluded from source packaging. QA certificates and private keys are generated locally for each QA build into ignored build output; no private keys are published with the source. Normal debug/release builds and their unit tests do not run the QA generator.

The exact **83,488-byte** `harbor-android-0.1alpha.apk` passed signature verification (APK Signature Scheme v3) and alignment checks. Its SHA256 is `5da5b8515d33afec3decf84941ddd4a62588fbae5e11fc0eb3aae866f1a1ea3f`; the development certificate SHA256 is `ef3a5456e9cc77c975e0b1f4e3d45edeaf78ba6ef25621420f1d7f1bb0c72aa8`.

Compiled manifest, DEX, resource, and archive inspection confirmed `BuildConfig.DEBUG=false`, release build type, Android debugging disabled, only `INTERNET`, disabled backups/cleartext traffic, and no custom trust configuration, fixture CA/key, test classes, or provider. Installing this exact APK on the disposable API 36 emulator succeeded; its cold launch took 1.451 seconds and displayed the address field and **Connect** button. Android also refused `run-as` access because the package is not debuggable. No credentials were entered during this distribution smoke check.

## Remaining device checks

No physical phone was attached. Try your own server/account and real files on your phone, especially large transfers, your chosen document provider, media codecs/fullscreen video, and Office files with unusual fonts. The complete Harbor web file browser and Office layouts were checked in the earlier desktop/mobile-browser validation; the Android device tests specifically exercise native integration and the shared PDF engine.

Android 10–15 were not separately emulated. Foreground transfers can be interrupted by process termination, device shutdown, or leaving the app; this version does not promise background/resumable transfers or offline synchronization. A forced process stop may leave a partial download for manual removal.
