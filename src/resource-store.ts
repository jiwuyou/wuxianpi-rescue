import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const RESOURCE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/;
const ARCHIVE_PATTERN = /^[a-z0-9][a-z0-9._-]*\.tgz$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RESOURCE_SIZE = 60 * 1024 * 1024;
const MAX_UNCOMPRESSED_SIZE = 512 * 1024 * 1024;
const MAX_RESOURCE_SET_GUIDE_SIZE = 32 * 1024;
const CORE_RESOURCE_ARCHIVES = new Map([
  ["service-manager", "service-manager.tgz"],
  ["openhouse-control-plane", "openhouse-control-plane.tgz"],
  ["openhouse-runtime", "runtime-aarch64.tgz"],
  ["wuyou", "wuyou.tgz"],
  ["openhouse-web", "openhouse-web.tgz"],
  ["openhouse-resource-manager", "openhouse-resource-manager.tgz"],
  ["openhouse-resource-import", "openhouse-resource-import.tgz"],
  ["wuxianpi-setup", "wuxianpi-setup.tgz"],
  ["openhouse-bootstrap", "openhouse-bootstrap.tgz"],
  ["openhouse-install-runtime-components", "openhouse-install-runtime-components.tgz"],
  ["openhouse-install-ubuntu", "openhouse-install-ubuntu.tgz"],
  ["openhouse-update-ubuntu-packages", "openhouse-update-ubuntu-packages.tgz"],
  ["openhouse-ubuntu-mirror-policy", "openhouse-ubuntu-mirror-policy.tgz"],
  ["openhouse-retry-profile", "openhouse-retry-profile.tgz"],
  ["openhouse-start-smallphone", "openhouse-start-smallphone.tgz"],
  ["openhouse-register-component", "openhouse-register-component.tgz"],
  ["openhouse-control-plane-start", "openhouse-control-plane-start.tgz"],
  ["openhouse-termux-services-env", "openhouse-termux-services-env.tgz"],
  ["openhouse-start-service-manager", "openhouse-start-service-manager.tgz"],
  ["openhouse-repair-control-plane", "openhouse-repair-control-plane.tgz"],
  ["openhouse-inspect-control-plane", "openhouse-inspect-control-plane.tgz"],
]);
const LEGACY_CORE_STACK_IDS = [
  "openhouse-control-plane", "openhouse-runtime", "openhouse-web", "service-manager", "wuyou",
].sort();
const MARKET_CORE_STACK_IDS = [
  "service-manager", "openhouse-runtime", "wuyou", "openhouse-web",
  "openhouse-resource-manager", "openhouse-resource-import", "wuxianpi-setup",
  "openhouse-bootstrap", "openhouse-install-runtime-components", "openhouse-install-ubuntu",
  "openhouse-update-ubuntu-packages", "openhouse-ubuntu-mirror-policy", "openhouse-retry-profile",
  "openhouse-start-smallphone", "openhouse-register-component",
  "openhouse-control-plane-start", "openhouse-termux-services-env", "openhouse-start-service-manager",
  "openhouse-repair-control-plane", "openhouse-inspect-control-plane",
].sort();

export interface ResourceRelease {
  id: string;
  version: string;
  archive: string;
  compression: "gzip";
  abi: "arm64-v8a";
  size: number;
  sha256: string;
  url: string;
  mirrors: string[];
  minApkVersionCode?: number;
  maxApkVersionCode?: number;
}

export interface CatalogResource {
  id: string;
  latestVersion: string | null;
  versions: ResourceRelease[];
}

export interface ResourceCatalog {
  schema: 2;
  generatedAt: string;
  revision: string;
  resources: CatalogResource[];
}

export interface ResourceSetMember {
  id: string;
  version: string;
  archive: string;
  size: number;
  sha256: string;
}

export interface ResourceSetRelease {
  schema: 2;
  id: string;
  version: string;
  sequence: number;
  abi: "arm64-v8a";
  minApkVersionCode: number;
  guide?: {
    title: string;
    markdown: string;
  };
  resources: ResourceSetMember[];
}

export interface CatalogResourceSet {
  id: string;
  latestVersion: string | null;
  versions: ResourceSetRelease[];
}

export interface ResourceSetCatalog {
  schema: 2;
  generatedAt: string;
  revision: string;
  resourceSets: CatalogResourceSet[];
}

