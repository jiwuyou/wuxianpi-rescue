import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();

test("first install and repair publish the same fixed control-plane contract", async () => {
  const firstInstall = path.join(ROOT, "plugins", "official", "wuxianpi.first-install", "scripts");
  const repair = path.join(ROOT, "plugins", "official", "wuxianpi.termux-repair", "scripts");
  const [entry, implementation, repairEntry, repairImplementation] = await Promise.all([
    readFile(path.join(firstInstall, "openhouse-control-plane-start"), "utf8"),
    readFile(path.join(firstInstall, "start-service-manager.sh"), "utf8"),
    readFile(path.join(repair, "openhouse-control-plane-start"), "utf8"),
    readFile(path.join(repair, "start-service-manager.sh"), "utf8"),
  ]);

  assert.equal(entry, repairEntry);
  assert.equal(implementation, repairImplementation);
  assert.equal(
    entry,
    "#!/data/data/com.termux/files/usr/bin/bash\nexec \"$PREFIX/libexec/openhouse/start-service-manager.sh\"\n",
  );
  assert.match(implementation, /openhouse-control-plane-start\.lock/);
  assert.match(implementation, /service-daemon\" start/);
  assert.match(implementation, /sv\" up service-manager/);
  assert.match(implementation, /runsvdir=ready/);
  assert.match(implementation, /service-daemon=already-running/);
  for (const forbidden of [
    "authToken",
    "/api/v1/services",
    "resource-set",
    "sha256",
    "registry",
    "install-service",
  ]) {
    assert.doesNotMatch(implementation, new RegExp(forbidden, "i"));
  }
});
