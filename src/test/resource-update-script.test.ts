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

async function executable(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\nset -eu\n${contents}\n`);
  await chmod(file, 0o755);
}

async function resourceArchive(root: string, id: string, revision: string): Promise<Buffer> {
  const source = path.join(root, `${id}-${revision}`);
  await mkdir(source, { recursive: true });
  switch (id) {
    case "service-manager":
      await executable(path.join(source, "service-manager"), 'if [ "${1:-}" = "--version" ]; then echo "service-manager fixture"; elif [ "${1:-}" = token ]; then echo fixture-token; fi');
      await executable(path.join(source, "scripts/install.sh"), 'root=$(CDPATH= cd "$(dirname "$0")/.." && pwd); mkdir -p "$PREFIX/bin"; cp "$root/service-manager" "$PREFIX/bin/service-manager"; chmod 755 "$PREFIX/bin/service-manager"');
      break;
    case "openhouse-control-plane":
      await executable(path.join(source, "start-control-plane-termux-native.sh"), "exit 0");
      await executable(path.join(source, "repair-control-plane-termux-native.sh"), "exit 0");
      await executable(path.join(source, "inspect-control-plane-termux-native.sh"), "exit 0");
      break;
    case "openhouse-runtime":
      await executable(path.join(source, "install.sh"), "exit 0");
      await executable(path.join(source, "scripts/check.sh"), "exit 0");
      await executable(path.join(source, "scripts/register-service.sh"), "exit 0");
      await executable(path.join(source, "bin/wuxianpi"), "exit 0");
      break;
    case "wuyou":
      await executable(path.join(source, "wuyou"), `echo ${revision}`);
      await executable(path.join(source, "scripts/install.sh"), "exit 0");
      await executable(path.join(source, "scripts/check.sh"), "exit 0");
      await executable(path.join(source, "scripts/register-service.sh"), "exit 0");
      break;
    case "openhouse-web":
      await executable(path.join(source, "scripts/install.sh"), "exit 0");
      await executable(path.join(source, "scripts/check.sh"), "exit 0");
      await executable(path.join(source, "scripts/register-service.sh"), "exit 0");
      break;
    default:
      throw new Error(`unknown fixture resource ${id}`);
  }
  const archive = path.join(root, `${id}-${revision}.tgz`);
  const packed = spawnSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", source, "."], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  return readFile(archive);
}

function runUpdate(home: string, prefix: string, apkRoot: string, command: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("bash", [SCRIPT, command], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PREFIX: prefix,
      PATH: `${prefix}/bin:${process.env.PATH ?? ""}`,
      OPENHOUSEAI_APK_RESOURCES_ROOT: apkRoot,
      OPENHOUSEAI_RESOURCE_MANAGER_ROOT: path.join(home, ".local/share/openhouseai/resource-manager"),
      OPENHOUSEAI_RESOURCE_INSTALL_ROOT: path.join(home, ".local/share/openhouseai/resources"),
      OPENHOUSEAI_APK_VERSION_CODE: "126",
      OPENHOUSEAI_DISABLE_NETWORK: "1",
      OPENHOUSEAI_SKIP_LIVE_HEALTH: "1",
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("resource updater converges five resources, repairs damage and rolls back a set", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-resource-update-"));
  const home = path.join(temporary, "home");
  const prefix = path.join(temporary, "prefix");
  const apkRoot = path.join(home, ".local/share/openhouseai/update-resources");
  const manager = path.join(home, ".local/share/openhouseai/resource-manager");
  const ids = ["service-manager", "openhouse-control-plane", "openhouse-runtime", "wuyou", "openhouse-web"];
  const archiveNames: Record<string, string> = {
    "service-manager": "service-manager.tgz",
    "openhouse-control-plane": "openhouse-control-plane.tgz",
    "openhouse-runtime": "runtime-aarch64.tgz",
    wuyou: "wuyou.tgz",
    "openhouse-web": "openhouse-web.tgz",
  };
  try {
    await mkdir(path.join(prefix, "bin"), { recursive: true });
    const releases = new Map<string, { version: string; bytes: Buffer; sha256: string }>();
    for (const id of ids) {
      const bytes = await resourceArchive(temporary, id, "v1");
      releases.set(id, { version: "1.0.0", bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
    }

    const writeSet = async (directory: string, version: string, sequence: number, values: typeof releases, complete: boolean) => {
      const payloads = path.join(directory, "product-payloads");
      await mkdir(payloads, { recursive: true });
      const resources = [];
      for (const id of ids) {
        const release = values.get(id)!;
        await writeFile(path.join(payloads, archiveNames[id]), release.bytes);
        resources.push({ id, version: release.version, sha256: release.sha256 });
      }
      await writeFile(path.join(payloads, "resource-set.json"), `${JSON.stringify({
        schema: 2,
        id: "openhouse-core-stack",
        version,
        sequence,
        abi: "arm64-v8a",
        minApkVersionCode: 126,
        resources,
      }, null, 2)}\n`);
      if (complete) {
        await writeFile(path.join(directory, ".complete"), '{"apkVersionCode":126}\n');
        await writeFile(path.join(directory, ".pending"), "pending\n");
      }
    };

    await writeSet(path.join(apkRoot, "apk-126"), "2026.08.09.1", 2026080901, releases, true);
    await writeSet(path.join(apkRoot, "apk-incomplete"), "2099.01.01.1", 2099010101, releases, false);
    await writeFile(path.join(apkRoot, "PENDING_APK_RESOURCES.json"), '{"apkVersionCode":126}\n');

    const initialPlan = runUpdate(home, prefix, apkRoot, "plan");
    assert.equal(initialPlan.status, 0, initialPlan.stderr);
    assert.match(initialPlan.stdout, /target_resources=5/);
    assert.match(initialPlan.stdout, /from_apk=5/);
    assert.doesNotMatch(initialPlan.stdout, /2099\.01\.01\.1/);

    const firstApply = runUpdate(home, prefix, apkRoot, "apply");
    assert.equal(firstApply.status, 0, firstApply.stderr);
    assert.equal(JSON.parse(await readFile(path.join(manager, "installed-set.json"), "utf8")).sequence, 2026080901);

    const unchanged = runUpdate(home, prefix, apkRoot, "plan");
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(unchanged.stdout, /unchanged=5/);

    await writeFile(path.join(home, ".local/share/openhouseai/resources/wuyou/versions/1.0.0/wuyou"), "damaged\n");
    const repairPlan = runUpdate(home, prefix, apkRoot, "plan");
    assert.equal(repairPlan.status, 0, repairPlan.stderr);
    assert.match(repairPlan.stdout, /unchanged=4/);
    assert.match(repairPlan.stdout, /from_(apk|cache)=1/);
    const repaired = runUpdate(home, prefix, apkRoot, "apply");
    assert.equal(repaired.status, 0, repaired.stderr);

    const next = new Map(releases);
    const nextWuyou = await resourceArchive(temporary, "wuyou", "v2");
    next.set("wuyou", {
      version: "1.0.1",
      bytes: nextWuyou,
      sha256: createHash("sha256").update(nextWuyou).digest("hex"),
    });
    await writeSet(path.join(apkRoot, "apk-127"), "2026.08.09.2", 2026080902, next, true);
    const deltaPlan = runUpdate(home, prefix, apkRoot, "plan");
    assert.equal(deltaPlan.status, 0, deltaPlan.stderr);
    assert.match(deltaPlan.stdout, /unchanged=4/);
    assert.match(deltaPlan.stdout, /from_apk=1/);
    const secondApply = runUpdate(home, prefix, apkRoot, "apply");
    assert.equal(secondApply.status, 0, secondApply.stderr);
    assert.equal(JSON.parse(await readFile(path.join(manager, "installed-set.json"), "utf8")).sequence, 2026080902);

    const rollback = runUpdate(home, prefix, apkRoot, "rollback");
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.equal(JSON.parse(await readFile(path.join(manager, "installed-set.json"), "utf8")).sequence, 2026080901);
    const verification = runUpdate(home, prefix, apkRoot, "verify");
    assert.equal(verification.status, 0, verification.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
