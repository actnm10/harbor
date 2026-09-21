# Verification record

## 0.1.5-alpha — recycle bin and file management

Verified September 21, 2026 with disposable files and accounts. The release adds recycle-bin retention/recovery, bounded bulk moves/copies, folder imports, ZIP64 downloads, and Android ZIP support.

The final Linux Docker image passed **125/125 checks** with no skips in 17.67 seconds using Node.js 24.21.0 and UID/GID 1000. The container had no network or published ports, a read-only root and test mount, dropped capabilities, a 1 GiB memory limit, a 100-process limit, and a 512 MiB temporary filesystem. Test-file concurrency was limited to two: the earlier unrestricted test runner aborted a worker under the bounded container resources. This is a test-runner setting, not a change to the app's runtime limits. The Windows run passed **118 checks with five Linux-only skips**; after the final Android folder-picker guard and retention help text, all **41 frontend checks** passed again. The final 14 operation checks also passed on Windows, including a bin with 10,002 entries across two valid roots, the exact 10,000-entry operation boundary, and rejection of a larger individual tree without changes.

An independent migration/recovery check constructs the original database schema and old saved settings, preserves an existing administrator and file bytes, recycles a folder, stops Harbor, copies the complete backup to a new path, and restores that folder from the recovered bin despite a name conflict. Operation tests cover quota including retained trash and copy reservations, independently trashed descendants, cycle/depth/conflict rejection, partial purge retry after restart, missing mount safety, expired retention, session revocation, pending request bodies, source/destination locks, client cancellation, interrupted copy cleanup, and shutdown during archives. Text/slide/content paths reject items recycled while asynchronous work is pending.

ZIP tests use an independent reader and CRC implementation to verify byte equality, Unicode, empty files/directories, exact lengths, corrupted/truncated archives, cancellation/backpressure, unsafe names, and ZIP64 size/offset boundaries. A separate Python standard-library reader also opened a real streamed ZIP64 archive and verified its payloads. Boundary tests inspect plans/headers above 4 GiB; they do not claim a multi-gigabyte phone transfer was performed.

Browser checks exercised real bulk copies and moves, rejection of occupied names, recycling/restoring a populated folder, a real nested directory picker upload, a ZIP download that leaves the library open, and saving retention settings. Desktop slate-dark and 390-by-844 light/dark layouts were inspected, including selection controls, list/grid views, the destination picker, and Administration. The phone-size page and dialog had no horizontal overflow; the final browser session logged no console warnings or errors. Browser checks caught and resolved a FileHandle stream completion hang in copies; copying now uses a bounded explicit read/write loop with cancellation and cleanup.

Android **0.1.5-alpha** passed **15 JVM tests and 13 emulator tests**, including native authenticated ZIP saving and rejection of unsupported directory selection. The exact signed APK updates the previous test app and retains its development certificate. See [android/VALIDATION.md](android/VALIDATION.md). No physical phone or live Proxmox deployment was modified or tested in this release. Folder-tree uploads require a desktop browser; Android supports individual/multiple files. The earlier Office-renderer trials below remain historical; real LibreOffice conversion was not repeated for these file-management changes.

### Earlier verification

Verified on September 20, 2026 using Node.js 24.19.0 on Windows and Node.js 24.21.0 inside Docker on Ubuntu-26.04 / WSL 2.

## Office previews and file colors

The full Office-preview suite passed 87/87 tests on Linux with no skips (15.76 seconds), and 82 tests on Windows with five Linux-only skips (26.90 seconds). The Linux image ran as UID/GID 1000 with a read-only root, no network, all capabilities dropped, a 1 GiB memory limit, a 100-process limit, and a 256 MiB temporary filesystem. Test helpers are excluded from the test-file glob. A subsequent HTML-only fix preserves the Download link's accessible name on phones; all seven focused file-category/accessibility tests passed after that adjustment.

Excel cases cover legacy XLS and modern XLSX, ordered worksheet selection, sparse coordinates, formatted values, cached formulas, Unicode, literal markup, empty worksheets, and output truncation. Malformed compound files, excessive shared-string counts, unsafe ZIP paths, excessive XML depth/size, DTDs, and expansion limits are checked before parsing in a bounded worker. Existing Word and authentication regressions continue to pass.

Presentation cases exercise authenticated access, session invalidation during conversion, private socket requests containing document bytes only, invalid/oversized responses, cancellation, conversion timeouts, process cleanup, and reuse after failure. The automated lifecycle cases use a controlled fake converter. Separate real LibreOffice 7.4.7 (Debian package 4:7.4.7-1+deb12u14) trials converted synthetic two-slide PPTX and legacy PPT presentations in the isolated renderer container. Both PDFs contained two pages and preserved the sample shapes, embedded image, chart labels, and values; temporary files were removed after each conversion.