export class ResourceValidationError extends Error {}
export class ResourceConflictError extends Error {}
export class ResourceNotFoundError extends Error {}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function requiredString(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ResourceValidationError(`${field} is invalid`);
  }
  return value;
}

function optionalVersionCode(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1) throw new ResourceValidationError(`${field} is invalid`);
  return Number(value);
}

export function validateResourceMetadata(input: unknown, id: string, version: string): ResourceRelease {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ResourceValidationError("resource metadata must be an object");
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "id", "version", "archive", "compression", "abi", "size", "sha256", "url", "mirrors",
    "minApkVersionCode", "maxApkVersionCode"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ResourceValidationError(`resource metadata has unknown field '${key}'`);
  }
  if (requiredString(id, "resource id", RESOURCE_ID_PATTERN) !== value.id) {
    throw new ResourceValidationError("resource id does not match URL");
  }
  if (requiredString(version, "resource version", VERSION_PATTERN) !== value.version) {
    throw new ResourceValidationError("resource version does not match URL");
  }
  const archive = requiredString(value.archive, "resource archive", ARCHIVE_PATTERN);
  const canonicalArchive = CORE_RESOURCE_ARCHIVES.get(id);
  if (canonicalArchive && archive !== canonicalArchive) {
    throw new ResourceValidationError(`${id} must use archive ${canonicalArchive}`);
  }
  if (value.compression !== "gzip" || value.abi !== "arm64-v8a") {
    throw new ResourceValidationError("resource must be gzip arm64-v8a");
  }
  if (!Number.isInteger(value.size) || Number(value.size) < 1 || Number(value.size) > MAX_RESOURCE_SIZE) {
    throw new ResourceValidationError("resource size is invalid");
  }
  const digest = requiredString(value.sha256, "resource sha256", SHA256_PATTERN);
  const expectedUrl = `/resources-v2/${id}/${version}/${archive}`;
  if (value.url !== expectedUrl) throw new ResourceValidationError("resource url does not match its id/version/archive");
  const mirrors = value.mirrors === undefined ? [] : value.mirrors;
  if (!Array.isArray(mirrors) || mirrors.some((mirror) => typeof mirror !== "string" || !/^https?:\/\//.test(mirror))) {
    throw new ResourceValidationError("resource mirrors must be HTTP(S) URLs");
  }
  const minApkVersionCode = optionalVersionCode(value.minApkVersionCode, "minApkVersionCode");
  const maxApkVersionCode = optionalVersionCode(value.maxApkVersionCode, "maxApkVersionCode");
  if (minApkVersionCode && maxApkVersionCode && minApkVersionCode > maxApkVersionCode) {
    throw new ResourceValidationError("resource APK version range is invalid");
  }
  return {
    id,
    version,
    archive,
    compression: "gzip",
    abi: "arm64-v8a",
    size: Number(value.size),
    sha256: digest,
    url: expectedUrl,
    mirrors: [...mirrors],
    ...(minApkVersionCode ? { minApkVersionCode } : {}),
    ...(maxApkVersionCode ? { maxApkVersionCode } : {})
  };
}

