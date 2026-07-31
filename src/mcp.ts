import { CatalogRepository } from "./catalog.js";
import { CommentStore } from "./database.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const tools = [
  {
    name: "search_plugins",
    description: "Search the WuxianPi rescue plugin catalog.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false }
  },
  {
    name: "get_plugin",
    description: "Get one plugin and a specific or latest release.",
    inputSchema: {
      type: "object",
      properties: { pluginId: { type: "string" }, version: { type: "string" } },
      required: ["pluginId"],
      additionalProperties: false
    }
  },
  {
    name: "read_plugin_document",
    description: "Read a declared Markdown document from a plugin release.",
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string" },
        version: { type: "string" },
        path: { type: "string" }
      },
      required: ["pluginId", "path"],
      additionalProperties: false
    }
  },
  {
    name: "get_plugin_comments",
    description: "Read user, agent and maintainer comments for a plugin version.",
    inputSchema: {
      type: "object",
      properties: { pluginId: { type: "string" }, version: { type: "string" } },
      required: ["pluginId"],
      additionalProperties: false
    }
  }
];

function result(id: JsonRpcRequest["id"], value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function error(id: JsonRpcRequest["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function stringArgument(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], structuredContent: value };
}

export class McpHandler {
  constructor(private readonly catalog: CatalogRepository, private readonly comments: CommentStore) {}

  async handle(request: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return error(request.id, -32600, "Invalid Request");
    if (request.method === "notifications/initialized") return null;
    if (request.method === "initialize") {
      return result(request.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wuxianpi-hub", version: "0.1.0" }
      });
    }
    if (request.method === "tools/list") return result(request.id, { tools });
    if (request.method !== "tools/call") return error(request.id, -32601, "Method not found");

    try {
      const name = request.params?.name;
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== "string") throw new Error("tool name is required");
      let value: unknown;
      if (name === "search_plugins") {
        value = await this.catalog.search(stringArgument(args, "query") ?? "");
      } else if (name === "get_plugin") {
        const pluginId = stringArgument(args, "pluginId", true)!;
        value = await this.catalog.getRelease(pluginId, stringArgument(args, "version"));
        if (!value) throw new Error("plugin release not found");
      } else if (name === "read_plugin_document") {
        const pluginId = stringArgument(args, "pluginId", true)!;
        const documentPath = stringArgument(args, "path", true)!;
        const release = await this.catalog.getRelease(pluginId, stringArgument(args, "version"));
        if (!release) throw new Error("plugin release not found");
        value = release.documents.find((document) => document.path === documentPath) ?? null;
        if (!value) throw new Error("plugin document not found");
      } else if (name === "get_plugin_comments") {
        const pluginId = stringArgument(args, "pluginId", true)!;
        value = this.comments.list(pluginId, stringArgument(args, "version"));
      } else {
        throw new Error(`unknown tool: ${name}`);
      }
      return result(request.id, toolResult(value));
    } catch (toolError) {
      return result(request.id, {
        isError: true,
        content: [{ type: "text", text: toolError instanceof Error ? toolError.message : String(toolError) }]
      });
    }
  }
}
