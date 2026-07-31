export const PLUGIN_SCHEMA_VERSION = 1 as const;

export type AuthorType = "user" | "agent" | "maintainer";

export interface PluginDocumentDeclaration {
  path: string;
  title: string;
}

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  category: string;
  minHostVersion: number;
  requiredCapabilities: string[];
  tags: string[];
  entryWorkflow?: string;
  documents: PluginDocumentDeclaration[];
}

export interface PluginDocument extends PluginDocumentDeclaration {
  content: string;
  url: string;
}

export interface PluginRelease {
  manifest: PluginManifest;
  sha256: string;
  size: number;
  downloadUrl: string;
  documents: PluginDocument[];
  workflows: string[];
}

export interface CatalogPlugin {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  latestVersion: string;
  versions: PluginRelease[];
}

export interface PluginCatalog {
  schemaVersion: 1;
  revision: string;
  generatedAt: string;
  plugins: CatalogPlugin[];
}

export interface CommentRecord {
  id: string;
  pluginId: string;
  version: string;
  parentId: string | null;
  authorType: AuthorType;
  authorName: string;
  clientId: string;
  content: string;
  rating: number | null;
  environment: Record<string, unknown> | null;
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function safeRelativePath(value: string, field: string): void {
  if (value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new Error(`${field} must be a safe relative path`);
  }
}

function stringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
}

export function validateManifest(input: unknown): PluginManifest {
  if (!isRecord(input)) throw new Error("manifest must be an object");
  if (input.schemaVersion !== PLUGIN_SCHEMA_VERSION) throw new Error("unsupported plugin schemaVersion");

  requiredString(input.id, "id");
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(input.id)) throw new Error("id has an invalid format");
  requiredString(input.version, "version");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) throw new Error("version must be semantic");
  requiredString(input.name, "name");
  requiredString(input.description, "description");
  requiredString(input.category, "category");
  if (!Number.isInteger(input.minHostVersion) || Number(input.minHostVersion) < 1) {
    throw new Error("minHostVersion must be a positive integer");
  }
  stringArray(input.requiredCapabilities, "requiredCapabilities");
  stringArray(input.tags, "tags");

  if (!Array.isArray(input.documents)) throw new Error("documents must be an array");
  const documents = input.documents.map((document, index) => {
    if (!isRecord(document)) throw new Error(`documents[${index}] must be an object`);
    requiredString(document.path, `documents[${index}].path`);
    requiredString(document.title, `documents[${index}].title`);
    safeRelativePath(document.path, `documents[${index}].path`);
    return { path: document.path, title: document.title };
  });

  let entryWorkflow: string | undefined;
  if (input.entryWorkflow !== undefined) {
    requiredString(input.entryWorkflow, "entryWorkflow");
    safeRelativePath(input.entryWorkflow, "entryWorkflow");
    entryWorkflow = input.entryWorkflow;
  }

  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    id: input.id,
    version: input.version,
    name: input.name,
    description: input.description,
    category: input.category,
    minHostVersion: Number(input.minHostVersion),
    requiredCapabilities: [...input.requiredCapabilities],
    tags: [...input.tags],
    entryWorkflow,
    documents
  };
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split("-")[0].split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return left.localeCompare(right);
}

export function isAuthorType(value: unknown): value is AuthorType {
  return value === "user" || value === "agent" || value === "maintainer";
}
