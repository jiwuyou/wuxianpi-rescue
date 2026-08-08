#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENHOUSEAI_UPDATE_RESOURCES_ROOT:-$HOME/.local/share/openhouseai/update-resources}"
MARKET_URL="${WUXIANPI_RESCUE_MARKET_URL:-https://wuxianpirescue.webefficacy.com}"
MARKET_URL="${MARKET_URL%/}"
RESOURCE_ID="${OPENHOUSEAI_RESOURCE_ID:-openhouse-runtime}"
CURRENT="$ROOT/resources/$RESOURCE_ID/current"
VERSIONS="$ROOT/resources/$RESOURCE_ID/versions"
mkdir -p "$VERSIONS"

latest_apk_dir=""
for candidate in $(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name 'apk-*' 2>/dev/null | sort -r); do
  [ -f "$candidate/.complete" ] || continue
  [ -f "$candidate/product-payloads/runtime-aarch64.tgz" ] || continue
  latest_apk_dir="$candidate"
  break
done

catalog="$(mktemp)"
archive=""
trap 'rm -f "$catalog" "$catalog.tmp"' EXIT HUP INT TERM
if command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 && curl -q -fsS --max-time 12 "$MARKET_URL/api/v1/resources" > "$catalog" 2>/dev/null; then
  archive="$(jq -r --arg id "$RESOURCE_ID" '.resources[] | select(.id == $id) | .archive' "$catalog" | head -n 1)"
  version="$(jq -r --arg id "$RESOURCE_ID" '.resources[] | select(.id == $id) | .version' "$catalog" | head -n 1)"
  url="$(jq -r --arg id "$RESOURCE_ID" '.resources[] | select(.id == $id) | .url' "$catalog" | head -n 1)"
  expected_size="$(jq -r --arg id "$RESOURCE_ID" '.resources[] | select(.id == $id) | .size' "$catalog" | head -n 1)"
  expected_sha="$(jq -r --arg id "$RESOURCE_ID" '.resources[] | select(.id == $id) | .sha256' "$catalog" | head -n 1)"
  if [ -n "$archive" ] && [ "$archive" != null ] && curl -q -fsS --max-time 60 "$MARKET_URL${url}" -o "$catalog.tmp"; then
    actual_size="$(stat -c '%s' "$catalog.tmp")"
    actual_sha="$(sha256sum "$catalog.tmp" | awk '{print $1}')"
    if [ "$actual_size" = "$expected_size" ] && [ "$actual_sha" = "$expected_sha" ]; then
      install_dir="$VERSIONS/$version"
      mkdir -p "$install_dir"
      mv -f "$catalog.tmp" "$install_dir/$archive"
      ln -sfn "$install_dir" "$CURRENT"
      printf 'resource_update=market\nresource_id=%s\nversion=%s\nsha256=%s\n' "$RESOURCE_ID" "$version" "$actual_sha"
      exit 0
    fi
  fi
fi

if [ -n "$latest_apk_dir" ]; then
  source="$latest_apk_dir/product-payloads/runtime-aarch64.tgz"
  version="apk-$(jq -r '.apkVersionCode // "unknown"' "$latest_apk_dir/.complete" 2>/dev/null || printf unknown)"
  actual_sha="$(sha256sum "$source" | awk '{print $1}')"
  install_dir="$VERSIONS/$version"
  mkdir -p "$install_dir"
  cp -f "$source" "$install_dir/runtime-aarch64.tgz"
  ln -sfn "$install_dir" "$CURRENT"
  printf 'resource_update=apk-offline\nresource_id=%s\nversion=%s\nsha256=%s\n' "$RESOURCE_ID" "$version" "$actual_sha"
  exit 0
fi

printf 'resource_update=unavailable\nresource_id=%s\n' "$RESOURCE_ID" >&2
exit 1
