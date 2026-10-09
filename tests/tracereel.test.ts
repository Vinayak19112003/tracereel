/**
 * TraceReel agent-neutrality and adapter tests.
 *
 * A. Muse normalization (legacy muse-managed-browser -> agent-browser/muse + deprecation warning)
 * B. Grokbot-style trace normalizes through the grokbot adapter
 * C. Unknown "future-agent" works through the generic adapter
 * D. Legacy muse-managed-browser input builds a manifest end to end
 * E. Agent identity does not alter render output
 * Plus: state-first conversion, structured error codes, TraceBuilder, bundles,
 * and --require-source semantics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeTrace,
  getAdapter,
  listAdapters,
  traceToReconstructionInput,
  statesToFrames,
  assertRequireSource,
  TraceBuilder,
  writeBundle,
  loadBundle,
  MUSE_CAPABILITIES,
} from "../src/index.js";
import { validateReconstructionInput } from "../src/reconstruct/validate.js";
import { buildReconstructionManifest } from "../src/reconstruct/build.js";
import { RECONSTRUCTION_DEFAULTS, resolveConfig } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureFrames = join(here, "fixtures", "qa", "frames");

/** Copy two real fixture PNGs into a temp dir; return the dir. */
function shotDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracereel-test-"));
  copyFileSync(join(fixtureFrames, "01-post.png"), join(dir, "a.png"));
  copyFileSync(join(fixtureFrames, "02-liked.png"), join(dir, "b.png"));
  return dir;
}

function legacyMuseInput() {
  return {
    version: 1,
    source: { type: "muse-managed-browser", session: "main", captureTool: "muse" },
    viewport: { width: 1280, height: 800 },
    frames: [
      { file: "a.png", actions: [{ kind: "click", x: 100, y: 100 }], caption: "home" },
      { file: "b.png" },
    ],
  };
}

function grokbotStateInput() {
  return {
    version: 1,
    source: { type: "agent-browser", agent: "grokbot", session: "s-1" },
    viewport: { width: 1280, height: 800 },
    states: [
      { id: "s1", screenshot: "a.png", caption: "home" },
      { id: "s2", screenshot: "b.png", caption: "liked" },
    ],
    actions: [
      { kind: "click", from: "s1", to: "s2", x: 100, y: 100, stateDelayMs: 600 },
    ],
  };
}

test("A: legacy muse-managed-browser normalizes to agent-browser/muse with a deprecation warning", () => {
  const { trace, warnings, adapter } = normalizeTrace(legacyMuseInput());
  assert.equal(adapter.name, "muse");
  assert.equal(trace.source?.type, "agent-browser");
  assert.equal(trace.source?.agent, "muse");
  assert.equal(trace.source?.session, "main");
  assert.ok(warnings.some((w) => w.includes("deprecated")), `expected a deprecation warning, got: ${warnings.join("; ")}`);
});

test("A2: explicit --adapter muse on a sourceless legacy input assumes muse (warned)", () => {
  const { trace, warnings, adapter } = normalizeTrace(
    { viewport: { width: 1280, height: 800 }, frames: [{ file: "a.png" }] },
    { adapter: "muse" },
  );
  assert.equal(adapter.name, "muse");
  assert.equal(trace.source?.agent, "muse");
  assert.ok(warnings.length > 0);
});

test("B: grokbot-style states/actions trace normalizes with the agent preserved", () => {
  const { trace, warnings, adapter } = normalizeTrace(grokbotStateInput());
  assert.equal(adapter.name, "grokbot");
  assert.equal(adapter.verified, false);
  assert.equal(trace.source?.agent, "grokbot");
  assert.equal(trace.states?.length, 2);
  assert.equal(trace.actions?.length, 1);
  assert.ok(warnings.length === 0, `unexpected warnings: ${warnings.join("; ")}`);
});

test("C: unknown future-agent works through the generic adapter, name preserved", () => {
  const input = {
    version: 1,
    source: { type: "agent-browser", agent: "future-agent" },
    viewport: { width: 1280, height: 800 },
    frames: [{ file: "a.png" }, { file: "b.png" }],
  };
  const { trace, adapter } = normalizeTrace(input);
  assert.equal(adapter.name, "generic");
  assert.equal(trace.source?.agent, "future-agent");
});

