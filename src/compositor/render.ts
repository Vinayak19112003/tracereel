import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { cpus } from "node:os";
import { chromium, type Browser } from "playwright";
import type { RecordingManifest, ScenarioConfig, UserScenarioConfig } from "../types.js";
import { resolveConfig, resolveCursorSize } from "../config.js";
import { ensureChromium, resolveExecutablePath } from "../browser.js";
import { spawnFfmpeg, runFfmpeg, resolveBestH264Encoder } from "../ffmpeg.js";
import { clamp } from "../motion.js";
import { compositorHtml } from "./page.js";
import { buildTimeline, cameraBusyWindows, outToSource, sourceToOutput, rateAtSource, planCamera, makeCameraEvaluator, extractCursor, planKeyToasts, type CameraKeyframe, type CameraState, type KeptRange } from "./plan.js";
import { planFrameInstructions, type FrameInstruction } from "./instructions.js";
import type { ScrollPlan } from "./scrollplan.js";
import { planReconstructionCamera } from "../reconstruct/shots.js";

export interface RenderOptions {
  /** Directory containing manifest.json and frames/. */
  recordingDir: string;
  /** Output file. Default <recordingDir>/output.<format>. */
  outFile?: string;
  /** Overrides on top of the config stored in the manifest (frame, cursor, zoom, output...). */
  config?: UserScenarioConfig;
  /** Also write a tiled keyframe sheet next to the video. Default true. */
  contactSheet?: boolean;
  log?: (msg: string) => void;
  onProgress?: (done: number, total: number) => void;
}

export interface RenderResult {
  outFile: string;
  contactSheet?: string;
  durationMs: number;
  frames: number;
}

export interface RenderCameraPlan {
  /** Source-time keyframes (also feeds the cut-protection windows). */
  keys: CameraKeyframe[];
  /** Camera state evaluated at OUTPUT time. */
  camAtOut: (tOut: number) => CameraState;
  /** QA warnings from the shot planner (empty for native). */
  warnings: string[];
}

/**
 * Source-time camera keyframes for a render, chosen by manifest mode.
 *
 * - native: the classic click-driven auto-zoom keys (unchanged behavior).
 * - reconstructed: shot-level planning (see ../reconstruct/shots.ts).
 *
 * Split from makeCamAtOut because buildTimeline needs the keys before the
 * output-time ranges exist.
 */
export function planCameraKeys(
  manifest: RecordingManifest,
  cfg: ScenarioConfig,
): { keys: CameraKeyframe[]; warnings: string[] } {
  if (manifest.mode === "reconstructed") {
    const { keys, audit } = planReconstructionCamera(manifest, cfg);
    return { keys, warnings: audit.warnings };
  }
  return { keys: planCamera(manifest, cfg), warnings: [] };
}

/**
 * Camera state evaluated at OUTPUT time.
 *
 * - native: wraps the source-time evaluator by mapping each output frame back to its
 *   source time — exactly what the old inline code did.
 * - reconstructed: keyframes are mapped to output time first — both start times AND
 *   durations (divided by the local time-lapse rate), so a move plays at the same speed
 *   as the action it was choreographed with under trimming and time-lapse.
 */
export function makeCamAtOut(
  manifest: RecordingManifest,
  cfg: ScenarioConfig,
  ranges: KeptRange[],
  keys: CameraKeyframe[],
): (tOut: number) => CameraState {
  const vw = manifest.viewport.width, vh = manifest.viewport.height;
  if (manifest.mode === "reconstructed") {
    const outKeys = keys.map((k) => ({
      ...k,
      t: sourceToOutput(ranges, k.t),
      duration: k.duration / rateAtSource(ranges, k.t),
    }));
    return makeCameraEvaluator(outKeys, vw, vh);
  }
  const nativeAt = makeCameraEvaluator(keys, vw, vh);
  return (tOut: number) => nativeAt(outToSource(ranges, tOut));
}

/** Convenience for tests: keys plus the output-time evaluator in one call. */
export function planRenderCamera(
  manifest: RecordingManifest,
  cfg: ScenarioConfig,
  ranges: KeptRange[],
): RenderCameraPlan {
  const { keys, warnings } = planCameraKeys(manifest, cfg);
  return { keys, camAtOut: makeCamAtOut(manifest, cfg, ranges, keys), warnings };
}

