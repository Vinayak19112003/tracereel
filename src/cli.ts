#!/usr/bin/env node
import { Command } from "commander";
import { basename, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, relative } from "node:path";
import { loadScenario } from "./load-scenario.js";
import { recordScenario, dryRunScenario } from "./runner/index.js";
import { exploreScenario } from "./runner/explore.js";
import { renderRecording } from "./compositor/render.js";
import { assembleVideo } from "./assemble.js";
import { writeReconstructionDir, type ReconstructionInput } from "./reconstruct/build.js";
import type { TraceReelTrace } from "./trace/types.js";
import { chromiumInfo, launchBrowser, connectToSession } from "./browser.js";
import {
  DEFAULT_SESSION_PORT,
  clearSession,
  readSession,
  sessionAlive,
  sessionPort,
  startSessionDaemon,
  waitForSession,
  ensureSession,
  sendCommand,
} from "./runner/session-store.js";
import { ffmpegVersion } from "./ffmpeg.js";
import { resolveConfig } from "./config.js";
import type { UserScenarioConfig } from "./types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const log = (s: string) => console.error(s);

function parseOverrides(o: { config?: string; width?: string; height?: string; fps?: string; viewport?: string; dpr?: string; chromium?: string; cdp?: string; headed?: boolean; state?: string; profile?: string }): UserScenarioConfig {
  const c: UserScenarioConfig = o.config ? JSON.parse(o.config) : {};
  c.output ??= {};
  c.viewport ??= {};
  c.browser ??= {};
  if (o.width) c.output.width = Number(o.width);
  if (o.height) c.output.height = Number(o.height);
  if (o.fps) c.output.fps = Number(o.fps);
  if (o.viewport) {
    const [w, h] = o.viewport.split("x").map(Number);
    c.viewport.width = w;
    c.viewport.height = h;
  }
  if (o.dpr) c.viewport.deviceScaleFactor = Number(o.dpr);
  if (o.chromium) c.browser.executablePath = o.chromium;
  if (o.cdp) c.browser.cdp = o.cdp;
  if (o.headed) c.browser.headless = false;
  if (o.state) c.browser.storageState = resolve(o.state);
  if (o.profile) c.browser.userDataDir = resolve(o.profile);
  return c;
}

function defaultOutDir(scenarioFile: string, name?: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join("recordings", `${name ?? basename(scenarioFile).replace(/\.[^.]+$/, "")}-${stamp}`);
}

/**
 * Enforce --require-source against the normalized trace.
 *
 * The legacy value "muse-managed-browser" keeps working: it matches any trace
 * the Muse adapter normalized (agent-browser / agent "muse"). This preserves
 * existing Muse workflows through the v0.x deprecation period.
 */
async function checkRequireSource(required: string | undefined, trace: TraceReelTrace, engineInput: ReconstructionInput, rawSourceType?: string) {
  if (!required) return;
  const { assertRequireSource } = await import("./adapters/normalize.js");
  assertRequireSource(required, trace, engineInput, rawSourceType);
}

/**
 * Read a trace file (TraceReel Trace v1, or legacy takeone frame input) and
 * normalize it through the adapter pipeline into the ReconstructionInput the
 * engine renders. Emits adapter warnings (deprecations, assumptions).
 */
async function loadTraceInput(inputFile: string, adapterName?: string) {
  const { normalizeTrace } = await import("./adapters/index.js");
  const { traceToReconstructionInput } = await import("./adapters/normalize.js");
  const inputPath = resolve(inputFile);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (e) {
    throw new Error(`invalid JSON in ${inputPath}: ${(e as Error).message}`);
  }
  // Capture before normalizeTrace: adapters may mutate the raw object in place.
  const rawSourceType = (raw as { source?: { type?: unknown } } | null)?.source?.type as string | undefined;
  const { trace, warnings, adapter } = normalizeTrace(raw, adapterName ? { adapter: adapterName } : undefined);
  for (const w of warnings) log(`warning: ${w}`);
  return {
    inputPath,
    baseDir: dirname(inputPath),
    trace,
    adapter,
    engineInput: traceToReconstructionInput(trace),
    // The source type the file actually declared, before adapter normalization.
    // --require-source pins declared provenance, so it must see this too.
    rawSourceType,
  };
}

const program = new Command();
// Primary CLI is `tracereel`. `takeone` and `muse-takeone` remain as deprecated
// compatibility aliases (all bins point at this file). Show whichever name the
// user invoked, and nudge alias users toward the new name.
const invokedAs = basename(process.argv[1] ?? "").replace(/\.js$/, "");
// Unknown invocation basenames (e.g. `node dist/cli.js` -> "cli") fall back to
// the primary name instead of leaking an internal file name into help text.
const cliName =
  invokedAs === "tracereel" || invokedAs === "takeone" || invokedAs === "muse-takeone"
    ? invokedAs
    : "tracereel";
program.name(cliName).description(pkg.description).version(pkg.version);
if (invokedAs === "takeone" || invokedAs === "muse-takeone") {
  log(
    `warning: the \`${invokedAs}\` command is deprecated and will be removed in a future release. ` +
      `Use \`tracereel\` instead.`,
  );
}

const sharedOpts = (cmd: Command) =>
  cmd
    .option("-c, --config <json>", "JSON config overrides")
    .option("--viewport <WxH>", "browser viewport, e.g. 1920x1080")
    .option("--dpr <n>", "device scale factor (2 = retina)")
    .option("--width <px>", "output width")
    .option("--height <px>", "output height")
    .option("--fps <n>", "output frame rate")
    .option("--chromium <path>", "Chromium/Chrome executable to use")
    .option("--cdp <endpoint>", "attach directly to agent's running browser via CDP (port or URL)")
    .option("--headed", "show the browser window")
    .option("--state <file>", "Playwright storage state file (cookies, localStorage, IndexedDB)")
    .option("--profile <dir>", "persistent Chromium user data dir");

sharedOpts(
  program
    .command("record")
    .description("Run a scenario, capture it, and (by default) render the final video")
    .argument("<scenario>", "scenario .ts/.js file")
    .option("-o, --out <dir>", "output directory")
    .option("--no-render", "only capture raw frames + manifest; render later with `takeone render`")
    .option("--no-contact-sheet", "skip the keyframe sheet"),
).action(async (file: string, o) => {
  const scenario = await loadScenario(file);
  const overrides = parseOverrides(o);
  const outDir = o.out ?? defaultOutDir(file, scenario.config.name);
  const rec = await recordScenario(scenario, { outDir, config: overrides, log });
  if (o.render) {
    const res = await renderRecording({ recordingDir: rec.outDir, config: overrides, contactSheet: o.contactSheet, log, onProgress: progress });
    console.log(JSON.stringify({ outDir: rec.outDir, video: res.outFile, keyframes: res.contactSheet, durationMs: res.durationMs }, null, 2));
  } else {
    console.log(JSON.stringify({ outDir: rec.outDir, manifest: rec.manifestPath, frames: rec.manifest.frames.length }, null, 2));
  }
});

const sessionCmd = program
  .command("session")
  .description("Keep one logged-in browser alive so explore/find/act attach instead of relaunching");

sessionCmd
  .command("start")
  .description("Launch the session browser and log in once (spawns a detached daemon)")
  .option("--scenario <file>", "reuse this scenario's config and explore.setup for login")
  .option("--url <url>", "page to open after setup")
  .option("--port <n>", "CDP debug port (or TRACEREEL_SESSION_PORT)", String(sessionPort()))
  .option("--profile <dir>", "persistent Chromium user data dir", "/tmp/takeone-session")
  .option("--headed", "show the browser window")
  .action(async (o) => {
    const existing = readSession();
    if (existing && (await sessionAlive(existing))) {
      console.log(JSON.stringify({ status: "already-running", ...existing }, null, 2));
      return;
    }
    const { pid } = startSessionDaemon({
      port: Number(o.port),
      userDataDir: resolve(o.profile),
      url: o.url,
      setup: o.scenario ? resolve(o.scenario) : undefined,
      config: { browser: { headless: !o.headed } },
      log,
    });
    const info = await waitForSession(pid);
    if (info.setupError) {
      console.log(JSON.stringify({ status: "started-but-login-failed", ...info }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ status: "started", ...info }, null, 2));
  });