test("C2: getAdapter falls back to generic for unknown names", () => {
  assert.equal(getAdapter("definitely-not-an-agent").name, "generic");
  assert.deepEqual(listAdapters().map((a) => a.name), ["muse", "grokbot", "generic"]);
});

test("D: legacy muse-managed-browser input converts to an engine input and builds a manifest", () => {
  const { trace } = normalizeTrace(legacyMuseInput());
  const engineInput = traceToReconstructionInput(trace);
  assert.equal(engineInput.frames.length, 2);
  assert.equal(engineInput.frames[0].actions?.length, 1);
  assert.equal(engineInput.source?.type, "agent-browser");
  const manifest = buildReconstructionManifest(engineInput, resolveConfig(RECONSTRUCTION_DEFAULTS));
  assert.equal(manifest.frames.length, 2);
  assert.ok(manifest.events.some((e) => (e as { type?: string }).type === "mousedown"));
});

test("E: agent identity does not alter render output", () => {
  const base = grokbotStateInput();
  const forAgents = ["muse", "grokbot", "future-agent"].map((agent) => {
    const input = { ...base, source: { ...base.source, agent } };
    const { trace } = normalizeTrace(input, { adapter: "generic" });
    return traceToReconstructionInput(trace);
  });
  const cfg = resolveConfig(RECONSTRUCTION_DEFAULTS);
  const manifests = forAgents.map((ei) => {
    const m = buildReconstructionManifest(ei, cfg);
    // createdAt is wall-clock; source carries the agent name by design.
    // Everything else must be identical across agents.
    const { source: _s, createdAt: _c, ...rest } = m as Record<string, unknown>;
    return rest;
  });
  assert.deepEqual(manifests[1], manifests[0]);
  assert.deepEqual(manifests[2], manifests[0]);
});

test("F: states/actions convert to frames; stateDelayMs becomes nextFrameAfterMs", () => {
  const { trace } = normalizeTrace(grokbotStateInput());
  const frames = statesToFrames(trace);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].file, "a.png");
  assert.equal(frames[0].caption, "home");
  assert.equal(frames[0].actions?.length, 1);
  assert.equal((frames[0].actions?.[0] as Record<string, unknown>).nextFrameAfterMs, 600);
  assert.equal(frames[1].file, "b.png");
});

test("G: structured error codes with paths and suggestions", () => {
  const dir = shotDir();
  const bad = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 1280, height: 800 },
    frames: [{ file: "a.png", actions: [{ kind: "click", x: 2000, y: 100 }] }, { file: "b.png" }],
  };
  const v = validateReconstructionInput(bad, dir);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, "COORD_OUTSIDE_VIEWPORT");
  assert.equal(v.errors[0].path, "frames[0].actions[0].x");
  assert.ok(v.errors[0].message.includes("2000"));
  assert.ok((v.errors[0].suggestion ?? "").length > 0);
});

test("G2: mixed states[] and frames[] is a hard error", () => {
  const dir = shotDir();
  const mixed = {
    version: 1,
    viewport: { width: 1280, height: 800 },
    states: [{ id: "s1", screenshot: "a.png" }],
    frames: [{ file: "a.png" }],
  };
  const v = validateReconstructionInput(mixed, dir);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === "MIXED_TRACE_FORMS"));
});

test("G3: missing post-action state warns with a code", () => {
  const dir = shotDir();
  const dangling = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 1280, height: 800 },
    frames: [{ file: "a.png", actions: [{ kind: "click", x: 100, y: 100 }] }],
  };
  const v = validateReconstructionInput(dangling, dir);
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => w.code === "MISSING_STATE_AFTER_ACTION"));
});

test("H: TraceBuilder produces a valid trace", () => {
  const dir = shotDir();
  const t = new TraceBuilder({ agent: "muse", viewport: { width: 1280, height: 800 }, session: "demo" });
  const s1 = t.state("s1", "a.png", { caption: "Home." });
  const s2 = t.state("s2", "b.png");
  t.click({ from: s1, to: s2, x: 640, y: 400, stateDelayMs: 500 });
  t.caption(s2, "Liked.");
  t.redact(s2, { x: 0, y: 0, width: 200, height: 40, mode: "blur" });
  const trace = t.build();
  assert.equal(trace.source?.agent, "muse");
  assert.equal(trace.states?.length, 2);
  const { trace: normalized } = normalizeTrace(trace, { adapter: "muse" });
  const v = validateReconstructionInput(traceToReconstructionInput(normalized), dir);
  assert.equal(v.ok, true);
  assert.deepEqual(normalized.capabilities?.screenshots, MUSE_CAPABILITIES.screenshots);
});