export function validateResourceSetMetadata(
  input: unknown,
  id: string,
  version: string,
  requireCurrentContract = false,
): ResourceSetRelease {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ResourceValidationError("resource set metadata must be an object");
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set(["schema", "id", "version", "sequence", "abi", "minApkVersionCode", "guide", "resources"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ResourceValidationError(`resource set metadata has unknown field '${key}'`);
  }
  if (value.schema !== 2) throw new ResourceValidationError("resource set schema must be 2");
  if (requiredString(id, "resource set id", RESOURCE_ID_PATTERN) !== value.id) {
    throw new ResourceValidationError("resource set id does not match URL");
  }
  if (requiredString(version, "resource set version", VERSION_PATTERN) !== value.version) {
    throw new ResourceValidationError("resource set version does not match URL");
  }
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) {
    throw new ResourceValidationError("resource set sequence is invalid");
  }
  if (value.abi !== "arm64-v8a") throw new ResourceValidationError("resource set ABI must be arm64-v8a");
  if (!Number.isInteger(value.minApkVersionCode) || Number(value.minApkVersionCode) < 1) {
    throw new ResourceValidationError("resource set minApkVersionCode is invalid");
  }
  if (!Array.isArray(value.resources) || value.resources.length === 0) {
    throw new ResourceValidationError("resource set resources must not be empty");
  }
  let guide: ResourceSetRelease["guide"];
  if (value.guide !== undefined) {
    if (!value.guide || typeof value.guide !== "object" || Array.isArray(value.guide)) {
      throw new ResourceValidationError("resource set guide must be an object");
    }
    const candidate = value.guide as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => !["title", "markdown"].includes(key))) {
      throw new ResourceValidationError("resource set guide has unknown fields");
    }
    if (typeof candidate.title !== "string" || candidate.title.trim().length === 0 || candidate.title.length > 120) {
      throw new ResourceValidationError("resource set guide title is invalid");
    }
    if (typeof candidate.markdown !== "string" || candidate.markdown.trim().length === 0 ||
        Buffer.byteLength(candidate.markdown, "utf8") > MAX_RESOURCE_SET_GUIDE_SIZE) {
      throw new ResourceValidationError("resource set guide markdown is invalid");
    }
    guide = { title: candidate.title.trim(), markdown: candidate.markdown };
  } else if (requireCurrentContract) {
    throw new ResourceValidationError("resource set guide is required");
  }
  const seen = new Set<string>();
  const resources = value.resources.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ResourceValidationError(`resource set member ${index} is invalid`);
    }
    const member = entry as Record<string, unknown>;
    if (Object.keys(member).some((key) => !["id", "version", "archive", "size", "sha256"].includes(key))) {
      throw new ResourceValidationError(`resource set member ${index} has unknown fields`);
    }
    const memberId = requiredString(member.id, `resource set member ${index} id`, RESOURCE_ID_PATTERN);
    if (seen.has(memberId)) throw new ResourceValidationError(`resource set contains duplicate resource '${memberId}'`);
    seen.add(memberId);
    const archive = requiredString(member.archive, `resource set member ${index} archive`, ARCHIVE_PATTERN);
    if (!Number.isSafeInteger(member.size) || Number(member.size) < 1 || Number(member.size) > MAX_RESOURCE_SIZE) {
      throw new ResourceValidationError(`resource set member ${index} size is invalid`);
    }
    return {
      id: memberId,
      version: requiredString(member.version, `resource set member ${index} version`, VERSION_PATTERN),
      archive,
      size: Number(member.size),
      sha256: requiredString(member.sha256, `resource set member ${index} sha256`, SHA256_PATTERN)
    };
  });
  if (id === "openhouse-core-stack") {
    const actual = resources.map((resource) => resource.id).sort();
    const matchesLegacy = JSON.stringify(actual) === JSON.stringify(LEGACY_CORE_STACK_IDS);
    const matchesMarket = JSON.stringify(actual) === JSON.stringify(MARKET_CORE_STACK_IDS);
    if ((requireCurrentContract && !matchesMarket) || (!requireCurrentContract && !matchesLegacy && !matchesMarket)) {
      throw new ResourceValidationError("openhouse-core-stack resources do not match a supported contract");
    }
  }
  return {
    schema: 2,
    id,
    version,
    sequence: Number(value.sequence),
    abi: "arm64-v8a",
    minApkVersionCode: Number(value.minApkVersionCode),
    ...(guide ? { guide } : {}),
    resources
  };
}

function validateArchivePath(rawPath: string): string {
  const normalizedSlashes = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalizedSlashes || normalizedSlashes === ".") return ".";
  if (normalizedSlashes.startsWith("/") || /^[A-Za-z]:\//.test(normalizedSlashes)) {
    throw new ResourceValidationError("resource archive contains an absolute path");
  }
  const normalized = path.posix.normalize(normalizedSlashes);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new ResourceValidationError("resource archive contains path traversal");
  }
  return normalized;
}

function tarString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  return block.subarray(start, end >= start && end < start + length ? end : start + length).toString("utf8").trim();
}

function tarSize(block: Buffer): number {
  const raw = tarString(block, 124, 12).replace(/\0/g, "").trim();
  if (!/^[0-7]*$/.test(raw)) throw new ResourceValidationError("resource archive has an invalid TAR size");
  return raw ? Number.parseInt(raw, 8) : 0;
}