sessionCmd
  .command("status")
  .description("Report whether a session is running and where it is")
  .action(async () => {
    const info = readSession();
    if (!info) return console.log(JSON.stringify({ status: "none" }, null, 2));
    const alive = await sessionAlive(info);
    console.log(JSON.stringify({ status: alive ? "running" : "stale", ...info }, null, 2));
  });

sessionCmd
  .command("stop")
  .description("Stop the session browser")
  .action(async () => {
    const info = readSession();
    if (!info) return console.log(JSON.stringify({ status: "none" }, null, 2));
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {}
    clearSession();
    console.log(JSON.stringify({ status: "stopped", pid: info.pid }, null, 2));
  });


/** Print a daemon reply; a failed step is a failed command. */
function printReply(reply: { ok: boolean; lines: string[] }) {
  console.log(reply.lines.filter(Boolean).join("\n"));
  if (!reply.ok) process.exitCode = 1;
}

/** What an exported scenario should import: the package, or this repo's source when run from inside it. */
function packageImport(fromFile: string): string {
  try {
    const here = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    if (here.name === pkg.name && existsSync(resolve("src/index.ts"))) {
      const rel = relative(dirname(resolve(fromFile)), resolve("src/index.js"));
      return rel.startsWith(".") ? rel : `./${rel}`;
    }
  } catch {}
  return pkg.name;
}

program
  .command("do")
  .description("Act in the live session and see what changed: goto, click, type, press, hover, scroll, scroll-to, wait-for, wait-url, wait, zoom, zoom-out")
  .argument("<verb>", "what to do")
  .argument("[args...]", 'the target in plain words ("new project"), then any text. Also role:name, text=…, css=…, or x,y')
  .option("--role <role>", "only consider elements with this ARIA role")
  .option("--nth <n>", "pick the n-th of several equally good matches")
  .option("--timeout <ms>", "for wait-for and wait-url", "30000")
  .option("--gone", "wait-for: wait until it disappears")
  .option("--scenario <file>", "when no session is running, start one using this scenario's login setup")
  .action(async (verb: string, args: string[], o) => {
    const isWait = verb === "wait-for" || verb === "wait-url";
    const info = await ensureSession({ scenario: o.scenario, log });
    printReply(
      await sendCommand(info, "/do", {
        verb, args, role: o.role, nth: o.nth ? Number(o.nth) : undefined, gone: o.gone,
        timeout: isWait ? Number(o.timeout) : undefined,
      }),
    );
  });

program
  .command("look")
  .description("Show the session's page: every element on screen numbered and grouped by region, plus a screenshot with the same numbers drawn on it")
  .option("--role <role>", "only this ARIA role")
  .option("--filter <text>", "only names containing this text")
  .option("--all", "also list what is scrolled off screen, not only its headings")
  .option("--scenario <file>", "when no session is running, start one using this scenario's login setup")
  .action(async (o) => {
    const info = await ensureSession({ scenario: o.scenario, log });
    printReply(await sendCommand(info, "/look", { role: o.role, filter: o.filter, all: o.all }));
  });

program
  .command("mark")
  .description('Name a beat in the journal. `takeone mark setup`: unrecorded setup begins. `takeone mark start`: the recording begins. Everything before either was looking around')
  .argument("<name>")
  .action(async (name: string) => {
    const info = await ensureSession({ log });
    printReply(await sendCommand(info, "/do", { verb: "mark", args: [name] }));
  });

/** "3 5-8" -> [3,5,6,7,8] */
function parseIds(parts: string[]): number[] {
  const ids: number[] = [];
  for (const part of parts.flatMap((p) => p.split(","))) {
    const m = /^#?(\d+)(?:-#?(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Not a step id or range: ${part}`);
    for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) ids.push(i);
  }
  return ids;
}

program
  .command("journal")
  .description("Show the steps taken with `takeone do` and which of them will be exported. Detours are left out automatically")
  .argument("[action]", "drop | keep | setup | clear")
  .argument("[ids...]", "step ids or ranges, e.g. 5-8")
  .action(async (action: string | undefined, ids: string[]) => {
    if (action && !["drop", "keep", "setup", "clear"].includes(action)) throw new Error("Use: takeone journal [drop|keep|setup <ids>] [clear]");
    const info = await ensureSession({ log });
    printReply(await sendCommand(info, "/journal", { action, ids: parseIds(ids) }));
  });

sessionCmd
  .command("export")
  .description("Write the kept journal steps as a scenario, after replaying them in a fresh tab to prove the path holds")
  .argument("<file>", "scenario file to write")
  .option("--name <name>", "scenario name")
  .option("--from <scenario>", "inherit config and login setup from this scenario (defaults to the one the session started with)")
  .option("--no-verify", "skip the replay")
  .option("--force", "overwrite the whole file, even if it was hand-written or its steps were edited")
  .action(async (file: string, o) => {
    const info = await ensureSession({ log });
    printReply(
      await sendCommand(info, "/export", {
        file: resolve(file), name: o.name ?? basename(file).replace(/\.[^.]+$/, ""), from: o.from ? resolve(o.from) : undefined,
        verify: o.verify, force: o.force, pkg: packageImport(file), budget: 180000,
      }),
    );
  });