test("I: bundle round-trip preserves the trace and frames", () => {
  const dir = shotDir();
  const t = new TraceBuilder({ agent: "muse", viewport: { width: 1280, height: 800 } });
  t.state("s1", "a.png");
  t.state("s2", "b.png");
  t.click({ from: "s1", to: "s2", x: 10, y: 10 });
  const { trace, adapter } = normalizeTrace(t.build(), { adapter: "muse" });
  const outDir = mkdtempSync(join(tmpdir(), "tracereel-bundle-"));
  const { dir: bundleDir, metadata } = writeBundle(join(outDir, "demo"), trace, {
    framesSourceDir: dir,
    adapter: adapter.name,
    warnings: [],
  });
  assert.ok(bundleDir.endsWith(".tracereel"));
  assert.equal(metadata.agent, "muse");
  assert.equal(metadata.traceForm, "states");
  const loaded = loadBundle(bundleDir);
  assert.equal(loaded.trace.states?.length, 2);
  assert.equal(loaded.frameFiles.length, 2);
  for (const f of loaded.frameFiles) {
    readFileSync(f); // throws if missing
  }
});

test("J: --require-source semantics across the normalization boundary", () => {
  const muse = normalizeTrace(legacyMuseInput());
  const museEngine = traceToReconstructionInput(muse.trace);
  // Legacy value keeps working for Muse traces.
  assertRequireSource("muse-managed-browser", muse.trace, museEngine);
  assertRequireSource("agent-browser", muse.trace, museEngine);
  const grok = normalizeTrace(grokbotStateInput());
  const grokEngine = traceToReconstructionInput(grok.trace);
  // A grokbot trace must NOT pass a muse-only gate.
  assert.throws(() => assertRequireSource("muse-managed-browser", grok.trace, grokEngine), (e: unknown) => {
    assert.equal((e as { code?: string }).code, "SOURCE_MISMATCH");
    return true;
  });
  assertRequireSource("agent-browser", grok.trace, grokEngine);
  // Unknown required type is still rejected by the engine's own gate (unchanged behavior).
  assert.throws(
    () => assertRequireSource("nope", grok.trace, grokEngine),
    /--require-source "nope"/,
  );
});

test("K: missing final state is counted under missing-state; no global score exists", async () => {
  const { qaReconstruction } = await import("../src/reconstruct/qa.js");
  const dir = shotDir();
  const trace = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 1280, height: 800 },
    frames: [
      { file: "a.png", holdMs: 500, actions: [{ kind: "click", x: 100, y: 100 }] },
      { file: "b.png", holdMs: 500, actions: [{ kind: "click", x: 200, y: 200 }] },
    ],
  };
  const { trace: normalized } = normalizeTrace(trace, { adapter: "muse" });
  const engineInput = traceToReconstructionInput(normalized);
  const v = validateReconstructionInput(engineInput, dir);
  assert.equal(v.ok, true);
  const manifest = buildReconstructionManifest(engineInput, resolveConfig(RECONSTRUCTION_DEFAULTS));
  const qa = qaReconstruction(engineInput, manifest);
  assert.equal(qa.warningCounts["missing-state"], 1);
  assert.ok(qa.categorized.some((w) => w.category === "missing-state"));
  // No invented global quality score anywhere on the report.
  assert.ok(!("score" in qa) && !("score" in qa.metrics));
});

test("K2: very short states are counted under timing", async () => {
  const { qaReconstruction } = await import("../src/reconstruct/qa.js");
  const trace = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 1280, height: 800 },
    frames: [
      { file: "a.png", holdMs: 50, actions: [{ kind: "wait", durationMs: 50 }] },
      { file: "b.png", holdMs: 3000 },
    ],
  };
  const { trace: normalized } = normalizeTrace(trace, { adapter: "muse" });
  const engineInput = traceToReconstructionInput(normalized);
  const manifest = buildReconstructionManifest(engineInput, resolveConfig(RECONSTRUCTION_DEFAULTS));
  const qa = qaReconstruction(engineInput, manifest);
  assert.ok(qa.warningCounts.timing >= 1, `expected a timing warning, got ${JSON.stringify(qa.warningCounts)}`);
});

