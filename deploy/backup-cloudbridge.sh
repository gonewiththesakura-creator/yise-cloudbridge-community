#!/usr/bin/env bash
set -euo pipefail
umask 077
source "$(dirname "${BASH_SOURCE[0]}")/shell-common.sh"
mode=${1:---dry-run}
[[ $# -le 1 && "$mode" =~ ^--(dry-run|apply)$ ]] || { echo 'Usage: backup-cloudbridge.sh [--dry-run | --apply]' >&2; exit 2; }
if [[ "$mode" == --dry-run ]]; then
  printf 'DRY RUN: no files read, written, encrypted, or pruned.\n'
  printf 'Control database: %s\nS-UI database (optional): %s\nApplication config: %s\nDevice CA directory: %s\nBackup directory: %s\nRetention days (blank means no pruning): %s\n' \
    "${CB_DATABASE_PATH:-<required>}" "${SUI_DATABASE_PATH:-<omitted>}" "${CB_CONFIG_FILE:-<required>}" \
    "${DEVICE_CA_DIR:-<required>}" "${CB_BACKUP_DIR:-<required>}" "${BACKUP_RETENTION_DAYS:-}"
  exit 0
fi
for name in CB_APP_DIR CB_DATABASE_PATH CB_CONFIG_FILE DEVICE_CA_DIR CB_BACKUP_DIR BACKUP_PASSPHRASE_FILE NODE_BIN; do require_path "$name"; done
[[ -z ${SUI_DATABASE_PATH:-} ]] || require_path SUI_DATABASE_PATH
[[ -z ${BACKUP_RETENTION_DAYS:-} || ${BACKUP_RETENTION_DAYS} =~ ^[1-9][0-9]*$ ]] || { echo 'BACKUP_RETENTION_DAYS must be blank or a positive integer' >&2; exit 2; }
for file in "$CB_APP_DIR/server/sqlite-backup.mjs" "$CB_DATABASE_PATH" "$CB_CONFIG_FILE" "$BACKUP_PASSPHRASE_FILE"; do
  [[ -s "$file" && -r "$file" ]] || { echo "Required readable nonempty backup input is missing: $file" >&2; exit 1; }
done
[[ -d "$DEVICE_CA_DIR" ]] || { echo 'DEVICE_CA_DIR is missing' >&2; exit 1; }
[[ -z ${SUI_DATABASE_PATH:-} || -s "$SUI_DATABASE_PATH" ]] || { echo 'Configured SUI_DATABASE_PATH is missing' >&2; exit 1; }
mkdir -p -- "$CB_BACKUP_DIR"
work_dir=$(mktemp -d "$CB_BACKUP_DIR/.build.XXXXXX")
temporary=''
cleanup() { rm -rf -- "$work_dir"; [[ -z "$temporary" ]] || rm -f -- "$temporary"; }
trap cleanup EXIT
"$NODE_BIN" "$CB_APP_DIR/server/sqlite-backup.mjs" "$CB_DATABASE_PATH" "$work_dir/friendlink.db"
if [[ -n ${SUI_DATABASE_PATH:-} ]]; then
  "$NODE_BIN" "$CB_APP_DIR/server/sqlite-backup.mjs" "$SUI_DATABASE_PATH" "$work_dir/s-ui.db"
fi
install -m 600 -- "$CB_CONFIG_FILE" "$work_dir/cloudbridge.env"
cp -a -- "$DEVICE_CA_DIR" "$work_dir/device-ca"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
printf 'format=1\ncreated_utc=%s\nsqlite_snapshots=consistent_per_database\n' "$stamp" > "$work_dir/backup-manifest.txt"
temporary=$(mktemp "$CB_BACKUP_DIR/cloudbridge-$stamp-XXXXXX.tar.enc.tmp")
final=${temporary%.tmp}
tar -C "$work_dir" -cf - . | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -pass "file:$BACKUP_PASSPHRASE_FILE" -out "$temporary"
# Same-filesystem hard link publishes atomically and refuses to overwrite.
ln -- "$temporary" "$final"
rm -f -- "$temporary"
temporary=''
if [[ -n ${BACKUP_RETENTION_DAYS:-} ]]; then
  find "$CB_BACKUP_DIR" -maxdepth 1 -regextype posix-extended -type f \
    -regex '.*/cloudbridge-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]{6}\.tar\.enc' \
    -mtime "+$BACKUP_RETENTION_DAYS" -delete
fi
printf 'BACKUP_CREATED %s\n' "$final"
