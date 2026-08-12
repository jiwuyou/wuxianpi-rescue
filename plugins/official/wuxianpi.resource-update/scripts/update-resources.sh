#!/usr/bin/env bash
set -euo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
CANONICAL_SOURCE="${OPENHOUSEAI_CANONICAL_RESOURCE_MANAGER_SOURCE:-}"
MANAGER_TARGET="$PREFIX/bin/openhouse-resource-manager"
PLUGIN_COPY="$HOME/.local/share/wuxianpi/plugins/wuxianpi.resource-update/openhouse-resource-manager"

die() { printf '[resource-update-bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

resolve_source() {
  local candidate
  for candidate in "$CANONICAL_SOURCE" "$PLUGIN_COPY"; do
    [ -n "$candidate" ] && [ -f "$candidate" ] && [ ! -L "$candidate" ] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

install_canonical_manager() {
  local source="$1" temporary
  bash -n "$source" || die 'canonical resource manager failed syntax validation'
  mkdir -p "$PREFIX/bin"
  temporary="$MANAGER_TARGET.tmp.$$"
  install -m 700 "$source" "$temporary"
  cmp -s "$source" "$temporary" || die 'canonical resource manager write verification failed'
  mv -f "$temporary" "$MANAGER_TARGET"
}

main() {
  local source shell
  source="$(resolve_source)" || die \
    'canonical manager document is missing; workflow must write it before execution'
  install_canonical_manager "$source"
  shell="$PREFIX/bin/bash"
  [ -x "$shell" ] || shell="$(command -v bash)"
  exec "$shell" "$MANAGER_TARGET" "${1:-apply}"
}

main "$@"