test("L: screenshotsDir survives normalization into the engine input", () => {
  const trace = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 1280, height: 800 },
    screenshotsDir: "frames",
    states: [
      { id: "home", screenshot: "01.png" },
      { id: "done", screenshot: "02.png" },
    ],
    actions: [{ kind: "click", from: "home", to: "done", x: 10, y: 10 }],
  };
  const { trace: normalized } = normalizeTrace(trace, { adapter: "muse" });
  assert.equal(normalized.screenshotsDir, "frames");
  const engineInput = traceToReconstructionInput(normalized);
  assert.equal(engineInput.screenshotsDir, "frames");
});

test("M: --require-source matches the raw declared source type after normalization", () => {
  const trace = {
    version: 1,
    source: { type: "manual-screenshots", note: "synthetic fixture" },
    viewport: { width: 1280, height: 800 },
    frames: [{ file: "a.png" }],
  };
  const { trace: normalized } = normalizeTrace(trace);
  const engineInput = traceToReconstructionInput(normalized);
  // Normalized to agent-browser/unknown; the raw declaration still pins.
  assert.doesNotThrow(() => assertRequireSource("manual-screenshots", normalized, engineInput, "manual-screenshots"));
  assert.throws(
    () => assertRequireSource("muse-managed-browser", normalized, engineInput, "manual-screenshots"),
    (e: unknown) => (e as { code?: string }).code === "SOURCE_MISMATCH",
  );
});

test("N: TraceBuilder action ids are per-builder, not module-global", () => {
  const b1 = new TraceBuilder({ agent: "muse", viewport: { width: 1280, height: 800 } });
  b1.state("s1", "a.png");
  b1.state("s2", "b.png");
  b1.click({ from: "s1", to: "s2", x: 10, y: 10 });
  const b2 = new TraceBuilder({ agent: "muse", viewport: { width: 1280, height: 800 } });
  b2.state("s1", "a.png");
  b2.state("s2", "b.png");
  b2.click({ from: "s1", to: "s2", x: 10, y: 10 });
  const t1 = b1.build();
  const t2 = b2.build();
  assert.deepEqual(
    (t1.actions ?? []).map((a) => (a as { id?: string }).id),
    (t2.actions ?? []).map((a) => (a as { id?: string }).id),
  );
  assert.equal((t1.actions ?? [])[0] && ((t1.actions ?? [])[0] as { id?: string }).id, "a1");
});

test("O: writeBundle rejects duplicate asset basenames", () => {
  const dir = mkdtempSync(join(tmpdir(), "tracereel-o-"));
  const a = join(dir, "a"); const b = join(dir, "b");
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  writeFileSync(join(a, "shot.png"), "a"); writeFileSync(join(b, "shot.png"), "b");
  const trace = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 10, height: 10 },
    states: [
      { id: "s1", screenshot: "a/shot.png" },
      { id: "s2", screenshot: "b/shot.png" },
    ],
    actions: [],
  } as Parameters<typeof writeBundle>[1];
  assert.throws(
    () => writeBundle(join(dir, "out"), trace, { framesSourceDir: dir, adapter: "muse" }),
    /duplicate asset basename "shot\.png"/,
  );
});

test("P: writeBundle refuses a non-empty destination", () => {
  const dir = mkdtempSync(join(tmpdir(), "tracereel-p-"));
  writeFileSync(join(dir, "a.png"), "x");
  const trace = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 10, height: 10 },
    states: [{ id: "s1", screenshot: "a.png" }],
    actions: [],
  } as Parameters<typeof writeBundle>[1];
  mkdirSync(join(dir, "out.tracereel"), { recursive: true });
  writeFileSync(join(dir, "out.tracereel", "stale.txt"), "x");
  assert.throws(
    () => writeBundle(join(dir, "out.tracereel"), trace, { framesSourceDir: dir, adapter: "muse" }),
    /not empty/,
  );
  // ...but an existing EMPTY bundle dir is fine.
  mkdirSync(join(dir, "empty.tracereel"), { recursive: true });
  const r = writeBundle(join(dir, "empty.tracereel"), trace, {
    framesSourceDir: dir, adapter: "muse", bundledAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(r.metadata.bundledAt, "2026-01-01T00:00:00.000Z");
});

