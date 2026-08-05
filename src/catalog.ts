import { readFile } from "node:fs/promises";
import path from "node:path";
import { CatalogPlugin, PluginCatalog, PluginRelease } from "./contracts.js";

export class CatalogRepository {
  private catalog: PluginCatalog | null = null;

  constructor(private readonly catalogPath: string) {}

  async load(): Promise<PluginCatalog> {
    this.catalog = JSON.parse(await readFile(this.catalogPath, "utf8")) as PluginCatalog;
    return this.catalog;
  }

  async reload(): Promise<PluginCatalog> {
    return this.load();
  }

  setCatalog(catalog: PluginCatalog): void {
    this.catalog = catalog;
  }

  async getCatalog(): Promise<PluginCatalog> {
    return this.catalog ?? this.load();
  }

  async search(query = ""): Promise<CatalogPlugin[]> {
    const catalog = await this.getCatalog();
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return catalog.plugins;
    return catalog.plugins.filter((plugin) => [
      plugin.id,
      plugin.name,
      plugin.description,
      plugin.category,
      ...plugin.tags
    ].some((value) => value.toLocaleLowerCase().includes(normalized)));
  }

  async getPlugin(id: string): Promise<CatalogPlugin | null> {
    return (await this.getCatalog()).plugins.find((plugin) => plugin.id === id) ?? null;
  }

  async getRelease(id: string, version?: string): Promise<PluginRelease | null> {
    const plugin = await this.getPlugin(id);
    if (!plugin) return null;
    const target = version ?? plugin.latestVersion;
    return plugin.versions.find((release) => release.manifest.version === target) ?? null;
  }
}

export function defaultCatalogPath(rootDirectory: string): string {
  return path.join(rootDirectory, "public", "catalog.json");
}
