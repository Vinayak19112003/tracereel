/**
 * Public configuration and event types.
 */

export type EasingName = "linear" | "smooth" | "snappy" | "spring" | "easeOut" | "easeIn";
export type Easing = EasingName | [number, number, number, number];

export interface ViewportConfig {
  /** CSS pixel width of the browser viewport. Default 1920. */
  width: number;
  /** CSS pixel height of the browser viewport. Default 1080. */
  height: number;
  /** Device scale factor. 2 gives a crisp "retina" capture and headroom for zoom. Default 2. */
  deviceScaleFactor: number;
}

export interface OutputConfig {
  /** Output video width in pixels. Default 1920. */
  width: number;
  /** Output video height in pixels. Default 1080. */
  height: number;
  /** Output frames per second. Default 60. */
  fps: number;
  /** Container/codec. Default mp4 (H.264). */
  format: "mp4" | "webm";
  /** Constant rate factor for the encoder. Lower is better quality. Default 18. */
  crf: number;
  /** Use lossless PNG intermediates between compositor and encoder. Slower. Default false (JPEG q95). */
  lossless: boolean;
  /** Parallel render workers (browser processes). Default: CPU count minus 2, capped at 6. */
  workers?: number;
}

export interface ShadowConfig {
  blur: number;
  offsetY: number;
  color: string;
}

export interface FrameConfig {
  /** Padding around the browser content, in output pixels. Default 96. */
  padding: number;
  /** CSS color, gradient, or `{ image: "path" }`. Default a soft gradient. */
  background: string | { image: string; fit?: "cover" | "contain" };
  /** Corner radius of the browser content, in output pixels. Default 16. */
  borderRadius: number;
  /** Drop shadow behind the content. `false` disables. */
  shadow: ShadowConfig | false;
}

export type CursorSizePreset = "small" | "default" | "large" | "xl";
export type CursorSpeedPreset = "slow" | "normal" | "fast";

export interface CursorConfig {
  /** Draw a synthetic cursor in post. Default true. */
  enabled: boolean;
  /**
   * Cursor size. A preset (`small` 24, `default` 36, `large` 48, `xl` 64) or an explicit height in
   * output pixels at 1080p; scales with the output resolution. Default "default".
   */
  size: CursorSizePreset | number;
  /** Cursor style. */
  style: "arrow" | "dot";
  /** Draw an expanding ring on clicks. Default true. */
  clickRipple: boolean;
  /** Shrink the cursor slightly while the button is held. Default true. */
  clickScale: boolean;
  /** Cursor colour for the `dot` style / accent. */
  color: string;
}

export interface ZoomConfig {
  /** Zoom automatically toward clicks and typing targets. Default true. */
  auto: boolean;
  /** Scale used by automatic zooms. Default 1.6. */
  autoScale: number;
  /** How long an automatic zoom stays after the last interaction before easing out, in ms. Default 1500. */
  autoHold: number;
  /** How far ahead of a click the automatic zoom starts, in ms, so the camera is already in when the click lands. Default 600. */
  autoLead: number;
  /** Default transition duration for zoom moves, in ms. Default 700. */
  duration: number;
  /** Default easing for zoom moves. */
  easing: Easing;
  /** Maximum allowed scale. Default 3. */
  maxScale: number;
  /** Margin, as a fraction of the viewport, kept around an element when zooming onto it. Default 0.12. */
  margin: number;
  /** Keep the cursor in view by panning while zoomed. Default true. */
  followCursor: boolean;
}

/**
 * Tuning for reconstructed recordings (mode: "reconstructed"): sparse screenshots plus
 * synthetic cursor/click/key events, where the camera philosophy is SHOT = CAMERA MOVE
 * instead of CLICK = CAMERA MOVE. Several related interactions share one settled camera
 * shot; the camera only moves when the next important target leaves the current shot's
 * useful visual region.
 */
export interface ReconstructionConfig {
  /**
   * Two interactions belong to the same camera shot when they happen within this many ms
   * of each other AND their targets are visually nearby. Separate from how long a shot
   * holds after its final interaction. Default 3000.
   */
  groupGap: number;
  /** Routine zoom scale for single-target shots. High zoom is reserved for genuinely small UI. Default 1.35. */
  routineScale: number;
  /** How long the camera takes to move into a shot, in output ms. Default 900. */
  transitionMs: number;
  /** How long before an interaction the camera must already be settled, in ms. Default 200. */
  settleMs: number;
  /** How long a shot holds after its final interaction before releasing to overview, in ms. Default 2000. */
  releaseMs: number;
}

