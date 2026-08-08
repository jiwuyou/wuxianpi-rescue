import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPlugins } from "../build-plugins.js";
import { PluginRelease, validateManifest } from "../contracts.js";
import { createHubServer } from "../server.js";
import { createZip } from "../zip.js";

function manifest(version: string) {
  return {
    schemaVersion: 1 as const,
    id: "wuxianpi.management-fixture",
    version,
    name: "Management fixture",
    description: "Management API fixture",
    category: "test",
    minHostVersion: 1,
    requiredCapabilities: [],
    tags: ["test"],
    documents: []
  };
}

function releaseFor(version: string, archive: Buffer): PluginRelease {
  const normalizedManifest = validateManifest(manifest(version));
  return {
    manifest: normalizedManifest,
    sha256: createHash("sha256").update(archive).digest("hex"),
    size: archive.length,
    downloadUrl: `/plugins/${normalizedManifest.id}/${version}.zip`,
    documents: [],
    workflows: []
  };
}

function archiveFor(version: string, contents = "fixture"): Buffer {
  return createZip([
    { path: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest(version), null, 2)}\n`) },
    { path: "payload.txt", data: Buffer.from(contents) }
  ]);
}

async function upload(base: string, token: string, release: PluginRelease, archive: Buffer): Promise<Response> {
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(release)], { type: "application/json" }), "metadata.json");
  form.set("archive", new Blob([new Uint8Array(archive)], { type: "application/zip" }), "plugin.zip");
  return fetch(`${base}/api/v1/management/plugins/${release.manifest.id}/releases/${release.manifest.version}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: form
  });
}

test("management API publishes immutably and survives restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-management-"));
  const sourcePlugin = path.join(root, "source", "wuxianpi.management-fixture");
  const publicDirectory = path.join(root, "public");
  const releaseDirectory = path.join(root, "data", "releases");
  const databasePath = path.join(root, "data", "comments.db");
  await mkdir(sourcePlugin, { recursive: true });
  await writeFile(path.join(sourcePlugin, "manifest.json"), `${JSON.stringify(manifest("1.0.0"), null, 2)}\n`);
  await buildPlugins(path.dirname(sourcePlugin), publicDirectory);

  const token = "management-test-token";
  let instance = await createHubServer({
    rootDirectory: root,
    publicDirectory,
    releaseDirectory,
    databasePath,
    managementToken: token,
    port: 0
  });
  let address = await instance.start();
  let base = `http://${address.host}:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/v1/management/status`)).status, 401);
    const status = await fetch(`${base}/api/v1/management/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(status.status, 200);
    const statusPayload = await status.json() as { market: string; revision: string };
    assert.equal(statusPayload.market, "rescue");
    assert.ok(Array.isArray((statusPayload as { resources?: unknown[] }).resources));

    const archive = archiveFor("1.1.0");
    const release = releaseFor("1.1.0", archive);
    const published = await upload(base, token, release, archive);
    assert.equal(published.status, 201);
    assert.equal((await published.json()).status, "published");

    const repeated = await upload(base, token, release, archive);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).status, "already-published");

    const changedArchive = archiveFor("1.1.0", "changed");
    const changed = await upload(base, token, releaseFor("1.1.0", changedArchive), changedArchive);
    assert.equal(changed.status, 409);

    const wrongShaArchive = archiveFor("1.2.0", "wrong-sha");
    const wrongShaRelease = { ...releaseFor("1.2.0", wrongShaArchive), sha256: "0".repeat(64) };
    const wrongSha = await upload(base, token, wrongShaRelease, wrongShaArchive);
    assert.equal(wrongSha.status, 400);

    const corruptArchive = Buffer.from("not a zip");
    const corruptRelease = releaseFor("1.2.0", corruptArchive);
    const corrupt = await upload(base, token, corruptRelease, corruptArchive);
    assert.equal(corrupt.status, 400);
    const afterCorrupt = await (await fetch(`${base}/api/v1/plugins/${release.manifest.id}`)).json();
    assert.equal(afterCorrupt.versions.some((candidate: { manifest: { version: string } }) => candidate.manifest.version === "1.2.0"), false);

    const promoted = await fetch(`${base}/api/v1/management/plugins/${release.manifest.id}/promote`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: "1.1.0" })
    });
    assert.equal(promoted.status, 200);
    const promotedPayload = await promoted.json() as { latestVersion: string; revision: string };
    assert.equal(promotedPayload.latestVersion, "1.1.0");
    assert.notEqual(promotedPayload.revision, statusPayload.revision);

    const rollback = await fetch(`${base}/api/v1/management/plugins/${release.manifest.id}/promote`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: "1.0.0" })
    });
    assert.equal(rollback.status, 200);
    assert.equal((await rollback.json()).latestVersion, "1.0.0");
  } finally {
    await instance.close();
  }

  instance = await createHubServer({
    rootDirectory: root,
    publicDirectory,
    releaseDirectory,
    databasePath,
    managementToken: token,
    port: 0
  });
  address = await instance.start();
  base = `http://${address.host}:${address.port}`;
  try {
    const detail = await (await fetch(`${base}/api/v1/plugins/${"wuxianpi.management-fixture"}`)).json();
    assert.equal(detail.latestVersion, "1.0.0");
    assert.deepEqual(detail.versions.map((candidate: { manifest: { version: string } }) => candidate.manifest.version), ["1.1.0", "1.0.0"]);
    assert.equal((await fetch(`${base}/plugins/wuxianpi.management-fixture/1.1.0.zip`)).status, 200);
    const persistentCatalog = JSON.parse(await readFile(path.join(releaseDirectory, "catalog.json"), "utf8"));
    assert.equal(persistentCatalog.plugins[0].latestVersion, "1.0.0");
  } finally {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("management write routes are disabled without a token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-management-disabled-"));
  const sourcePlugin = path.join(root, "source", "wuxianpi.disabled-fixture");
  const publicDirectory = path.join(root, "public");
  await mkdir(sourcePlugin, { recursive: true });
  await writeFile(path.join(sourcePlugin, "manifest.json"), `${JSON.stringify({ ...manifest("1.0.0"), id: "wuxianpi.disabled-fixture" }, null, 2)}\n`);
  await buildPlugins(path.dirname(sourcePlugin), publicDirectory);
  const instance = await createHubServer({
    rootDirectory: root,
    publicDirectory,
    releaseDirectory: path.join(root, "releases"),
    databasePath: path.join(root, "comments.db"),
    managementToken: "",
    port: 0
  });
  const address = await instance.start();
  try {
    assert.equal((await fetch(`http://${address.host}:${address.port}/api/v1/management/status`)).status, 503);
    assert.equal((await fetch(`http://${address.host}:${address.port}/api/v1/management/plugins/wuxianpi.disabled-fixture/releases/1.1.0`, { method: "PUT" })).status, 503);
  } finally {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});
