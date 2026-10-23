#!/usr/bin/env bash
# Shared validation only. Loading this file never changes the host.
require_value() {
  local name=$1 value=${!1:-}
  if [[ -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    printf '%s must be explicitly configured without line breaks\n' "$name" >&2
    return 1
  fi
}
require_path() {
  require_value "$1"
  local value=${!1}
  if [[ ! "$value" =~ ^/[A-Za-z0-9_./-]+$ || "$value" == / || "/$value/" == *'/../'* ]]; then
    printf '%s must be an absolute path without whitespace or traversal\n' "$1" >&2
    return 1
  fi
}
require_account() {
  require_value "$1"
  [[ "${!1}" =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || { printf 'Invalid account in %s\n' "$1" >&2; return 1; }
}
validate_units() {
  local unit
  for unit in "$@"; do
    [[ "$unit" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$ ]] || { printf 'Invalid service unit\n' >&2; return 1; }
  done
}

validate_server_certificate() {
  # OpenSSL's -checkend exits early; hostname checking must be a separate command.
  openssl x509 -in "$1" -noout -checkend 0 >/dev/null || return 1
  openssl x509 -in "$1" -noout -checkhost "$2" >/dev/null || return 1
}