/**
 * Screenshot-to-screenshot transition tuning. The crossfade is measured in output
 * (final video) ms so it stays correct under trimming and time-lapse.
 */
export interface TransitionConfig {
  /** Crossfade duration after a screenshot cut, in output ms. Default 240. */
  duration: number;
}

export interface MotionConfig {
  /** Cursor travel speed: a preset (`slow` 0.6, `normal` 0.9, `fast` 1.6 CSS px per ms) or a number. Default "normal". */
  cursorSpeed: CursorSpeedPreset | number;
  /** Minimum cursor travel duration in ms. Default 350. */
  minMoveDuration: number;
  /** Maximum cursor travel duration in ms. Default 1600. */
  maxMoveDuration: number;
  /** Cursor path easing. */
  easing: Easing;
  /** How long the mouse button is held on a click, in ms. Default 90. */
  clickHold: number;
  /** Default typing speed in words per minute. Default 220. */
  wpm: number;
  /** Random variation of per-key delay, 0 to 1. Default 0.35. */
  typingJitter: number;
  /** Default scroll duration in ms. Default 600. */
  scrollDuration: number;
}

/**
 * How a wait appears in the finished video.
 * - `"keep"` (default): shown in full, real time. Waiting is the default so a slow step
 *   such as provisioning is visible rather than silently cut.
 * - `"trim"`: shortened to `idleTrim.keep`.
 * - a number: time-lapse, played that many times faster (`8` = 8x).
 */
export type WaitEdit = "trim" | "keep" | number;

export interface IdleTrimConfig {
  /**
   * Master switch for trimming. Waits play in real time by default; this only governs
   * waits that explicitly ask to be trimmed with `edit: "trim"`. Default true.
   */
  enabled: boolean;
  /** Idle stretches longer than this (ms) are shortened. Default 1500. */
  threshold: number;
  /** What an idle stretch is shortened to, in ms. Default 600. */
  keep: number;
  /**
   * Never cut inside a camera animation. A cut that overlaps a zoom would otherwise jump
   * the camera mid-move, which reads as a broken zoom. Default true.
   */
  protectCamera: boolean;
}

export interface BrowserConfig {
  /** Path to a Chromium/Chrome executable. Defaults to the Playwright-managed Chromium. */
  executablePath?: string;
  /** Attach directly to an already-running AI agent browser session via CDP (port or URL). */
  cdp?: string | number;
  /** Run with a visible window (only useful on machines with a display). Default false. */
  headless: boolean;
  /** Playwright storage state (cookies, localStorage, IndexedDB) file or object. */
  storageState?: string;
  /** Persistent user data directory. Enables a real profile with extensions and all storage. */
  userDataDir?: string;
  /** Extra Chromium args. */
  args?: string[];
  /** Locale, timezone, colour scheme passthrough. */
  locale?: string;
  timezoneId?: string;
  colorScheme?: "light" | "dark";
  /** Default timeout for locators and navigation in ms. Default 15000. */
  timeout: number;
  /** Rewrite target=_blank links so navigation stays in the recorded tab. Default true. */
  sameTabLinks: boolean;
}

export interface CaptureConfig {
  /** Image format for raw captured frames. jpeg is much faster at high resolutions. Default jpeg. */
  format: "jpeg" | "png";
  /** JPEG quality 0-100. Default 92. */
  quality: number;
}

export interface KeysConfig {
  /**
   * Which key presses get an on-screen overlay.
   * `shortcuts`: chords and special keys from press() only. `all`: also typed text.
   * `manual`: only steps that pass `showKeys: true`. `off`: never.
   */
  mode: "shortcuts" | "all" | "manual" | "off";
  /** How long a shortcut stays visible after the last key, ms. Default 1200. */
  hold: number;
  /** Typed characters closer together than this join one pill, ms. Default 900. */
  gap: number;
  /** Glyph style: ⌘ ⌥ ⌃ ⇧ for mac, Ctrl/Alt/Win for windows. Default mac. */
  platform: "mac" | "windows";
  /** Vertical placement. Default bottom. */
  position: "bottom" | "top";
  /** Distance from the frame edge as a fraction of output height. Default 0.1. */
  offset: number;
  /** Font size in output px at 1080p. Default 30. */
  fontSize: number;
}

