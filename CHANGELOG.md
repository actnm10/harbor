# Changelog

## Unreleased

- Preview Excel workbooks with worksheet selection and readable saved cell values.
- Preview PowerPoint slides with layout, images, charts, zoom, and text view through an optional isolated local renderer.
- Distinguish file types with muted pastel icons in light and dark themes, including documents, spreadsheets, PDFs, and presentations.

- Keep the account setup username prompt visible when readline redraws the terminal.
- Exit account setup and password recovery cleanly on Ctrl+C or end of input, with terminal state restored and no unsettled-await warning.
- Check configuration and storage write access before prompting to create an owner; add a noninteractive `admin.js check` command and actionable mount-permission errors.
- Check write access to registered storage locations at startup, including mounts whose permissions changed after installation.
- Count only failed credentials toward password lockouts, while retaining independent request-burst and concurrent-password checks.
- Clear stale failed-password lockouts after console password recovery without restarting the app, and report the exact stored username.
- Recover once from a stale browser security token after another tab signs in, and show the server's retry time for authentication throttling.
- Prevent phone keyboards from autocapitalizing or autocorrecting case-sensitive usernames.

## 0.1alpha

Initial alpha release. Package version: `0.1.0-alpha`.

- Single administrator account with password recovery, persistent sessions, and protected file access.
- Folders, drag-and-drop uploads with progress and retry, downloads, search, media filters, rename, and deletion.
- Image and audio/video previews, readable text and Word previews, and PDF page navigation, zoom, and text view.
- Administration for upload limits, storage quota, session duration, and storage locations that preserve existing files.
- Responsive layouts with light and dark themes.
- Docker Compose deployment, optional Caddy HTTPS, backup and restore tooling, and Linux/Proxmox setup instructions.
- Integration coverage for authentication, uploads, storage safety, administration, and document preview limits.

This is an early development release. See [README.md](README.md) for setup and current limitations.