/**
 * Render the final video: background frame, camera zoom, synthetic cursor, click ripples,
 * idle trimming. Deterministic and re-runnable with different looks.
 */
export async function renderRecording(opts: RenderOptions): Promise<RenderResult> {
  const log = opts.log ?? (() => {});
  const dir = resolve(opts.recordingDir);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`No manifest.json in ${dir}`);
  const manifest: RecordingManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const cfg: ScenarioConfig = resolveConfig(manifest.config, opts.config);
  const { width: W, height: H, fps } = cfg.output;
  const outFile = resolve(opts.outFile ?? join(dir, `output.${cfg.output.format}`));
  mkdirSync(dirname(outFile), { recursive: true });
  if (!manifest.frames.length) throw new Error("Recording has no frames. Did the scenario call startRecording() and do something visible?");

  // ---- Plan every frame up front (cheap, and lets workers be stateless) ----
  const vw = manifest.viewport.width, vh = manifest.viewport.height;
  const { keys: cameraKeys, warnings: cameraWarnings } = planCameraKeys(manifest, cfg);
  for (const w of cameraWarnings) log(`camera: ${w}`);
  // Cuts must not land inside a camera move, so the timeline is built knowing where they are.
  const { ranges, outDuration } = buildTimeline(manifest, cfg, cameraBusyWindows(cameraKeys));
  const totalFrames = Math.max(1, Math.ceil((outDuration / 1000) * fps));
  const camAtOut = makeCamAtOut(manifest, cfg, ranges, cameraKeys);
  const { samples, downs } = extractCursor(manifest.events);
  const keyToasts = planKeyToasts(manifest.events, cfg);

  const pad = cfg.frame.padding;
  const availW = W - 2 * pad, availH = H - 2 * pad;
  const aspect = vw / vh;
  let cw = availW, ch = availW / aspect;
  if (ch > availH) { ch = availH; cw = availH * aspect; }
  const content = { x: (W - cw) / 2, y: (H - ch) / 2, w: cw, h: ch };

  const instructions = planFrameInstructions({
    frames: manifest.frames,
    fps,
    ranges,
    totalFrames,
    camAtOut,
    samples,
    downs,
    keyToasts,
    captions: manifest.captions,
    content,
    vw,
    W,
    H,
    cfg,
    transitionMs: cfg.transition.duration,
  });

  // ---- Scroll-compositing pre-pass: analyze each unique timed scroll once ----
  // Measures the true document displacement and partitions the frame into
  // document/fixed/sticky regions + scrollbar, so parallel workers can render
  // the layer compositing statelessly from the serialized plan.
  await analyzeScrollPlans(dir, instructions, cfg, log);

  // ---- Render in parallel workers, each encoding its own segment ----
  const workers = clamp(cfg.output.workers ?? Math.min(6, cpus().length - 2), 1, 16);
  const perWorker = Math.ceil(totalFrames / workers);
  const chunks: [number, number][] = [];
  for (let s = 0; s < totalFrames; s += perWorker) chunks.push([s, Math.min(totalFrames, s + perWorker)]);
  log(`Rendering ${totalFrames} frames at ${W}x${H}@${fps} (${(outDuration / 1000).toFixed(1)}s) with ${chunks.length} worker${chunks.length > 1 ? "s" : ""}`);

  ensureChromium(cfg.browser);
  const segDir = join(dir, ".segments");
  rmSync(segDir, { recursive: true, force: true });
  mkdirSync(segDir, { recursive: true });
  const bg = cfg.frame.background;
  const bgImage = typeof bg === "object" ? "/bg/" + encodeURIComponent(isAbsolute(bg.image) ? bg.image : resolve(bg.image)) : undefined;
  const setup = {
    width: W, height: H,
    background: typeof bg === "string" ? bg : "#000",
    backgroundImage: bgImage,
    backgroundFit: typeof bg === "object" ? bg.fit : undefined,
    viewport: { width: vw, height: vh },
    shadow: cfg.frame.shadow, borderRadius: cfg.frame.borderRadius, cursor: { ...cfg.cursor, size: resolveCursorSize(cfg.cursor.size, H) },
    keys: { ...cfg.keys, fontSize: cfg.keys.fontSize * (H / 1080) },
    content,
  };
  const lossless = cfg.output.lossless;
  const isWebm = cfg.output.format === "webm";
  const bestH264 = isWebm ? null : resolveBestH264Encoder(cfg.output.crf);
  if (bestH264?.isHardware) log(`Using hardware encoder: ${bestH264.description}`);
  const encoderArgs = isWebm
    ? ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(cfg.output.crf), "-row-mt", "1", "-threads", "2"]
    : bestH264!.args;

  const start = Date.now();
  let done = 0;
  const report = () => opts.onProgress?.(done, totalFrames);
  const segments = await Promise.all(
    chunks.map(async ([from, to], idx) => {
      const segFile = join(segDir, `seg-${String(idx).padStart(3, "0")}.${cfg.output.format}`);
      const browser = await chromium.launch({ headless: true, executablePath: resolveExecutablePath(cfg.browser), args: ["--hide-scrollbars"] });
      try {
        const page = await openCompositorPage(browser, dir, setup);
        const ff = spawnFfmpeg(["-f", "image2pipe", "-vcodec", lossless ? "png" : "mjpeg", "-framerate", String(fps), "-i", "-", ...encoderArgs, "-r", String(fps), segFile]);
        for (let i = from; i < to; i++) {
          const ins = instructions[i];
          const b64: string = await page.evaluate(
            ({ ins, lossless }) => (window as any).__render(ins, lossless),
            { ins, lossless },
          );
          await ff.write(Buffer.from(b64, "base64"));
          done++;
          if (done % 30 === 0) report();
        }
        await ff.end();
        await ff.done;
      } finally {
        await browser.close().catch(() => {});
      }
      return segFile;
    }),
  );
  report();

  if (segments.length === 1) {
    await runFfmpeg(["-i", segments[0], "-c", "copy", "-movflags", "+faststart", outFile]);
  } else {
    const list = join(segDir, "list.txt");
    writeFileSync(list, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", ...(isWebm ? [] : ["-movflags", "+faststart"]), outFile]);
  }
  rmSync(segDir, { recursive: true, force: true });
  const took = Date.now() - start;
  log(`Encoded ${totalFrames} frames in ${(took / 1000).toFixed(1)}s (${(totalFrames / (took / 1000)).toFixed(1)} fps) -> ${outFile}`);

  let contactSheet: string | undefined;
  if (opts.contactSheet !== false) {
    contactSheet = join(dirname(outFile), "output-keyframes.jpg");
    const secs = outDuration / 1000;
    const every = Math.max(1, Math.round(secs / 12));
    const tiles = Math.max(1, Math.ceil(secs / every));
    const cols = Math.min(4, tiles);
    await runFfmpeg([
      "-i", outFile, "-vf", `fps=1/${every},scale=480:-1,tile=${cols}x${Math.ceil(tiles / cols)}`,
      "-frames:v", "1", "-q:v", "4", contactSheet,
    ]).catch((e) => log(`Keyframe sheet failed: ${e.message}`));
  }
  return { outFile, contactSheet, durationMs: outDuration, frames: totalFrames };
}

