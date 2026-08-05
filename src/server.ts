import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogRepository } from "./catalog.js";
import { isAuthorType } from "./contracts.js";
import { CommentStore } from "./database.js";
import { McpHandler } from "./mcp.js";
import {
  defaultReleaseDirectory,
  ReleaseConflictError,
  ReleaseNotFoundError,
  ReleaseStore,
  ReleaseValidationError,
  validateReleaseMetadata
} from "./release-store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface HubServerOptions {
  rootDirectory?: string;
  publicDirectory?: string;
  databasePath?: string;
  releaseDirectory?: string;
  managementToken?: string;
  host?: string;
  port?: number;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface CommentBody {
  version?: unknown;
  authorType?: unknown;
  authorName?: unknown;
  clientId?: unknown;
  content?: unknown;
  rating?: unknown;
  environment?: unknown;
}

interface ValidCommentBody {
  version: string;
  authorType: "user" | "agent" | "maintainer";
  authorName: string;
  clientId: string;
  content: string;
  rating: number | null;
  environment: Record<string, unknown> | null;
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "access-control-allow-origin": "*",
    ...headers
  });
  response.end(payload);
}

function text(response: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  const payload = Buffer.from(body);
  response.writeHead(status, { "content-type": contentType, "content-length": String(payload.length) });
  response.end(payload);
}

async function requestBytes(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength && Number.isFinite(Number(declaredLength)) && Number(declaredLength) > maximum) {
    throw new HttpError(413, "request body is too large");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += part.length;
    if (length > maximum) throw new HttpError(413, "request body is too large");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const payload = await requestBytes(request, 1024 * 1024);
  if (payload.length === 0) return {};
  return JSON.parse(payload.toString("utf8"));
}

async function multipartBody(request: IncomingMessage): Promise<FormData> {
  const contentType = request.headers["content-type"];
  const normalizedContentType = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!normalizedContentType?.toLowerCase().startsWith("multipart/form-data;")) {
    throw new HttpError(415, "management upload requires multipart/form-data");
  }
  const payload = await requestBytes(request, 32 * 1024 * 1024);
  try {
    return await new Response(new Uint8Array(payload), { headers: { "content-type": normalizedContentType } }).formData();
  } catch {
    throw new HttpError(400, "invalid multipart/form-data body");
  }
}

async function formText(form: FormData, field: string): Promise<string> {
  const value = form.get(field);
  if (typeof value === "string") return value;
  if (value && typeof (value as File).text === "function") return (value as File).text();
  throw new HttpError(400, `${field} is required`);
}

async function formFile(form: FormData, field: string): Promise<Buffer> {
  const value = form.get(field);
  if (!value || typeof value === "string" || typeof (value as File).arrayBuffer !== "function") {
    throw new HttpError(400, `${field} is required`);
  }
  return Buffer.from(await (value as File).arrayBuffer());
}

function requireManagementAccess(request: IncomingMessage, configuredToken: string | undefined): void {
  if (!configuredToken) throw new HttpError(503, "management API is disabled");
  const authorization = request.headers.authorization;
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const expected = createHash("sha256").update(configuredToken, "utf8").digest();
  const actual = createHash("sha256").update(supplied, "utf8").digest();
  if (!timingSafeEqual(actual, expected)) {
    throw new HttpError(401, "management authorization required");
  }
}

function managementStatus(catalog: CatalogRepository, managementEnabled: boolean): Promise<unknown> {
  return catalog.getCatalog().then((current) => ({
    status: "ok",
    market: "rescue",
    managementEnabled,
    revision: current.revision,
    plugins: current.plugins.map((plugin) => ({
      id: plugin.id,
      latestVersion: plugin.latestVersion,
      versions: plugin.versions.map((release) => release.manifest.version)
    }))
  }));
}

function requiredText(value: unknown, field: string, maximum = 4000): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  if (value.trim().length > maximum) throw new Error(`${field} is too long`);
  return value.trim();
}

function validateComment(input: unknown): ValidCommentBody {
  const value = input as CommentBody;
  const version = requiredText(value.version, "version", 80);
  if (!isAuthorType(value.authorType)) throw new Error("authorType must be user, agent or maintainer");
  const authorName = requiredText(value.authorName, "authorName", 80);
  const clientId = requiredText(value.clientId, "clientId", 160);
  const content = requiredText(value.content, "content");
  const rating = value.rating === undefined || value.rating === null ? null : Number(value.rating);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw new Error("rating must be between 1 and 5");
  const environment = value.environment === undefined || value.environment === null
    ? null
    : value.environment as Record<string, unknown>;
  if (environment !== null && (typeof environment !== "object" || Array.isArray(environment))) {
    throw new Error("environment must be an object");
  }
  return { version, authorType: value.authorType, authorName, clientId, content, rating, environment };
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

async function streamFile(response: ServerResponse, filePath: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": contentType(filePath),
      "content-length": String(info.size),
      "cache-control": filePath.endsWith(".zip") ? "public, max-age=31536000, immutable" : "no-cache"
    });
    createReadStream(filePath).pipe(response);
  } catch {
    json(response, 404, { error: "not found" });
  }
}

