import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlugins } from "../build-plugins.js";
import { validateManifest } from "../contracts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("builds validated deterministic plugin releases and catalog", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-plugin-build-"));
  try {
    const catalog = await buildPlugins(path.join(ROOT, "plugins", "official"), temporary);
    assert.equal(catalog.plugins.length, 7);
    const firstInstall = catalog.plugins.find((plugin) => plugin.id === "wuxianpi.first-install");
    assert.ok(firstInstall);
    const release = firstInstall.versions[0];
    const archive = await readFile(path.join(temporary, "plugins", firstInstall.id, `${release.manifest.version}.zip`));
    assert.equal(archive.subarray(0, 2).toString("binary"), "PK");
    assert.equal(createHash("sha256").update(archive).digest("hex"), release.sha256);

    const workflow = JSON.parse(await readFile(path.join(ROOT, "plugins", "official", firstInstall.id, "workflows", "install.json"), "utf8"));
    const allowed = new Set([
      "inspect_wuxianpi_setup",
      "prepare_runtime_host",
      "request_termux_home_access",
      "request_termux_run_command_permission",
      "prepare_persistent_termux",
      "start_wuxianpi_setup",
      "termux_exec_command",
      "get_wuxianpi_setup_status"
    ]);
    const toolSteps = workflow.steps.filter((step: Record<string, unknown>) => typeof step.tool === "string");
    assert.ok(toolSteps.every((step: Record<string, unknown>) => allowed.has(String(step.tool))));
    assert.equal(toolSteps.length, allowed.size);
    const stageSetup = workflow.steps.find((step: Record<string, unknown>) => step.id === "stage-setup");
    const runSetup = workflow.steps.find((step: Record<string, unknown>) => step.id === "run-setup");
    const verify = workflow.steps.find((step: Record<string, unknown>) => step.id === "verify");
    assert.deepEqual(
      { kind: stageSetup.kind, tool: stageSetup.tool },
      { kind: "tool", tool: "start_wuxianpi_setup" }
    );
    assert.deepEqual(
      { kind: runSetup.kind, tool: runSetup.tool, sourceStep: runSetup.sourceStep },
      { kind: "tool-from-result", tool: "termux_exec_command", sourceStep: "stage-setup" }
    );
    assert.deepEqual(
      { kind: verify.kind, tool: verify.tool },
      { kind: "poll-tool", tool: "get_wuxianpi_setup_status" }
    );
    assert.match(String(runSetup.description), /command、session_name 和 yield_time_ms/);
    assert.equal(workflow.executionPolicy.afterPersistentTermux, "termux_exec_command");
    assert.equal(workflow.executionPolicy.longRunningCommands, "termux_exec_command");

    const keyboard = catalog.plugins.find((plugin) => plugin.id === "wuxianpi.termux-keyboard");
    assert.ok(keyboard);
    const keyboardRelease = keyboard.versions[0];
    assert.deepEqual(
      keyboardRelease.workflows,
      [
        "workflows/apply.json",
        "workflows/remove.json",
        "workflows/restore-original.json"
      ]
    );
    assert.ok(keyboardRelease.documents.some((document) => document.path === "scripts/termux-keyboard.sh"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects unsafe manifest document paths", () => {
  assert.throws(() => validateManifest({
    schemaVersion: 1,
    id: "wuxianpi.bad",
    version: "1.0.0",
    name: "Bad",
    description: "Bad plugin",
    category: "test",
    minHostVersion: 1,
    requiredCapabilities: [],
    tags: [],
    documents: [{ path: "../outside.md", title: "Outside" }]
  }), /safe relative path/);
});