export interface ExploreConfig {
  /** Where `takeone explore` writes the inventory index. Default ".takeone/inventory.json". */
  index: string;
  /** Max elements to inventory per page. Default 250. */
  max: number;
  /** Scroll the page while inventorying so off-screen elements are included. Default true. */
  scroll: boolean;
}

export interface DryRunConfig {
  /** Scale screenshots down by this factor for cheaper contact sheets. Default 0.5. */
  scale: number;
  /** Emit a single contact sheet image. Default true. */
  contactSheet: boolean;
  /** Columns in the contact sheet. Default 3. */
  columns: number;
}

export interface ScenarioConfig {
  /** Human readable name, used for the output folder. */
  name?: string;
  viewport: ViewportConfig;
  output: OutputConfig;
  frame: FrameConfig;
  cursor: CursorConfig;
  zoom: ZoomConfig;
  /** Camera tuning for reconstructed recordings. Only used when the manifest mode is "reconstructed". */
  reconstruction: ReconstructionConfig;
  /** Screenshot-to-screenshot crossfade tuning. */
  transition: TransitionConfig;
  motion: MotionConfig;
  idleTrim: IdleTrimConfig;
  browser: BrowserConfig;
  capture: CaptureConfig;
  keys: KeysConfig;
  dryRun: DryRunConfig;
  explore: ExploreConfig;
  /** Path to the inventory index used to resolve @eNN handles. Default ".takeone/inventory.json". */
  indexPath?: string;
}

/** Deep partial helper for user-facing config. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object
      ? T[K] extends Function
        ? T[K]
        : DeepPartial<T[K]>
      : T[K];
};

export type UserScenarioConfig = DeepPartial<ScenarioConfig>;

// ---------------------------------------------------------------------------
// Event log (written by the runner, consumed by the compositor)
// ---------------------------------------------------------------------------

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

export interface CameraTarget {
  /** Centre of the camera in viewport CSS px. */
  cx: number;
  cy: number;
  scale: number;
}

export type RecordedEvent =
  | { type: "mouse"; t: number; x: number; y: number }
  | { type: "mousedown"; t: number; x: number; y: number; button: string }
  | { type: "mouseup"; t: number; x: number; y: number; button: string }
  | { type: "key"; t: number; key: string; x?: number; y?: number; source?: "press" | "type"; show?: boolean }
  | { type: "scroll"; t: number; dx: number; dy: number }
  | { type: "hover"; t: number; x: number; y: number }
  | { type: "zoom"; t: number; target: CameraTarget; duration: number; easing: Easing; follow?: boolean; source: "manual" | "auto" }
  | { type: "zoomOut"; t: number; duration: number; easing: Easing; source: "manual" | "auto" }
  | { type: "autoZoomOff"; t: number }
  | { type: "autoZoomOn"; t: number }
  | { type: "idle"; t: number; end: number; reason: string; edit?: WaitEdit }
  | { type: "step"; t: number; name: string; detail?: string }
  | { type: "recording"; t: number; state: "start" | "pause" | "resume" | "stop" };

export interface FrameIndexEntry {
  /** Time in ms relative to recording origin. */
  t: number;
  /** File name inside the frames directory. */
  file: string;
  /**
   * How the video arrives at this frame from the previous one (reconstructed
   * recordings). Default "crossfade". "cut" is instant; a slide moves the old
   * screenshot by (dx, dy) source px while the new one fades in — used for
   * scrolls so the direction of movement reads on screen.
   *
   * When `durationMs` is present, the transition is a true scroll: it lasts
   * `durationMs` (not the generic transition duration), BOTH screenshots
   * translate so overlapping content stays aligned (old moves by (dx, dy),
   * new enters from -(dx, dy)), and no crossfade is applied. This is how
   * scroll actions are reconstructed; plain `{kind:"slide",dx,dy}` without
   * `durationMs` keeps the legacy crossfade nudge for backwards compatibility.
   */
  transitionIn?: "crossfade" | "cut" | { kind: "slide"; dx: number; dy: number; durationMs?: number };
}

/**
 * One settled camera shot in a reconstructed recording. A shot may cover several related
 * interactions; the camera moves once into the shot and stays there until the story needs
 * a different visual region. Times are ms on the source timeline.
 */
export interface CameraShot {
  /** Source ms: the camera begins moving toward this shot. */
  start: number;
  /** Source ms: the shot ends; the camera may move on (or release to overview). */
  end: number;
  /** Shot centre in viewport CSS px. */
  cx: number;
  cy: number;
  /** Shot scale. */
  scale: number;
  /** Move duration into this shot, in output ms. Defaults to the reconstruction config. */
  transitionDuration?: number;
  /** Easing into this shot. Defaults to the zoom config easing. */
  easing?: Easing;
}

