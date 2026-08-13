import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins/official/wuxianpi.resource-update/scripts/update-resources.sh");
const MANAGER = path.resolve(ROOT, "../smallphoneai/openhouseai-app-ai-web/app/src/main/assets/smallphoneai/bootstrap/scripts/openhouse-resource-manager");
const IDS = ["service-manager", "openhouse-control-plane", "openhouse-runtime", "wuyou", "openhouse-web"];
const ARCHIVES: Record<string, string> = {
  "service-manager": "service-manager.tgz", "openhouse-control-plane": "openhouse-control-plane.tgz",
  "openhouse-runtime": "runtime-aarch64.tgz", wuyou: "wuyou.tgz", "openhouse-web": "openhouse-web.tgz",
};

async function executable(file: string, body = "exit 0"): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`); await chmod(file, 0o755);
}

async function archive(root: string, id: string, revision: string): Promise<Buffer> {
  const source = path.join(root, `${id}-${revision}`); await mkdir(path.join(source, "scripts"), { recursive: true });
  await executable(path.join(source, "scripts/install.sh")); await executable(path.join(source, "scripts/check.sh"));
  await executable(path.join(source, "scripts/register-service.sh"));
  if (id === "service-manager") await executable(path.join(source, "service-manager"));
  if (id === "openhouse-control-plane") await executable(path.join(source, "start-control-plane-termux-native.sh"));
  if (id === "openhouse-runtime") { await executable(path.join(source, "install.sh")); await executable(path.join(source, "bin/wuxianpi")); }
  if (id === "wuyou") {
    await executable(path.join(source, "wuyou"), `echo ${revision}`);
    if (revision === "broken") await executable(path.join(source, "scripts/install.sh"), "exit 17");
  }
  const output = path.join(root, `${id}-${revision}.tgz`);
  const packed = spawnSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", output, "-C", source, "."], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr); return readFile(output);
}

async function offer(home: string, work: string, version: string, sequence: number, releases: Map<string, {version: string; bytes: Buffer}>): Promise<void> {
  const stage = path.join(work, `bundle-${sequence}`); const resourcesDir = path.join(stage, "resources");
  await mkdir(resourcesDir, { recursive: true }); const resources = [];
  for (const id of IDS) {
    const release = releases.get(id)!; const archiveName = ARCHIVES[id];
    await writeFile(path.join(resourcesDir, archiveName), release.bytes);
    resources.push({ id, version: release.version, archive: archiveName, size: release.bytes.length, sha256: createHash("sha256").update(release.bytes).digest("hex") });
  }
  const set = { schema: 2, id: "openhouse-core-stack", version, sequence, abi: "arm64-v8a", minApkVersionCode: 126, resources };
  await writeFile(path.join(resourcesDir, "resource-set.json"), JSON.stringify(set));
  await writeFile(path.join(stage, "bundle-manifest.json"), JSON.stringify({ schema: 2, id: "openhouse-install-bundle", bundleId: `openhouse-core-stack-${sequence}`, apkVersionCode: 126, resourceSet: set }));
  const inbox = path.join(home, `.local/share/openhouseai/apk-resource-inbox/com.wuxianpi-126-${sequence}`); await mkdir(inbox, { recursive: true });
  const packed = spawnSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", path.join(inbox, "openhouse-install-bundle.tar"), "-C", stage, "."], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr); await writeFile(path.join(inbox, ".ready"), "");
}

function run(home: string, prefix: string, command: string) {
  const result = spawnSync("bash", [SCRIPT, command], { encoding: "utf8", env: {
    ...process.env, HOME: home, PREFIX: prefix, PATH: `${prefix}/bin:${process.env.PATH ?? ""}`,
    WUXIANPI_RESCUE_MARKET_URL: "http://127.0.0.1:9",
    OPENHOUSEAI_RESOURCE_MANAGER_ROOT: path.join(home, ".local/share/openhouseai/resource-manager"),
    OPENHOUSEAI_RESOURCE_INSTALL_ROOT: path.join(home, ".local/share/openhouseai/resources"),
  }}); return result;
}

test("resource updater uses TAR offers, skips equal resources, applies one delta and refuses downgrade", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-resource-update-")); const home = path.join(work, "home"); const prefix = path.join(work, "prefix");
  try {
    await mkdir(path.join(prefix, "bin"), { recursive: true });
    const managerScript = (await readFile(MANAGER, "utf8")).replace(/^#![^\n]+/, "#!/usr/bin/env bash");
    await writeFile(path.join(prefix, "bin/openhouse-resource-manager"), managerScript); await chmod(path.join(prefix, "bin/openhouse-resource-manager"), 0o755);
    await executable(path.join(prefix, "bin/wuxianpi-setup"), 'if [ -f "$HOME/fail-activation" ]; then exit 42; fi; echo activated >> "$HOME/activation.log"');
    const first = new Map<string, {version: string; bytes: Buffer}>();
    for (const id of IDS) first.set(id, { version: "1.0.0", bytes: await archive(work, id, "v1") });
    await offer(home, work, "2026.08.12.1", 2026081201, first);
    const initial = run(home, prefix, "plan"); assert.equal(initial.status, 0, initial.stderr); assert.match(initial.stdout, /changed=5/); assert.match(initial.stdout, /source=apk/);
    const applied = run(home, prefix, "apply"); assert.equal(applied.status, 0, applied.stderr);
    const unchanged = run(home, prefix, "plan"); assert.equal(unchanged.status, 0, unchanged.stderr); assert.match(unchanged.stdout, /changed=0/);
    const broken = new Map(first); broken.set("wuyou", { version: "1.0.1", bytes: await archive(work, "wuyou", "broken") });
    await offer(home, work, "2026.08.12.2", 2026081202, broken);
    const failedContent = run(home, prefix, "apply"); assert.notEqual(failedContent.status, 0);
    assert.equal(JSON.parse(await readFile(path.join(home, ".local/share/openhouseai/resource-manager/installed-set.json"), "utf8")).sequence, 2026081201);
    assert.match(await readFile(path.join(home, ".local/share/openhouseai/resources/wuyou/current/wuyou"), "utf8"), /v1/);
    await rm(path.join(home, ".local/share/openhouseai/apk-resource-inbox/com.wuxianpi-126-2026081202"), { recursive: true });
    const next = new Map(first); next.set("wuyou", { version: "1.0.2", bytes: await archive(work, "wuyou", "v2") });
    await offer(home, work, "2026.08.12.3", 2026081203, next);
    const delta = run(home, prefix, "plan"); assert.equal(delta.status, 0, delta.stderr); assert.match(delta.stdout, /changed=1/); assert.match(delta.stdout, /resource=wuyou version=1.0.2 source=apk/);
    await writeFile(path.join(home, "fail-activation"), "1");
    const failedActivation = run(home, prefix, "apply"); assert.equal(failedActivation.status, 42, failedActivation.stderr);
    assert.equal(JSON.parse(await readFile(path.join(home, ".local/share/openhouseai/resource-manager/installed-set.json"), "utf8")).sequence, 2026081203);
    await rm(path.join(home, "fail-activation"));
    const activationRetry = run(home, prefix, "apply"); assert.equal(activationRetry.status, 0, activationRetry.stderr); assert.match(activationRetry.stdout, /retrying independent activation/);
    await rm(path.join(home, ".local/share/openhouseai/apk-resource-inbox/com.wuxianpi-126-2026081203"), { recursive: true });
    const downgrade = run(home, prefix, "plan"); assert.equal(downgrade.status, 0, downgrade.stderr); assert.match(downgrade.stdout, /result=no-downgrade/);
  } finally { await rm(work, { recursive: true, force: true }); }
});