async function openCompositorPage(browser: Browser, dir: string, setup: Record<string, unknown>) {
  const framesDir = join(dir, "frames");
  const page = await browser.newPage({ viewport: { width: setup.width as number, height: setup.height as number }, deviceScaleFactor: 1 });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/frames/")) {
      const file = join(framesDir, url.pathname.slice("/frames/".length));
      return route.fulfill({ body: readFileSync(file), contentType: file.endsWith(".png") ? "image/png" : "image/jpeg" });
    }
    if (url.pathname === "/") return route.fulfill({ body: compositorHtml, contentType: "text/html" });
    if (url.pathname.startsWith("/bg/")) return route.fulfill({ body: readFileSync(decodeURIComponent(url.pathname.slice(4))) });
    return route.abort();
  });
  await page.goto("http://takeone.local/");
  await page.evaluate((c) => (window as any).__setup(c), setup);
  // Rasterise the CSS background (gradient or image) once and hand it to the canvas as a layer.
  await page.evaluate(() => (window as any).__showCanvas(false));
  if (setup.backgroundImage) await page.waitForLoadState("networkidle").catch(() => {});
  const cdp = await page.context().newCDPSession(page);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await cdp.detach();
  await page.evaluate((d) => (window as any).__setBackground(d), "data:image/png;base64," + shot.data);
  await page.evaluate(() => (window as any).__showCanvas(true));
  return page;
}