export type RecordingMode = "native" | "reconstructed";

/**
 * Which visual path produced a manifest's page pixels. Explicit and
 * inspectable — TraceReel never silently switches between paths.
 */
export type VisualSource =
  /** Every page pixel comes from a real captured screenshot (dense real-frame intervals). */
  | "managed-real-frames"
  /** Sparse screenshots plus synthetic transitions (the fallback path). */
  | "reconstructed-sparse"
  /** Some intervals are real frames, others reconstructed. */
  | "mixed";

/**
 * Where reconstruction screenshots were captured. This is provenance metadata only:
 * TakeOne cannot cryptographically prove a PNG's source, but recording it here makes
 * an accidental capture fallback detectable in the manifest and in agent logs.
 *
 * "muse-managed-browser": Muse's currently active managed/main browser session, with
 * its real cookies, login state and page state. This is the default capture source
 * for the Muse reconstruction workflow: footage must come from the browser Muse is
 * already driving, never from a fresh browser launched to recreate the page.
 * "external-browser": some other browser session the operator controls.
 * "manual-screenshots": screenshots captured by hand or by an unknown pipeline.
 */
export type ReconstructionSourceType =
  | "agent-browser"
  | "muse-managed-browser"
  | "external-browser"
  | "manual-screenshots";

export interface ReconstructionSource {
  type: ReconstructionSourceType;
  /** Which session the screenshots came from, e.g. "main". */
  session?: string;
  /**
   * What captured the screenshots, e.g. "muse". Declarative, not verified:
   * nothing in a PNG proves which tool wrote it.
   */
  captureTool?: string;
  /**
   * Which agent's trace this is, e.g. "muse", "grokbot". Only meaningful for
   * source.type "agent-browser"; the renderer ignores it (agent identity
   * never changes the output).
   */
  agent?: string;
  /** ISO 8601 timestamp of the capture session, e.g. "2026-09-27T10:00:00+05:30". */
  capturedAt?: string;
  /** Viewport the screenshots were captured at; should match the input viewport. */
  viewport?: { width: number; height: number };
  /** Free-form note, e.g. how the screenshots were materialized. */
  note?: string;
}

export interface RecordingManifest {
  version: 1;
  /**
   * "native" (default): captured by TakeOne's own browser; camera follows the classic
   * click-driven auto-zoom. "reconstructed": sparse screenshots plus synthetic events
   * (e.g. from a managed browser TakeOne cannot attach to); the camera is planned in
   * settled shots that each cover several related interactions.
   */
  mode?: RecordingMode;
  /**
   * Which visual path produced this manifest's page pixels. Explicit and
   * inspectable — TraceReel never silently switches between paths:
   * - "managed-real-frames": every page pixel comes from a real captured
   *   screenshot (dense real-frame intervals; scrollplan/NCC/B-strip and
   *   synthetic document translation are never invoked for these intervals).
   * - "reconstructed-sparse": sparse screenshots plus synthetic transitions
   *   (the fallback path; existing behavior, unchanged).
   * - "mixed": some intervals are real frames, others reconstructed.
   * Optional for backwards compatibility; `tracereel reconstruct` always sets
   * it and prints it as "Visual source: ...".
   */
  visualSource?: VisualSource;
  /**
   * Capture provenance for reconstructed recordings. Preserved verbatim from the
   * reconstruction input; never affects rendering, only documents where the
   * screenshots came from.
   */
  source?: ReconstructionSource;
  createdAt: string;
  config: ScenarioConfig;
  /** CSS viewport size the page was rendered at. */
  viewport: ViewportConfig;
  /** Actual pixel size of the captured frames. */
  frameSize: { width: number; height: number };
  frames: FrameIndexEntry[];
  events: RecordedEvent[];
  /** Total wall-clock duration of the capture, ms. */
  duration: number;
  /**
   * Explicit camera shots for reconstructed recordings. When present (and mode is
   * "reconstructed"), the shot planner is skipped and these are used directly.
   */
  shots?: CameraShot[];
  /**
   * Optional narrative captions, drawn as a fixed pill at the bottom of the
   * screen (unaffected by the camera), like the key HUD. Times are ms on the
   * source timeline.
   */
  captions?: { start: number; end: number; text: string }[];
}
