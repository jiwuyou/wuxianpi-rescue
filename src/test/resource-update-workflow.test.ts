import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN = path.join(ROOT, "plugins/official/wuxianpi.resource-update");

test("APK companion update only repairs the Android-private connection", async () => {
  const manifest = JSON.parse(await readFile(path.join(PLUGIN, "manifest.json"), "utf8"));
  const workflow = JSON.parse(await readFile(path.join(PLUGIN, "workflows/update.json"), "utf8"));
  const guide = await readFile(path.join(PLUGIN, "docs/guide.md"), "utf8");

  assert.equal(manifest.version, "4.0.1");
  assert.equal(manifest.name, "APK 配套更新");
  assert.deepEqual(manifest.documents.map((document: { path: string }) => document.path), ["docs/guide.md"]);

  const tools = workflow.steps.map((step: { tool: string }) => step.tool);
  assert.deepEqual(tools, [
    "inspect_apk_resource_offer",
    "store_service_manager_connection",
    "prepare_persistent_termux",
    "termux_exec_command",
    "write_service_manager_connection",
    "store_service_manager_connection",
    "complete_apk_resource_offer",
  ]);

  const readTermux = workflow.steps.find((step: { id: string }) => step.id === "read-termux-connection");
  const writeAndroid = workflow.steps.find((step: { id: string }) => step.id === "write-android-connection");
  const complete = workflow.steps.find((step: { id: string }) => step.id === "complete-apk-offer");
  assert.match(readTermux.when, /reason == apk-update/);
  assert.match(readTermux.when, /hasToken != true/);
  assert.match(readTermux.arguments.command, /wuxianpi-setup.*connection-info/);
  assert.equal(writeAndroid.arguments.serviceManagerBaseUrl, "{{steps.read-termux-connection.serviceManagerBaseUrl}}");
  assert.equal(writeAndroid.arguments.token, "{{steps.read-termux-connection.token}}");
  assert.deepEqual(complete.arguments, {
    status: "satisfied",
    detail: "Android-private service-manager connection verified",
  });

  const serialized = JSON.stringify(workflow);
  for (const forbidden of [
    "stage_apk_resource_bundle",
    "openhouse-core-stack",
    "openhouse-resource-manager",
    "resources-v2",
    "wuxianpi-setup activate",
    "openhouse-runtime",
    "openhouse-web",
    "20765",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(guide, /不会：[\s\S]*更新 service-manager/);
  assert.match(guide, /结束本次提醒/);
});