A separate Compose test project verified socket permissions, healthy startup, and authenticated Excel/PowerPoint previews through the app. Browser checks covered worksheet switching, percentages/cached values, literal markup, empty sheets, the PowerPoint image and chart slides, slide navigation, selectable text, and full-slide fitting. Light and slate-dark file colors were visually checked. At a 390-by-844 viewport, worksheets scrolled horizontally inside the dialog without page overflow and slide controls remained usable. These are browser viewport checks, not a physical Android-device test. Production Caddy/Compose files and live deployment volumes were unchanged.

## Setup and login bug fixes

The final rebuilt Linux image passed all 58 automated tests with no skips in 15.16 seconds using Node.js 24.21.0, UID/GID 1000, a read-only root filesystem and test mount, no network, all capabilities dropped, a 1 GiB memory limit, a 100-process limit, and a 256 MiB temporary filesystem. The full Windows run passed all 54 platform-independent tests in 24.00 seconds; the affected preflight suite was rerun after the final permission-diagnostic adjustment and passed with its four Linux-only cases skipped. The production Docker image built successfully, including the new preflight module.

The follow-up suite adds five authentication regressions, eleven installation/storage checks, and eleven browser-logic checks. Authentication cases exercise real HTTP requests and SQLite: successful sign-ins do not spend failed-password allowance, console password recovery unlocks the running server and revokes old sessions, the independent burst limit survives recovery, and concurrent/delayed guesses cannot exceed the remaining failure allowance.

Installation checks verify noninteractive operation, early failure before account prompts, preservation of stored files and markers, missing-mount and symlink rejection, and temporary probe cleanup. Linux tests run as UID/GID 1000 and cover unwritable roots, registered folders, unreadable identity markers, and non-traversable folders. The four tests that depend on Unix permissions are skipped on Windows and must pass on Linux.

Browser-logic tests execute the shipped JavaScript with small DOM, network, and clock doubles. They cover one-time recovery from the server's explicit pre-action CSRF rejection, simultaneous stale-tab writes, raw upload recovery, no replay on other errors, protection against old responses expiring a newer sign-in, cooldown expiry/cancellation, credential case and whitespace, and mobile username input attributes. These are automated request/control-flow checks, not a new physical Android or manual browser test.

The terminal regression harness was rerun against the updated CLI, preflight, and account modules: all 13 PTY flows passed in 17.59 seconds, including the original erased-prompt negative control. Passwords were generated only for disposable test accounts and never printed. The live WSL instance and the Proxmox deployment were not changed.

## Automated application checks

All 31 integration tests in `test/server.test.js` pass on both platforms: 18.9 seconds on Windows and 12.2 seconds in the Linux container. Tests run against real HTTP servers, real SQLite databases, and temporary file storage, without bypassing authentication.

The Linux suite ran as the image's nonroot `node` user with a read-only root filesystem and test mount, no external network, all capabilities dropped, a 1 GiB memory limit, and a 256 MiB temporary filesystem for fixtures. The command used `env -u STORAGE_ROOT node --test` so the Docker image's deployment storage default did not override the tests' temporary directories.

Covered behaviors include:

- Protected listings and downloads, login, cookie properties, origin and CSRF checks.
- Session persistence across restarts, password changes, and session invalidation.
- Folder creation, global search and filters, renaming, deletion, and duplicate-name rejection.
- Byte-for-byte binary upload/download and normal, suffix, and invalid media ranges.
- Active-content download containment and invalid file/path rejection.
- File-size limits, total-storage reservations, simultaneous uploads, and interrupted-upload cleanup.
- Deleting a folder during an upload and recovering the upload slot afterward.
- Login rate limiting and delayed request-body concurrency limits.
- Administrator-only settings and storage routes, including role revocation while a request body is pending.
- Atomic settings validation, persisted limits, unchanged expiry for existing sessions, and quota checks that include active upload reservations.
- Migration of the original database and owner to the administrator role without losing existing file content.
- Storage switching, per-file storage tracking, restart persistence, deletion from the correct location, and uploads retaining their starting location and size limit.
- Storage root relocation, missing-mount detection, safe folder names, and rejection of symlinks or replacement folders missing identity markers.
- Authenticated, inert text previews and bounded truncation; successful extraction of genuine DOC and generated DOCX fixtures.
- Rejection of malformed Word documents, inputs above 20 MiB, and DOCX archives exceeding the 40 MiB expanded-size limit.
- Prompt rejection of legacy DOC allocation headers with excessive sector sizes/counts, out-of-range references, cyclic sector chains, or oversized stream claims, followed by successful extraction of a valid document.

The interactive account setup was also exercised in a disposable directory: it creates an owner successfully and hides password entry. JavaScript syntax checks and the backup script's shell syntax check pass.

