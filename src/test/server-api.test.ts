import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlugins } from "../build-plugins.js";
import { createHubServer } from "../server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function post(url: string, value: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}

test("serves catalog, downloads and persistent versioned comments", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-api-"));
  const databasePath = path.join(temporary, "comments.db");
  let instance = await createHubServer({ rootDirectory: ROOT, databasePath, port: 0 });
  let address = await instance.start();
  let base = `http://${address.host}:${address.port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).plugins, 7);

    const catalog = await (await fetch(`${base}/api/v1/plugins?q=termux`)).json();
    assert.ok(catalog.plugins.some((plugin: { id: string }) => plugin.id === "wuxianpi.termux-repair"));

    const detail = await (await fetch(`${base}/api/v1/plugins/wuxianpi.first-install`)).json();
    assert.equal(detail.latestVersion, "1.0.1");
    assert.deepEqual(
      detail.versions.map((release: { manifest: { version: string } }) => release.manifest.version),
      ["1.0.1", "1.0.0"]
    );
    const release = detail.versions[0];
    const download = await fetch(`${base}${release.downloadUrl}`);
    assert.equal(download.status, 200);
    assert.equal((await download.arrayBuffer()).byteLength, release.size);
    const document = await fetch(`${base}${release.documents[0].url}`);
    assert.equal(document.status, 200);
    assert.match(await document.text(), /首次安装/);

    const created = await post(`${base}/api/v1/plugins/wuxianpi.first-install/comments`, {
      version: "1.0.0",
      authorType: "agent",
      authorName: "Rescue Agent",
      clientId: "device-test",
      content: "Android 14 实测通过",
      rating: 5,
      environment: { android: "14", termux: "0.118" }
    });
    assert.equal(created.status, 201);
    const comment = await created.json();
    assert.equal(comment.authorType, "agent");

    const reply = await post(`${base}/api/v1/comments/${comment.id}/replies`, {
      version: "1.0.0",
      authorType: "maintainer",
      authorName: "WuxianPi",
      clientId: "maintainer-test",
      content: "感谢实测"
    });
    assert.equal(reply.status, 201);
    assert.equal((await reply.json()).parentId, comment.id);
  } finally {
    await instance.close();
  }

  instance = await createHubServer({ rootDirectory: ROOT, databasePath, port: 0 });
  address = await instance.start();
  base = `http://${address.host}:${address.port}`;
  try {
    const comments = await (await fetch(`${base}/api/v1/plugins/wuxianpi.first-install/comments?version=1.0.0`)).json();
    assert.equal(comments.comments.length, 2);
    assert.deepEqual(comments.comments[0].environment, { android: "14", termux: "0.118" });
  } finally {
    await instance.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("serves releases whose strict SemVer contains build metadata", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-api-build-metadata-"));
  const source = path.join(temporary, "source", "wuxianpi.build-metadata");
  const publicDirectory = path.join(temporary, "public");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "wuxianpi.build-metadata",
    version: "1.0.0+build.1",
    name: "Build metadata",
    description: "Download route fixture",
    category: "test",
    minHostVersion: 1,
    requiredCapabilities: [],
    tags: [],
    documents: []
  }, null, 2)}\n`);
  await buildPlugins(path.dirname(source), publicDirectory);

  const instance = await createHubServer({
    rootDirectory: temporary,
    databasePath: path.join(temporary, "comments.db"),
    port: 0
  });
  const address = await instance.start();
  try {
    const response = await fetch(
      `http://${address.host}:${address.port}/plugins/wuxianpi.build-metadata/1.0.0+build.1.zip`
    );
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  } finally {
    await instance.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
