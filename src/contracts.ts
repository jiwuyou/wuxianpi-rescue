export const PLUGIN_SCHEMA_VERSION = 1 as const;

export type AuthorType = "user" | "agent" | "maintainer";

export interface PluginDocumentDeclaration {
  path: string;
  title: string;
}

export type PluginAssistantContextScope = "session" | "turn";
export type PluginAssistantContextProvider = "static" | "javascript";
export type PluginSessionRole = "bootstrap" | "runtime" | "business";
export type PluginActionVisibility =
  | "always"
  | "apk-update-pending"
  | "first-install-incomplete"
  | "maintenance-due";

export interface PluginAssistantContextDeclaration {
  path: string;
  scope: PluginAssistantContextScope;
  provider: PluginAssistantContextProvider;
  function?: string;
}

export interface PluginActionDeclaration {
  id: string;
  title: string;
  icon: string;
  priority: number;
  prompt: string;
  visibleWhen: PluginActionVisibility;
  requiresPlugins: string[];
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
  sessionRole: PluginSessionRole;
  assistantContexts: PluginAssistantContextDeclaration[];
  actions: PluginActionDeclaration[];
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

interface SemanticVersion {
  major: string;
  minor: string;
  patch: string;
  preRelease: string[] | null;
}

const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function safeRelativePath(value: string, field: string): void {
  const segments = value.split("/");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`${field} must be a safe relative path`);
  }
}

function stringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedFields = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new Error(`${field} has an unknown field '${key}'`);
    }
  }
}

function parseSemanticVersion(value: string): SemanticVersion {
  const normalized = value.trim();
  const match = STRICT_SEMVER.exec(normalized);
  if (!match) throw new Error(`Version is not strict SemVer: ${value}`);
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    preRelease: match[4] ? match[4].split(".") : null
  };
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return compareText(left, right);
}

function comparePreReleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return compareNumeric(left, right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return compareText(left, right);
}