function parsePax(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

function validateTgz(archive: Buffer): void {
  if (archive.length < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
    throw new ResourceValidationError("resource archive is not gzip data");
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_UNCOMPRESSED_SIZE });
  } catch {
    throw new ResourceValidationError("resource archive cannot be decompressed safely");
  }
  let offset = 0;
  let entries = 0;
  let pendingName: string | undefined;
  let pendingLink: string | undefined;
  let pendingPax: Record<string, string> = {};
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const size = tarSize(header);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.length) throw new ResourceValidationError("resource archive is truncated");
    const type = String.fromCharCode(header[156] || 0);
    const prefix = tarString(header, 345, 155);
    const headerName = [prefix, tarString(header, 0, 100)].filter(Boolean).join("/");
    const body = tar.subarray(bodyStart, bodyEnd);
    if (type === "L") {
      pendingName = body.subarray(0, body.indexOf(0) >= 0 ? body.indexOf(0) : body.length).toString("utf8");
      validateArchivePath(pendingName);
    } else if (type === "K") {
      pendingLink = body.subarray(0, body.indexOf(0) >= 0 ? body.indexOf(0) : body.length).toString("utf8");
    } else if (type === "x" || type === "g") {
      const values = parsePax(body);
      if (values.path) validateArchivePath(values.path);
      if (values.linkpath && values.linkpath.startsWith("/")) {
        throw new ResourceValidationError("resource archive contains an absolute link target");
      }
      if (type === "x") pendingPax = values;
    } else {
      if (!["\0", "0", "1", "2", "5"].includes(type)) {
        throw new ResourceValidationError(`resource archive contains unsupported TAR entry type '${type}'`);
      }
      const entryName = validateArchivePath(pendingPax.path ?? pendingName ?? headerName);
      const linkName = pendingPax.linkpath ?? pendingLink ?? tarString(header, 157, 100);
      if ((type === "1" || type === "2") && linkName) {
        if (linkName.startsWith("/") || /^[A-Za-z]:\//.test(linkName)) {
          throw new ResourceValidationError("resource archive contains an absolute link target");
        }
        validateArchivePath(path.posix.join(path.posix.dirname(entryName), linkName));
      }
      pendingName = undefined;
      pendingLink = undefined;
      pendingPax = {};
      entries += 1;
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (entries === 0) throw new ResourceValidationError("resource archive is empty");
}

function emptyResourceCatalog(): ResourceCatalog {
  const resources: CatalogResource[] = [];
  return { schema: 2, generatedAt: new Date().toISOString(), revision: revisionFor(resources), resources };
}

function emptyResourceSetCatalog(): ResourceSetCatalog {
  const resourceSets: CatalogResourceSet[] = [];
  return { schema: 2, generatedAt: new Date().toISOString(), revision: revisionFor(resourceSets), resourceSets };
}

function revisionFor(value: unknown): string {
  return sha256(JSON.stringify(value)).slice(0, 16);
}

function validateResourceCatalog(value: unknown): ResourceCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("resource catalog is invalid");
  const input = value as Record<string, unknown>;
  if (input.schema !== 2 || !Array.isArray(input.resources)) throw new Error("resource catalog is invalid");
  const resources = input.resources.map((entry) => {
    const candidate = entry as Record<string, unknown>;
    const id = requiredString(candidate.id, "catalog resource id", RESOURCE_ID_PATTERN);
    if (!Array.isArray(candidate.versions)) throw new Error("resource catalog versions are invalid");
    const versions = candidate.versions.map((release) => {
      const item = release as Record<string, unknown>;
      return validateResourceMetadata(item, id, String(item.version));
    });
    const latestVersion = candidate.latestVersion === null ? null : requiredString(candidate.latestVersion, "latestVersion", VERSION_PATTERN);
    if (latestVersion && !versions.some((release) => release.version === latestVersion)) throw new Error("resource latestVersion is missing");
    return { id, latestVersion, versions };
  });
  return { schema: 2, generatedAt: String(input.generatedAt ?? ""), revision: String(input.revision ?? ""), resources };
}

function validateResourceSetCatalog(value: unknown): ResourceSetCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("resource set catalog is invalid");
  const input = value as Record<string, unknown>;
  if (input.schema !== 2 || !Array.isArray(input.resourceSets)) throw new Error("resource set catalog is invalid");
  const resourceSets = input.resourceSets.map((entry) => {
    const candidate = entry as Record<string, unknown>;
    const id = requiredString(candidate.id, "catalog resource set id", RESOURCE_ID_PATTERN);
    if (!Array.isArray(candidate.versions)) throw new Error("resource set catalog versions are invalid");
    const versions = candidate.versions.map((release) => {
      const item = release as Record<string, unknown>;
      return validateResourceSetMetadata(item, id, String(item.version));
    });
    const latestVersion = candidate.latestVersion === null ? null : requiredString(candidate.latestVersion, "latestVersion", VERSION_PATTERN);
    if (latestVersion && !versions.some((release) => release.version === latestVersion)) throw new Error("resource set latestVersion is missing");
    return { id, latestVersion, versions };
  });
  return { schema: 2, generatedAt: String(input.generatedAt ?? ""), revision: String(input.revision ?? ""), resourceSets };
}

