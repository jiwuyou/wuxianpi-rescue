import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { buildPlugins } from "../build-plugins.js";
import { ResourceStore, validateResourceMetadata, validateResourceSetMetadata } from "../resource-store.js";
import { createHubServer } from "../server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function post(url: string, value: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}

function tgzFixture(name = "payload.txt", contents = "resource-fixture"): Buffer {
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
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
    const healthPayload = await health.json() as { plugins: number };
    assert.ok(Number.isInteger(healthPayload.plugins) && healthPayload.plugins > 0);

    const catalog = await (await fetch(`${base}/api/v1/plugins?q=termux`)).json();
    assert.ok(catalog.plugins.some((plugin: { id: string }) => plugin.id === "wuxianpi.termux-repair"));

    const detail = await (await fetch(`${base}/api/v1/plugins/wuxianpi.first-install`)).json();
    const versions = detail.versions.map((release: { manifest: { version: string } }) => release.manifest.version);
    assert.equal(detail.latestVersion, versions[0]);
    assert.equal(new Set(versions).size, versions.length);
    assert.ok(versions.includes("1.0.6"));
    assert.ok(versions.includes("1.0.0"));
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

test("serves, promotes and downloads resource API v2 releases and sets", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-resources-"));
  const databasePath = path.join(temporary, "comments.db");
  const token = "resource-management-token";
  const instance = await createHubServer({ rootDirectory: ROOT, databasePath, releaseDirectory: path.join(temporary, "releases"), managementToken: token, port: 0 });
  const address = await instance.start();
  const base = `http://${address.host}:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/v1/resources`)).status, 410);
    const catalog = await (await fetch(`${base}/api/v2/resources`)).json() as { schema: number; resources: unknown[] };
    assert.equal(catalog.schema, 2);
    assert.deepEqual(catalog.resources, []);

    const archive = tgzFixture();
    const metadata = {
      id: "openhouse-runtime",
      version: "1.0.0",
      archive: "runtime-aarch64.tgz",
      compression: "gzip",
      abi: "arm64-v8a",
      size: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
      url: "/resources-v2/openhouse-runtime/1.0.0/runtime-aarch64.tgz",
      mirrors: [],
      minApkVersionCode: 126
    };
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
    form.set("archive", new Blob([new Uint8Array(archive)], { type: "application/gzip" }), "runtime-aarch64.tgz");
    const published = await fetch(`${base}/api/v2/management/resources/openhouse-runtime/releases/1.0.0`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: form
    });
    assert.equal(published.status, 201);
    assert.equal((await published.json()).status, "published");
    const detailBeforePromote = await (await fetch(`${base}/api/v2/resources/openhouse-runtime`)).json() as {
      latestVersion: string | null; versions: Array<{ version: string }>
    };
    assert.equal(detailBeforePromote.latestVersion, null);
    assert.deepEqual(detailBeforePromote.versions.map((release) => release.version), ["1.0.0"]);

    const promoted = await post(`${base}/api/v2/management/resources/openhouse-runtime/promote`, { version: "1.0.0" });
    assert.equal(promoted.status, 401);
    const authorizedPromote = await fetch(`${base}/api/v2/management/resources/openhouse-runtime/promote`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: "1.0.0" })
    });
    assert.equal(authorizedPromote.status, 200);

    const downloadUrl = `${base}/resources-v2/openhouse-runtime/1.0.0/runtime-aarch64.tgz`;
    const download = await fetch(downloadUrl);
    assert.equal(download.status, 200);
    assert.equal(Buffer.from(await download.arrayBuffer()).compare(archive), 0);
    const head = await fetch(downloadUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(archive.length));
    assert.equal(head.headers.get("etag"), `"sha256-${metadata.sha256}"`);
    const range = await fetch(downloadUrl, { headers: { range: "bytes=0-15" } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 16);

    const setMembers = [{ id: metadata.id, version: metadata.version, archive: metadata.archive, size: metadata.size, sha256: metadata.sha256 }];
    for (const [id, archiveName] of [
      ["service-manager", "service-manager.tgz"],
      ["openhouse-control-plane", "openhouse-control-plane.tgz"],
      ["wuyou", "wuyou.tgz"],
      ["openhouse-web", "openhouse-web.tgz"],
    ] as const) {
      const memberMetadata = {
        ...metadata,
        id,
        archive: archiveName,
        url: `/resources-v2/${id}/1.0.0/${archiveName}`,
      };
      const memberForm = new FormData();
      memberForm.set("metadata", new Blob([JSON.stringify(memberMetadata)], { type: "application/json" }), "metadata.json");
      memberForm.set("archive", new Blob([new Uint8Array(archive)], { type: "application/gzip" }), archiveName);
      const memberPublished = await fetch(`${base}/api/v2/management/resources/${id}/releases/1.0.0`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}` },
        body: memberForm,
      });
      assert.equal(memberPublished.status, 201);
      setMembers.push({ id, version: "1.0.0", archive: archiveName, size: archive.length, sha256: metadata.sha256 });
    }

    const resourceSet = {
      schema: 2,
      id: "openhouse-core-stack",
      version: "2026.08.09.1",
      sequence: 2026080901,
      abi: "arm64-v8a",
      minApkVersionCode: 126,
      resources: setMembers
    };
    const setPublished = await fetch(`${base}/api/v2/management/resource-sets/openhouse-core-stack/releases/2026.08.09.1`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(resourceSet)
    });
    assert.equal(setPublished.status, 201);
    const setPromoted = await fetch(`${base}/api/v2/management/resource-sets/openhouse-core-stack/promote`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: resourceSet.version })
    });
    assert.equal(setPromoted.status, 200);
    const setDetail = await (await fetch(`${base}/api/v2/resource-sets/openhouse-core-stack`)).json() as {
      latestVersion: string; versions: Array<{ sequence: number }>
    };
    assert.equal(setDetail.latestVersion, resourceSet.version);
    assert.deepEqual(setDetail.versions.map((release) => release.sequence), [resourceSet.sequence]);

    const corrupt = Buffer.from("not-gzip");
    const corruptMetadata = {
      ...metadata,
      version: "1.0.1",
      size: corrupt.length,
      sha256: createHash("sha256").update(corrupt).digest("hex"),
      url: "/resources-v2/openhouse-runtime/1.0.1/runtime-aarch64.tgz"
    };
    const corruptForm = new FormData();
    corruptForm.set("metadata", new Blob([JSON.stringify(corruptMetadata)], { type: "application/json" }), "metadata.json");
    corruptForm.set("archive", new Blob([new Uint8Array(corrupt)], { type: "application/gzip" }), "runtime-aarch64.tgz");
    const corruptResponse = await fetch(`${base}/api/v2/management/resources/openhouse-runtime/releases/1.0.1`, {
      method: "PUT", headers: { authorization: `Bearer ${token}` }, body: corruptForm
    });
    assert.equal(corruptResponse.status, 400);
  } finally {
    await instance.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("persists V2 resources, history and promotion pointers across store restart", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-resource-store-restart-"));
  const releaseDirectory = path.join(temporary, "releases");
  const archive = tgzFixture();
  const digest = createHash("sha256").update(archive).digest("hex");
  const specs = [
    ["service-manager", "service-manager.tgz"],
    ["openhouse-control-plane", "openhouse-control-plane.tgz"],
    ["openhouse-runtime", "runtime-aarch64.tgz"],
    ["wuyou", "wuyou.tgz"],
    ["openhouse-web", "openhouse-web.tgz"],
  ] as const;
  try {
    const first = new ResourceStore(releaseDirectory);
    await first.initialize();
    for (const [id, archiveName] of specs) {
      const release = validateResourceMetadata({
        id,
        version: "1.0.0",
        archive: archiveName,
        compression: "gzip",
        abi: "arm64-v8a",
        size: archive.length,
        sha256: digest,
        url: `/resources-v2/${id}/1.0.0/${archiveName}`,
        mirrors: [],
        minApkVersionCode: 126,
      }, id, "1.0.0");
      await first.publishResource(release, archive);
      await first.promoteResource(id, "1.0.0");
    }
    const set = validateResourceSetMetadata({
      schema: 2,
      id: "openhouse-core-stack",
      version: "2026.08.09.1",
      sequence: 2026080901,
      abi: "arm64-v8a",
      minApkVersionCode: 126,
      resources: specs.map(([id, archiveName]) => ({ id, version: "1.0.0", archive: archiveName, size: archive.length, sha256: digest })),
    }, "openhouse-core-stack", "2026.08.09.1");
    await first.publishResourceSet(set);
    await first.promoteResourceSet(set.id, set.version);

    const restarted = new ResourceStore(releaseDirectory);
    await restarted.initialize();
    const catalog = await restarted.readCatalog();
    const sets = await restarted.readResourceSetCatalog();
    assert.equal(catalog.resources.length, 5);
    assert.ok(catalog.resources.every((resource) => resource.latestVersion === "1.0.0"));
    assert.equal(sets.resourceSets[0].latestVersion, set.version);
    assert.equal(sets.resourceSets[0].versions[0].sequence, set.sequence);
  } finally {
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