export function validateManifest(input: unknown): PluginManifest {
  if (!isRecord(input)) throw new Error("manifest must be an object");
  if (input.schemaVersion !== PLUGIN_SCHEMA_VERSION) throw new Error("unsupported plugin schemaVersion");

  requiredString(input.id, "id");
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(input.id)) throw new Error("id has an invalid format");
  requiredString(input.version, "version");
  const version = input.version.trim();
  parseSemanticVersion(version);
  requiredString(input.name, "name");
  requiredString(input.description, "description");
  requiredString(input.category, "category");
  if (!Number.isInteger(input.minHostVersion) || Number(input.minHostVersion) < 1) {
    throw new Error("minHostVersion must be a positive integer");
  }
  stringArray(input.requiredCapabilities, "requiredCapabilities");
  stringArray(input.tags, "tags");

  const sessionRole: PluginSessionRole = input.sessionRole === undefined
    ? "business"
    : input.sessionRole as PluginSessionRole;
  if (sessionRole !== "bootstrap" && sessionRole !== "runtime" && sessionRole !== "business") {
    throw new Error("sessionRole must be bootstrap, runtime, or business");
  }

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

  const assistantContexts = input.assistantContexts === undefined
    ? []
    : (() => {
        if (!Array.isArray(input.assistantContexts)) {
          throw new Error("assistantContexts must be an array");
        }
        return input.assistantContexts.map((context, index) => {
          if (!isRecord(context)) {
            throw new Error(`assistantContexts[${index}] must be an object`);
          }
          rejectUnknownFields(context, ["path", "scope", "provider", "function"], `assistantContexts[${index}]`);
          requiredString(context.path, `assistantContexts[${index}].path`);
          safeRelativePath(context.path, `assistantContexts[${index}].path`);
          if (context.scope !== "session" && context.scope !== "turn") {
            throw new Error(`assistantContexts[${index}].scope must be session or turn`);
          }
          const scope: PluginAssistantContextScope = context.scope;
          const provider: PluginAssistantContextProvider = context.provider === undefined ? "static" : context.provider as PluginAssistantContextProvider;
          if (provider !== "static" && provider !== "javascript") {
            throw new Error(`assistantContexts[${index}].provider must be static or javascript`);
          }
          let functionName: string | undefined;
          if (context.function !== undefined) {
            requiredString(context.function, `assistantContexts[${index}].function`);
            if (!/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(context.function)) {
              throw new Error(`assistantContexts[${index}].function has an invalid format`);
            }
            functionName = context.function;
          }
          if (provider === "javascript" && !functionName) {
            throw new Error(`assistantContexts[${index}].function is required for javascript provider`);
          }
          if (provider === "static" && functionName) {
            throw new Error(`assistantContexts[${index}].function is only valid for javascript provider`);
          }
          return { path: context.path, scope, provider, ...(functionName ? { function: functionName } : {}) };
        });
      })();

  const actions = input.actions === undefined
    ? []
    : (() => {
        if (!Array.isArray(input.actions)) throw new Error("actions must be an array");
        const actionIds = new Set<string>();
        return input.actions.map((action, index) => {
          if (!isRecord(action)) throw new Error(`actions[${index}] must be an object`);
          rejectUnknownFields(
            action,
            ["id", "title", "icon", "priority", "prompt", "visibleWhen", "requiresPlugins"],
            `actions[${index}]`
          );
          requiredString(action.id, `actions[${index}].id`);
          if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(action.id)) {
            throw new Error(`actions[${index}].id has an invalid format`);
          }
          if (actionIds.has(action.id)) {
            throw new Error(`actions contains duplicate id '${action.id}'`);
          }
          actionIds.add(action.id);
          requiredString(action.title, `actions[${index}].title`);
          requiredString(action.icon, `actions[${index}].icon`);
          requiredString(action.prompt, `actions[${index}].prompt`);
          if (!Number.isInteger(action.priority) || Number(action.priority) < 0 || Number(action.priority) > 1000) {
            throw new Error(`actions[${index}].priority must be an integer from 0 to 1000`);
          }
          const visibleWhen = action.visibleWhen === undefined ? "always" : action.visibleWhen;
          if (
            visibleWhen !== "always" &&
            visibleWhen !== "apk-update-pending" &&
            visibleWhen !== "first-install-incomplete" &&
            visibleWhen !== "maintenance-due"
          ) {
            throw new Error(`actions[${index}].visibleWhen is unsupported`);
          }
          const requiresPlugins = action.requiresPlugins === undefined ? [] : action.requiresPlugins;
          stringArray(requiresPlugins, `actions[${index}].requiresPlugins`);
          requiresPlugins.forEach((pluginId) => {
            if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(pluginId)) {
              throw new Error(`actions[${index}].requiresPlugins contains an invalid plugin id`);
            }
          });
          return {
            id: action.id,
            title: action.title,
            icon: action.icon,
            priority: Number(action.priority),
            prompt: action.prompt,
            visibleWhen: visibleWhen as PluginActionVisibility,
            requiresPlugins: [...requiresPlugins]
          };
        });
      })();

  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    id: input.id,
    version,
    name: input.name,
    description: input.description,
    category: input.category,
    minHostVersion: Number(input.minHostVersion),
    requiredCapabilities: [...input.requiredCapabilities],
    tags: [...input.tags],
    entryWorkflow,
    sessionRole,
    assistantContexts,
    actions,
    documents
  };
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseSemanticVersion(left);
  const rightVersion = parseSemanticVersion(right);
  for (const field of ["major", "minor", "patch"] as const) {
    const comparison = compareNumeric(leftVersion[field], rightVersion[field]);
    if (comparison !== 0) return comparison;
  }

  if (!leftVersion.preRelease) return rightVersion.preRelease ? 1 : 0;
  if (!rightVersion.preRelease) return -1;
  const sharedSize = Math.min(leftVersion.preRelease.length, rightVersion.preRelease.length);
  for (let index = 0; index < sharedSize; index += 1) {
    const comparison = comparePreReleaseIdentifier(
      leftVersion.preRelease[index],
      rightVersion.preRelease[index]
    );
    if (comparison !== 0) return comparison;
  }
  return leftVersion.preRelease.length - rightVersion.preRelease.length;
}

export function isAuthorType(value: unknown): value is AuthorType {
  return value === "user" || value === "agent" || value === "maintainer";
}
