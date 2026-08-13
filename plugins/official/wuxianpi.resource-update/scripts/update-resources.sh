#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
MARKET_URL="${WUXIANPI_RESCUE_MARKET_URL:-https://wuxianpirescue.webefficacy.com}"
MARKET_URL="${MARKET_URL%/}"
SET_ID="openhouse-core-stack"
MANAGER="$PREFIX/bin/openhouse-resource-manager"
SETUP="$PREFIX/bin/wuxianpi-setup"
ROOT="${OPENHOUSEAI_RESOURCE_MANAGER_ROOT:-$HOME/.local/share/openhouseai/resource-manager}"
INSTALLED="$ROOT/installed-set.json"
CACHE="$ROOT/archives"
INBOX="$HOME/.local/share/openhouseai/apk-resource-inbox"
COMMAND="${1:-plan}"
WORK=""

log() { printf '[resource-update] %s\n' "$*"; }
die() { printf '[resource-update] ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() { [[ -z "$WORK" || ! -d "$WORK" ]] || rm -rf "$WORK"; }
trap cleanup EXIT

require_tools() {
  local tool
  for tool in jq curl tar gzip stat find sort; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required command: $tool"
  done
  [[ -x "$MANAGER" ]] || die "resource manager is missing; complete first install or repair the APK bootstrap"
}

new_work() {
  mkdir -p "$CACHE" "${TMPDIR:-$PREFIX/tmp}"
  chmod 700 "$ROOT" "$CACHE"
  WORK="$(mktemp -d "${TMPDIR:-$PREFIX/tmp}/wuxianpi-resource-update.XXXXXX")"
  mkdir -p "$WORK/source"
}

apk_candidate() {
  local directory bundle manifest sequence best_sequence=0 best=''
  [[ -d "$INBOX" ]] || return 1
  while IFS= read -r directory; do
    [[ -f "$directory/.ready" && ! -s "$directory/.ready" ]] || continue
    bundle="$directory/openhouse-install-bundle.tar"
    [[ -s "$bundle" ]] || continue
    manifest="$(tar -xOf "$bundle" ./bundle-manifest.json 2>/dev/null || true)"
    sequence="$(jq -r '.resourceSet.sequence // 0' <<<"$manifest" 2>/dev/null || printf 0)"
    [[ "$sequence" =~ ^[0-9]+$ ]] || continue
    if (( sequence > best_sequence )); then best_sequence="$sequence"; best="$directory"; fi
  done < <(find "$INBOX" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort)
  [[ -n "$best" ]] || return 1
  printf '%s\n' "$best"
}

read_apk_set() {
  local directory bundle
  directory="$(apk_candidate || true)"
  [[ -n "$directory" ]] || return 1
  bundle="$directory/openhouse-install-bundle.tar"
  tar -xOf "$bundle" ./resources/resource-set.json >"$WORK/apk-set.json"
  tar -xOf "$bundle" ./bundle-manifest.json >"$WORK/apk-manifest.json"
  printf '%s\n' "$directory" >"$WORK/apk-inbox.txt"
}

read_market_set() {
  local detail latest
  detail="$(curl -q -fsS --connect-timeout 8 --max-time 25 "$MARKET_URL/api/v2/resource-sets/$SET_ID")" || return 1
  latest="$(jq -r '.latestVersion // empty' <<<"$detail")"
  [[ -n "$latest" ]] || return 1
  jq -e --arg version "$latest" '.versions[] | select(.version == $version)' <<<"$detail" >"$WORK/market-set.json"
}

set_signature() { jq -c '[.resources[] | {id,version}] | sort_by(.id)' "$1"; }

validate_set() {
  jq -e '
    .schema == 2 and .id == "openhouse-core-stack" and .abi == "arm64-v8a" and
    (.sequence | type == "number" and . > 0) and (.resources | length) == 5 and
    ([.resources[].id] | sort) == ["openhouse-control-plane","openhouse-runtime","openhouse-web","service-manager","wuyou"] and
    all(.resources[]; (.version | type == "string" and length > 0) and
      (.archive | type == "string" and test("^[A-Za-z0-9._-]+\\.tgz$")) and
      (.size | type == "number" and . > 0 and . <= 62914560))
  ' "$1" >/dev/null || die "resource set is invalid: $1"
}

choose_target() {
  local target='' sequence=0 candidate candidate_sequence signature owner_signature
  read_apk_set || true
  read_market_set || true
  for candidate in "$WORK/apk-set.json" "$WORK/market-set.json"; do
    [[ -f "$candidate" ]] || continue
    validate_set "$candidate"
    candidate_sequence="$(jq -r '.sequence' "$candidate")"
    if (( candidate_sequence > sequence )); then
      target="$candidate"; sequence="$candidate_sequence"
    elif (( candidate_sequence == sequence )); then
      signature="$(set_signature "$candidate")"; owner_signature="$(set_signature "$target")"
      [[ "$signature" == "$owner_signature" ]] || die "resource sequence conflict: $candidate_sequence"
    fi
  done
  [[ -n "$target" ]] || die 'neither an APK resource set nor the official market set is available'
  if [[ -f "$INSTALLED" ]]; then
    local installed_sequence installed_signature
    installed_sequence="$(jq -r '.sequence // 0' "$INSTALLED")"
    if (( installed_sequence > sequence )); then
      cp "$INSTALLED" "$WORK/target-installed.json"
      printf '%s\n' "$WORK/target-installed.json"; return 0
    fi
    if (( installed_sequence == sequence )); then
      installed_signature="$(set_signature "$INSTALLED")"
      [[ "$installed_signature" == "$(set_signature "$target")" ]] \
        || die "installed resource set conflicts with sequence $sequence"
    fi
  fi
  cp "$target" "$WORK/target.json"
  printf '%s\n' "$WORK/target.json"
}

installed_version() {
  local id="$1"
  [[ -f "$INSTALLED" ]] || return 0
  jq -r --arg id "$id" '.resources[] | select(.id == $id) | .version' "$INSTALLED" 2>/dev/null || true
}

cache_path() { printf '%s/%s/%s/%s\n' "$CACHE" "$1" "$2" "$3"; }

archive_valid() {
  local file="$1" size="$2"
  [[ -f "$file" && "$(stat -c '%s' "$file")" == "$size" ]] || return 1
  gzip -t "$file" >/dev/null 2>&1 && tar -tzf "$file" >/dev/null 2>&1
}

apk_archive() {
  local id="$1" version="$2" archive="$3" size="$4" directory bundle apk_version
  [[ -f "$WORK/apk-set.json" && -f "$WORK/apk-inbox.txt" ]] || return 1
  apk_version="$(jq -r --arg id "$id" '.resources[] | select(.id == $id) | .version' "$WORK/apk-set.json")"
  [[ "$apk_version" == "$version" ]] || return 1
  directory="$(cat "$WORK/apk-inbox.txt")"; bundle="$directory/openhouse-install-bundle.tar"
  tar -xOf "$bundle" "./resources/$archive" >"$WORK/source/$archive.part" || return 1
  [[ "$(stat -c '%s' "$WORK/source/$archive.part")" == "$size" ]] || return 1
  mv "$WORK/source/$archive.part" "$WORK/source/$archive"
}

market_archive() {
  local id="$1" version="$2" archive="$3" size="$4" detail release url
  detail="$(curl -q -fsS --connect-timeout 8 --max-time 25 "$MARKET_URL/api/v2/resources/$id")" \
    || die "market resource metadata is unavailable: $id"
  release="$(jq -e --arg version "$version" '.versions[] | select(.version == $version)' <<<"$detail")" \
    || die "market resource release is unavailable: $id@$version"
  [[ "$(jq -r '.archive' <<<"$release")" == "$archive" && "$(jq -r '.size' <<<"$release")" == "$size" ]] \
    || die "market resource metadata conflicts with target set: $id@$version"
  url="$(jq -r '.url' <<<"$release")"
  [[ "$url" == /* ]] || die "market resource URL is not a trusted relative path: $id"
  curl -q -fL --connect-timeout 10 --max-time 600 --retry 3 --retry-delay 2 \
    "$MARKET_URL$url" -o "$WORK/source/$archive.part"
  [[ "$(stat -c '%s' "$WORK/source/$archive.part")" == "$size" ]] || die "download size mismatch: $id"
  mv "$WORK/source/$archive.part" "$WORK/source/$archive"
}

prepare_sources() {
  local target="$1" plan="$2" id version archive size cache changed=0 source action
  : >"$WORK/sources.tsv"
  while IFS=$'\t' read -r id version archive size; do
    action="$(sed -n "s/^resource=$id version=[^ ]* action=\\([^ ]*\\).*/\\1/p" "$plan" | head -n 1)"
    if [[ "$action" == skip ]]; then
      printf '%s\t%s\t%s\n' "$id" "$version" skip >>"$WORK/sources.tsv"; continue
    fi
    changed=$((changed + 1)); cache="$(cache_path "$id" "$version" "$archive")"
    mkdir -p "$(dirname "$cache")"
    if archive_valid "$cache" "$size"; then
      cp "$cache" "$WORK/source/$archive"; source=cache
    elif apk_archive "$id" "$version" "$archive" "$size" && archive_valid "$WORK/source/$archive" "$size"; then
      source=apk
    else
      market_archive "$id" "$version" "$archive" "$size"
      archive_valid "$WORK/source/$archive" "$size" || die "downloaded resource archive is invalid: $id"
      source=market
    fi
    install -m 600 "$WORK/source/$archive" "$cache"
    printf '%s\t%s\t%s\n' "$id" "$version" "$source" >>"$WORK/sources.tsv"
  done < <(jq -r '.resources[] | [.id,.version,.archive,.size] | @tsv' "$target")
  printf '%s\n' "$changed" >"$WORK/changed.txt"
}

run_plan() {
  local target plan changed=0 download=0 id version archive size action source cache apk_version
  target="$(choose_target)"
  if [[ "$target" == "$WORK/target-installed.json" ]]; then
    printf 'target_sequence=%s\ninstalled_sequence=%s\nchanged=0\nresult=no-downgrade\n' \
      "$(jq -r '.sequence' "$target")" "$(jq -r '.sequence' "$INSTALLED")"; return 0
  fi
  plan="$WORK/manager-plan.txt"
  "$MANAGER" plan --set "$target" --source "$WORK/source" >"$plan"
  while IFS=$'\t' read -r id version archive size; do
    action="$(sed -n "s/^resource=$id version=[^ ]* action=\\([^ ]*\\).*/\\1/p" "$plan" | head -n 1)"
    if [[ "$action" == skip ]]; then source=skip; else
      changed=$((changed + 1)); cache="$(cache_path "$id" "$version" "$archive")"
      if archive_valid "$cache" "$size"; then source=cache
      elif [[ -f "$WORK/apk-set.json" ]] && apk_version="$(jq -r --arg id "$id" '.resources[] | select(.id == $id) | .version' "$WORK/apk-set.json")" && [[ "$apk_version" == "$version" ]]; then source=apk
      else source=market; download=$((download + size)); fi
    fi
    printf '%s\t%s\t%s\n' "$id" "$version" "$source" >>"$WORK/sources.tsv"
  done < <(jq -r '.resources[] | [.id,.version,.archive,.size] | @tsv' "$target")
  printf 'target_set=%s@%s\ntarget_sequence=%s\nchanged=%s\n' \
    "$(jq -r '.id' "$target")" "$(jq -r '.version' "$target")" "$(jq -r '.sequence' "$target")" "$changed"
  printf 'download_bytes=%s\n' "$download"
  while IFS=$'\t' read -r id version source; do printf 'resource=%s version=%s source=%s\n' "$id" "$version" "$source"; done <"$WORK/sources.tsv"
  cat "$plan"
}

run_apply() {
  local target changed plan
  target="$(choose_target)"
  if [[ "$target" == "$WORK/target-installed.json" ]]; then log 'installed resource set is newer; automatic downgrade skipped'; return 0; fi
  plan="$WORK/manager-plan.txt"
  "$MANAGER" plan --set "$target" --source "$WORK/source" >"$plan"
  prepare_sources "$target" "$plan"; changed="$(cat "$WORK/changed.txt")"
  if (( changed == 0 )); then
    log 'all five resources already match the target set; retrying independent activation'
  else
    "$MANAGER" apply --set "$target" --source "$WORK/source"
  fi
  [[ -x "$SETUP" ]] || die 'content updated but the runtime activator is missing'
  "$SETUP" activate
}

main() {
  require_tools; new_work
  case "$COMMAND" in
    check|plan) run_plan ;;
    apply) run_apply ;;
    verify) "$MANAGER" verify; "$SETUP" verify ;;
    rollback) "$MANAGER" rollback; "$SETUP" activate ;;
    *) die 'usage: update-resources.sh [check|plan|apply|verify|rollback]' ;;
  esac
}

main
