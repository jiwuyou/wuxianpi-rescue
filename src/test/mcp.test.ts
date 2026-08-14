import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHubServer } from "../server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("implements initialize, tools/list and tools/call over HTTP", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-mcp-"));
  const instance = await createHubServer({ rootDirectory: ROOT, databasePath: path.join(temporary, "comments.db"), port: 0 });
  const address = await instance.start();
  const endpoint = `http://${address.host}:${address.port}/mcp`;
  const call = async (payload: unknown) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 200);
    return { response, payload: await response.json() };
  };

  try {
    const initialized = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(initialized.payload.result.serverInfo.name, "wuxianpi-rescue");
    assert.ok(initialized.response.headers.get("mcp-session-id"));

    const listed = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.deepEqual(listed.payload.result.tools.map((tool: { name: string }) => tool.name), [
      "search_plugins", "get_plugin", "read_plugin_document", "get_plugin_comments"
    ]);

    const searched = await call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_plugins", arguments: { query: "Ubuntu" } }
    });
    assert.ok(searched.payload.result.structuredContent.some((plugin: { id: string }) => plugin.id === "wuxianpi.ubuntu"));

    const document = await call({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "read_plugin_document",
        arguments: { pluginId: "wuxianpi.first-install", path: "docs/guide.md" }
      }
    });
    assert.match(document.payload.result.structuredContent.content, /首次安装不依赖资源更新插件/);
    assert.match(document.payload.result.structuredContent.content, /Ubuntu 在核心资源和激活完成后单独安装/);
    assert.match(document.payload.result.structuredContent.content, /openhouse-install-bundle\.tar/);
    assert.match(document.payload.result.structuredContent.content, /市场优先与离线回退/);
    assert.match(document.payload.result.structuredContent.content, /openhouse-control-plane-start/);
  } finally {
    await instance.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
