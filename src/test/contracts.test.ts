import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, validateManifest } from "../contracts.js";

function manifest(version: string) {
  return {
    schemaVersion: 1,
    id: "wuxianpi.semver-fixture",
    version,
    name: "SemVer fixture",
    description: "Strict semantic version fixture",
    category: "test",
    minHostVersion: 1,
    requiredCapabilities: [],
    tags: [],
    documents: []
  };
}

test("validates strict SemVer manifests and accepts build metadata", () => {
  const valid = [
    "0.0.0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-0.3.7",
    "1.0.0-x.7.z.92",
    "1.0.0+build.1",
    "1.0.0-rc.1+build.20260802",
    "999999999999999999999999.0.1"
  ];
  for (const version of valid) assert.equal(validateManifest(manifest(version)).version, version);
  assert.equal(validateManifest(manifest(" 1.0.0+build.1 ")).version, "1.0.0+build.1");
});

test("accepts optional assistant contexts while preserving old manifests", () => {
  const legacy = validateManifest(manifest("1.0.0"));
  assert.deepEqual(legacy.assistantContexts, []);
  assert.equal(legacy.sessionRole, "business");
  assert.deepEqual(legacy.actions, []);

  const withContext = validateManifest({
    ...manifest("1.0.0"),
    assistantContexts: [
      { path: "prompts/instruction.md", scope: "session" },
      { path: "scripts/time.js", scope: "turn", provider: "javascript", function: "buildContext" }
    ]
  });
  assert.deepEqual(withContext.assistantContexts, [
    { path: "prompts/instruction.md", scope: "session", provider: "static" },
    { path: "scripts/time.js", scope: "turn", provider: "javascript", function: "buildContext" }
  ]);
});

test("validates session roles and dynamic prompt actions", () => {
  const parsed = validateManifest({
    ...manifest("1.0.0"),
    sessionRole: "runtime",
    actions: [{
      id: "resource-update",
      title: "Check updates",
      icon: "refresh-cw",
      priority: 90,
      prompt: "Inspect current resources.",
      requiresPlugins: ["wuxianpi.resource-update"]
    }]
  });
  assert.equal(parsed.sessionRole, "runtime");
  assert.deepEqual(parsed.actions, [{
    id: "resource-update",
    title: "Check updates",
    icon: "refresh-cw",
    priority: 90,
    prompt: "Inspect current resources.",
    visibleWhen: "always",
    requiresPlugins: ["wuxianpi.resource-update"]
  }]);
  assert.throws(() => validateManifest({
    ...manifest("1.0.0"),
    sessionRole: "bootstrap",
    actions: [
      { id: "same", title: "One", icon: "play", priority: 1, prompt: "One" },
      { id: "same", title: "Two", icon: "play", priority: 2, prompt: "Two" }
    ]
  }), /duplicate id/);
});

test("rejects unsafe or incomplete assistant context declarations", () => {
  assert.throws(() => validateManifest({
    ...manifest("1.0.0"),
    assistantContexts: [{ path: "../instruction.md", scope: "session" }]
  }), /safe relative path/);
  assert.throws(() => validateManifest({
    ...manifest("1.0.0"),
    assistantContexts: [{ path: "scripts/time.js", scope: "turn", provider: "javascript" }]
  }), /function is required/);
  assert.throws(() => validateManifest({
    ...manifest("1.0.0"),
    assistantContexts: [{ path: "prompts/instruction.md", scope: "session", extra: true }]
  }), /unknown field 'extra'/);
  assert.throws(() => validateManifest({
    ...manifest("1.0.0"),
    assistantContexts: [{ path: "scripts/time.js", scope: "turn", provider: "static", function: "buildContext" }]
  }), /only valid for javascript/);
});

test("rejects leading zeroes and empty or malformed SemVer identifiers", () => {
  const invalid = [
    "01.0.0",
    "1.01.0",
    "1.0.01",
    "1.0",
    "1.0.0-01",
    "1.0.0-alpha..1",
    "1.0.0-",
    "1.0.0+",
    "1.0.0+build..1",
    "1.0.0_alpha",
    "v1.0.0"
  ];
  for (const version of invalid) {
    assert.throws(() => validateManifest(manifest(version)), /Version is not strict SemVer/);
  }
  assert.throws(() => compareVersions("1.0.0", "1.0.0-01"), /Version is not strict SemVer/);
});

test("compares SemVer precedence exactly and ignores build metadata", () => {
  const precedence = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0"
  ];
  for (let index = 1; index < precedence.length; index += 1) {
    assert.ok(compareVersions(precedence[index], precedence[index - 1]) > 0);
  }

  assert.ok(compareVersions("1.0.0", "1.0.0-rc.1") > 0);
  assert.ok(compareVersions("1.0.0-alpha.10", "1.0.0-alpha.2") > 0);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-1") > 0);
  assert.ok(compareVersions("100000000000000000000.0.0", "99999999999999999999.999.999") > 0);
  assert.equal(compareVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
  assert.equal(compareVersions("1.0.0-rc.1+build.2", "1.0.0-rc.1+build.1"), 0);
});
