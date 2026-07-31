import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins", "official", "wuxianpi.termux-keyboard", "scripts", "termux-keyboard.sh");

async function runScript(home: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("bash", [SCRIPT, ...args], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${path.join(home, "bin")}:${process.env.PATH ?? ""}`
    }
  });
  return result.stdout.trim();
}

async function createHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-termux-keyboard-"));
  await mkdir(path.join(home, ".termux"), { recursive: true });
  await mkdir(path.join(home, "bin"), { recursive: true });
  await writeFile(
    path.join(home, "bin", "termux-reload-settings"),
    "#!/bin/sh\nprintf 'reload\\n' >> \"$HOME/reloads\"\n",
    { mode: 0o755 }
  );
  return home;
}

test("Termux keyboard plugin applies, removes and restores without losing user settings", async () => {
  const home = await createHome();
  const properties = path.join(home, ".termux", "termux.properties");
  const original = "bell-character=ignore\nextra-keys = [['OLD']]\n";
  try {
    await writeFile(properties, original);

    assert.equal(await runScript(home, "apply"), "applied");
    const applied = await readFile(properties, "utf8");
    assert.match(applied, /bell-character=ignore/);
    assert.match(applied, /extra-keys = \[\['OLD'\]\]/);
    assert.match(applied, /# BEGIN WUXIANPI KEYBOARD/);
    assert.match(applied, /\['DRAWER','ENTER'/);
    assert.equal(
      await readFile(path.join(home, ".termux", "wuxianpi-backups", "termux.properties.original"), "utf8"),
      original
    );

    assert.equal(await runScript(home, "apply"), "already applied");
    assert.equal((await readFile(path.join(home, "reloads"), "utf8")).trim().split("\n").length, 1);

    assert.equal(await runScript(home, "remove"), "removed");
    const removed = await readFile(properties, "utf8");
    assert.match(removed, /extra-keys = \[\['OLD'\]\]/);
    assert.doesNotMatch(removed, /WUXIANPI KEYBOARD/);

    await assert.rejects(runScript(home, "restore-original"), /requires --confirm/);
    await writeFile(properties, `${removed}# BEGIN WUXIANPI KEYBOARD\nuse-black-ui=true\n`);
    assert.equal(await runScript(home, "restore-original", "--confirm"), "original restored");
    assert.equal(await readFile(properties, "utf8"), original);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Termux keyboard plugin restores an originally absent properties file", async () => {
  const home = await createHome();
  const properties = path.join(home, ".termux", "termux.properties");
  try {
    assert.equal(await runScript(home, "apply"), "applied");
    assert.equal(await runScript(home, "restore-original", "--confirm"), "original restored");
    await assert.rejects(readFile(properties), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
