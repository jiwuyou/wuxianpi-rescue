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
      "wuxianpi.openhouse-small-app-guide",
      "wuxianpi.service-manager"
    ]) {
      assert.ok(pluginIds.has(requiredId), `missing required plugin ${requiredId}`);
    }
    const firstInstall = catalog.plugins.find((plugin) => plugin.id === "wuxianpi.first-install");
    assert.ok(firstInstall);
    assert.deepEqual(
      firstInstall.versions.map((candidate) => candidate.manifest.version),
      ["1.0.3", "1.0.2", "1.0.1", "1.0.0"]
    );
    assert.equal(
      firstInstall.versions[3].sha256,
      "791424f96a6d59942e0d8e6ccebe5433fa4fe93e709e80e72fb6b7b30cdbded4"
    );
    assert.equal(
      firstInstall.versions[2].sha256,
      "0f18af13475719d8b4669a2ed2a3d90c2d4a406488f64a0a0104787a31fd5646"
    );
    const release = firstInstall.versions[0];
    assert.equal(release.manifest.version, "1.0.3");
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
      "get_wuxianpi_setup_status",
      "read_rescue_plugin_document",
      "write_file"
    ]);
    const toolSteps = workflow.steps.filter((step: Record<string, unknown>) => typeof step.tool === "string");
    assert.ok(toolSteps.every((step: Record<string, unknown>) => allowed.has(String(step.tool))));
    const stageSetup = workflow.steps.find((step: Record<string, unknown>) => step.id === "stage-setup");
    const runCommand = workflow.steps.find((step: Record<string, unknown>) => step.id === "run-command");
    const runSetupNative = workflow.steps.find((step: Record<string, unknown>) => step.id === "run-setup-native");
    const runSetupEmbedded = workflow.steps.find((step: Record<string, unknown>) => step.id === "run-setup-embedded");
    const verify = workflow.steps.find((step: Record<string, unknown>) => step.id === "verify");
    assert.deepEqual(
      { kind: stageSetup.kind, tool: stageSetup.tool },
      { kind: "tool", tool: "start_wuxianpi_setup" }
    );
    assert.deepEqual(
      { kind: runSetupNative.kind, tool: runSetupNative.tool, sourceStep: runSetupNative.sourceStep },
      { kind: "tool-from-result", tool: "termux_exec_command", sourceStep: "stage-setup" }
    );
    assert.equal(runSetupNative.when, "runtimeHost.externalTermux");
    assert.deepEqual(
      {
        kind: runSetupEmbedded.kind,
        tool: runSetupEmbedded.tool,
        sourceStep: runSetupEmbedded.sourceStep,
        when: runSetupEmbedded.when
      },
      {
        kind: "tool-from-result",
        tool: "termux_exec_command",
        sourceStep: "stage-setup",
        when: "!runtimeHost.externalTermux"
      }
    );
    assert.deepEqual(
      { kind: verify.kind, tool: verify.tool },
      { kind: "poll-tool", tool: "get_wuxianpi_setup_status" }
    );
    assert.equal(runCommand.when, "runtimeHost.externalTermux");
    assert.match(String(runCommand.description), /allow-external-apps = true/);
    assert.match(String(runSetupNative.description), /install-resources\/current\/bootstrap\/wuxianpi-setup/);
    assert.match(String(runSetupNative.description), /绝不能.*\$PREFIX\/bin\/wuxianpi-setup/);
    assert.equal(runSetupEmbedded.arguments, undefined);
    assert.match(String(runSetupEmbedded.description), /stage-setup 返回/);
    assert.doesNotMatch(String(runSetupEmbedded.description), /\.local\/share\/wuxianpi\/install-resources/);
    assert.equal(workflow.executionPolicy.afterPersistentTermux, "termux_exec_command");
    assert.equal(workflow.executionPolicy.longRunningCommands, "termux_exec_command");
    assert.match(String(verify.description), /service-daemon/);
    assert.match(String(verify.description), /unable to change to service directory/);
    assert.match(String(verify.description), /WuxianPi stopped 是正常按需状态/);
    assert.deepEqual(verify.retryPolicy, {
      maxAttempts: 10,
      delayMs: 3000,
      retryWhen: [
        "runsvdir 尚未就绪",
        "sv up service-manager 返回 unable to change to service directory",
        "service-manager 20087 健康检查暂不可达"
      ]
    });

    const firstInstallGuide = await readFile(
      path.join(ROOT, "plugins", "official", firstInstall.id, "docs", "guide.md"),
      "utf8"
    );
    assert.match(firstInstallGuide, /residentByDefault.*false/);
    assert.match(firstInstallGuide, /tmux.*不是正式服务的生命周期所有者/);
    assert.match(firstInstallGuide, /allow-external-apps = true/);
    assert.match(firstInstallGuide, /3 秒间隔最多重试 10 次/);
    assert.match(firstInstallGuide, /Native 返回的命令会解包并调用/);
    assert.match(firstInstallGuide, /All-in-One 返回的命令会调用宿主已暂存的 `\/bin\/wuxianpi-setup`/);
    assert.match(firstInstallGuide, /桌面组件注册/);
    const registrationScript = await readFile(
      path.join(ROOT, "plugins", "official", firstInstall.id, "scripts", "register-openhouse-component.sh"),
      "utf8"
    );
    assert.match(registrationScript, /SERVICE_ID="yuanshengwuxianpi"/);
    assert.match(registrationScript, /COMPONENT_ID="\$SERVICE_ID"/);
    assert.match(registrationScript, /LEGACY_COMPONENT_ID="pi-agent"/);
    assert.match(registrationScript, /migrate_legacy_component_file/);
    assert.match(registrationScript, /api_request DELETE ["']\/api\/v1\/registry\/components/);
    assert.match(registrationScript, /api_request PUT ["']\/api\/v1\/registry\/components\/\$COMPONENT_ID/);
    assert.match(registrationScript, /api_request POST ["']\/api\/v1\/registry\/sync/);
    assert.match(registrationScript, /components\.d/);
    assert.match(registrationScript, /components\.d\/\$COMPONENT_ID\.json/);
    assert.match(registrationScript, /\.local\/share\/wuxianpi\/plugins\/wuxianpi\.first-install\/migrations/);

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

test("published first-install catalog retains historical releases and promotes 1.0.3", async () => {
  const catalog = JSON.parse(await readFile(path.join(ROOT, "public", "catalog.json"), "utf8"));
  const firstInstall = catalog.plugins.find((plugin: { id: string }) => plugin.id === "wuxianpi.first-install");
  assert.ok(firstInstall);
  assert.equal(firstInstall.latestVersion, "1.0.3");
  assert.deepEqual(
    firstInstall.versions.map((release: { manifest: { version: string } }) => release.manifest.version),
    ["1.0.3", "1.0.2", "1.0.1", "1.0.0"]
  );
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
