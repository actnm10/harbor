# Verification record

Verified on September 20, 2026 using Node.js 24.19.0 on Windows and Node.js 24.21.0 inside Docker on Ubuntu-26.04 / WSL 2.

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
