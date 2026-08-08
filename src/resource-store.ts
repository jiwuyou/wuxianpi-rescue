import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const RESOURCE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RESOURCE_SIZE = 256 * 1024 * 1024;

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

export interface ResourceCatalog {
  schema: 1;
  generatedAt: string;
  revision: string;
  resources: ResourceRelease[];
}

export class ResourceValidationError extends Error {}
export class ResourceConflictError extends Error {}
export class ResourceNotFoundError extends Error {}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function validateRelease(input: unknown, id: string, version: string): ResourceRelease {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ResourceValidationError("resource metadata must be an object");
  const value = input as Record<string, unknown>;
  const allowed = new Set(["id", "version", "archive", "compression", "abi", "size", "sha256", "url", "mirrors", "minApkVersionCode", "maxApkVersionCode"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ResourceValidationError(`resource metadata has unknown field '${key}'`);
  if (!RESOURCE_ID_PATTERN.test(id) || value.id !== id) throw new ResourceValidationError("resource id does not match URL");
  if (value.version !== version || typeof version !== "string" || version.trim().length === 0) throw new ResourceValidationError("resource version does not match URL");
  if (typeof value.archive !== "string" || value.archive.includes("/") || !value.archive.endsWith(".tgz")) throw new ResourceValidationError("resource archive must be a .tgz filename");
  if (value.compression !== "gzip" || value.abi !== "arm64-v8a") throw new ResourceValidationError("resource must be gzip arm64-v8a");
  if (!Number.isInteger(value.size) || Number(value.size) < 1 || Number(value.size) > MAX_RESOURCE_SIZE) throw new ResourceValidationError("resource size is invalid");
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) throw new ResourceValidationError("resource sha256 is invalid");
  if (value.url !== `/resources/${id}/${version}/${value.archive}`) throw new ResourceValidationError("resource url does not match its id/version/archive");
  const mirrors = value.mirrors === undefined ? [] : value.mirrors;
  if (!Array.isArray(mirrors) || mirrors.some((mirror) => typeof mirror !== "string")) throw new ResourceValidationError("resource mirrors must be strings");
  return {
    id, version, archive: value.archive, compression: "gzip", abi: "arm64-v8a",
    size: Number(value.size), sha256: value.sha256, url: value.url, mirrors: [...mirrors],
    ...(Number.isInteger(value.minApkVersionCode) ? { minApkVersionCode: Number(value.minApkVersionCode) } : {}),
    ...(Number.isInteger(value.maxApkVersionCode) ? { maxApkVersionCode: Number(value.maxApkVersionCode) } : {})
  };
}

function validateCatalog(value: unknown): ResourceCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("resource catalog is invalid");
  const input = value as Record<string, unknown>;
  if (input.schema !== 1 || !Array.isArray(input.resources)) throw new Error("resource catalog is invalid");
  const resources = input.resources.map((entry) => {
    const candidate = entry as Record<string, unknown>;
    return validateRelease(candidate, String(candidate.id), String(candidate.version));
  });
  return { schema: 1, generatedAt: String(input.generatedAt ?? ""), revision: String(input.revision ?? ""), resources };
}

function revisionFor(resources: ResourceRelease[]): string {
  return createHash("sha256").update(JSON.stringify({ schema: 1, resources })).digest("hex").slice(0, 16);
}

export class ResourceStore {
  readonly catalogPath: string;
  readonly resourcesDirectory: string;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(private readonly seedPublicDirectory: string, readonly releaseDirectory: string) {
    this.catalogPath = path.join(releaseDirectory, "resources.json");
    this.resourcesDirectory = path.join(releaseDirectory, "resources");
  }

  async initialize(): Promise<void> {
    await mkdir(this.resourcesDirectory, { recursive: true });
    try { await access(this.catalogPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const seed = path.join(this.seedPublicDirectory, "resources.json");
      try { await copyFile(seed, this.catalogPath); } catch (seedError) {
        if ((seedError as NodeJS.ErrnoException).code !== "ENOENT") throw seedError;
        await writeFile(this.catalogPath, `${JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), revision: revisionFor([]), resources: [] }, null, 2)}\n`);
      }
    }
    const catalog = await this.readCatalog();
    for (const release of catalog.resources) {
      const source = path.join(this.seedPublicDirectory, release.archive);
      const target = this.archivePath(release.id, release.version, release.archive);
      try { await access(target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { await mkdir(path.dirname(target), { recursive: true }); await copyFile(source, target); } catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code !== "ENOENT") throw copyError;
        }
      }
    }
  }

  async readCatalog(): Promise<ResourceCatalog> { return validateCatalog(JSON.parse(await readFile(this.catalogPath, "utf8"))); }

  archivePath(id: string, version: string, archive: string): string { return path.join(this.resourcesDirectory, id, version, archive); }

  async publish(release: ResourceRelease, archive: Buffer): Promise<{ catalog: ResourceCatalog; status: "published" | "already-published" }> {
    return this.serialized(async () => {
      if (archive.length !== release.size || sha256(archive) !== release.sha256) throw new ResourceValidationError("resource size or SHA-256 does not match metadata");
      const current = await this.readCatalog();
      const existing = current.resources.find((candidate) => candidate.id === release.id && candidate.version === release.version);
      if (existing) {
        if (existing.sha256 === release.sha256 && existing.size === release.size) return { catalog: current, status: "already-published" };
        throw new ResourceConflictError(`${release.id}@${release.version} already exists with different content`);
      }
      const target = this.archivePath(release.id, release.version, release.archive);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, archive, { flag: "wx", mode: 0o640 });
      await rename(temporary, target);
      const resources = [...current.resources, release].sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`));
      const next: ResourceCatalog = { schema: 1, generatedAt: new Date().toISOString(), revision: revisionFor(resources), resources };
      await this.writeCatalog(next);
      return { catalog: next, status: "published" };
    });
  }

  private async writeCatalog(catalog: ResourceCatalog): Promise<void> {
    const temporary = `${this.catalogPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { flag: "wx", mode: 0o640 });
    try { await rename(temporary, this.catalogPath); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

export function validateResourceMetadata(input: unknown, id: string, version: string): ResourceRelease {
  return validateRelease(input, id, version);
}
