#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/publish-resource-via-api.sh --market rescue --resource <id> --version <version> --archive <file> [options]

Options:
  --metadata <path>  Resource metadata JSON (default: generated from arguments)
  --dry-run          Validate locally without calling the API
USAGE
}

MARKET=""
RESOURCE_ID=""
VERSION=""
ARCHIVE=""
METADATA=""
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --market) MARKET="${2:?missing value}"; shift 2 ;;
    --resource) RESOURCE_ID="${2:?missing value}"; shift 2 ;;
    --version) VERSION="${2:?missing value}"; shift 2 ;;
    --archive) ARCHIVE="${2:?missing value}"; shift 2 ;;
    --metadata) METADATA="${2:?missing value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ "$MARKET" = rescue ] || { echo "--market rescue is required" >&2; exit 2; }
[ -n "$RESOURCE_ID" ] && [ -n "$VERSION" ] && [ -f "$ARCHIVE" ] || { echo "--resource, --version and --archive are required" >&2; exit 2; }

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wuxianpi-resource-publish.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT HUP INT TERM
metadata_path="$WORK_DIR/metadata.json"

node - "$RESOURCE_ID" "$VERSION" "$ARCHIVE" "${METADATA:-}" "$metadata_path" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const [id, version, archivePath, metadataPathArg, output] = process.argv.slice(2);
const data = fs.readFileSync(archivePath);
const supplied = metadataPathArg ? JSON.parse(fs.readFileSync(metadataPathArg, "utf8")) : {
  id, version, archive: path.basename(archivePath), compression: "gzip", abi: "arm64-v8a",
  size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex"),
  url: `/resources/${id}/${version}/${path.basename(archivePath)}`, mirrors: []
};
if (supplied.id !== id || supplied.version !== version) throw new Error("metadata id/version mismatch");
if (supplied.size !== data.length) throw new Error(`size mismatch: expected ${supplied.size}, got ${data.length}`);
const digest = crypto.createHash("sha256").update(data).digest("hex");
if (supplied.sha256 !== digest) throw new Error(`sha256 mismatch: expected ${supplied.sha256}, got ${digest}`);
if (supplied.url !== `/resources/${id}/${version}/${supplied.archive}`) throw new Error("metadata url mismatch");
fs.writeFileSync(output, `${JSON.stringify(supplied, null, 2)}\n`, { mode: 0o600 });
console.log(`Validated ${id}@${version}: ${data.length} bytes, sha256=${digest}`);
NODE

[ "$DRY_RUN" -eq 1 ] && { echo "Dry run complete; no management API request was made."; exit 0; }
BASE_URL="${WUXIANPI_RESCUE_MANAGEMENT_URL:-}"
TOKEN="${WUXIANPI_RESCUE_MANAGEMENT_TOKEN:-}"
[ -n "$BASE_URL" ] && [ -n "$TOKEN" ] || { echo "WUXIANPI_RESCUE_MANAGEMENT_URL and WUXIANPI_RESCUE_MANAGEMENT_TOKEN are required" >&2; exit 1; }
BASE_URL="${BASE_URL%/}"
curl -q --fail --silent --show-error -X PUT -H "Authorization: Bearer $TOKEN" \
  -F "metadata=<${metadata_path};type=application/json" -F "archive=@${ARCHIVE};type=application/gzip" \
  "$BASE_URL/api/v1/management/resources/$RESOURCE_ID/releases/$VERSION"
printf '\n'
curl -q --fail --silent --show-error "$BASE_URL/api/v1/resources"
printf '\n'
