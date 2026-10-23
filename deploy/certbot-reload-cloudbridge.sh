#!/usr/bin/env bash
set -euo pipefail
umask 077
source "$(dirname "${BASH_SOURCE[0]}")/shell-common.sh"
mode=${1:---dry-run}
[[ $# -le 1 && "$mode" =~ ^--(dry-run|apply)$ ]] || { echo 'Usage: certbot-reload-cloudbridge.sh [--dry-run | --apply]' >&2; exit 2; }
if [[ "$mode" == --dry-run ]]; then
  printf 'DRY RUN: no certificates copied and no services changed.\n'
  printf 'Renewed lineage: %s\nCertificate target: %s\nKey target: %s\nRestart units: %s\nReload units: %s\n' \
    "${RENEWED_LINEAGE:-<required>}" "${DATA_PLANE_CERT_PATH:-<required>}" "${DATA_PLANE_KEY_PATH:-<required>}" \
    "${CERT_RESTART_UNITS:-<none>}" "${CERT_RELOAD_UNITS:-<none>}"
  exit 0
fi
for name in RENEWED_LINEAGE DATA_PLANE_CERT_PATH DATA_PLANE_KEY_PATH; do require_path "$name"; done
for name in CERT_OWNER CERT_GROUP; do require_account "$name"; done
require_value PROXY_SERVER_NAME
[[ "$PROXY_SERVER_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo 'Invalid PROXY_SERVER_NAME' >&2; exit 2; }
read -r -a restart_units <<< "${CERT_RESTART_UNITS:-}"
read -r -a reload_units <<< "${CERT_RELOAD_UNITS:-}"
validate_units "${restart_units[@]}" "${reload_units[@]}"
cert_dir=$(dirname "$DATA_PLANE_CERT_PATH")
[[ "$cert_dir" != / && "$cert_dir" == "$(dirname "$DATA_PLANE_KEY_PATH")" && "$DATA_PLANE_CERT_PATH" != "$DATA_PLANE_KEY_PATH" ]] || { echo 'Certificate and key targets must be distinct files in the same non-root directory' >&2; exit 2; }
certificate="$RENEWED_LINEAGE/fullchain.pem"
key="$RENEWED_LINEAGE/privkey.pem"
validate_server_certificate "$certificate" "$PROXY_SERVER_NAME"
cert_public=$(openssl x509 -in "$certificate" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)
key_public=$(openssl pkey -in "$key" -pubout -outform DER | openssl dgst -sha256)
[[ "$cert_public" == "$key_public" ]] || { echo 'Certificate and private key do not match' >&2; exit 1; }
install -d -m 750 -o "$CERT_OWNER" -g "$CERT_GROUP" -- "$cert_dir"
work_dir=$(mktemp -d "$cert_dir/.renew.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT
install -m 640 -o "$CERT_OWNER" -g "$CERT_GROUP" -- "$certificate" "$work_dir/fullchain.pem"
install -m 640 -o "$CERT_OWNER" -g "$CERT_GROUP" -- "$key" "$work_dir/privkey.pem"
mv -f -- "$work_dir/fullchain.pem" "$DATA_PLANE_CERT_PATH"
mv -f -- "$work_dir/privkey.pem" "$DATA_PLANE_KEY_PATH"
for unit in "${restart_units[@]}"; do systemctl restart "$unit"; done
for unit in "${reload_units[@]}"; do systemctl reload "$unit"; done
printf 'CERTIFICATE_INSTALLED\n'