program
  .command("find")
  .description("List elements matching a role and name on a page (no scenario needed)")
  .argument("<url>", "page to inspect; with --scenario, a path relative to the scenario's baseUrl")
  .requiredOption("--role <role>", "ARIA role, e.g. button, link, textbox, heading")
  .option("--name <text>", "accessible name; omit to list every element with that role")
  .option("--scenario <file>", "reuse a scenario's config, baseUrl and login setup before searching")
  .option("--base <url>", "base URL for relative navigation")
  .option("--wait-for <selector>", "wait for this selector before searching")
  .option("--settle <ms>", "extra settle time after load")
  .option("--within <selector>", "scope the search to a container")
  .option("--state <file>", "Playwright storage state file (cookies, localStorage, IndexedDB)")
  .option("--profile <dir>", "persistent Chromium user data dir")
  .option("--no-session", "ignore a running takeone session and launch a fresh browser")
  .action(async (url: string, o) => {
    let config = resolveConfig(parseOverrides(o));
    let base = o.base ?? "";
    let setup: ((page: import("playwright").Page) => Promise<void>) | undefined;

    // Reusing a scenario is what makes this usable against a logged-in app: the scenario
    // already knows how to log in, so no storage state file is needed.
    if (o.scenario) {
      const scenario = await loadScenario(o.scenario);
      config = resolveConfig(scenario.config, parseOverrides(o));
      base = scenario.explore?.baseUrl ?? base;
      setup = scenario.explore?.setup;
    }

    const session = readSession();
    const useSession = !o.noSession && session && (await sessionAlive(session));
    // A live session already knows its origin, so a path needs no --base.
    if (!base && useSession && session?.url) {
      try {
        base = new URL(session.url).origin;
      } catch {}
    }

    const target = /^https?:/.test(url) ? url : `${base}${url}`;
    if (!/^https?:/.test(target)) {
      throw new Error("Pass --base <url>, --scenario <file> with a baseUrl, a full URL, or start a session with an --url.");
    }
    const launched = useSession
      ? await connectToSession(session!.port, config.browser)
      : await launchBrowser(config.browser, config.viewport, log);
    try {
      const page = launched.context.pages()[0] ?? (await launched.context.newPage());
      if (setup && !useSession) await setup(page);
      await page.goto(target, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      if (o.waitFor) await page.locator(o.waitFor).first().waitFor({ state: "visible" });
      if (o.settle) await page.waitForTimeout(Number(o.settle));
      const name = o.name ? new RegExp(o.name, "i") : undefined;
      const { findAllRoleTargets } = await import("./resolver.js");
      const matches = await findAllRoleTargets(page, { role: o.role, name, within: o.within } as any);
      // Matches without a box are not on screen; listing them as x:-1 only misleads.
      const visible = matches.filter((m) => m.width > 0 && m.height > 0);
      console.log(JSON.stringify({ url: page.url(), count: visible.length, hidden: matches.length - visible.length, matches: visible }, null, 2));
      if (!visible.length) process.exitCode = 1;
    } finally {
      await launched.close();
    }
  });

program
  .command("explore")
  .description("Visit pages once and inventory every clickable element into an index with @eNN handles")
  .argument("<target>", "a scenario file, or a URL/path to inventory")
  .option("-o, --out <dir>", "output directory")
  .option("--base <url>", "base URL prepended to relative paths")
  .option("--path <path...>", "extra paths to visit (repeatable)")
  .option("--wait-for <selector>", "wait for this selector on each page before inventorying")
  .option("--settle <ms>", "extra settle time per page")
  .option("--no-html", "skip the HTML inventory page")
  .option("--no-session", "ignore a running takeone session and launch a fresh browser")
  .option("--list", "print the inventory to stdout as text instead of writing files")
  .action(async (target: string, o) => {
    const isScenario = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/.test(target);
    const overrides = parseOverrides(o);
    let pages: { path: string; waitFor?: string; settle?: number }[];
    let baseUrl = o.base;
    let setup: ((page: import("playwright").Page) => Promise<void>) | undefined;

    if (isScenario) {
      const scenario = await loadScenario(target);
      const plan = scenario.explore;
      if (!plan) throw new Error(`${target} does not export an \`explore\` plan. Add one, or pass a URL to inventory directly.`);
      pages = plan.pages;
      baseUrl = baseUrl ?? plan.baseUrl;
      setup = plan.setup;
      overrides.name = undefined;
      for (const p of o.path ?? []) pages.push({ path: p, waitFor: o.waitFor, settle: o.settle ? Number(o.settle) : undefined });
    } else {
      if (!baseUrl) throw new Error("Pass --base <url> when inventorying a URL directly, or use a scenario file.");
      pages = [{ path: target, waitFor: o.waitFor, settle: o.settle ? Number(o.settle) : undefined }];
      for (const p of o.path ?? []) pages.push({ path: p, waitFor: o.waitFor, settle: o.settle ? Number(o.settle) : undefined });
    }

    const outDir = o.out ?? join("recordings", `explore-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
    const res = await exploreScenario({ pages, outDir, baseUrl, setup, config: overrides, log, html: o.html, noSession: o.session === false });

    if (o.list) {
      for (const page of res.bundle.pages) {
        console.log(`\n${page.url}`);
        for (const el of page.elements) {
          console.log(`  ${el.handle.padEnd(6)} ${el.role.padEnd(9)} ${JSON.stringify(el.name).slice(0, 70)}${el.disabled ? " (disabled)" : ""}`);
        }
      }
    }
    console.log(
      JSON.stringify(
        {
          outDir: res.outDir,
          index: res.indexPath,
          pages: res.bundle.pages.map((p) => ({ url: p.url, elements: p.elements.length, ambiguous: p.ambiguous.length })),
          total: res.bundle.pages.reduce((n, p) => n + p.elements.length, 0),
          pagesSheet: res.sheets[0],
          html: res.html,
        },
        null,
        2,
      ),
    );
  });

sharedOpts(
  program
    .command("render")
    .description("Render (or re-render) a captured recording with the given look")
    .argument("<recordingDir>", "directory containing manifest.json")
    .option("-o, --out <file>", "output video file")
    .option("--no-contact-sheet", "skip the keyframe sheet"),
).action(async (dir: string, o) => {
  const res = await renderRecording({ recordingDir: dir, outFile: o.out, config: parseOverrides(o), contactSheet: o.contactSheet, log, onProgress: progress });
  console.log(JSON.stringify({ video: res.outFile, keyframes: res.contactSheet, durationMs: res.durationMs }, null, 2));
});

sharedOpts(
  program
    .command("reconstruct")
    .description("Build a polished video from an agent's trace: screenshots + actions in, demo video out")
    .argument("<input>", "trace JSON: TraceReel Trace v1 (states/actions or frames), or a legacy takeone frame input")
    .option("-o, --out <file>", "output video file (default <input-dir>/reconstruct-output.mp4)")
    .option("--work-dir <dir>", "working directory for manifest + copied frames (default <input-dir>/.reconstruct)")
    .option("--keep-work-dir", "do not delete the working directory after rendering")
    .option("--no-contact-sheet", "skip the keyframe sheet")
    .option("--adapter <name>", "force an adapter: muse | grokbot | generic (default: picked from the trace source)")
    .option("--require-source <type>", "fail unless the normalized trace's source.type matches (agent-browser | muse-managed-browser | external-browser | manual-screenshots)"),
).action(async (inputFile: string, o) => {
  const { rmSync } = await import("node:fs");
  let workDir = "";
  try {
    const loaded = await loadTraceInput(inputFile, o.adapter);
    const { inputPath, baseDir, engineInput } = loaded;
    workDir = resolve(o.workDir ?? join(baseDir, ".reconstruct"));
    const { validateReconstructionInput } = await import("./reconstruct/validate.js");
    const { qaReconstruction, formatQaMetrics } = await import("./reconstruct/qa.js");
    const v = validateReconstructionInput(engineInput, baseDir);
    for (const w of v.warnings) log(`warning: ${w.code}: ${w.message}`);
    if (!v.ok) {
      for (const e of v.errors) log(`error: ${e.code}: ${e.message}${e.suggestion ? ` (${e.suggestion})` : ""}`);
      log(`reconstruct failed: input invalid (${v.errors.length} error${v.errors.length === 1 ? "" : "s"})`);
      process.exitCode = 1;
      return;
    }
    checkRequireSource(o.requireSource, loaded.trace, engineInput, loaded.rawSourceType);
    // Managed real-frame path: validate dense capture sequences before
    // building. Bad captures fail loudly so the agent recaptures them —
    // TraceReel never repairs page pixels synthetically.
    {
      const { detectDenseRuns, validateRealFrameSequence, visualSourceForFrames } =
        await import("./reconstruct/realframes.js");
      const runs = detectDenseRuns(engineInput.frames);
      if (runs.length) {
        const shotsDir = resolve(baseDir, engineInput.screenshotsDir ?? ".");
        let failed = false;
        for (const run of runs) {
          const seq = engineInput.frames.slice(run.start, run.end + 1);
          const vr = await validateRealFrameSequence(seq, shotsDir, {
            viewportHeight: engineInput.viewport.height,
          });
          for (const w of vr.warnings) log(`warning: real-frames ${w.code}: ${w.message}`);
          for (const e of vr.errors) {
            log(`error: real-frames ${e.code}: ${e.message}`);
            failed = true;
          }
        }
        if (failed) {
          log(`reconstruct failed: real-frame validation failed; recapture the flagged frames`);
          process.exitCode = 1;
          return;
        }
      }
      const vs = visualSourceForFrames(engineInput.frames);
      log(`Visual source: ${vs === "managed-real-frames" ? "managed real frames" : vs === "mixed" ? "mixed (managed real frames + reconstructed sparse states)" : "reconstructed sparse states"}`);
    }
    const { manifest } = writeReconstructionDir({ input: engineInput, baseDir, workDir, config: parseOverrides(o), log });
    const outFile = resolve(o.out ?? join(baseDir, "reconstruct-output.mp4"));
    if (outFile === inputPath) {
      log("error: refusing to write the video over the input file itself");
      process.exitCode = 1;
      return;
    }
    if (outFile === workDir || outFile.startsWith(workDir + sep)) {
      log("error: refusing to write the video inside the work dir (it is deleted after rendering unless --keep-work-dir)");
      process.exitCode = 1;
      return;
    }
    const res = await renderRecording({ recordingDir: workDir, outFile, config: parseOverrides(o), contactSheet: o.contactSheet, log, onProgress: progress });
    const { formatWarningCounts } = await import("./reconstruct/qa.js");
    const qa = qaReconstruction(engineInput, manifest);
    log(`QA: ${formatQaMetrics(qa.metrics)}`);
    log(`QA warnings: ${formatWarningCounts(qa.warningCounts)}`);
    for (const w of qa.categorized) log(`QA warning [${w.category}]: ${w.message}`);
    console.log(JSON.stringify({ video: res.outFile, keyframes: res.contactSheet, durationMs: res.durationMs, frames: manifest.frames.length, visualSource: manifest.visualSource, qa: qa.metrics, qaWarnings: qa.warnings }, null, 2));
  } catch (e) {
    log(`reconstruct failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    if (workDir && !o.keepWorkDir) rmSync(workDir, { recursive: true, force: true });
  }
});

program
  .command("audio")
  .description("Mix agent-supplied narration/music onto a finished video: scene-timed placement, ducking, fades, AAC output, video stream copied (-c:v copy)")
  .argument("<video>", "finished video from `tracereel reconstruct` (its stream is copied, never re-encoded)")
  .option("--trace <file>", "trace JSON carrying narration[] and/or audio.music (required)")
  .option("-o, --out <file>", "output MP4 (default <video-dir>/<video-base>-narrated.mp4)")
  .option("--adapter <name>", "force an adapter: muse | grokbot | generic (default: picked from the trace source)")
  .option("--subtitles <format>", "export subtitle cues from narration: srt | vtt | both (written next to the output)")
  .option("--loudness-target <lufs>", "override loudness target in LUFS (default -16; trace audio.loudness.targetLUFS also works)")
  .option("--loudness-peak <dbtp>", "override max true peak in dBTP (default -1.5)")
  .option("--no-loudness", "disable loudness normalization; the mix ships as-is")
  .option("--json", "machine-readable output")
  .action(async (videoFile: string, o: { trace?: string; out?: string; adapter?: string; subtitles?: string; loudnessTarget?: string; loudnessPeak?: string; loudness?: boolean; json?: boolean }) => {
    const { join, dirname, basename, resolve, sep, extname } = await import("node:path");
    const { writeFileSync } = await import("node:fs");
    if (!o.trace) {
      console.error("audio needs --trace <trace.json>: the narration/music declarations live in the trace");
      process.exitCode = 1;
      return;
    }
    // Validate --subtitles before doing any work, so a bad value fails fast.
    const wantSubtitles = o.subtitles ? o.subtitles.toLowerCase() : null;
    if (wantSubtitles && !["srt", "vtt", "both"].includes(wantSubtitles)) {
      console.error(`audio: --subtitles must be srt, vtt, or both (got ${o.subtitles})`);
      process.exitCode = 1;
      return;
    }
    const videoPath = resolve(videoFile);
    try {
      const loaded = await loadTraceInput(o.trace, o.adapter);
      const { inputPath, baseDir, trace, engineInput } = loaded;
      const { validateReconstructionInput } = await import("./reconstruct/validate.js");
      const v = validateReconstructionInput(engineInput, baseDir);
      if (!v.ok) {
        for (const e of v.errors) log(`error: ${e.code}: ${e.message}`);
        log("audio aborted: the trace's visual input is invalid");
        process.exitCode = 1;
        return;
      }
      if (!trace.narration?.length && !trace.audio?.music) {
        log("audio aborted: the trace declares no narration[] and no audio.music — nothing to mix");
        process.exitCode = 1;
        return;
      }
      const { buildReconstructionManifest } = await import("./reconstruct/build.js");
      const { RECONSTRUCTION_DEFAULTS, resolveConfig } = await import("./config.js");
      const manifest = buildReconstructionManifest(engineInput, resolveConfig(RECONSTRUCTION_DEFAULTS, undefined));
      const { planAudio } = await import("./audio/plan.js");
      const loudnessOverride: { targetLUFS?: number; maxTruePeakDbTP?: number; disabled?: boolean } = {};
      if (o.loudnessTarget !== undefined) {
        const v = Number(o.loudnessTarget);
        if (!Number.isFinite(v)) {
          log(`audio: --loudness-target must be a number (got ${o.loudnessTarget})`);
          process.exitCode = 1;
          return;
        }
        loudnessOverride.targetLUFS = v;
      }
      if (o.loudnessPeak !== undefined) {
        const v = Number(o.loudnessPeak);
        if (!Number.isFinite(v)) {
          log(`audio: --loudness-peak must be a number (got ${o.loudnessPeak})`);
          process.exitCode = 1;
          return;
        }
        loudnessOverride.maxTruePeakDbTP = v;
      }
      if (o.loudness === false) loudnessOverride.disabled = true;
      const plan = planAudio(trace, manifest, { baseDir, loudnessOverride });
      for (const w of plan.warnings) log(`warning: ${w.code}: ${w.message}`);
      if (plan.errors.length) {
        for (const e of plan.errors) log(`error: ${e.code}: ${e.message}${e.suggestion ? ` (${e.suggestion})` : ""}`);
        log(`audio aborted: ${plan.errors.length} audio error${plan.errors.length === 1 ? "" : "s"}`);
        process.exitCode = 1;
        return;
      }
      const outFile = resolve(o.out ?? join(dirname(videoPath), `${basename(videoPath, extname(videoPath))}-narrated.mp4`));
      if (outFile === videoPath) {
        log("error: refusing to write the narrated video over the input video itself");
        process.exitCode = 1;
        return;
      }
      const { muxAudio } = await import("./audio/mux.js");
      const muxed = muxAudio({ videoFile: videoPath, plan, baseDir, outFile });
      log(`muxed: video stream copied (${muxed.videoCodec}), audio ${muxed.audioCodec} ${muxed.audioSampleRate}Hz ${muxed.audioChannels}ch`);

      let subtitleFiles: string[] = [];
      if (wantSubtitles) {
        const { cuesFromPlan, cuesToSrt, cuesToVtt } = await import("./audio/subtitles.js");
        const cues = cuesFromPlan(plan);
        const base = join(dirname(outFile), basename(outFile, extname(outFile)));
        if (wantSubtitles === "srt" || wantSubtitles === "both") {
          writeFileSync(`${base}.srt`, cuesToSrt(cues));
          subtitleFiles.push(`${base}.srt`);
        }
        if (wantSubtitles === "vtt" || wantSubtitles === "both") {
          writeFileSync(`${base}.vtt`, cuesToVtt(cues));
          subtitleFiles.push(`${base}.vtt`);
        }
        log(`subtitles: ${cues.length} cue(s)${subtitleFiles.length ? ` -> ${subtitleFiles.join(", ")}` : " (no clip had text; nothing written)"}`);
        if (!cues.length) subtitleFiles = [];
      }

      const { qaAudio } = await import("./audio/qa.js");
      const aqa = qaAudio(plan, { outFile });
      for (const w of aqa.warnings) log(`QA warning ${w}`);
      const summary = {
        video: videoPath,
        outFile: muxed.outFile,
        videoStreamCopied: true,
        videoCodec: muxed.videoCodec,
        narrationClips: aqa.metrics.narrationClips,
        narrationOnsetsMs: aqa.metrics.narrationOnsetsMs,
        music: aqa.metrics.musicPresent
          ? { loops: aqa.metrics.musicLoops, volume: aqa.metrics.musicVolume, ducking: aqa.metrics.duckingEnabled }
          : null,
        audio: { codec: aqa.metrics.finalCodec, sampleRate: aqa.metrics.finalSampleRate, channels: aqa.metrics.finalChannels },
        loudness: {
          normalized: aqa.metrics.loudnessNormalized,
          targetLufs: aqa.metrics.loudnessTargetLufs,
          integratedLufs: aqa.metrics.loudnessIntegratedLufs,
          truePeakDbTP: aqa.metrics.loudnessTruePeakDbTP,
        },
        subtitles: subtitleFiles,
        audioWarnings: aqa.warnings,
      };
      if (o.json) console.log(JSON.stringify(summary, null, 2));
      else {
        const l = aqa.metrics;
        if (l.loudnessIntegratedLufs !== null && l.loudnessTruePeakDbTP !== null) {
          log(`loudness: ${l.loudnessIntegratedLufs.toFixed(1)} LUFS integrated, ${l.loudnessTruePeakDbTP.toFixed(1)} dBTP true peak` +
            (l.loudnessNormalized ? ` (normalized to ${l.loudnessTargetLufs} LUFS)` : " (normalization disabled)"));
        }
        log(`audio done: ${muxed.outFile}`);
      }
    } catch (e) {
      log(`audio failed: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("validate")
  .description("Validate a trace without rendering anything: adapter normalization, then structural checks with error codes")
  .argument("<input>", "trace JSON: TraceReel Trace v1 (states/actions or frames), or a legacy takeone frame input")
  .option("--adapter <name>", "force an adapter: muse | grokbot | generic (default: picked from the trace source)")
  .option("--json", "machine-readable output with error codes, paths, and suggestions")
  .action(async (inputFile: string, o: { adapter?: string; json?: boolean }) => {
    const { validateReconstructionInput } = await import("./reconstruct/validate.js");
    let loaded;
    try {
      loaded = await loadTraceInput(inputFile, o.adapter);
    } catch (e) {
      if (o.json) {
        console.log(JSON.stringify({ ok: false, errors: [{ code: "UNREADABLE_INPUT", message: (e as Error).message }], warnings: [] }, null, 2));
      } else {
        console.error(`invalid: ${(e as Error).message}`);
      }
      process.exitCode = 1;
      return;
    }
    const { inputPath, baseDir, trace, engineInput, adapter } = loaded;
    const { errors, warnings, ok } = validateReconstructionInput(engineInput, baseDir);
    // Audio validation: runs when the trace declares narration or music. Needs
    // the output timeline, so the manifest is built (cheap — no rendering).
    let audioErrors: { code: string; path?: string; message: string; suggestion?: string }[] = [];
    let audioWarnings: { code: string; path?: string; message: string; suggestion?: string }[] = [];
    if (trace.narration?.length || trace.audio?.music) {
      const { buildReconstructionManifest } = await import("./reconstruct/build.js");
      const { RECONSTRUCTION_DEFAULTS, resolveConfig } = await import("./config.js");
      const { planAudio } = await import("./audio/plan.js");
      const manifest = buildReconstructionManifest(engineInput, resolveConfig(RECONSTRUCTION_DEFAULTS, undefined));
      const plan = planAudio(trace, manifest, { baseDir });
      audioErrors = plan.errors;
      audioWarnings = plan.warnings;
    }
    const allErrors = [...errors, ...audioErrors];
    const allWarnings = [...warnings, ...audioWarnings];
    const allOk = ok && audioErrors.length === 0;
    if (o.json) {
      console.log(JSON.stringify({
        ok: allOk,
        input: inputPath,
        adapter: adapter.name,
        agent: loaded.trace.source?.agent ?? null,
        errors: allErrors.map((e) => ({ code: e.code, path: e.path ?? null, message: e.message, suggestion: e.suggestion ?? null })),
        warnings: allWarnings.map((w) => ({ code: w.code, path: w.path ?? null, message: w.message, suggestion: w.suggestion ?? null })),
      }, null, 2));
    } else {
      for (const w of allWarnings) console.error(`warning: ${w.code}: ${w.message}`);
      for (const e of allErrors) console.error(`error: ${e.code}: ${e.message}${e.suggestion ? ` (${e.suggestion})` : ""}`);
      if (allOk) console.log(`valid: ${inputPath} (adapter: ${adapter.name}, ${allWarnings.length} warning${allWarnings.length === 1 ? "" : "s"})`);
      else console.error(`invalid: ${allErrors.length} error${allErrors.length === 1 ? "" : "s"}`);
    }
    process.exitCode = allOk ? 0 : 1;
  });

program
  .command("inspect")
  .description("Report what a trace will produce: agent, states/frames, actions, duration, camera shots, warnings")
  .argument("<input>", "trace JSON: TraceReel Trace v1 (states/actions or frames), or a legacy takeone frame input")
  .option("--adapter <name>", "force an adapter: muse | grokbot | generic (default: picked from the trace source)")
  .option("--json", "machine-readable output")
  .option("-c, --config <json>", "JSON config overrides")
  .action(async (inputFile: string, o: { json?: boolean; config?: string; adapter?: string }) => {
    const { validateReconstructionInput } = await import("./reconstruct/validate.js");
    const { buildReconstructionManifest } = await import("./reconstruct/build.js");
    const { qaReconstruction, formatQaMetrics } = await import("./reconstruct/qa.js");
    const { planReconstructionCamera } = await import("./reconstruct/shots.js");
    const { RECONSTRUCTION_DEFAULTS, resolveConfig } = await import("./config.js");
    let loaded;
    try {
      loaded = await loadTraceInput(inputFile, o.adapter);
    } catch (e) {
      console.error(`inspect aborted: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    const { inputPath, baseDir, trace, engineInput, adapter } = loaded;
    const v = validateReconstructionInput(engineInput, baseDir);
    if (!v.ok) {
      for (const e of v.errors) console.error(`error: ${e.code}: ${e.message}`);
      console.error(`inspect aborted: fix the errors above (or run \`tracereel validate --json\` for codes and suggestions)`);
      process.exitCode = 1;
      return;
    }
    const cfg = resolveConfig(RECONSTRUCTION_DEFAULTS, o.config ? JSON.parse(o.config) : undefined);
    const manifest = buildReconstructionManifest(engineInput, cfg);
    const qa = qaReconstruction(engineInput, manifest);
    const { shots } = planReconstructionCamera(manifest, cfg);
    const src = trace.source;
    const frames = engineInput.frames;
    const frameRows = frames.map((f, i: number) => ({
      n: i + 1,
      file: f.file,
      stateId: trace.states?.[i]?.id ?? null,
      atMs: manifest.frames[i].t,
      actions: (f.actions ?? []).length,
      caption: f.caption ?? null,
      transitionIn: manifest.frames[i].transitionIn ?? "crossfade",
    }));
    const report = {
      input: inputPath,
      agent: src?.agent ?? null,
      adapter: adapter.name,
      source: src ?? null,
      viewport: trace.viewport,
      traceForm: trace.states ? "states" : "frames",
      frames: frameRows,
      qa: qa.metrics,
      cameraShots: shots.map((s, i) => ({
        n: i + 1,
        startMs: Math.round(s.start),
        endMs: Math.round(s.end),
        cx: Math.round(s.cx),
        cy: Math.round(s.cy),
        scale: Number(s.scale.toFixed(2)),
      })),
      output: { width: cfg.output.width, height: cfg.output.height, fps: cfg.output.fps, format: cfg.output.format },
      warnings: [...v.warnings.map((w) => `${w.code}: ${w.message}`), ...qa.warnings],
    };
    // Audio section: plan narration/music onto the output timeline when declared.
    let audioSection: Record<string, unknown> | null = null;
    if (trace.narration?.length || trace.audio?.music) {
      const { planAudio } = await import("./audio/plan.js");
      const { qaAudio } = await import("./audio/qa.js");
      const aplan = planAudio(trace, manifest, { baseDir });
      const aqa = qaAudio(aplan);
      const m = aplan.music;
      audioSection = {
        narrationClips: aplan.narration.map((p) => ({
          state: p.clip.state,
          audio: p.clip.audio,
          startMs: p.startMs,
          sceneStartMs: p.sceneStartMs,
          sceneEndMs: p.sceneEndMs,
          audioDurationMs: p.audioDurationMs,
          explicitStart: p.explicitStart,
          generatedBy: p.clip.generatedBy ?? null,
        })),
        narrationTotalMs: aqa.metrics.narrationTotalMs,
        music: m
          ? {
              file: m.music.file,
              loop: m.music.loop ?? true,
              loopsNeeded: m.loops,
              volume: m.volume,
              fadeInMs: m.fadeInMs,
              fadeOutMs: m.fadeOutMs,
              duckUnderNarration: m.duckUnderNarration,
            }
          : null,
        finalAudio: { codec: "aac", sampleRate: 48000, channels: 2 },
        loudness: {
          enabled: aplan.loudness.enabled,
          targetLUFS: aplan.loudness.targetLUFS,
          maxTruePeakDbTP: aplan.loudness.maxTruePeakDbTP,
        },
        errors: aplan.errors.map((e) => `${e.code}: ${e.message}`),
        warnings: [...aplan.errors.map((e) => `${e.code}: ${e.message}`), ...aqa.warnings],
      };
      (report as Record<string, unknown>).audio = audioSection;
      for (const w of aplan.warnings) (report.warnings as string[]).push(`${w.code}: ${w.message}`);
    }
    if (o.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`input: ${inputPath}`);
    console.log(`agent: ${src?.agent ?? "unspecified"} (adapter: ${adapter.name}, form: ${trace.states ? "states" : "frames"})`);
    console.log(`viewport: ${trace.viewport.width}x${trace.viewport.height}`);
    console.log(`frames:`);
    for (const r of frameRows) {
      console.log(`  ${r.n}. ${r.file}${r.stateId ? ` [${r.stateId}]` : ""} @${(r.atMs / 1000).toFixed(1)}s — ${r.actions} action(s), in: ${typeof r.transitionIn === "string" ? r.transitionIn : r.transitionIn.kind}${r.caption ? ` — "${r.caption}"` : ""}`);
    }
    console.log(`expect: ${formatQaMetrics(qa.metrics)}`);
    console.log(`camera shots (${shots.length}):`);
    for (const s of report.cameraShots) {
      console.log(`  ${s.n}. ${s.startMs}..${s.endMs}ms @ (${s.cx}, ${s.cy}) ${s.scale}x`);
    }
    console.log(`output: ${cfg.output.width}x${cfg.output.height}@${cfg.output.fps} ${cfg.output.format}`);
    if (audioSection) {
      const clips = audioSection.narrationClips as Array<{ startMs: number }>;
      console.log(`audio:`);
      console.log(`  narration clips: ${clips.length}`);
      console.log(`  narration total duration: ${((audioSection.narrationTotalMs as number) / 1000).toFixed(1)}s`);
      const mus = audioSection.music as { file: string; loop: boolean; volume: number; duckUnderNarration: boolean } | null;
      if (mus) {
        console.log(`  music:`);
        console.log(`    ${mus.file}`);
        console.log(`    loop: ${mus.loop ? "yes" : "no"}`);
        console.log(`    volume: ${Math.round(mus.volume * 100)}%`);
        console.log(`    ducking: ${mus.duckUnderNarration ? "enabled" : "disabled"}`);
      } else {
        console.log(`  music: none`);
      }
      console.log(`  final audio: AAC, 48kHz, stereo`);
    }
    if (report.warnings.length) {
      console.log(`warnings (${report.warnings.length}):`);
      for (const w of report.warnings) console.log(`  - ${w}`);
    } else {
      console.log("warnings: none");
    }
  });

program
  .command("capabilities")
  .description("Show what each agent's captures are known to provide (verified integrations vs planned)")
  .argument("[agent]", "agent name: muse | grokbot | generic (default: all)")
  .option("--json", "machine-readable output")
  .action(async (agent: string | undefined, o: { json?: boolean }) => {
    const { listAdapters, getAdapter } = await import("./adapters/index.js");
    const { CAPABILITY_DESCRIPTIONS } = await import("./capabilities.js");
    const adapters = agent ? [getAdapter(agent)] : listAdapters();
    if (o.json) {
      console.log(JSON.stringify({
        adapters: adapters.map((a) => ({
          name: a.name,
          description: a.description,
          verified: a.verified,
          capabilities: a.capabilities,
        })),
      }, null, 2));
      return;
    }
    for (const a of adapters) {
      console.log(`${a.name}${a.verified ? " (verified)" : " (planned — not yet verified end to end)"}`);
      console.log(`  ${a.description}`);
      for (const [k, v] of Object.entries(a.capabilities)) {
        const label = CAPABILITY_DESCRIPTIONS[k as keyof typeof CAPABILITY_DESCRIPTIONS] ?? k;
        console.log(`  ${v ? "✓" : "✗"} ${label}`);
      }
    }
  });

program
  .command("import")
  .description("Normalize an agent's trace into a portable TraceReel bundle (demo.tracereel/)")
  .argument("<agent-trace>", "the agent's trace JSON file (screenshots sit next to it, or under screenshotsDir)")
  .option("-o, --out <dir>", "bundle directory (default: <trace-name>.tracereel next to the trace)")
  .option("--adapter <name>", "force an adapter: muse | grokbot | generic (default: picked from the trace source)")
  .option("--producer <name>", "free-form producer note recorded in metadata.json")
  .action(async (traceFile: string, o: { out?: string; adapter?: string; producer?: string }) => {
    const { writeBundle } = await import("./bundle.js");
    let loaded;
    try {
      loaded = await loadTraceInput(traceFile, o.adapter);
    } catch (e) {
      log(`import failed: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    const { inputPath, baseDir, trace, adapter } = loaded;
    const { validateReconstructionInput } = await import("./reconstruct/validate.js");
    const { traceToReconstructionInput } = await import("./adapters/normalize.js");
    const v = validateReconstructionInput(traceToReconstructionInput(trace), baseDir);
    if (!v.ok) {
      for (const e of v.errors) log(`error: ${e.code}: ${e.message}${e.suggestion ? ` (${e.suggestion})` : ""}`);
      log(`import failed: trace invalid (${v.errors.length} error${v.errors.length === 1 ? "" : "s"}) — fix with the suggestions above`);
      process.exitCode = 1;
      return;
    }
    const screenshotsDir = trace.screenshotsDir ? resolve(baseDir, trace.screenshotsDir) : baseDir;
    const defaultOut = inputPath.replace(/\.[^.]+$/, "") + ".tracereel";
    try {
      const { dir, metadata } = writeBundle(resolve(o.out ?? defaultOut), trace, {
        framesSourceDir: screenshotsDir,
        adapter: adapter.name,
        warnings: v.warnings.map((w) => `${w.code}: ${w.message}`),
        producer: o.producer,
      });
      console.log(JSON.stringify({ bundle: dir, agent: metadata.agent, adapter: metadata.adapter, traceForm: metadata.traceForm }, null, 2));
    } catch (e) {
      log(`import failed: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("Check the machine can render: node, ffmpeg, Chromium renderer, disk space, write permissions")
  .option("--json", "machine-readable output")
  .action(async (o: { json?: boolean }) => {
    const lines: { ok: boolean; label: string; detail: string }[] = [];
    const major = Number(process.versions.node.split(".")[0]);
    lines.push({ ok: major >= 20, label: "node", detail: `${process.versions.node} ${major >= 20 ? "(>= 20 ok)" : "(need >= 20)"}` });
    try {
      const { resolveFfmpeg, ffmpegVersion } = await import("./ffmpeg.js");
      const p = resolveFfmpeg();
      lines.push({ ok: true, label: "ffmpeg", detail: `${ffmpegVersion() ?? "unknown version"} @ ${p}` });
    } catch (e) {
      lines.push({ ok: false, label: "ffmpeg", detail: (e as Error).message });
    }
    try {
      const { resolveExecutablePath } = await import("./browser.js");
      const { existsSync: existsSync2 } = await import("node:fs");
      const envPath = process.env.TRACEREEL_CHROMIUM_PATH ?? process.env.TAKEONE_CHROMIUM_PATH;
      const p = resolveExecutablePath({ headless: true } as never);
      if (p) {
        lines.push({ ok: true, label: "chromium (renderer)", detail: `${p}${envPath ? " (TRACEREEL_CHROMIUM_PATH)" : ""}` });
      } else {
        // No pinned binary: the render falls back to Playwright-managed Chromium.
        const { chromium } = await import("playwright");
        const managed = chromium.executablePath();
        if (managed && existsSync2(managed)) {
          lines.push({ ok: true, label: "chromium (renderer)", detail: `${managed} (Playwright-managed)` });
        } else {
          lines.push({ ok: false, label: "chromium (renderer)", detail: "no pinned binary and Playwright-managed Chromium is not installed — set TRACEREEL_CHROMIUM_PATH or run setup" });
        }
      }
    } catch (e) {
      lines.push({ ok: false, label: "chromium (renderer)", detail: `${(e as Error).message} — set TRACEREEL_CHROMIUM_PATH or run setup` });
    }
    try {
      const { execFileSync } = await import("node:child_process");
      const df = execFileSync("df", ["-k", "."], { encoding: "utf8" }).trim().split("\n").pop()!.split(/\s+/);
      const availGb = Number(df[3]) / 1024 / 1024;
      lines.push({ ok: availGb > 1, label: "disk", detail: `${availGb.toFixed(1)} GB free ${availGb > 1 ? "(> 1 GB ok)" : "(low!)"}` });
    } catch {
      lines.push({ ok: true, label: "disk", detail: "could not check (non-fatal)" });
    }
    try {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const d = mkdtempSync(join(tmpdir(), "tracereel-"));
      rmSync(d, { recursive: true });
      lines.push({ ok: true, label: "write", detail: "temp dir writable" });
    } catch (e) {
      lines.push({ ok: false, label: "write", detail: (e as Error).message });
    }
    let allOk = true;
    for (const l of lines) if (!l.ok) allOk = false;
    if (o.json) {
      console.log(JSON.stringify({ ok: allOk, checks: lines }, null, 2));
    } else {
      for (const l of lines) console.log(`${l.ok ? "ok  " : "FAIL"} ${l.label}: ${l.detail}`);
    }
    process.exitCode = allOk ? 0 : 1;
  });

program
  .command("assemble")
  .description("Build a polished video from a folder of screenshots: Ken Burns motion, captions, title card")
  .argument("<framesDir>", "directory of screenshots (png/jpg/webp), played in sorted order")
  .option("-o, --out <file>", "output video file (default <framesDir>/assemble-output.mp4)")
  .option("-s, --script <file>", "JSON script with per-frame captions, holds and moves (default <framesDir>/assemble.json if present)")
  .option("--title <text>", "title card text (overrides script)")
  .option("--no-title", "skip the title card")
  .option("--hold <sec>", "default seconds per frame", "3")
  .option("--fps <n>", "output frame rate", "30")
  .option("--width <px>", "output width", "1920")
  .option("--height <px>", "output height", "1080")
  .action(async (dir: string, o) => {
    try {
      const res = await assembleVideo({
        framesDir: dir,
        outFile: o.out,
        scriptFile: o.script,
        title: o.title,
        noTitle: o.title === false,
        hold: Number(o.hold),
        fps: Number(o.fps),
        width: Number(o.width),
        height: Number(o.height),
        log,
      });
      console.log(JSON.stringify({ video: res.outFile, frames: res.frames, durationSec: res.durationSec }, null, 2));
    } catch (e) {
      log(`assemble failed: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

sharedOpts(
  program
    .command("dry-run")
    .description("Run a scenario at recording pace without capturing or rendering, screenshotting every step into one contact sheet")
    .argument("<scenario>", "scenario .ts/.js file")
    .option("-o, --out <dir>", "output directory")
    .option("--scale <n>", "screenshot scale factor, e.g. 0.5")
    .option("--columns <n>", "contact sheet columns")
    .option("--fast", "skip pacing: instant typing, no waits. Quicker, but not the run the recording will be")
    .option("--no-contact-sheet", "keep individual screenshots only"),
).action(async (file: string, o) => {
  const scenario = await loadScenario(file);
  const overrides = parseOverrides(o);
  overrides.dryRun = { ...(overrides.dryRun ?? {}) };
  if (o.scale) overrides.dryRun.scale = Number(o.scale);
  if (o.columns) overrides.dryRun.columns = Number(o.columns);
  if (o.contactSheet === false) overrides.dryRun.contactSheet = false;
  const outDir = o.out ?? defaultOutDir(file, scenario.config.name);
  const res = await dryRunScenario(scenario, { outDir, config: overrides, log, fast: o.fast });
  console.log(JSON.stringify({ outDir: res.outDir, contactSheet: res.contactSheet, steps: res.steps.length, error: res.error }, null, 2));
  if (res.error) process.exitCode = 1;
});

program
  .command("login")
  .description("Open a visible browser so you can log in, then save cookies/localStorage/IndexedDB to a state file")
  .requiredOption("--url <url>", "page to open")
  .option("-o, --out <file>", "state file", "state.json")
  .option("--chromium <path>", "Chromium/Chrome executable to use")
    .option("--cdp <endpoint>", "attach directly to agent's running browser via CDP (port or URL)")
  .option("--profile <dir>", "persistent Chromium user data dir to reuse")
  .action(async (o) => {
    const cfg = resolveConfig({ browser: { headless: false, executablePath: o.chromium, userDataDir: o.profile } });
    const launched = await launchBrowser(cfg.browser, { width: 1280, height: 800, deviceScaleFactor: 1 }, log);
    const page = launched.context.pages()[0] ?? (await launched.context.newPage());
    await page.goto(o.url);
    log("Log in in the browser window, then press Enter here to save the state...");
    await new Promise<void>((r) => process.stdin.once("data", () => r()));
    await launched.context.storageState({ path: resolve(o.out), indexedDB: true } as any);
    await launched.close();
    console.log(JSON.stringify({ state: resolve(o.out) }));
    process.exit(0);
  });

program
  .command("setup")
  .description("Get this machine ready to record: download Chromium, check ffmpeg, and prove a headless browser starts. Safe to run again")
  .option("--with-deps", "also install the system libraries Chromium needs on Linux (uses sudo when not root)")
  .option("--chromium <path>", "use this Chromium/Chrome instead of downloading one")
  .action(async (o) => {
    const steps: { step: string; ok: boolean; detail: string }[] = [];
    const say = (step: string, ok: boolean, detail: string) => {
      steps.push({ step, ok, detail });
      console.log(`${ok ? "✓" : "✗"} ${step}: ${detail}`);
    };
    const major = Number(process.versions.node.split(".")[0]);
    say("node", major >= 20, major >= 20 ? process.version : `${process.version} is too old; install Node 20 or newer`);

    const cfg = resolveConfig({ browser: { executablePath: o.chromium } });
    if (o.withDeps && process.platform === "linux") {
      const { spawnSync } = await import("node:child_process");
      const { playwrightCli } = await import("./browser.js");
      const cli = playwrightCli();
      const root = process.getuid?.() === 0;
      const res = spawnSync(root ? process.execPath : "sudo", root ? [cli, "install-deps", "chromium"] : [process.execPath, cli, "install-deps", "chromium"], { stdio: "inherit" });
      say("system libraries", res.status === 0, res.status === 0 ? "installed" : "install-deps failed; run it with sudo yourself");
    }
    try {
      const { ensureChromium } = await import("./browser.js");
      ensureChromium(cfg.browser, log);
      const info = chromiumInfo(cfg.browser);
      say("chromium", true, `${info.version ?? "installed"} at ${info.path}`);
    } catch (e) {
      say("chromium", false, (e as Error).message);
    }
    const ff = ffmpegVersion();
    say("ffmpeg", !!ff, ff ? ff.split(" Copyright")[0] : "missing; set FFMPEG_PATH to an ffmpeg binary");

    // The real test: can a headless browser start and render a page here?
    try {
      const { chromium } = await import("playwright");
      const { resolveExecutablePath } = await import("./browser.js");
      const browser = await chromium.launch({ headless: true, executablePath: resolveExecutablePath(cfg.browser) });
      const page = await browser.newPage();
      await page.setContent("<h1>takeone</h1>");
      await browser.close();
      say("headless launch", true, "Chromium starts and renders a page");
    } catch (e) {
      const msg = (e as Error).message.split("\n").slice(0, 3).join(" ");
      const missingLibs = /shared librar|error while loading|install-deps|dependencies/i.test(msg);
      say("headless launch", false, missingLibs && process.platform === "linux" ? `system libraries are missing. Run \`npx takeone setup --with-deps\` (needs sudo). ${msg}` : msg);
    }
    const ok = steps.every((s) => s.ok);
    console.log(ok ? "\nReady. Next: npx takeone do goto <url>" : "\nNot ready: fix the ✗ lines above and run setup again.");
    if (!ok) process.exitCode = 1;
  });

program
  .command("init")
  .description("Write an example scenario file")
  .argument("[file]", "file to create", "scenario.ts")
  .action((file: string) => {
    writeFileSync(
      resolve(file),
      `import { defineScenario } from "takeone";

export default defineScenario(
  {
    name: "demo",
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 2 },
    output: { width: 1920, height: 1080, fps: 60 },
    // browser: { storageState: "./state.json" },
  },
  async (s) => {
    await s.goto("http://localhost:3000");
    // Setup steps here are not recorded.
    await s.startRecording();
    await s.wait(600);
    await s.click("text=Get started");
    await s.type("input[name=email]", "hello@example.com", { wpm: 240 });
    await s.zoom("form", { scale: 1.6 });
    await s.wait(1200);
    await s.zoomOut();
    await s.stopRecording();
  },
);
`,
    );
    console.log(`Wrote ${resolve(file)}`);
  });

const GUIDE = `takeone in one screen

THE LOOP (no scenario file, no selectors, no probe scripts)
  takeone do goto http://localhost:3000/projects        # first command starts the browser
  takeone do click 6                                    # a number from the view below
  takeone do type 5 "acme-prod"
  takeone do wait-for "Deployed" --timeout 120000       # slow server step
  takeone do zoom 14                                    # camera only
  takeone do zoom-out
  takeone session export demo.ts              # replays the path to prove it, then writes it
  takeone record demo.ts                      # -> output.mp4

  Logged-in app: add --scenario <file with explore.setup> to the FIRST command. It logs in once.

SEEING THE PAGE
  \`takeone look\` and every \`takeone do\` that lands on a new page or opens a dialog print the VIEW:
  every element on screen, numbered, grouped by region (header, nav, sidebar, main, dialog),
  with what the markup says it does:
      12 link "Projects" → /projects [current]
      31 button "More" [icon ellipsis] (opens menu)
      40 switch "Email alerts" [off]
  and the path of a screenshot with the same numbers drawn on it (view: /tmp/takeone-view-…/007-step7.jpg).
  Open the screenshot when the text is not enough: icons, layout, what a chart shows.
  Off-screen content is summarised as its headings; \`scroll-to <n>\` or \`look --all\`.
  Other steps print only what changed: + new elements (with their numbers), - removed,
  ~ state changes, alerts, page errors (!). Numbers always refer to the latest view.

TARGETS
  12                       a number from the latest view (a control literally named "2": button:2)
  "new project"            plain words, best match wins; --nth 2 picks another; --role button narrows
  button:Create            role:name        text=Deployed     css=.monaco-editor     640,360
  The export never writes numbers: each becomes a role+name address that survives a replay.
  Several identical elements (three "Delete" buttons)? The error lists text that sets each apart.

EXPLORING VS RECORDING
  Click around freely. Steps that end up back where they started (open a menu, close it; visit
  a page, come back) are detours and are left out of the export automatically.
  takeone mark setup           unrecorded setup begins (get the app into the state the video starts from)
  takeone mark start           the recording begins; with no setup mark, everything before was looking around
  takeone journal              where each step landed    takeone journal drop 5-8 | keep 6 | setup 3 | clear

EXPORTING INTO AN EXISTING FILE
  Steps live between "// takeone:steps-begin" and "// takeone:steps-end". A re-export replaces only
  that block; config, helpers and login around it are kept. To add steps to a hand-written
  scenario (one with your login), put those two lines in its body and export into it.
  Setup steps use their own pair before startRecording(): "// takeone:setup-begin" / "// takeone:setup-end".
  Refused: no markers, hand-edited block, or --force on the file the session logged in from.
  takeone dry-run paces the page exactly like takeone record (pass there = pass in the recording); --fast does not.

WHEN SOMETHING FAILS
  The error shows the closest elements and what the page says (headings, alerts, text).
  "login page" or "not found" in that text means the wrong URL or no auth, not a wrong name.
  Nothing hangs: commands give up with a non-zero exit code. Do not wrap them in long timeouts.

MCP
  \`takeone mcp\` serves all of this as MCP tools (takeone_do, takeone_look, takeone_export, takeone_dry_run, takeone_record, …).
  Each reply carries the screenshot itself, so one call acts and shows the page.
  TRACEREEL_SESSION_PORT=9322 gives a second agent on the same machine its own browser.

THE LOOK (after the export works)
  Edit the exported file's config: viewport/deviceScaleFactor (capture), output (video size,
  fps), frame (padding, background, radius), cursor, zoom, keys. \`takeone render <dir>\` restyles
  an existing capture without recording again. For a sharp 4K output, capture at dpr 3.
  Waits play in real time unless wrapped: s.lapse(8, () => ...) or s.trim(() => ...).
`;

program
  .command("serve")
  .description("Start the TraceReel HTTP & live trace ingestion server for AI agent harnesses")
  .option("-p, --port <number>", "server port", "4100")
  .option("-h, --host <host>", "server host", "127.0.0.1")
  .option("--cdp <endpoint>", "default agent browser CDP port or URL (e.g. 9222 or http://127.0.0.1:9222)")
  .action(async (opts) => {
    const { startServer } = await import("./server.js");
    const port = parseInt(opts.port, 10);
    const host = opts.host;
    const cdpEndpoint = opts.cdp;
    await startServer({ port, host, cdpEndpoint });
  });

program
  .command("mcp")
  .description("Run takeone as a local MCP server over stdio. It launches Chrome itself; every step returns the numbered view and its screenshot")
  .action(async () => {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
  });

program
  .command("guide")
  .description("The whole agent workflow on one screen. Read this instead of the source")
  .action(() => console.log(GUIDE));

function progress(done: number, total: number) {
  process.stderr.write(`\r  frame ${done}/${total}`);
  if (done === total) process.stderr.write("\n");
}

// No discovery command may hang silently: a stuck page is a failure, reported as one.
const BUDGETS: Record<string, number> = { find: 60, explore: 120, look: 60 };
const budget = Number(process.env.TRACEREEL_BUDGET ?? process.env.TAKEONE_BUDGET ?? BUDGETS[process.argv[2] ?? ""] ?? 0);
if (budget > 0) {
  setTimeout(() => {
    console.error(`tracereel ${process.argv[2]} gave up after ${budget}s: the page never became ready. Raise with TRACEREEL_BUDGET=<seconds> if the app is really that slow.`);
    process.exit(124);
  }, budget * 1000).unref();
}

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
