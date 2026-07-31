import { createHash } from "node:crypto";
import { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogPlugin, PluginCatalog, PluginRelease, compareVersions, validateManifest } from "./contracts.js";
import { ZipEntry, createZip } from "./zip.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = path.join(ROOT, "plugins", "official");
const DEFAULT_PUBLIC = path.join(ROOT, "public");

async function collectFiles(directory: string, prefix = ""): Promise<ZipEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: ZipEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
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

async function buildRelease(directory: string, publicDirectory: string): Promise<PluginRelease> {
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  if (path.basename(directory) !== manifest.id) throw new Error(`${manifest.id}: directory name must match plugin id`);

  const files = await collectFiles(directory);
  const available = new Set(files.map((file) => file.path));
  for (const document of manifest.documents) {
    if (!available.has(document.path)) throw new Error(`${manifest.id}: missing document ${document.path}`);
  }
  if (manifest.entryWorkflow && !available.has(manifest.entryWorkflow)) {
    throw new Error(`${manifest.id}: missing entry workflow ${manifest.entryWorkflow}`);
  }

  const workflows = files.filter((file) => file.path.startsWith("workflows/") && file.path.endsWith(".json"));
  for (const workflow of workflows) JSON.parse(workflow.data.toString("utf8"));

  const archive = createZip(files);
  const outputDirectory = path.join(publicDirectory, "plugins", manifest.id);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${manifest.version}.zip`);
  await writeFile(outputPath, archive);

  return {
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
  };
}

export async function buildPlugins(sourceDirectory = DEFAULT_SOURCE, publicDirectory = DEFAULT_PUBLIC): Promise<PluginCatalog> {
  const sourceInfo = await stat(sourceDirectory);
  if (!sourceInfo.isDirectory()) throw new Error("plugin source must be a directory");
  await rm(path.join(publicDirectory, "plugins"), { recursive: true, force: true });
  await mkdir(publicDirectory, { recursive: true });

  const directories = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry: Dirent) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  if (directories.length === 0) throw new Error("no plugins found");

  const releases = await Promise.all(directories.map((entry) => buildRelease(path.join(sourceDirectory, entry.name), publicDirectory)));
  const grouped = new Map<string, PluginRelease[]>();
  for (const release of releases) grouped.set(release.manifest.id, [...(grouped.get(release.manifest.id) ?? []), release]);

  const plugins: CatalogPlugin[] = [...grouped.entries()].map(([id, versions]) => {
    versions.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
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
  }).sort((a, b) => a.id.localeCompare(b.id));

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