export class ResourceStore {
  readonly rootDirectory: string;
  readonly catalogPath: string;
  readonly resourceSetCatalogPath: string;
  readonly resourcesDirectory: string;
  readonly resourceSetsDirectory: string;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(releaseDirectory: string) {
    this.rootDirectory = path.join(path.dirname(releaseDirectory), "releases-v2");
    this.catalogPath = path.join(this.rootDirectory, "resource-catalog.json");
    this.resourceSetCatalogPath = path.join(this.rootDirectory, "resource-set-catalog.json");
    this.resourcesDirectory = path.join(this.rootDirectory, "resources");
    this.resourceSetsDirectory = path.join(this.rootDirectory, "resource-sets");
  }

  async initialize(): Promise<void> {
    await mkdir(this.resourcesDirectory, { recursive: true });
    await mkdir(this.resourceSetsDirectory, { recursive: true });
    await this.initializeCatalog(this.catalogPath, emptyResourceCatalog());
    await this.initializeCatalog(this.resourceSetCatalogPath, emptyResourceSetCatalog());
    await this.readCatalog();
    await this.readResourceSetCatalog();
  }

  private async initializeCatalog(target: string, value: ResourceCatalog | ResourceSetCatalog): Promise<void> {
    try {
      await access(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeJsonAtomic(target, value);
    }
  }

  async readCatalog(): Promise<ResourceCatalog> {
    return validateResourceCatalog(JSON.parse(await readFile(this.catalogPath, "utf8")));
  }

  async readResourceSetCatalog(): Promise<ResourceSetCatalog> {
    return validateResourceSetCatalog(JSON.parse(await readFile(this.resourceSetCatalogPath, "utf8")));
  }

  archivePath(id: string, version: string, archive: string): string {
    return path.join(this.resourcesDirectory, id, version, archive);
  }

  resourceSetPath(id: string, version: string): string {
    return path.join(this.resourceSetsDirectory, id, version, "manifest.json");
  }

  async publishResource(release: ResourceRelease, archive: Buffer): Promise<{ catalog: ResourceCatalog; status: "published" | "already-published" }> {
    return this.serialized(async () => {
      if (archive.length !== release.size || sha256(archive) !== release.sha256) {
        throw new ResourceValidationError("resource size or SHA-256 does not match metadata");
      }
      validateTgz(archive);
      const current = await this.readCatalog();
      const existingResource = current.resources.find((candidate) => candidate.id === release.id);
      const existing = existingResource?.versions.find((candidate) => candidate.version === release.version);
      if (existing) {
        if (existing.sha256 === release.sha256 && existing.size === release.size && existing.archive === release.archive) {
          return { catalog: current, status: "already-published" };
        }
        throw new ResourceConflictError(`${release.id}@${release.version} already exists with different content`);
      }
      const target = this.archivePath(release.id, release.version, release.archive);
      await mkdir(path.dirname(target), { recursive: true });
      await this.writeBufferAtomic(target, archive);
      const resources = current.resources.filter((candidate) => candidate.id !== release.id);
      const nextResource: CatalogResource = {
        id: release.id,
        latestVersion: existingResource?.latestVersion ?? null,
        versions: [...(existingResource?.versions ?? []), release].sort((left, right) => right.version.localeCompare(left.version))
      };
      resources.push(nextResource);
      resources.sort((left, right) => left.id.localeCompare(right.id));
      const next = this.resourceCatalog(resources);
      await this.writeJsonAtomic(this.catalogPath, next);
      return { catalog: next, status: "published" };
    });
  }

  async promoteResource(id: string, version: string): Promise<{ catalog: ResourceCatalog; status: "promoted" | "already-promoted" }> {
    return this.serialized(async () => {
      const current = await this.readCatalog();
      const resource = current.resources.find((candidate) => candidate.id === id);
      if (!resource || !resource.versions.some((release) => release.version === version)) {
        throw new ResourceNotFoundError(`${id}@${version} is not published`);
      }
      if (resource.latestVersion === version) return { catalog: current, status: "already-promoted" };
      const resources = current.resources.map((candidate) => candidate.id === id ? { ...candidate, latestVersion: version } : candidate);
      const next = this.resourceCatalog(resources);
      await this.writeJsonAtomic(this.catalogPath, next);
      return { catalog: next, status: "promoted" };
    });
  }

  async publishResourceSet(release: ResourceSetRelease): Promise<{ catalog: ResourceSetCatalog; status: "published" | "already-published" }> {
    return this.serialized(async () => {
      const resources = await this.readCatalog();
      for (const member of release.resources) {
        const resource = resources.resources.find((candidate) => candidate.id === member.id);
        const published = resource?.versions.find((candidate) => candidate.version === member.version);
        if (!published || published.sha256 !== member.sha256 ||
            published.archive !== member.archive || published.size !== member.size) {
          throw new ResourceValidationError(`resource set references unavailable or mismatched ${member.id}@${member.version}`);
        }
      }
      const current = await this.readResourceSetCatalog();
      const existingSet = current.resourceSets.find((candidate) => candidate.id === release.id);
      const existing = existingSet?.versions.find((candidate) => candidate.version === release.version);
      if (existing) {
        if (sha256(JSON.stringify(existing)) === sha256(JSON.stringify(release))) {
          return { catalog: current, status: "already-published" };
        }
        throw new ResourceConflictError(`${release.id}@${release.version} already exists with different content`);
      }
      const sequenceOwner = existingSet?.versions.find((candidate) => candidate.sequence === release.sequence);
      if (sequenceOwner) {
        throw new ResourceConflictError(
          `${release.id} sequence ${release.sequence} already belongs to ${sequenceOwner.version}`
        );
      }
      const target = this.resourceSetPath(release.id, release.version);
      await mkdir(path.dirname(target), { recursive: true });
      await this.writeJsonAtomic(target, release);
      const resourceSets = current.resourceSets.filter((candidate) => candidate.id !== release.id);
      resourceSets.push({
        id: release.id,
        latestVersion: existingSet?.latestVersion ?? null,
        versions: [...(existingSet?.versions ?? []), release].sort((left, right) => right.sequence - left.sequence)
      });
      resourceSets.sort((left, right) => left.id.localeCompare(right.id));
      const next = this.resourceSetCatalog(resourceSets);
      await this.writeJsonAtomic(this.resourceSetCatalogPath, next);
      return { catalog: next, status: "published" };
    });
  }

  async promoteResourceSet(id: string, version: string): Promise<{ catalog: ResourceSetCatalog; status: "promoted" | "already-promoted" }> {
    return this.serialized(async () => {
      const current = await this.readResourceSetCatalog();
      const resourceSet = current.resourceSets.find((candidate) => candidate.id === id);
      const release = resourceSet?.versions.find((candidate) => candidate.version === version);
      if (!resourceSet || !release) {
        throw new ResourceNotFoundError(`${id}@${version} is not published`);
      }
      if (resourceSet.latestVersion === version) return { catalog: current, status: "already-promoted" };
      const resources = await this.readCatalog();
      for (const member of release.resources) {
        const resource = resources.resources.find((candidate) => candidate.id === member.id);
        if (resource?.latestVersion !== member.version) {
          throw new ResourceValidationError(
            `resource set cannot be promoted before ${member.id}@${member.version}`
          );
        }
      }
      const resourceSets = current.resourceSets.map((candidate) => candidate.id === id ? { ...candidate, latestVersion: version } : candidate);
      const next = this.resourceSetCatalog(resourceSets);
      await this.writeJsonAtomic(this.resourceSetCatalogPath, next);
      return { catalog: next, status: "promoted" };
    });
  }

  private resourceCatalog(resources: CatalogResource[]): ResourceCatalog {
    return { schema: 2, generatedAt: new Date().toISOString(), revision: revisionFor(resources), resources };
  }

  private resourceSetCatalog(resourceSets: CatalogResourceSet[]): ResourceSetCatalog {
    return { schema: 2, generatedAt: new Date().toISOString(), revision: revisionFor(resourceSets), resourceSets };
  }

  private async writeBufferAtomic(target: string, value: Buffer): Promise<void> {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, { flag: "wx", mode: 0o640 });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async writeJsonAtomic(target: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o640 });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
