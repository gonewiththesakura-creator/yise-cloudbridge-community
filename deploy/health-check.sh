#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/shell-common.sh"
mode=${1:---dry-run}
[[ $# -le 1 && "$mode" =~ ^--(dry-run|check)$ ]] || { echo 'Usage: health-check.sh [--dry-run | --check]' >&2; exit 2; }
if [[ "$mode" == --dry-run ]]; then
  printf 'DRY RUN: no network requests or host inspection.\n'
  printf 'Console health URL: %s\nS-UI check: %s\nOptional service units: %s\nOptional UDP listen port: %s\n' \
    "${HEALTH_CONSOLE_URL:-<required>}" "$([[ -n ${SUI_API_URL:-} ]] && echo configured || echo omitted)" \
    "${HEALTH_SERVICE_UNITS:-<none>}" "${HEALTH_TUIC_PORT:-<none>}"
  exit 0
fi
require_value HEALTH_CONSOLE_URL
require_path NODE_BIN
# Node validates URLs, refuses redirects, and checks response bodies without logging tokens.
"$NODE_BIN" "$(dirname "${BASH_SOURCE[0]}")/health-check.mjs"
read -r -a units <<< "${HEALTH_SERVICE_UNITS:-}"
validate_units "${units[@]}"
for unit in "${units[@]}"; do systemctl is-active --quiet "$unit"; done
[[ ${#units[@]} -eq 0 ]] || echo SERVICES_OK
if [[ -n ${HEALTH_TUIC_PORT:-} ]]; then
  [[ "$HEALTH_TUIC_PORT" =~ ^[0-9]+$ && "$HEALTH_TUIC_PORT" -ge 1 && "$HEALTH_TUIC_PORT" -le 65535 ]] || { echo 'Invalid HEALTH_TUIC_PORT' >&2; exit 2; }
  [[ -n "$(ss -H -lun "sport = :$HEALTH_TUIC_PORT")" ]] || { echo 'No local UDP listener on HEALTH_TUIC_PORT' >&2; exit 1; }
  echo TUIC_UDP_LISTEN_OK
fi
