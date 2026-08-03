import { createHash } from "node:crypto";
import { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogPlugin, PluginCatalog, PluginRelease, compareVersions, validateManifest } from "./contracts.js";
import { ZipEntry, compareCodeUnitStrings, createZip } from "./zip.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = path.join(ROOT, "plugins", "official");
const DEFAULT_PUBLIC = path.join(ROOT, "public");

async function collectFiles(directory: string, prefix = ""): Promise<ZipEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: ZipEntry[] = [];
  for (const entry of entries.sort((a, b) => compareCodeUnitStrings(a.name, b.name))) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${relative}`);
    if (entry.isDirectory()) files.push(...await collectFiles(absolute, relative));
    else if (entry.isFile()) files.push({ path: relative, data: await readFile(absolute) });
  }
  return files;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function compareVersionStrings(left: string, right: string): number {
  const precedence = compareVersions(left, right);
  if (precedence !== 0) return precedence;
  return compareCodeUnitStrings(left, right);
}

interface BuiltRelease {
  release: PluginRelease;
  archive: Buffer;
}

async function buildRelease(directory: string, expectedPluginId = path.basename(directory)): Promise<BuiltRelease> {
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  if (expectedPluginId !== manifest.id) throw new Error(`${manifest.id}: directory name must match plugin id`);

  const files = await collectFiles(directory);
  const available = new Set(files.map((file) => file.path));
  for (const document of manifest.documents) {
    if (!available.has(document.path)) throw new Error(`${manifest.id}: missing document ${document.path}`);
  }
  for (const context of manifest.assistantContexts) {
    if (!available.has(context.path)) {
      throw new Error(`${manifest.id}: missing assistant context ${context.path}`);
    }
  }
  if (manifest.entryWorkflow && !available.has(manifest.entryWorkflow)) {
    throw new Error(`${manifest.id}: missing entry workflow ${manifest.entryWorkflow}`);
  }

  const workflows = files.filter((file) => file.path.startsWith("workflows/") && file.path.endsWith(".json"));
  for (const workflow of workflows) JSON.parse(workflow.data.toString("utf8"));

  const archive = createZip(files);
  return {
    archive,
    release: {
      manifest,
      sha256: sha256(archive),
      size: archive.length,
      downloadUrl: `/plugins/${manifest.id}/${manifest.version}.zip`,
      documents: await Promise.all(manifest.documents.map(async (document) => ({
        ...document,
        content: await readFile(path.join(directory, document.path), "utf8"),
        url: `/docs/raw/${manifest.id}/${manifest.version}/${document.path}`
      }))),
      workflows: workflows.map((workflow) => workflow.path)
    }
  };
}

async function buildPluginReleases(directory: string): Promise<BuiltRelease[]> {
  const pluginId = path.basename(directory);
  const current = await buildRelease(directory, pluginId);
  const historyDirectory = path.join(directory, ".history");
  let historyEntries: Dirent[] = [];
  try {
    historyEntries = (await readdir(historyDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => compareVersionStrings(a.name, b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const historical = await Promise.all(historyEntries.map(async (entry) => {
    const release = await buildRelease(path.join(historyDirectory, entry.name), pluginId);
    if (release.release.manifest.version !== entry.name) {
      throw new Error(`${pluginId}: history directory ${entry.name} must match its manifest version`);
    }
    return release;
  }));
  return [current, ...historical];
}

async function readExistingCatalog(publicDirectory: string): Promise<PluginCatalog | null> {
  try {
    return JSON.parse(await readFile(path.join(publicDirectory, "catalog.json"), "utf8")) as PluginCatalog;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function loadPublishedReleases(
  publicDirectory: string,
  catalog: PluginCatalog | null,
): Promise<Map<string, Map<string, PluginRelease>>> {
  const grouped = new Map<string, Map<string, PluginRelease>>();
  if (!catalog) return grouped;
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins)) {
    throw new Error("existing catalog is invalid");
  }

  for (const plugin of catalog.plugins) {
    if (!Array.isArray(plugin.versions)) throw new Error(`${plugin.id}: existing versions must be an array`);
    const versions = grouped.get(plugin.id) ?? new Map<string, PluginRelease>();
    grouped.set(plugin.id, versions);
    for (const release of plugin.versions) {
      const manifest = validateManifest(release.manifest);
      if (manifest.id !== plugin.id) throw new Error(`${plugin.id}: release manifest id does not match catalog id`);
      if (versions.has(manifest.version)) throw new Error(`${plugin.id}@${manifest.version}: duplicate published release`);

      const expectedUrl = `/plugins/${plugin.id}/${manifest.version}.zip`;
      if (release.downloadUrl !== expectedUrl) {
        throw new Error(`${plugin.id}@${manifest.version}: unexpected download URL`);
      }
      let archive: Buffer;
      try {
        archive = await readFile(path.join(publicDirectory, "plugins", plugin.id, `${manifest.version}.zip`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`${plugin.id}@${manifest.version}: published archive is missing`);
        }
        throw error;
      }
      const archiveSha = sha256(archive);
      if (archiveSha !== release.sha256 || archive.length !== release.size) {
        throw new Error(`${plugin.id}@${manifest.version}: published archive does not match catalog metadata`);
      }
      versions.set(manifest.version, release);
    }
  }
  return grouped;
}

export async function buildPlugins(sourceDirectory = DEFAULT_SOURCE, publicDirectory = DEFAULT_PUBLIC): Promise<PluginCatalog> {
  const sourceInfo = await stat(sourceDirectory);
  if (!sourceInfo.isDirectory()) throw new Error("plugin source must be a directory");
  await mkdir(publicDirectory, { recursive: true });

  const directories = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry: Dirent) => entry.isDirectory())
    .sort((a, b) => compareCodeUnitStrings(a.name, b.name));
  if (directories.length === 0) throw new Error("no plugins found");

  const existingCatalog = await readExistingCatalog(publicDirectory);
  const grouped = await loadPublishedReleases(publicDirectory, existingCatalog);
  const built = (await Promise.all(
    directories.map((entry) => buildPluginReleases(path.join(sourceDirectory, entry.name)))
  )).flat();
  const pendingWrites: BuiltRelease[] = [];

  for (const candidate of built) {
    const { id, version } = candidate.release.manifest;
    const versions = grouped.get(id) ?? new Map<string, PluginRelease>();
    grouped.set(id, versions);
    const published = versions.get(version);
    if (published && (published.sha256 !== candidate.release.sha256 || published.size !== candidate.release.size)) {
      throw new Error(`${id}@${version}: published releases are immutable; increment the plugin version`);
    }
    versions.set(version, candidate.release);
    if (!published) pendingWrites.push(candidate);
  }

  for (const candidate of pendingWrites) {
    const { id, version } = candidate.release.manifest;
    const outputDirectory = path.join(publicDirectory, "plugins", id);
    await mkdir(outputDirectory, { recursive: true });
    const outputPath = path.join(outputDirectory, `${version}.zip`);
    let archiveExists = false;
    try {
      const existingArchive = await readFile(outputPath);
      archiveExists = true;
      if (sha256(existingArchive) !== candidate.release.sha256 || existingArchive.length !== candidate.release.size) {
        throw new Error(`${id}@${version}: published archive is immutable; increment the plugin version`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!archiveExists) await writeFile(outputPath, candidate.archive);
  }

  const plugins: CatalogPlugin[] = [...grouped.entries()].map(([id, releases]) => {
    const versions = [...releases.values()];
    versions.sort((a, b) => compareVersionStrings(b.manifest.version, a.manifest.version));
    const latest = versions[0];
    return {
      id,
      name: latest.manifest.name,
      description: latest.manifest.description,
      category: latest.manifest.category,
      tags: latest.manifest.tags,
      latestVersion: latest.manifest.version,
      versions
    };
  }).sort((a, b) => compareCodeUnitStrings(a.id, b.id));

  const stableCatalog = JSON.stringify({ schemaVersion: 1, plugins });
  const catalog: PluginCatalog = {
    schemaVersion: 1,
    revision: sha256(stableCatalog).slice(0, 16),
    generatedAt: new Date().toISOString(),
    plugins
  };
  await writeFile(path.join(publicDirectory, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = await buildPlugins();
  process.stdout.write(`Built ${catalog.plugins.length} plugins (revision ${catalog.revision})\n`);
}