test("Q: bundle round-trips frames + segments with resolved paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "tracereel-q-"));
  writeFileSync(join(dir, "a.png"), "img");
  writeFileSync(join(dir, "clip.mp4"), "vid");
  const trace = {
    version: 1,
    source: { type: "agent-browser", agent: "future-agent" },
    viewport: { width: 10, height: 10 },
    states: [{ id: "s1", screenshot: "a.png" }],
    actions: [],
    videoSegments: [{ id: "v1", file: "clip.mp4", start: 0, duration: 500 }],
  } as Parameters<typeof writeBundle>[1];
  const { dir: bundleDir } = writeBundle(join(dir, "demo"), trace, {
    framesSourceDir: dir, adapter: "generic",
  });
  const loaded = loadBundle(bundleDir);
  assert.equal(loaded.frameFiles.length, 1);
  assert.ok(loaded.frameFiles[0].endsWith(join("frames", "a.png")));
  assert.ok(existsSync(loaded.frameFiles[0]));
  assert.equal(loaded.segmentFiles.length, 1);
  assert.ok(loaded.segmentFiles[0].endsWith(join("segments", "clip.mp4")));
  assert.ok(existsSync(loaded.segmentFiles[0]));
  assert.equal(loaded.trace.states?.[0].screenshot, join("frames", "a.png"));
  assert.equal(loaded.trace.videoSegments?.[0].file, join("segments", "clip.mp4"));
});

test("R: states-form action errors point at the original actions[n]", () => {
  const dir = mkdtempSync(join(tmpdir(), "tracereel-r-"));
  mkdirSync(join(dir, "frames"), { recursive: true });
  for (const f of ["a.png", "b.png", "c.png"]) writeFileSync(join(dir, "frames", f), "x");
  const trace = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 100, height: 100 },
    screenshotsDir: "frames",
    states: [
      { id: "s1", screenshot: "a.png" },
      { id: "s2", screenshot: "b.png" },
      { id: "s3", screenshot: "c.png" },
    ],
    actions: [
      { kind: "click", from: "s1", to: "s2", x: 10, y: 10 },
      { kind: "wait", from: "s2", pauseMs: 100 },
      { kind: "click", from: "s2", to: "s3", x: 10, y: 10 },
      // actions[3]: x out of viewport bounds -> error path must be actions[3].x
      { kind: "click", from: "s1", to: "s2", x: 9999, y: 10 },
    ],
  };
  const res = validateReconstructionInput(trace as Parameters<typeof validateReconstructionInput>[0], dir);
  const bad = res.errors.find((e) => e.path === "actions[3].x");
  assert.ok(bad, `expected an error at actions[3].x, got: ${JSON.stringify(res.errors.map((e) => e.path))}`);
  assert.ok(!res.errors.some((e) => (e.path ?? "").startsWith("states[")), "no derived states[i].actions[j] paths");
});

test("S: explicit muse adapter never relabels foreign source types as Muse capture", () => {
  for (const t of ["external-browser", "manual-screenshots"]) {
    const { trace, warnings } = normalizeTrace(
      {
        version: 1,
        source: { type: t, note: "not muse" },
        viewport: { width: 10, height: 10 },
        frames: [{ file: "a.png" }],
      },
      { adapter: "muse" },
    );
    assert.equal(trace.source?.agent, "unknown");
    assert.ok(
      warnings.some((w) => w.includes("NOT as Muse capture")),
      `expected honesty warning for ${t}`,
    );
  }
});

test("G4: duplicate state ids are a structured error", () => {
  const dir = shotDir();
  const dup = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 1280, height: 800 },
    states: [
      { id: "home", screenshot: "a.png" },
      { id: "home", screenshot: "b.png" },
    ],
    actions: [],
  };
  const v = validateReconstructionInput(dup, dir);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === "DUPLICATE_STATE_ID"));
});

test("G5: empty states array is a structured error", () => {
  const dir = shotDir();
  const empty = {
    version: 1,
    source: { type: "agent-browser", agent: "muse" },
    viewport: { width: 1280, height: 800 },
    states: [],
    actions: [],
  };
  const v = validateReconstructionInput(empty, dir);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === "EMPTY_STATES"));
});

test("G6: non-object source is a structured error", () => {
  const dir = shotDir();
  const bad = {
    version: 1,
    source: "muse",
    viewport: { width: 1280, height: 800 },
    states: [{ id: "home", screenshot: "a.png" }],
    actions: [],
  };
  const v = validateReconstructionInput(bad, dir);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === "INVALID_SOURCE"));
});
