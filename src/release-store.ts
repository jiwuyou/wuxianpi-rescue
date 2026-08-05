import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CatalogPlugin, PluginCatalog, PluginRelease, compareVersions, validateManifest } from "./contracts.js";
import { readZipEntry } from "./zip.js";

const MAX_ARCHIVE_SIZE = 32 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export class ReleaseValidationError extends Error {}
export class ReleaseConflictError extends Error {}
export class ReleaseNotFoundError extends Error {}

export interface PublishResult {
  catalog: PluginCatalog;
  status: "published" | "already-published";
}

export interface PromoteResult {
  catalog: PluginCatalog;
  status: "promoted" | "already-promoted";
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeReleasePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\")) {
    throw new ReleaseValidationError(`${field} must be a safe relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new ReleaseValidationError(`${field} must be a safe relative path`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ReleaseValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function expectArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ReleaseValidationError(`${field} must be an array`);
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function validateCatalog(catalog: unknown): PluginCatalog {
  if (!isRecord(catalog) || catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins)) {
    throw new Error("catalog is invalid");
  }
  return catalog as unknown as PluginCatalog;
}

function releaseFromCatalog(plugin: CatalogPlugin, version: string): PluginRelease | null {
  return plugin.versions.find((candidate) => candidate.manifest.version === version) ?? null;
}

export function validateReleaseMetadata(input: unknown, pluginId: string, version: string): PluginRelease {
  if (!isRecord(input)) throw new ReleaseValidationError("metadata must be an object");
  const allowed = new Set(["manifest", "sha256", "size", "downloadUrl", "documents", "workflows"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new ReleaseValidationError(`metadata has an unknown field '${key}'`);
  }
  const manifest = validateManifest(input.manifest);
  if (!PLUGIN_ID_PATTERN.test(pluginId)) throw new ReleaseValidationError("plugin id has an invalid format");
  if (manifest.id !== pluginId) throw new ReleaseValidationError("metadata manifest id does not match URL plugin id");
  if (manifest.version !== version) throw new ReleaseValidationError("metadata manifest version does not match URL version");
  if (typeof input.sha256 !== "string" || !SHA256_PATTERN.test(input.sha256)) {
    throw new ReleaseValidationError("sha256 must be a lowercase SHA-256 hex string");
  }
  if (!Number.isSafeInteger(input.size) || Number(input.size) <= 0 || Number(input.size) > MAX_ARCHIVE_SIZE) {
    throw new ReleaseValidationError(`size must be an integer between 1 and ${MAX_ARCHIVE_SIZE}`);
  }
  const downloadUrl = requireString(input.downloadUrl, "downloadUrl");
  const expectedDownloadUrl = `/plugins/${pluginId}/${version}.zip`;
  if (downloadUrl !== expectedDownloadUrl) throw new ReleaseValidationError("downloadUrl does not match plugin id and version");

  const documents = expectArray(input.documents, "documents").map((item, index) => {
    if (!isRecord(item)) throw new ReleaseValidationError(`documents[${index}] must be an object`);
    const allowedDocumentFields = new Set(["path", "title", "content", "url"]);
    for (const key of Object.keys(item)) {
      if (!allowedDocumentFields.has(key)) throw new ReleaseValidationError(`documents[${index}] has an unknown field '${key}'`);
    }
    const documentPath = safeReleasePath(item.path, `documents[${index}].path`);
    const title = requireString(item.title, `documents[${index}].title`);
    if (typeof item.content !== "string") throw new ReleaseValidationError(`documents[${index}].content must be a string`);
    const content = item.content;
    const url = requireString(item.url, `documents[${index}].url`);
    const expectedUrl = `/docs/raw/${pluginId}/${version}/${documentPath}`;
    if (url !== expectedUrl) throw new ReleaseValidationError(`documents[${index}].url does not match its path`);
    return { path: documentPath, title, content, url };
  });
  const declaredDocuments = manifest.documents.map((document) => `${document.path}\u0000${document.title}`);
  const receivedDocuments = documents.map((document) => `${document.path}\u0000${document.title}`);
  if (stableJson(declaredDocuments) !== stableJson(receivedDocuments)) {
    throw new ReleaseValidationError("metadata documents do not match manifest documents");
  }

  const workflows = expectArray(input.workflows, "workflows").map((workflow, index) => {
    if (typeof workflow !== "string") throw new ReleaseValidationError(`workflows[${index}] must be a string`);
    return safeReleasePath(workflow, `workflows[${index}]`);
  });
  return {
    manifest,
    sha256: input.sha256,
    size: Number(input.size),
    downloadUrl,
    documents,
    workflows
  };
}

export class ReleaseStore {
  readonly catalogPath: string;
  readonly pluginsDirectory: string;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly seedPublicDirectory: string,
    readonly releaseDirectory: string
  ) {
    this.catalogPath = path.join(releaseDirectory, "catalog.json");
    this.pluginsDirectory = path.join(releaseDirectory, "plugins");
  }

  async initialize(): Promise<void> {
    await mkdir(this.pluginsDirectory, { recursive: true });
    try {
      await access(this.catalogPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const seedCatalogPath = path.join(this.seedPublicDirectory, "catalog.json");
      await copyFile(seedCatalogPath, this.catalogPath);
    }
    const catalog = await this.readCatalog();
    for (const plugin of catalog.plugins) {
      for (const release of plugin.versions) {
        const source = path.join(this.seedPublicDirectory, "plugins", plugin.id, `${release.manifest.version}.zip`);
        const target = this.archivePath(plugin.id, release.manifest.version);
        try {
          await access(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(source, target);
        }
      }
    }
  }

  async readCatalog(): Promise<PluginCatalog> {
    return validateCatalog(JSON.parse(await readFile(this.catalogPath, "utf8")));
  }

  archivePath(pluginId: string, version: string): string {
    return path.join(this.pluginsDirectory, pluginId, `${version}.zip`);
  }

  async hasArchive(pluginId: string, version: string): Promise<boolean> {
    try {
      const info = await stat(this.archivePath(pluginId, version));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async publish(release: PluginRelease, archive: Buffer): Promise<PublishResult> {
    return this.serialized(async () => {
      const current = await this.readCatalog();
      if (archive.length !== release.size || sha256(archive) !== release.sha256) {
        throw new ReleaseValidationError("archive size or SHA-256 does not match metadata");
      }
      const archiveManifest = readZipEntry(archive, "manifest.json");
      if (!archiveManifest) throw new ReleaseValidationError("archive is missing manifest.json");
      let archiveManifestValue: unknown;
      try {
        archiveManifestValue = JSON.parse(archiveManifest.toString("utf8"));
      } catch {
        throw new ReleaseValidationError("archive manifest.json is not valid JSON");
      }
      const normalizedArchiveManifest = validateManifest(archiveManifestValue);
      if (stableJson(normalizedArchiveManifest) !== stableJson(release.manifest)) {
        throw new ReleaseValidationError("archive manifest does not match metadata manifest");
      }

      const plugin = current.plugins.find((candidate) => candidate.id === release.manifest.id);
      const existing = plugin ? releaseFromCatalog(plugin, release.manifest.version) : null;
      if (existing) {
        if (existing.sha256 === release.sha256 && existing.size === release.size) {
          return { catalog: current, status: "already-published" };
        }
        throw new ReleaseConflictError(`${release.manifest.id}@${release.manifest.version} already exists with different content`);
      }

      const target = this.archivePath(release.manifest.id, release.manifest.version);
      await mkdir(path.dirname(target), { recursive: true });
      let archiveCreated = false;
      try {
        if (await this.hasArchive(release.manifest.id, release.manifest.version)) {
          const existingArchive = await readFile(target);
          if (sha256(existingArchive) !== release.sha256 || existingArchive.length !== release.size) {
            throw new ReleaseConflictError(`${release.manifest.id}@${release.manifest.version} archive exists with different content`);
          }
        } else {
          const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
          await writeFile(temporary, archive, { mode: 0o640, flag: "wx" });
          await rename(temporary, target);
          archiveCreated = true;
        }
        const next = addRelease(current, release);
        try {
          await this.writeCatalog(next);
        } catch (error) {
          if (archiveCreated) await rm(target, { force: true });
          throw error;
        }
        return { catalog: next, status: "published" };
      } catch (error) {
        throw error;
      }
    });
  }

  async promote(pluginId: string, version: string): Promise<PromoteResult> {
    return this.serialized(async () => {
      const current = await this.readCatalog();
      const plugin = current.plugins.find((candidate) => candidate.id === pluginId);
      if (!plugin || !releaseFromCatalog(plugin, version)) throw new ReleaseNotFoundError("plugin release not found");
      if (plugin.latestVersion === version) return { catalog: current, status: "already-promoted" };
      const plugins = current.plugins.map((candidate) => candidate.id === pluginId
        ? { ...candidate, latestVersion: version }
        : candidate);
      const next: PluginCatalog = {
        ...current,
        revision: revisionFor(plugins),
        generatedAt: new Date().toISOString(),
        plugins
      };
      await this.writeCatalog(next);
      return { catalog: next, status: "promoted" };
    });
  }

  private async writeCatalog(catalog: PluginCatalog): Promise<void> {
    const data = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
    const previous = await readFile(this.catalogPath);
    const backupPath = `${this.catalogPath}.previous`;
    const temporary = `${this.catalogPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(backupPath, previous, { mode: 0o640 });
      await writeFile(temporary, data, { mode: 0o640, flag: "wx" });
      await rename(temporary, this.catalogPath);
    } catch (error) {
      await rm(temporary, { force: true });
      try {
        await writeFile(this.catalogPath, previous, { mode: 0o640 });
      } catch {
        // The original catalog is still available as the .previous backup.
      }
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

function revisionFor(plugins: CatalogPlugin[]): string {
  const stable = JSON.stringify({ schemaVersion: 1, plugins });
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function addRelease(catalog: PluginCatalog, release: PluginRelease): PluginCatalog {
  const existingPlugin = catalog.plugins.find((plugin) => plugin.id === release.manifest.id);
  const plugins = existingPlugin
    ? catalog.plugins.map((plugin) => plugin.id === release.manifest.id
        ? {
            ...plugin,
            name: release.manifest.name,
            description: release.manifest.description,
            category: release.manifest.category,
            tags: release.manifest.tags,
            versions: [...plugin.versions, release].sort((left, right) => compareVersions(right.manifest.version, left.manifest.version))
          }
        : plugin)
    : [...catalog.plugins, {
        id: release.manifest.id,
        name: release.manifest.name,
        description: release.manifest.description,
        category: release.manifest.category,
        tags: release.manifest.tags,
        latestVersion: release.manifest.version,
        versions: [release]
      }];
  return {
    schemaVersion: 1,
    revision: revisionFor(plugins),
    generatedAt: new Date().toISOString(),
    plugins: plugins.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  };
}

export function defaultReleaseDirectory(databasePath: string): string {
  return process.env.RELEASE_DIRECTORY ?? path.join(path.dirname(databasePath), "releases");
}
