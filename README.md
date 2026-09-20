# Harbor 0.1alpha

A personal file library you host yourself. One administrator account, a responsive web interface, folders, drag-and-drop uploads with progress, downloads, document and image previews, and browser-native audio/video playback.

Harbor runs as one Node.js 24 process with SQLite metadata and files on disk. Document previews use local libraries; files are never sent to a conversion service. The supplied Docker Compose deployment adds Caddy for HTTPS. No cloud account or subscription is required.

## What you get

- A private library protected by a login; no public registration or shared links.
- Folders and breadcrumbs, global search, media filters, sorting, and grid/list views.
- Multiple file uploads with progress, cancellation, and retry.
- Rename and download; permanent deletion requires confirmation in the interface.
- Images and audio/video previews with seeking. Playback depends on browser codec support.
- Text and Word document previews, plus a PDF viewer with page navigation, zoom, and text view.
- A light/dark theme toggle on the login page and in the library, remembered in your browser.
- An owner password change screen and an offline password recovery command.
- An Administration menu for upload limits, storage quota, session duration, and storage locations.

This version is for one owner, who is an administrator. Server-side admin permissions prepare for a future multiuser release; account creation and separate user libraries are not included yet. It also does not include desktop synchronization, public sharing, version history, a recycle bin, directory uploads, video transcoding, or antivirus scanning. Unsupported previews remain downloadable. HTML and SVG files are downloads only; uploaded content is never injected as application HTML.

## 1. Prepare your Proxmox guest

Use a maintained Debian or Ubuntu guest with Docker Engine and the Docker Compose plugin. Start with 2 CPU cores, 2 GB RAM, and enough disk space for the file quota plus the OS, database, and backups. These are initial sizing suggestions, not measured capacity guarantees.

