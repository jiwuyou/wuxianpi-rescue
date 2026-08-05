#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage:
  scripts/publish-market-via-api.sh --market rescue --plugin <id> --version <version> [options]

Options:
  --catalog <path>   Local catalog.json (default: public/catalog.json)
  --archive <path>   Local plugin ZIP (default: public/plugins/<id>/<version>.zip)
  --no-promote       Upload the release but keep the current latestVersion
  --dry-run          Validate local metadata and archive without calling the API
  -h, --help         Show this help

Environment:
  WUXIANPI_RESCUE_MANAGEMENT_URL    Public management base URL
  WUXIANPI_RESCUE_MANAGEMENT_TOKEN   Bearer token for the management API
USAGE
}

MARKET=""
PLUGIN_ID=""
VERSION=""
CATALOG_PATH="public/catalog.json"
ARCHIVE_PATH=""
PROMOTE=1
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --market) MARKET="${2:?missing value for --market}"; shift 2 ;;
    --plugin) PLUGIN_ID="${2:?missing value for --plugin}"; shift 2 ;;
    --version) VERSION="${2:?missing value for --version}"; shift 2 ;;
    --catalog) CATALOG_PATH="${2:?missing value for --catalog}"; shift 2 ;;
    --archive) ARCHIVE_PATH="${2:?missing value for --archive}"; shift 2 ;;
    --no-promote) PROMOTE=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ "$MARKET" = "rescue" ] || { echo "--market rescue is required; other markets are not handled by this tool" >&2; exit 2; }
[ -n "$PLUGIN_ID" ] || { echo "--plugin is required" >&2; exit 2; }
[ -n "$VERSION" ] || { echo "--version is required" >&2; exit 2; }

if [ -z "$ARCHIVE_PATH" ]; then
  ARCHIVE_PATH="public/plugins/$PLUGIN_ID/$VERSION.zip"
fi

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
[ -f "$CATALOG_PATH" ] || { echo "catalog not found: $CATALOG_PATH" >&2; exit 1; }
[ -f "$ARCHIVE_PATH" ] || { echo "archive not found: $ARCHIVE_PATH" >&2; exit 1; }

TMP_ROOT="${TMPDIR:-/tmp}"
WORK_DIR="$(mktemp -d "${TMP_ROOT%/}/wuxianpi-market-publish.XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT HUP INT TERM
METADATA_PATH="$WORK_DIR/metadata.json"

node - "$CATALOG_PATH" "$PLUGIN_ID" "$VERSION" "$ARCHIVE_PATH" "$METADATA_PATH" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const [catalogPath, pluginId, version, archivePath, metadataPath] = process.argv.slice(2);
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const plugin = catalog.plugins?.find((candidate) => candidate.id === pluginId);
const release = plugin?.versions?.find((candidate) => candidate.manifest?.version === version);
if (!release) throw new Error(`${pluginId}@${version} is not present in ${catalogPath}`);
const archive = fs.readFileSync(archivePath);
const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
if (archive.length !== release.size) throw new Error(`archive size mismatch: expected ${release.size}, got ${archive.length}`);
if (sha256 !== release.sha256) throw new Error(`archive SHA-256 mismatch: expected ${release.sha256}, got ${sha256}`);
if (release.downloadUrl !== `/plugins/${pluginId}/${version}.zip`) throw new Error("release downloadUrl does not match its id/version");
fs.writeFileSync(metadataPath, `${JSON.stringify(release, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Validated ${pluginId}@${version}: ${archive.length} bytes, sha256=${sha256}\n`);
NODE

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run complete; no management API request was made."
  exit 0
fi

BASE_URL="${WUXIANPI_RESCUE_MANAGEMENT_URL:-}"
TOKEN="${WUXIANPI_RESCUE_MANAGEMENT_TOKEN:-}"
[ -n "$BASE_URL" ] || { echo "WUXIANPI_RESCUE_MANAGEMENT_URL is required" >&2; exit 1; }
[ -n "$TOKEN" ] || { echo "WUXIANPI_RESCUE_MANAGEMENT_TOKEN is required" >&2; exit 1; }
BASE_URL="${BASE_URL%/}"

UPLOAD_RESPONSE="$WORK_DIR/upload.json"
curl -q --fail --silent --show-error \
  -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -F "metadata=<${METADATA_PATH};type=application/json" \
  -F "archive=@${ARCHIVE_PATH};type=application/zip" \
  "$BASE_URL/api/v1/management/plugins/$PLUGIN_ID/releases/$VERSION" > "$UPLOAD_RESPONSE"
cat "$UPLOAD_RESPONSE"

if [ "$PROMOTE" -eq 1 ]; then
  curl -q --fail --silent --show-error \
    -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"version\":\"$VERSION\"}" \
    "$BASE_URL/api/v1/management/plugins/$PLUGIN_ID/promote"
  printf '\n'
fi

PUBLIC_RESPONSE="$WORK_DIR/public.json"
curl -q --fail --silent --show-error \
  "$BASE_URL/api/v1/plugins/$PLUGIN_ID" > "$PUBLIC_RESPONSE"
node - "$PUBLIC_RESPONSE" "$PLUGIN_ID" "$VERSION" "$PROMOTE" <<'NODE'
const fs = require("node:fs");
const [responsePath, pluginId, version, promote] = process.argv.slice(2);
const plugin = JSON.parse(fs.readFileSync(responsePath, "utf8"));
if (plugin.id !== pluginId || !plugin.versions?.some((release) => release.manifest?.version === version)) {
  throw new Error(`public API did not expose ${pluginId}@${version}`);
}
if (promote === "1" && plugin.latestVersion !== version) {
  throw new Error(`public API latestVersion is ${plugin.latestVersion}, expected ${version}`);
}
process.stdout.write(`Public API verified ${pluginId}@${version} (latest=${plugin.latestVersion})\n`);
NODE
