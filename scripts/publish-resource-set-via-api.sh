#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/publish-resource-set-via-api.sh --market rescue --manifest <resource-set.json> [--promote] [--dry-run]
USAGE
}

MARKET=""
MANIFEST=""
PROMOTE=0
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --market) MARKET="${2:?missing value}"; shift 2 ;;
    --manifest) MANIFEST="${2:?missing value}"; shift 2 ;;
    --promote) PROMOTE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ "$MARKET" = rescue ] || { echo "--market rescue is required" >&2; exit 2; }
[ -f "$MANIFEST" ] || { echo "--manifest is required" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

values="$(node - "$MANIFEST" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.schema !== 2) throw new Error("resource set schema must be 2");
if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value.id ?? "")) throw new Error("invalid resource set id");
if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/.test(value.version ?? "")) throw new Error("invalid resource set version");
if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new Error("invalid resource set sequence");
if (value.abi !== "arm64-v8a" || !Number.isSafeInteger(value.minApkVersionCode)) throw new Error("invalid resource set compatibility");
const expected = ["openhouse-control-plane", "openhouse-runtime", "openhouse-web", "service-manager", "wuyou"];
const actual = Array.isArray(value.resources) ? value.resources.map((item) => item.id).sort() : [];
if (value.id === "openhouse-core-stack" && JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error("openhouse-core-stack must contain exactly the five canonical resources");
}
process.stdout.write(`${value.id}\n${value.version}\n`);
NODE
)"
RESOURCE_SET_ID="$(printf '%s\n' "$values" | sed -n '1p')"
VERSION="$(printf '%s\n' "$values" | sed -n '2p')"
printf 'Validated resource set %s@%s\n' "$RESOURCE_SET_ID" "$VERSION"
[ "$DRY_RUN" -eq 1 ] && { echo "Dry run complete; no management API request was made."; exit 0; }

BASE_URL="${WUXIANPI_RESCUE_MANAGEMENT_URL:-}"
TOKEN="${WUXIANPI_RESCUE_MANAGEMENT_TOKEN:-}"
[ -n "$BASE_URL" ] && [ -n "$TOKEN" ] || {
  echo "WUXIANPI_RESCUE_MANAGEMENT_URL and WUXIANPI_RESCUE_MANAGEMENT_TOKEN are required" >&2
  exit 1
}
BASE_URL="${BASE_URL%/}"
curl -q --fail --silent --show-error -X PUT \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data-binary "@$MANIFEST" \
  "$BASE_URL/api/v2/management/resource-sets/$RESOURCE_SET_ID/releases/$VERSION"
printf '\n'
if [ "$PROMOTE" -eq 1 ]; then
  curl -q --fail --silent --show-error -X POST \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"version\":\"$VERSION\"}" \
    "$BASE_URL/api/v2/management/resource-sets/$RESOURCE_SET_ID/promote"
  printf '\n'
fi
curl -q --fail --silent --show-error "$BASE_URL/api/v2/resource-sets/$RESOURCE_SET_ID"
printf '\n'