A follow-up Linux Docker PTY regression run verified the account-prompt fix after the initial `0.1alpha` release. All 13 checks passed in 16.87 seconds: the username prompt remains visible after actual terminal cursor/erase operations, valid setup creates exactly one owner without echoing passwords, Ctrl+C and Ctrl+D at every setup prompt exit cleanly without creating an owner, mismatched passwords make no changes, and password-reset cancellation works at both hidden prompts. The original script reproduced the erased username prompt as a negative control. Tests used disposable read-only containers with temporary-memory storage, no published ports, and no live volumes. A separate Windows terminal check also confirmed the visible prompt and clean Ctrl+C exit. The application syntax check passes.

## Browser checks

Verified in the local Chromium-based browser using disposable test data:

- Sign-in, folder creation, empty folders, and breadcrumb navigation.
- A real file-chooser upload, upload completion, and download initiation.
- Renaming, cross-folder media categories, global search, and grid/list switching.
- PNG decoding, WAV decoding with native controls, and complete playback of a muted two-second H.264/AAC MP4.
- Plain-text preview, readable legacy DOC and modern DOCX previews, and literal markup displayed as text.
- A two-page PDF rendered to canvas, next-page navigation, 125% zoom, and selectable page text.
- Quick PDF zoom/page changes followed by mobile resizing, with a fitted page, no horizontal viewer overflow, and no browser warnings or errors.
- Administration access for the migrated owner, saving settings, creating a storage location, and three new uploads appearing in that location while older files remain accessible.
- Light/dark selection persisting across reload and sign-out, dark login, and the administration layout at a 390-pixel mobile viewport without horizontal page overflow.
- The revised slate blue/gray dark palette visually checked in the library and Administration, including supporting text and controls.
- A 390-pixel mobile viewport, navigation open/close, active-link closure, and exclusion of the closed sidebar from keyboard focus.
- Sign-out returning to the login page and clearing private library/preview state.
- Sign-out clearing the private storage paths and values from the administration dialog.

The drag-and-drop handlers and cancellation/retry UI were reviewed; a native drag gesture and interrupted browser transfer were not separately automated. The backend cancellation cases are covered by the integration tests above.

The WSL deployment was also checked from the Windows browser at `http://127.0.0.1:3001`: admin sign-in, folder listing, PDF page rendering/navigation/text view, and a real file-chooser upload all passed.

## Backup orchestration

A disposable Docker-command stub verifies four script paths: successful publication and restart, archive failure with restart, restart failure reporting, and exclusion of overlapping runs. The updated harness requires the exact archive arguments `-C / -czf - data storage`. It uses local fixture directories and native Windows Git-shell tar to verify that both trees, their identity markers, database bytes, and external file bytes appear in the archive.

All four cases pass. The failure case preserves the tar exit status and leaves the incomplete archive unpublished; a restart failure returns nonzero, and an overlapping invocation cannot start a second archive.

A real Docker backup-and-restore trial also passed in WSL. The test app was stopped while both volume trees were archived, then recreated and brought back healthy. All five original sample files retained their SHA-256 hashes. The archive was restored into two fresh volumes and a separate nonroot container with no external network or published ports. Restored file hashes/sizes, three text/Word previews, video range responses, administrator role, settings, active storage location, and both location snapshots matched the original. The disposable restored container and volumes were removed after verification; the private test backup was retained. An additional browser upload made after the backup stayed only in the live test instance.

## Deployment limits

The locked production and PDF renderer dependencies were checked with `pnpm audit`; no known advisories were reported at verification time.

The Docker image built successfully using the locked production dependencies. The separate `harbor-wsl-test` Compose project starts healthy on Docker Engine 29.1.3 and Compose 2.40.3. Windows can reach it at `http://127.0.0.1:3001`; Docker publishes only the loopback address. The running container uses UID/GID 1000, a read-only root filesystem, and correctly owned persistent data/storage volumes.

The deployed instance passed authenticated sample uploads, byte-for-byte downloads, text/DOC/DOCX previews, video range requests, and administration checks across both storage locations. The local Compose configuration now supports a separate port, matching origin, and image tag and allows 30 seconds for shutdown cleanup.

Public DNS, HTTPS certificate issuance, and the final Proxmox guest deployment remain untested. WSL testing does not establish public deployment readiness.

LAN phone testing was subsequently enabled using the Windows host's private LAN address. Windows forwards the configured LAN endpoint to the WSL loopback connection; a named inbound TCP rule is restricted to the local subnet on the Private profile. Harbor's exact origin was updated to that LAN URL. Windows-side health, admin login/settings, anonymous access rejection, and rejection of unrelated or old loopback origins passed. Physical phone connectivity has not been verified by the agent.

This record is development verification, not an independent security audit. Load testing, a large production library, and multi-gigabyte transfers have not been exercised.