/**
 * Scroll-compositing pre-pass. For each unique timed scroll (previousFile ->
 * file), runs the deterministic pixel analysis once in a headless page and
 * attaches the resulting ScrollPlan to every instruction of that scroll.
 * Workers stay stateless: they just execute the serialized plan.
 */
export interface ScrollTransition {
  aFile: string;
  bFile: string;
  dx: number;
  dy: number;
}

/**
 * Collect the unique timed-scroll transitions scrollplan must analyze.
 * Dense real-frame intervals never appear here: they play as cuts
 * (transitionIn "cut"), never as timed slides, so isScroll is never set for
 * them. This is the exact predicate analyzeScrollPlans uses — kept as a pure
 * function so tests can assert the dense path stays scrollplan-free.
 */
export function collectScrollTransitions(
  instructions: FrameInstruction[],
): Map<string, ScrollTransition> {
  const scrolls = new Map<string, ScrollTransition>();
  for (const ins of instructions) {
    if (ins.isScroll && ins.previousFile && ins.mix != null && ins.mix < 1) {
      const key = `${ins.previousFile}>${ins.file}`;
      if (!scrolls.has(key)) {
        // ins.slide is in base-uiScale pixels; ins.uiScale includes the
        // camera sqrt(scale) factor. Divide it out to get viewport pixels.
        const baseUiScale = ins.uiScale / Math.sqrt(ins.cam.scale);
        scrolls.set(key, {
          aFile: ins.previousFile,
          bFile: ins.file,
          dx: (ins.slide?.x ?? 0) / baseUiScale,
          dy: (ins.slide?.y ?? 0) / baseUiScale,
        });
      }
    }
  }
  return scrolls;
}

async function analyzeScrollPlans(
  dir: string,
  instructions: FrameInstruction[],
  cfg: ScenarioConfig,
  log: (msg: string) => void,
): Promise<void> {
  const scrolls = collectScrollTransitions(instructions);
  if (!scrolls.size) return;
  log(`Analyzing ${scrolls.size} scroll transition(s) for layer compositing...`);
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveExecutablePath(cfg.browser),
    args: ["--hide-scrollbars"],
  });
  try {
    const framesDir = join(dir, "frames");
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/frames/")) {
        const file = join(framesDir, url.pathname.slice("/frames/".length));
        return route.fulfill({
          body: readFileSync(file),
          contentType: file.endsWith(".png") ? "image/png" : "image/jpeg",
        });
      }
      if (url.pathname === "/") return route.fulfill({ body: compositorHtml, contentType: "text/html" });
      return route.abort();
    });
    await page.goto("http://takeone.local/");
    const plans = new Map<string, ScrollPlan>();
    for (const [key, s] of scrolls) {
      const plan = (await page.evaluate(
        ({ aFile, bFile, dx, dy }) => (window as any).__analyzeScroll(aFile, bFile, dx, dy),
        s,
      )) as ScrollPlan;
      plans.set(key, plan);
      for (const w of plan.warnings ?? []) log(`scroll ${s.aFile}>${s.bFile}: ${w}`);
      log(
        `scroll ${s.aFile}>${s.bFile}: measured=(${plan.mx},${plan.my}) ` +
        `declared=(${s.dx.toFixed(1)},${s.dy.toFixed(1)}) conf=${(plan.confidence ?? 0).toFixed(2)}` +
        (plan.useMeasured ? "" : " (using declared)"),
      );
    }
    for (const ins of instructions) {
      if (ins.isScroll && ins.previousFile) {
        const plan = plans.get(`${ins.previousFile}>${ins.file}`);
        if (plan) ins.scrollPlan = plan;
      }
    }
  } finally {
    await browser.close();
  }
}
