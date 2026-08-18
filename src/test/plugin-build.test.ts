import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPlugins } from "../build-plugins.js";
import { validateManifest } from "../contracts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("builds validated deterministic plugin releases and catalog", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-plugin-build-"));
  try {
    const catalog = await buildPlugins(path.join(ROOT, "plugins", "official"), temporary);
    const pluginIds = new Set(catalog.plugins.map((plugin) => plugin.id));
    for (const requiredId of [
      "wuxianpi.first-install",
      "wuxianpi.resource-update",
      "wuxianpi.session-bootstrap",
      "wuxianpi.session-runtime",
      "wuxianpi.openhouse-small-app-guide",
      "wuxianpi.service-manager",
      "wuxianpi.setup-finish"
    ]) {
    assert.ok(pluginIds.has(requiredId), `missing required plugin ${requiredId}`);
    }
    const runtime = catalog.plugins.find((plugin) => plugin.id === "wuxianpi.session-runtime");
    assert.equal(runtime?.latestVersion, "1.0.2");
    assert.equal(runtime?.versions[0].manifest.sessionRole, "runtime");
    assert.deepEqual(
      runtime?.versions[0].manifest.actions.map((action) => action.id),
      ["first-install", "resource-update", "daily-maintenance"]
    );
    const firstInstall = catalog.plugins.find((plugin) => plugin.id === "wuxianpi.first-install");
    assert.ok(firstInstall);
    assert.deepEqual(
      firstInstall.versions.map((candidate) => candidate.manifest.version),
      ["1.0.28", "1.0.23", "1.0.21", "1.0.10", "1.0.9", "1.0.8", "1.0.7", "1.0.6", "1.0.5", "1.0.4", "1.0.3", "1.0.2", "1.0.1", "1.0.0"]
    );
    assert.equal(firstInstall.versions.find((candidate) => candidate.manifest.version === "1.0.1")?.sha256,
      "0f18af13475719d8b4669a2ed2a3d90c2d4a406488f64a0a0104787a31fd5646");
    assert.equal(firstInstall.versions.find((candidate) => candidate.manifest.version === "1.0.0")?.sha256,
      "791424f96a6d59942e0d8e6ccebe5433fa4fe93e709e80e72fb6b7b30cdbded4");
    const release = firstInstall.versions[0];
    assert.equal(release.manifest.version, "1.0.28");
    const archive = await readFile(path.join(temporary, "plugins", firstInstall.id, `${release.manifest.version}.zip`));
    assert.equal(archive.subarray(0, 2).toString("binary"), "PK");
    assert.equal(createHash("sha256").update(archive).digest("hex"), release.sha256);

    const workflow = JSON.parse(await readFile(path.join(ROOT, "plugins", "official", firstInstall.id, "workflows", "install.json"), "utf8"));
    const allowed = new Set([
      "inspect_wuxianpi_setup",
      "prepare_runtime_host",
      "request_termux_run_command_permission",
      "configure_termux_external_apps",
      "execute_termux_command",
      "start_wuxianpi_setup",
      "termux_exec_command",
      "get_wuxianpi_setup_status",
      "store_service_manager_connection",
      "ensure_openhouse_connection_bridge",
      "write_service_manager_connection",
      "complete_apk_resource_offer",
      "install_rescue_plugin",
      "start_rescue_plugin_workflow"
    ]);
    const toolSteps = workflow.steps.filter((step: Record<string, unknown>) => typeof step.tool === "string");
    assert.ok(toolSteps.every((step: Record<string, unknown>) => allowed.has(String(step.tool))));
    const stageSetup = workflow.steps.find((step: Record<string, unknown>) => step.id === "stage-setup");
    const runCommand = workflow.steps.find((step: Record<string, unknown>) => step.id === "run-command");
    const runSetup = workflow.steps.find((step: Record<string, unknown>) => step.id === "run-setup");
    const initializeBase = workflow.steps.find((step: Record<string, unknown>) => step.id === "initialize-termux-base");
    const marketContent = workflow.steps.find((step: Record<string, unknown>) => step.id === "market-content");
    const verifyContent = workflow.steps.find((step: Record<string, unknown>) => step.id === "verify-content");
    const verify = workflow.steps.find((step: Record<string, unknown>) => step.id === "verify-activation");
    const reconcilePackages = workflow.steps.find((step: Record<string, unknown>) => step.id === "reconcile-preinstalled-packages");
    assert.deepEqual(
      { kind: stageSetup.kind, tool: stageSetup.tool },
      { kind: "tool", tool: "start_wuxianpi_setup" }
    );
    assert.equal(stageSetup.when, undefined);
    assert.deepEqual(
      { kind: runSetup.kind, tool: runSetup.tool, sourceStep: runSetup.sourceStep },
      { kind: "tool-from-result", tool: "termux_exec_command", sourceStep: "stage-setup" }
    );
    assert.deepEqual(
      { kind: verify.kind, tool: verify.tool },
      { kind: "poll-tool", tool: "get_wuxianpi_setup_status" }
    );
    assert.equal(reconcilePackages.tool, "termux_exec_command");
    assert.match(String(reconcilePackages.arguments.command), /reconcile-preinstalled/);
    assert.match(String(reconcilePackages.arguments.command), /distribution-packages/);
    assert.doesNotMatch(String(reconcilePackages.arguments.command), /github-bug-reporter|small-app-guide|pi-mcp-adapter/);
    assert.equal(runCommand.when, "runtimeHost.externalTermux");
    assert.match(String(runCommand.description), /仅检查/);
    const configureExternalApps = workflow.steps.find((step: Record<string, unknown>) => step.id === "configure-external-apps");
    const reloadSettings = workflow.steps.find((step: Record<string, unknown>) => step.id === "reload-termux-settings");
    const verifyRunCommand = workflow.steps.find((step: Record<string, unknown>) => step.id === "verify-run-command");
    assert.equal(configureExternalApps.tool, "configure_termux_external_apps");
    assert.equal(reloadSettings.kind, "user-action");
    assert.match(String(reloadSettings.description), /termux-reload-settings/);
    assert.equal(verifyRunCommand.tool, "execute_termux_command");
    assert.match(String(verifyRunCommand.arguments.command), /printf %s wuxianpi-termux-ready/);
    const persistentTerminal = workflow.steps.find((step: Record<string, unknown>) => step.id === "persistent-terminal");
    assert.equal(persistentTerminal.tool, "execute_termux_command");
    assert.doesNotMatch(String(persistentTerminal.arguments.command), /libncursesw/);
    assert.match(String(persistentTerminal.arguments.command), /PATH=\"\$PREFIX\/bin/);
    assert.ok(workflow.steps.indexOf(runCommand) < workflow.steps.indexOf(configureExternalApps));
    assert.ok(workflow.steps.indexOf(configureExternalApps) < workflow.steps.indexOf(reloadSettings));
    assert.ok(workflow.steps.indexOf(reloadSettings) < workflow.steps.indexOf(verifyRunCommand));
    assert.match(String(runSetup.description), /已投递的 TAR/);
    const baseCommand = String(initializeBase.arguments.command);
    assert.doesNotMatch(baseCommand, /pkg upgrade/);
    assert.doesNotMatch(baseCommand, /libncursesw/);
    assert.match(baseCommand, /zstd/);
    assert.doesNotMatch(baseCommand, /proot-distro/);
    assert.match(baseCommand, /termux-services/);
    assert.match(baseCommand, /git/);
    assert.match(baseCommand, /nodejs-lts/);
    assert.match(baseCommand, /node_major/);
    assert.match(baseCommand, /nodejs.*24|24.*nodejs/);
    assert.equal(marketContent.tool, "termux_exec_command");
    assert.match(String(marketContent.arguments.command), /api\/v2\/resource-sets\/openhouse-core-stack/);
    assert.match(String(marketContent.arguments.command), /openhouse-resource-manager.*market/);
    assert.match(String(marketContent.arguments.command), /\.guide\.markdown/);
    assert.match(String(marketContent.arguments.command), /market_content=unavailable/);
    assert.doesNotMatch(String(marketContent.arguments.command), /resources \| length/);
    assert.doesNotMatch(String(marketContent.arguments.command), /resources-v2/);
    assert.doesNotMatch(String(marketContent.arguments.command), /sha256sum/);
    assert.ok(workflow.steps.indexOf(initializeBase) < workflow.steps.indexOf(stageSetup));
    assert.ok(workflow.steps.indexOf(stageSetup) < workflow.steps.indexOf(runSetup));
    const verifyLocalContent = workflow.steps.find((step: Record<string, unknown>) => step.id === "verify-local-content");
    assert.ok(workflow.steps.indexOf(runSetup) < workflow.steps.indexOf(verifyLocalContent));
    assert.ok(workflow.steps.indexOf(verifyLocalContent) < workflow.steps.indexOf(marketContent));
    assert.ok(workflow.steps.indexOf(marketContent) < workflow.steps.indexOf(verifyContent));
    assert.equal(workflow.executionPolicy.afterPersistentTermux, "termux_exec_command");
    assert.equal(workflow.executionPolicy.longRunningCommands, "termux_exec_command");
    assert.match(String(verify.description), /activation=ready/);
    const activation = workflow.steps.find((step: Record<string, unknown>) => step.id === "activate-runtime");
    const ensureBridge = workflow.steps.find((step: Record<string, unknown>) => step.id === "ensure-connection-bridge");
    const completeOffer = workflow.steps.find((step: Record<string, unknown>) => step.id === "complete-resource-offer");
    const storeConnection = workflow.steps.find((step: Record<string, unknown>) => step.id === "store-service-manager-connection");
    const readConnection = workflow.steps.find((step: Record<string, unknown>) => step.id === "read-service-manager-connection");
    const writeConnection = workflow.steps.find((step: Record<string, unknown>) => step.id === "write-service-manager-connection");
    const confirmConnection = workflow.steps.find((step: Record<string, unknown>) => step.id === "confirm-service-manager-connection");
    const installUbuntu = workflow.steps.find((step: Record<string, unknown>) => step.id === "install-ubuntu");
    const resourceSetVerify = workflow.steps.find((step: Record<string, unknown>) => step.id === "verify-resource-set");
    const resourceUpdaterCheck = workflow.steps.find((step: Record<string, unknown>) => step.id === "prepare-resource-updater");
    assert.equal(activation.tool, "termux_exec_command");
    assert.equal(ensureBridge.tool, "ensure_openhouse_connection_bridge");
    assert.match(String(activation.arguments.command), /wuxianpi-setup.*activate/);
    assert.match(String(activation.arguments.command), /--connection-bridge-id/);
    assert.match(String(activation.arguments.command), /steps\.ensure-connection-bridge\.bridgeId/);
    assert.match(String(activation.arguments.command), /\*'\{\{'/);
    assert.match(String(activation.arguments.command), /var\/service/);
    assert.match(String(activation.arguments.command), /openhouse-control-plane-start/);
    assert.match(String(activation.arguments.command), /start-service-manager\.sh/);
    assert.match(String(activation.arguments.command), /_termux-services-env\.sh/);
    assert.match(String(activation.arguments.command), /50-install-runtime-components\.sh/);
    assert.match(String(activation.arguments.command), /60-start-smallphone\.sh/);
    assert.match(String(activation.arguments.command), /--request/);
    assert.match(String(activation.arguments.command), /request\.json/);
    assert.equal(completeOffer.tool, "complete_apk_resource_offer");
    assert.equal(storeConnection.tool, "store_service_manager_connection");
    assert.equal(readConnection.tool, "termux_exec_command");
    assert.match(String(readConnection.arguments.command), /wuxianpi-setup.*connection-info/);
    assert.equal(writeConnection.tool, "write_service_manager_connection");
    assert.equal(confirmConnection.tool, "store_service_manager_connection");
    assert.match(String(installUbuntu.arguments.command), /wuxianpi-setup.*ubuntu/);
    assert.match(String(installUbuntu.arguments.command), /proot-distro/);
    assert.doesNotMatch(String(verifyContent.arguments.command), /resources \| length/);
    assert.ok(workflow.steps.indexOf(runSetup) < workflow.steps.indexOf(verifyContent));
    assert.ok(workflow.steps.indexOf(verifyContent) < workflow.steps.indexOf(activation));
    assert.ok(workflow.steps.indexOf(ensureBridge) < workflow.steps.indexOf(activation));
    assert.ok(workflow.steps.indexOf(activation) < workflow.steps.indexOf(verify));
    assert.ok(workflow.steps.indexOf(verify) < workflow.steps.indexOf(reconcilePackages));
    assert.ok(workflow.steps.indexOf(verify) < workflow.steps.indexOf(storeConnection));
    assert.ok(workflow.steps.indexOf(storeConnection) < workflow.steps.indexOf(readConnection));
    assert.ok(workflow.steps.indexOf(readConnection) < workflow.steps.indexOf(writeConnection));
    assert.ok(workflow.steps.indexOf(writeConnection) < workflow.steps.indexOf(confirmConnection));
    assert.ok(workflow.steps.indexOf(confirmConnection) < workflow.steps.indexOf(completeOffer));
    assert.ok(workflow.steps.indexOf(completeOffer) < workflow.steps.indexOf(installUbuntu));
    assert.equal(resourceSetVerify, undefined);
    assert.equal(resourceUpdaterCheck, undefined);
    const finishInstall = workflow.steps.find((step: Record<string, unknown>) => step.id === "install-finish-plugin");
    const finishStart = workflow.steps.find((step: Record<string, unknown>) => step.id === "start-finish-plugin");
    assert.equal(finishInstall.tool, "install_rescue_plugin");
    assert.equal(finishInstall.arguments.pluginId, "wuxianpi.setup-finish");
    assert.equal(finishStart.tool, "start_rescue_plugin_workflow");
    assert.equal(finishStart.arguments.pluginId, "wuxianpi.setup-finish");
    assert.deepEqual(verify.retryPolicy, {
      maxAttempts: 10,
      delayMs: 3000,
      retryWhen: ["activation=pending", "service-manager 20087 暂不可达", "registry 同步仍在进行"]
    });

    const firstInstallGuide = await readFile(
      path.join(ROOT, "plugins", "official", firstInstall.id, "docs", "guide.md"),
      "utf8"
    );
    assert.match(firstInstallGuide, /首次安装不依赖资源更新插件/);
    assert.match(firstInstallGuide, /Android 私有连接确认都完成后单独安装/);
    assert.match(firstInstallGuide, /openhouse-install-bundle\.tar/);
    assert.match(firstInstallGuide, /本地投递与市场补齐/);
    assert.match(firstInstallGuide, /任意数量的 `wuxianpi-package-\*`/);
    assert.match(firstInstallGuide, /All-in-One 与 Native 使用同一份 Android 投递 TAR/);
    assert.match(firstInstallGuide, /注册资源/);
    assert.match(firstInstallGuide, /三个独立阶段/);
    assert.match(firstInstallGuide, /RUN_COMMAND/);
    assert.match(firstInstallGuide, /不请求 SAF/);
    assert.match(firstInstallGuide, /service-manager/);
    const registrationScript = await readFile(
      path.join(ROOT, "plugins", "official", firstInstall.id, "scripts", "register-openhouse-component.sh"),
      "utf8"
    );
    assert.match(registrationScript, /SERVICE_ID="yuanshengwuxianpi"/);
    assert.match(registrationScript, /COMPONENT_ID="\$SERVICE_ID"/);
    assert.match(registrationScript, /SERVICE_SPEC=.*service-manager\/services\.d/);
    assert.match(registrationScript, /api_request POST ["']?\/api\/v1\/registry\/apply/);
    assert.match(registrationScript, /api_request POST ["']?\/api\/v1\/registry\/sync/);
    assert.match(registrationScript, /endpoints\/runtime/);
    assert.match(registrationScript, /\.name == "runtime"/);
    assert.match(registrationScript, /\.dynamic == true/);
    assert.doesNotMatch(registrationScript, /RUNTIME_REGISTER|"\$RUNTIME_REGISTER"/);
    assert.doesNotMatch(registrationScript, /LEGACY_COMPONENT_ID|migrate_legacy_component_file/);

    const firstInstallDev = catalog.plugins.find((plugin) => plugin.id === "wuxianpi.first-install-dev");
    assert.ok(firstInstallDev);
    assert.equal(firstInstallDev.latestVersion, "0.2.0");
    const devWorkflow = JSON.parse(await readFile(
      path.join(ROOT, "plugins", "official", firstInstallDev.id, "workflows", "install.json"),
      "utf8"
    ));
    const devSteps = new Map(
      devWorkflow.steps.map((step: Record<string, unknown>) => [String(step.id), step])
    );
    assert.equal(devSteps.has("handoff-production"), false);
    for (const requiredStep of [
      "mirror-and-tmux", "initialize-termux-base", "stage-setup", "market-content",
      "activate-runtime", "reconcile-preinstalled-packages", "confirm-service-manager-connection",
      "install-ubuntu", "start-finish-plugin"
    ]) {
      assert.ok(devSteps.has(requiredStep), `development first install is missing ${requiredStep}`);
    }
    const devMirror = devSteps.get("mirror-and-tmux") as Record<string, any>;
    assert.match(String(devMirror.arguments.command), /termux-mirror-0\.2\.0\.sh/);
    const devMarket = devSteps.get("market-content") as Record<string, any>;
    assert.match(String(devMarket.arguments.command), /resource-sets\/openhouse-core-stack-dev/);
    assert.match(String(devMarket.arguments.command), /resource-set-compatible\.json/);
    assert.match(String(devMarket.arguments.command), /openhouse-install-ubuntu.*1\.0\.2/);
    assert.match(String(devMarket.arguments.command), /openhouse-ubuntu-mirror-policy.*1\.0\.2/);
    assert.match(String(devMarket.arguments.command), /openhouse-update-ubuntu-packages.*1\.0\.2/);
    assert.doesNotMatch(String(devMarket.arguments.command), /market_content=unavailable/);
    assert.ok(
      devWorkflow.steps.findIndex((step: Record<string, unknown>) => step.id === "mirror-and-tmux") <
      devWorkflow.steps.findIndex((step: Record<string, unknown>) => step.id === "initialize-termux-base")
    );
    assert.ok(
      devWorkflow.steps.findIndex((step: Record<string, unknown>) => step.id === "market-content") <
      devWorkflow.steps.findIndex((step: Record<string, unknown>) => step.id === "activate-runtime")
    );

    const resourceUpdate = catalog.plugins.find((plugin) => plugin.id === "wuxianpi.resource-update");
    assert.ok(resourceUpdate);
    assert.equal(resourceUpdate.latestVersion, "4.0.1");
    assert.equal(resourceUpdate.versions[0].manifest.name, "APK 配套更新");
    assert.deepEqual(resourceUpdate.versions[0].workflows, ["workflows/update.json"]);
    assert.deepEqual(
      resourceUpdate.versions[0].documents.map((document) => document.path),
      ["docs/guide.md"]
    );

    const serviceManagerGuide = await readFile(
      path.join(ROOT, "plugins", "official", "wuxianpi.service-manager", "docs", "guide.md"),
      "utf8"
    );
    assert.match(serviceManagerGuide, /sv status/);
    assert.match(serviceManagerGuide, /127\.0\.0\.1:20087/);
    assert.match(serviceManagerGuide, /`stopped` 是正常闲置状态/);

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

    const openHouseGuide = catalog.plugins.find(
      (plugin) => plugin.id === "wuxianpi.openhouse-small-app-guide"
    );
    assert.ok(openHouseGuide);
    const openHouseRelease = openHouseGuide.versions[0];
    assert.equal(openHouseRelease.manifest.minHostVersion, 13);
    assert.deepEqual(openHouseRelease.manifest.assistantContexts, [
      { path: "prompts/instruction.md", scope: "session", provider: "static" }
    ]);
    const instruction = await readFile(
      path.join(ROOT, "plugins", "official", openHouseGuide.id, "prompts", "instruction.md"),
      "utf8"
    );
    assert.equal(
      instruction,
      "需要创建或管理 OpenHouse 小 App 时，先读取《OpenHouse 小 App 开发与统一接入指南》。\n"
    );
    const guide = await readFile(
      path.join(ROOT, "plugins", "official", openHouseGuide.id, "docs", "guide.md")
    );
    assert.equal(
      createHash("sha256").update(guide).digest("hex"),
      "369f82002a39dffab56c4507af149a228ed0e8679bacbcd1d4e0b5b712925b47"
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("preserves immutable historical releases with deterministic SemVer ordering", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-plugin-history-"));
  const source = path.join(temporary, "source");
  const output = path.join(temporary, "public");
  const pluginDirectory = path.join(source, "wuxianpi.fixture");
  const documentPath = path.join(pluginDirectory, "docs", "guide.md");

  const writeFixture = async (version: string, content: string) => {
    await mkdir(path.dirname(documentPath), { recursive: true });
    await writeFile(path.join(pluginDirectory, "manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "wuxianpi.fixture",
      version,
      name: "Fixture",
      description: "Plugin build fixture",
      category: "test",
      minHostVersion: 1,
      requiredCapabilities: [],
      tags: ["fixture"],
      documents: [{ path: "docs/guide.md", title: "Guide" }]
    }, null, 2)}\n`);
    await writeFile(documentPath, content);
  };

  try {
    await writeFixture("1.0.9", "historical\n");
    const initial = await buildPlugins(source, output);
    const historical = initial.plugins[0].versions[0];

    await writeFixture("1.0.10", "latest\n");
    const updated = await buildPlugins(source, output);
    assert.deepEqual(
      updated.plugins[0].versions.map((release) => release.manifest.version),
      ["1.0.10", "1.0.9"]
    );
    assert.equal(updated.plugins[0].latestVersion, "1.0.10");
    assert.equal(
      createHash("sha256")
        .update(await readFile(path.join(output, "plugins", "wuxianpi.fixture", "1.0.9.zip")))
        .digest("hex"),
      historical.sha256
    );

    const identical = await buildPlugins(source, output);
    assert.deepEqual(
      identical.plugins[0].versions.map((release) => release.manifest.version),
      ["1.0.10", "1.0.9"]
    );

    await writeFile(documentPath, "mutated without a version bump\n");
    await assert.rejects(
      buildPlugins(source, output),
      /wuxianpi\.fixture@1\.0\.10: published releases are immutable/
    );
    const catalogAfterFailure = JSON.parse(await readFile(path.join(output, "catalog.json"), "utf8"));
    assert.deepEqual(
      catalogAfterFailure.plugins[0].versions.map((release: { manifest: { version: string } }) => release.manifest.version),
      ["1.0.10", "1.0.9"]
    );

    await rm(path.join(output, "catalog.json"));
    await assert.rejects(
      buildPlugins(source, output),
      /wuxianpi\.fixture@1\.0\.10: published archive is immutable/
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("published first-install catalog retains source history and a coherent latest pointer", async () => {
  const catalog = JSON.parse(await readFile(path.join(ROOT, "public", "catalog.json"), "utf8"));
  const firstInstall = catalog.plugins.find((plugin: { id: string }) => plugin.id === "wuxianpi.first-install");
  assert.ok(firstInstall);
  const versions = firstInstall.versions.map((release: { manifest: { version: string } }) => release.manifest.version);
  assert.equal(firstInstall.latestVersion, versions[0]);
  assert.equal(new Set(versions).size, versions.length);
  for (const version of ["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6"]) {
    assert.ok(versions.includes(version), `missing first-install history ${version}`);
  }
});

test("orders equal-precedence build metadata versions deterministically", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-plugin-build-metadata-"));
  const source = path.join(temporary, "source");
  const output = path.join(temporary, "public");
  const pluginDirectory = path.join(source, "wuxianpi.build-metadata");

  const writeFixture = async (version: string) => {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(path.join(pluginDirectory, "manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "wuxianpi.build-metadata",
      version,
      name: "Build metadata fixture",
      description: "Equal precedence fixture",
      category: "test",
      minHostVersion: 1,
      requiredCapabilities: [],
      tags: [],
      documents: []
    }, null, 2)}\n`);
  };

  try {
    await writeFixture("1.0.0+build.2");
    await buildPlugins(source, output);
    await writeFixture("1.0.0+build.1");
    const catalog = await buildPlugins(source, output);
    assert.deepEqual(
      catalog.plugins[0].versions.map((release) => release.manifest.version),
      ["1.0.0+build.2", "1.0.0+build.1"]
    );
    assert.equal(catalog.plugins[0].latestVersion, "1.0.0+build.2");

    const catalogPath = path.join(output, "catalog.json");
    const reversed = JSON.parse(await readFile(catalogPath, "utf8"));
    reversed.plugins[0].versions.reverse();
    await writeFile(catalogPath, `${JSON.stringify(reversed, null, 2)}\n`);
    const rebuilt = await buildPlugins(source, output);
    assert.deepEqual(
      rebuilt.plugins[0].versions.map((release) => release.manifest.version),
      ["1.0.0+build.2", "1.0.0+build.1"]
    );
    assert.equal(rebuilt.plugins[0].latestVersion, "1.0.0+build.2");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("produces identical archives and catalog ordering under different locales", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-plugin-locale-"));
  const source = path.join(temporary, "source");
  const englishOutput = path.join(temporary, "public-en");
  const swedishOutput = path.join(temporary, "public-sv");

  const writeFixture = async (id: string) => {
    const pluginDirectory = path.join(source, id);
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(path.join(pluginDirectory, "manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      id,
      version: "1.0.0",
      name: id,
      description: "Locale-independent ordering fixture",
      category: "test",
      minHostVersion: 1,
      requiredCapabilities: [],
      tags: [],
      documents: []
    }, null, 2)}\n`);
    for (const fileName of ["A.txt", "_note.txt", "a.txt", "z-1.txt", "z.1.txt", "ä.txt", "中.txt"]) {
      await writeFile(path.join(pluginDirectory, fileName), `${fileName}\n`);
    }
  };

  const buildUnderLocale = (locale: string, output: string): string => {
    const moduleUrl = pathToFileURL(path.join(ROOT, "dist", "build-plugins.js")).href;
    const script = [
      `import { buildPlugins } from ${JSON.stringify(moduleUrl)};`,
      `await buildPlugins(${JSON.stringify(source)}, ${JSON.stringify(output)});`,
      "process.stdout.write(Intl.Collator().resolvedOptions().locale);"
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, LANG: locale, LC_ALL: locale, LC_CTYPE: locale }
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  try {
    await writeFixture("wuxianpi.a-b");
    await writeFixture("wuxianpi.a.b");
    const englishLocale = buildUnderLocale("en", englishOutput);
    const swedishLocale = buildUnderLocale("sv", swedishOutput);
    assert.notEqual(englishLocale, swedishLocale);

    const englishCatalog = JSON.parse(await readFile(path.join(englishOutput, "catalog.json"), "utf8"));
    const swedishCatalog = JSON.parse(await readFile(path.join(swedishOutput, "catalog.json"), "utf8"));
    assert.equal(englishCatalog.revision, swedishCatalog.revision);
    assert.deepEqual(englishCatalog.plugins, swedishCatalog.plugins);
    assert.deepEqual(
      englishCatalog.plugins.map((plugin: { id: string }) => plugin.id),
      ["wuxianpi.a-b", "wuxianpi.a.b"]
    );

    for (const id of ["wuxianpi.a-b", "wuxianpi.a.b"]) {
      const englishArchive = await readFile(path.join(englishOutput, "plugins", id, "1.0.0.zip"));
      const swedishArchive = await readFile(path.join(swedishOutput, "plugins", id, "1.0.0.zip"));
      assert.deepEqual(englishArchive, swedishArchive);
    }
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

test("rejects assistant context declarations whose file is missing", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wuxianpi-plugin-instruction-"));
  const source = path.join(temporary, "source");
  const output = path.join(temporary, "public");
  const pluginDirectory = path.join(source, "wuxianpi.instruction-fixture");
  try {
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(path.join(pluginDirectory, "manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "wuxianpi.instruction-fixture",
      version: "1.0.0",
      name: "Instruction fixture",
      description: "Missing instruction fixture",
      category: "test",
      minHostVersion: 1,
      requiredCapabilities: [],
      tags: [],
      assistantContexts: [{ path: "prompts/instruction.md", scope: "session" }],
      documents: []
    })}\n`);

    await assert.rejects(
      buildPlugins(source, output),
      /missing assistant context prompts\/instruction\.md/
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
