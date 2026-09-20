#!/bin/sh
# Run from the Harbor project directory with the production .env configured.
set -eu
umask 077

if [ ! -f compose.yaml ] || [ ! -f .env ]; then
  echo "Run this from the Harbor project folder containing compose.yaml and .env." >&2
  exit 1
fi

mkdir -p backups
lock_dir="backups/.backup.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "Another backup may be running. If a previous backup was forcibly killed, verify it has stopped before removing backups/.backup.lock." >&2
  exit 1
fi

stopped=0
cleanup() {
  exit_status=$?
  trap - EXIT
  if [ "$stopped" -eq 1 ]; then
    if ! docker compose start app >/dev/null; then
      echo "Could not restart Harbor; run docker compose start app." >&2
      exit_status=1
    fi
  fi
  if ! rmdir "$lock_dir"; then
    echo "Could not release the backup lock." >&2
    exit_status=1
  fi
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! docker compose ps --status running --services | grep -qx app; then
  echo "Harbor must be running before this backup script starts." >&2
  exit 1
fi

archive="backups/harbor-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
if [ -e "$archive" ] || [ -e "$archive.partial" ]; then
  echo "Backup name already exists; try again in a moment." >&2
  exit 1
fi

stopped=1
docker compose stop app
docker compose run --rm --no-deps -T --entrypoint tar app -C / -czf - data storage > "$archive.partial"
mv "$archive.partial" "$archive"
printf 'Backup saved: %s\n' "$archive"