For your planned LXC deployment, use an unprivileged Linux container and enable the **Nesting** and **keyctl** features before installing Docker. Configure permissions for any mounted storage as seen *inside* the guest. Do not make the container privileged or disable AppArmor to work around a Docker problem. Proxmox documents the required keyctl feature and recommends a QEMU VM for Docker when stronger host isolation is desired. The same Compose files work inside a VM. See the [Proxmox container reference](https://pve.proxmox.com/pve-docs/pct.1.html).

Install Docker using the official [Debian instructions](https://docs.docker.com/engine/install/debian/) or [Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/). Check that `docker compose version` works. Run the following deployment commands from an account authorized to use Docker.

Copy this entire `harbor` folder into your guest, for example `/opt/harbor`. Keep the SQLite database on a local filesystem that supports SQLite locking. Do not put the live database on an SMB/NFS share. File storage can use a separate disk mounted into the guest.

## 2. Configure storage and your hostname

From the project folder:

```sh
cp .env.example .env
```

Edit `.env`:

```dotenv
HARBOR_DOMAIN=files.your-domain.com
ACME_EMAIL=you@your-domain.com
DATA_PATH=/srv/harbor/data
STORAGE_PATH=/srv/harbor/storage
MAX_UPLOAD_BYTES=10737418240
MAX_STORAGE_BYTES=107374182400
SESSION_HOURS=12
```

Use your own hostname and email. Both paths are absolute paths inside the Linux guest. `DATA_PATH` holds the database and original file location. `STORAGE_PATH` is the root for additional storage folders managed through Administration. The defaults allow 10 GiB per file and 100 GiB of stored file content. The total is an application quota, not a reservation of physical disk space; leave free space for the database, logs, and other guest workloads.

Create **the exact directories you chose**, with UID/GID 1000 ownership, as used by the app's unprivileged Docker user:

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /srv/harbor/data /srv/harbor/storage
chmod 600 .env
```

For Proxmox bind mounts, map ownership appropriately on the host. Guest UID 1000 is not necessarily host UID 1000. Existing files placed in these directories are not automatically imported: upload files through Harbor so its metadata stays consistent. Use actual directories or mounted filesystems, not symbolic links.

Point your hostname's DNS record at your public IP. Forward TCP ports **80 and 443** to this guest; UDP 443 is optional for HTTP/3. Check IPv6 records and firewall rules if you use IPv6. Caddy obtains and renews the certificate and redirects HTTP to HTTPS; this requires a reachable hostname and the correct ports. See [Caddy's HTTPS guide](https://caddyserver.com/docs/quick-starts/https).

The Compose file publishes only Caddy's ports. Do not publish the app's port 3000, or your Proxmox management interface, to the internet. If your ISP uses CGNAT, ordinary port forwarding will not work; you will need a reachable address or a separately configured tunnel/reverse proxy.

## 3. Build and create your owner account

```sh
docker compose build --pull app
docker compose run --rm --no-deps app node admin.js init
```

The account command prompts for a username and a password without displaying the password. Use a unique passphrase of at least 15 characters. There are no default credentials and no web setup endpoint that someone else can claim. Passwords are hashed; they are not stored in `.env` or the Docker image.

## 4. Start Harbor

```sh
docker compose up -d
docker compose ps
docker compose logs --tail=100 app caddy
```

Open `https://files.your-domain.com` using the hostname you configured, and sign in with the account you just created. The first library is empty. Create a folder or drop files into the browser to begin.

Renaming a file to an existing name is rejected. Uploading a duplicate name is also rejected so an upload does not silently overwrite your data. Deleting a folder permanently deletes its contents.

## Try it privately first

This standalone configuration binds HTTP only to the Docker host's loopback interface:

```sh
docker compose -f compose.local.yaml build app
docker compose -f compose.local.yaml run --rm --no-deps app node admin.js init
docker compose -f compose.local.yaml up -d
```

On that machine, open `http://localhost:3000`. To evaluate a remote Linux guest from your own computer, create an SSH tunnel:

```sh
ssh -L 3000:127.0.0.1:3000 your-user@your-guest
```

Then visit `http://localhost:3000` on your computer. Keep this development configuration private. It has its own named data and storage volumes, separate from production. Do not combine the two Compose files, and do not use `down -v` if you want to preserve local evaluation data.

To use another local port, set `LOCAL_PORT` and a matching `LOCAL_ORIGIN` (for example, `3001` and `http://127.0.0.1:3001`) in the environment or a file passed with Compose's `--env-file` option. `HARBOR_IMAGE` optionally gives a test build its own image tag. A distinct Compose project name (`-p harbor-wsl-test`) also gives it separate data and storage volumes.

## Daily use and media

Search covers the entire library. Media categories also show matching files across folders. Uploads go into the active folder; from a global category they go to My files. Multi-file uploads are individual operations, so completed files remain saved if another file fails. An interrupted file must be retried from the beginning.

Harbor sends audio/video byte ranges so your browser can seek without downloading the entire file first. MP4/H.264, WebM, MP3, and other browser-supported formats generally work; the exact combination depends on your device. A `.mov` or `.mkv` file may require downloading and playing in another application. Harbor does not convert video. Large images are served at their original resolution; this version does not generate smaller thumbnails.

### Documents and appearance

Click a file to preview it. Text previews support common plain-text, Markdown, CSV, JSON, configuration, and source-code files. They show up to 1 MiB of text, including UTF-8 and BOM-marked UTF-16. Word `.doc` and `.docx` previews extract readable text; original fonts, page layout, tables, and images are available in the downloaded document. Word inputs are limited to 20 MiB, with additional time and expansion limits; encrypted or malformed documents may require downloading instead.

PDF previews support files up to 100 MiB, page navigation, zoom, and a selectable text view. Scanned pages may have no selectable text. PDF scripts, interactive forms, and annotation actions are disabled. Files remain downloadable at their original quality regardless of preview support.

Use **Dark mode** at the top right or on the login screen. Harbor starts with your system preference and remembers an explicit choice in that browser.

### Administration and storage

Open your account menu and choose **Administration**. The existing owner is automatically an administrator after upgrading. Admin access is enforced by the server; a regular user role cannot read or change these settings.

You can change the per-file upload limit, total library quota, simultaneous upload limit, and lifetime of new sessions. Saved values persist in the database and take precedence over the environment defaults on subsequent starts. Quotas cannot be reduced below stored content plus space reserved by uploads. A running upload keeps its original limit and destination. Changing session duration applies to new sign-ins.

The storage selector controls **where new uploads are stored**. The original location remains inside `/data/blobs`. Enter a name under **Add a storage location** and choose **Create & use** to add a folder beneath the configured storage root (`/storage` in Docker). Existing files remain in their current location and stay accessible when you switch destinations. This is not a file migration or import tool.

To use another disk, mount it in your Linux guest, prepare ownership, and set `STORAGE_PATH` in `.env` before deployment. The Administration screen displays the configured root but cannot mount disks or browse arbitrary server directories. To move an already initialized storage root, stop Harbor, copy its complete contents including hidden marker files to the prepared replacement, change `STORAGE_PATH`, and restart. Preserve both the original and new copy until you have verified downloads. A missing or replaced location stops storage access instead of silently writing into an empty mount point. Never remove or edit `.harbor-location.json` markers.

## Password recovery

Change your password from the account menu while signed in. A password change invalidates existing sessions and requires signing in again.

If you forget it, run this command from your Linux guest:

```sh
docker compose exec app node admin.js reset-password
```

If the app is stopped, use `docker compose run --rm --no-deps app node admin.js reset-password`. The command prompts for the new password and revokes all sessions. Anyone with access to the Docker host and storage can administer the account, so secure your guest and Proxmox login accordingly.

## Back up and restore

Back up **both the entire data directory and storage root**, including their hidden marker files, plus your deployment configuration. File names, locations, settings, and folder relationships live in the database. Copying only the uploaded blobs is not a usable full backup.

For a consistent backup, run from the project folder. Harbor stays offline for the entire archive creation, which can take a while for a large library:

```sh
sh deploy/backup.sh
```

The script stops the app, saves a dated archive under `backups/`, and starts it again even if the backup fails. The archive contains `data/` and `storage/`, including hidden files. It expects the normal production Compose configuration. Store another copy off the guest, and protect archives because they contain your files, password hash, and session records. The script is manual; it does not schedule anything.

To restore a trusted backup:

1. Stop Harbor with `docker compose stop app`.
2. Preserve the current data directory and storage root as separate recovery copies.
3. Create a new empty recovery directory and extract the archive there, for example:

   ```sh
   sudo install -d -m 0700 -o 1000 -g 1000 /srv/harbor/restored
   sudo tar -xzf backups/harbor-YYYYMMDDTHHMMSSZ.tar.gz -C /srv/harbor/restored
   sudo chown -R 1000:1000 /srv/harbor/restored
   ```

4. Set `DATA_PATH=/srv/harbor/restored/data` and `STORAGE_PATH=/srv/harbor/restored/storage` in `.env`.
5. Run `docker compose run --rm --no-deps app node admin.js reset-password` to replace the restored password and invalidate restored sessions.
6. Run `docker compose up -d` and verify several folders and downloaded files.

Test restoration before relying on your backup. Proxmox bind-mounted directories are not necessarily included in guest backups; explicitly check coverage for your storage configuration.

For legacy archives with the database and blobs at the archive root, extract into a fresh data directory, point `DATA_PATH` there, and prepare a separate empty `STORAGE_PATH`. The first startup initializes the storage metadata. Use this legacy layout instead of the two-directory restore paths above.

## Updates

Back up first, then install updated source and rebuild. When upgrading from an early development build without separate storage, add `STORAGE_PATH` to `.env` and create that directory with UID/GID 1000 ownership before rebuilding. Existing files retain their original location and the owner becomes an admin automatically. Database changes run at startup; retain your backup if you need to return to an older version.

```sh
docker compose build --pull app
docker compose pull caddy
docker compose up -d
```

Both bind mounts persist across image rebuilds and container replacement. The supplied base image tags follow maintained major versions; pin image digests if your environment requires reviewed, reproducible rollouts.

## Security design and limits

The application uses scrypt password hashing, random session cookies with server-side records, CSRF tokens, origin checks for writes, login throttling, upload quotas, role checks, and opaque storage names. Production cookies are Secure and HttpOnly. All file listing, previews, and downloads require an authenticated session. Uploaded active content is never rendered as app HTML. The app runs without root or Linux capabilities in a read-only Docker image, with separate writable data and storage mounts.

The reverse proxy overwrites `X-Real-IP` before it reaches the app. `TRUST_PROXY=true` is appropriate only when app traffic must come through that trusted proxy. If you replace Caddy, preserve that behavior and keep the app inaccessible directly. These choices follow [OWASP's session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and [file upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

Harbor 0.1alpha is an early development release and has not received an independent security audit. It has no MFA, malware scanning, or encryption at rest. Use storage encryption if you need protection against offline disk access. Keep the guest, Node image, and Caddy patched. Run only one app instance against a data directory; horizontal replicas are not supported.

## Development

Install Node.js **24.15 or newer within the 24.x series** and pnpm **11.19.0**. The app uses the built-in `node:sqlite` API, currently labeled release candidate in the [Node 24 documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html). Install the locked dependencies before running it:

```sh
pnpm install --frozen-lockfile
node admin.js init
node server.js
node --test
```

PDF.js assets are included in `public/vendor/pdfjs`; run `pnpm vendor` after changing its dependency version. See `THIRD_PARTY.md` for sources and licenses. Docker installs only production dependencies and uses the included browser assets.

Default development address: `http://localhost:3000`. Runtime environment variables are `DATA_DIR`, `STORAGE_ROOT`, `HOST`, `PORT`, `APP_ORIGIN`, `NODE_ENV`, `TRUST_PROXY`, `MAX_UPLOAD_BYTES`, `MAX_STORAGE_BYTES`, `MAX_CONCURRENT_UPLOADS` (default 4), and `SESSION_HOURS`. Without an explicit root, new storage folders live under `DATA_DIR/storage`; an explicitly configured `STORAGE_ROOT` must already exist. Limit variables seed the first configuration, then saved admin settings take precedence. Production requires an HTTPS `APP_ORIGIN`. For local configuration in a file, Node also accepts `--env-file=your-file.env` before the script name; the server does not load `.env` automatically. Docker Compose uses `.env` for its own substitution.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| App cannot write storage | Both paths exist and are writable as UID/GID 1000 inside the guest; inspect bind-mount UID mapping. |
| Storage marker or mount error | Restore the correct mounted directory, including hidden `.harbor-location.json` markers. Do not erase markers or initialize a replacement over missing data. |
| Word or PDF preview unavailable | Check format and size limits; encrypted, damaged, or unsupported documents remain downloadable. |
| HTTPS certificate fails | DNS points to the guest's public address, ports 80/443 reach Caddy, IPv6 is correct, and no other service occupies the ports. |
| Login fails or writes return Forbidden | Browse the exact configured hostname and scheme. Verify `APP_ORIGIN` and avoid mixing `localhost` with `127.0.0.1`. |
| Login temporarily blocked | Wait for the throttle window; check the password and trusted proxy client-IP configuration. |
| Upload fails | Check the per-file limit, total quota, physical free space, and duplicate names; retry a canceled file. |
| Video has no picture or sound | The browser may not support its codecs; download and play it locally or convert it outside Harbor. |
| Caddy shows 502 | Check the app's health and logs; the app stays stopped while a backup archive is created. |