export async function createHubServer(options: HubServerOptions = {}): Promise<{
  server: Server;
  start: () => Promise<{ host: string; port: number }>;
  close: () => Promise<void>;
}> {
  const rootDirectory = options.rootDirectory ?? ROOT;
  const publicDirectory = options.publicDirectory ?? path.join(rootDirectory, "public");
  const databasePath = options.databasePath ?? path.join(rootDirectory, "data", "comments.db");
  const releaseDirectory = options.releaseDirectory ?? defaultReleaseDirectory(databasePath);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 20877;
  const managementToken = options.managementToken ?? process.env.WUXIANPI_RESCUE_MANAGEMENT_TOKEN;
  const releaseStore = new ReleaseStore(publicDirectory, releaseDirectory);
  await releaseStore.initialize();
  const catalog = new CatalogRepository(releaseStore.catalogPath);
  await catalog.load();
  const comments = new CommentStore(databasePath);
  const mcp = new McpHandler(catalog, comments);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const pathname = decodeURIComponent(url.pathname);
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
          "access-control-allow-headers": "authorization,content-type,mcp-session-id"
        });
        response.end();
        return;
      }
      if (request.method === "GET" && pathname === "/health") {
        const current = await catalog.getCatalog();
        json(response, 200, { status: "ok", revision: current.revision, plugins: current.plugins.length });
        return;
      }

      if (pathname === "/api/v1/management/status" && request.method === "GET") {
        requireManagementAccess(request, managementToken);
        json(response, 200, await managementStatus(catalog, Boolean(managementToken)));
        return;
      }

      const releaseUploadMatch = pathname.match(/^\/api\/v1\/management\/plugins\/([^/]+)\/releases\/([^/]+)$/);
      if (releaseUploadMatch && request.method === "PUT") {
        requireManagementAccess(request, managementToken);
        const form = await multipartBody(request);
        let metadata: unknown;
        try {
          metadata = JSON.parse(await formText(form, "metadata"));
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(400, "metadata must be valid JSON");
        }
        const release = validateReleaseMetadata(metadata, releaseUploadMatch[1], releaseUploadMatch[2]);
        const archive = await formFile(form, "archive");
        const result = await releaseStore.publish(release, archive);
        catalog.setCatalog(result.catalog);
        json(response, result.status === "published" ? 201 : 200, {
          status: result.status,
          pluginId: release.manifest.id,
          version: release.manifest.version,
          sha256: release.sha256,
          size: release.size,
          revision: result.catalog.revision
        });
        return;
      }

      const promoteMatch = pathname.match(/^\/api\/v1\/management\/plugins\/([^/]+)\/promote$/);
      if (promoteMatch && request.method === "POST") {
        requireManagementAccess(request, managementToken);
        const input = await body(request);
        if (typeof input !== "object" || input === null || Array.isArray(input) || typeof (input as { version?: unknown }).version !== "string") {
          throw new HttpError(400, "version is required");
        }
        const result = await releaseStore.promote(promoteMatch[1], (input as { version: string }).version);
        catalog.setCatalog(result.catalog);
        json(response, 200, {
          status: result.status,
          pluginId: promoteMatch[1],
          version: (input as { version: string }).version,
          latestVersion: result.catalog.plugins.find((plugin) => plugin.id === promoteMatch[1])?.latestVersion,
          revision: result.catalog.revision
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/plugins") {
        const current = await catalog.getCatalog();
        const plugins = await catalog.search(url.searchParams.get("q") ?? "");
        json(response, 200, { revision: current.revision, plugins }, { etag: `"${current.revision}"` });
        return;
      }

      const pluginMatch = pathname.match(/^\/api\/v1\/plugins\/([^/]+)$/);
      if (request.method === "GET" && pluginMatch) {
        const plugin = await catalog.getPlugin(pluginMatch[1]);
        json(response, plugin ? 200 : 404, plugin ?? { error: "plugin not found" });
        return;
      }
      const versionsMatch = pathname.match(/^\/api\/v1\/plugins\/([^/]+)\/versions$/);
      if (request.method === "GET" && versionsMatch) {
        const plugin = await catalog.getPlugin(versionsMatch[1]);
        json(response, plugin ? 200 : 404, plugin ? { pluginId: plugin.id, versions: plugin.versions } : { error: "plugin not found" });
        return;
      }
      const commentsMatch = pathname.match(/^\/api\/v1\/plugins\/([^/]+)\/comments$/);
      if (request.method === "GET" && commentsMatch) {
        const plugin = await catalog.getPlugin(commentsMatch[1]);
        if (!plugin) return json(response, 404, { error: "plugin not found" });
        json(response, 200, { comments: comments.list(plugin.id, url.searchParams.get("version") ?? undefined) });
        return;
      }
      if (request.method === "POST" && commentsMatch) {
        const plugin = await catalog.getPlugin(commentsMatch[1]);
        if (!plugin) return json(response, 404, { error: "plugin not found" });
        const input = validateComment(await body(request));
        if (!await catalog.getRelease(plugin.id, input.version)) return json(response, 400, { error: "plugin version not found" });
        const comment = comments.create({ pluginId: plugin.id, ...input });
        json(response, 201, comment);
        return;
      }

      const repliesMatch = pathname.match(/^\/api\/v1\/comments\/([^/]+)\/replies$/);
      if (request.method === "POST" && repliesMatch) {
        const parent = comments.get(repliesMatch[1]);
        if (!parent) return json(response, 404, { error: "parent comment not found" });
        const input = validateComment(await body(request));
        if (input.version !== parent.version) return json(response, 400, { error: "reply version must match parent" });
        const comment = comments.create({ pluginId: parent.pluginId, parentId: parent.id, ...input });
        json(response, 201, comment);
        return;
      }

      const documentMatch = pathname.match(/^\/docs\/raw\/([^/]+)\/([^/]+)\/(.+)$/);
      if (request.method === "GET" && documentMatch) {
        const release = await catalog.getRelease(documentMatch[1], documentMatch[2]);
        const document = release?.documents.find((item) => item.path === documentMatch[3]);
        if (!document) return json(response, 404, { error: "document not found" });
        text(response, 200, document.content, "text/markdown; charset=utf-8");
        return;
      }

      const downloadMatch = pathname.match(/^\/plugins\/([a-z0-9.-]+)\/([0-9A-Za-z.+-]+)\.zip$/);
      if (request.method === "GET" && downloadMatch) {
        if (!await catalog.getRelease(downloadMatch[1], downloadMatch[2])) return json(response, 404, { error: "plugin release not found" });
        await streamFile(response, releaseStore.archivePath(downloadMatch[1], downloadMatch[2]));
        return;
      }

      if (request.method === "POST" && pathname === "/mcp") {
        const rpc = await mcp.handle(await body(request) as Parameters<McpHandler["handle"]>[0]);
        if (rpc === null) {
          response.writeHead(202);
          response.end();
        } else {
          const headers: Record<string, string> = {};
          if ((rpc.result as Record<string, unknown> | undefined)?.serverInfo) headers["mcp-session-id"] = randomUUID();
          json(response, 200, rpc, headers);
        }
        return;
      }

      if (request.method === "GET" && pathname === "/catalog.json") {
        await streamFile(response, releaseStore.catalogPath);
        return;
      }

      if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        await streamFile(response, path.join(publicDirectory, "site", "index.html"));
        return;
      }
      const siteMatch = pathname.match(/^\/(app\.js|styles\.css)$/);
      if (request.method === "GET" && siteMatch) {
        await streamFile(response, path.join(publicDirectory, "site", siteMatch[1]));
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (requestError) {
      const status = requestError instanceof HttpError
        ? requestError.status
        : requestError instanceof ReleaseConflictError
          ? 409
          : requestError instanceof ReleaseNotFoundError
            ? 404
            : requestError instanceof ReleaseValidationError
              ? 400
              : 400;
      json(response, status, { error: requestError instanceof Error ? requestError.message : String(requestError) });
    }
  });

  return {
    server,
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const address = server.address();
        resolve({ host, port: typeof address === "object" && address ? address.port : port });
      });
    }),
    close: () => new Promise((resolve, reject) => {
      server.close((closeError) => {
        comments.close();
        if (closeError) reject(closeError);
        else resolve();
      });
    })
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = await createHubServer({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 20877),
    databasePath: process.env.DATABASE_PATH,
    releaseDirectory: process.env.RELEASE_DIRECTORY,
    managementToken: process.env.WUXIANPI_RESCUE_MANAGEMENT_TOKEN
  });
  const address = await instance.start();
  process.stdout.write(`WuxianPi Rescue listening on http://${address.host}:${address.port}\n`);
}
