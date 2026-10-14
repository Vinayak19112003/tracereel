export { defineScenario, withExplore, type Scenario, type ExplorePlan, type ExplorePage } from "./scenario.js";
export { exploreScenario, type ExploreOptions, type ExploreResult, type ExplorePageSpec } from "./runner/explore.js";
export { collectInventory, type InventoryElement, type InventoryPage, type InventoryBundle } from "./inventory.js";
export {
  indexFromPages,
  findEntry,
  pagesWithHandle,
  samePage,
  resolveRoleTarget,
  findAllRoleTargets,
  addressOf,
  targetOf,
  suggestedTarget,
  normalizeIndex,
  type AvrIndex,
  type RoleTarget,
  type IndexEntry,
  type Match,
  DEFAULT_INDEX_PATH,
} from "./resolver.js";
export { recordScenario, dryRunScenario, type RecordOptions, type RecordResult, type DryRunOptions, type DryRunResult } from "./runner/index.js";
export { Session, type Target, type ClickOptions, type MoveOptions, type TypeOptions, type ScrollOptions, type ZoomOptions } from "./runner/session.js";
export { renderRecording, collectScrollTransitions, type RenderOptions, type RenderResult, type ScrollTransition } from "./compositor/render.js";
export { defaultConfig, resolveConfig, RECONSTRUCTION_DEFAULTS } from "./config.js";
export * from "./types.js";
export {
  planReconstructionCamera,
  planShots,
  shotsToKeyframes,
  groupFocusEvents,
  extractFocusEvents,
  optimizeCameraKeys,
  auditCameraPlan,
  shotBusyWindows,
  type FocusEvent,
  type CameraPlanAudit,
} from "./reconstruct/shots.js";
export {
  buildReconstructionManifest,
  writeReconstructionDir,
  RECONSTRUCTION_SOURCE_TYPES,
  type ReconstructionInput,
  type ReconstructionFrame,
  type ReconstructionAction,
  type ReconstructionClick,
  type ReconstructionType,
  type BuildReconstructionOptions,
} from "./reconstruct/build.js";
// TraceReel Trace v1: the versioned, agent-neutral capture protocol.
export {
  TRACE_FORMAT_VERSION,
  type TraceReelTrace,
  type TraceSource,
  type TraceViewport,
  type AgentCapabilities,
  type AgentState,
  type AgentAction,
  type StateTransition,
  type TraceVideoSegment,
  type TraceTimeline,
  type RedactionRegion as TraceRedactionRegion,
} from "./trace/types.js";
// Adapters: one per agent. The renderer never sees agent identity.
export {
  MuseAdapter,
  GrokbotAdapter,
  GenericAdapter,
  getAdapter,
  listAdapters,
  pickAdapter,
  normalizeTrace,
  TraceReelError,
  type TraceReelAdapter,
  type NormalizedTrace,
} from "./adapters/index.js";
export { traceToReconstructionInput, statesToFrames, assertRequireSource } from "./adapters/normalize.js";
export {
  MUSE_CAPABILITIES,
  GROKBOT_CAPABILITIES,
  GENERIC_CAPABILITIES,
  CAPABILITY_DESCRIPTIONS,
} from "./capabilities.js";
// Portable capture bundles: <name>.tracereel/
export {
  writeBundle,
  loadBundle,
  isBundleDir,
  traceScreenshotFiles,
  traceSegmentFiles,
  traceNarrationFiles,
  traceMusicFiles,
  BUNDLE_SUFFIX,
  SEGMENTS_DIR,
  FRAMES_DIR,
  AUDIO_DIR,
  NARRATION_DIR,
  MUSIC_DIR,
  type BundleMetadata,
  type LoadedBundle,
} from "./bundle.js";
// Small TypeScript SDK: import { TraceBuilder } from "tracereel";
export { TraceBuilder } from "./sdk.js";
// Managed real-frame capture: validation, QA, and the scroll capture planner.
export {
  isDenseFrame,
  detectDenseRuns,
  visualSourceForFrames,
  denseRunEnclosingAction,
  validateRealFrameMetadata,
  validateRealFrameSequence,
  qaRealFrameCapture,
  type DenseRun,
  type RealFrameIssue,
} from "./reconstruct/realframes.js";
export {
  planScrollCaptures,
  TAKEONE_DEFAULT_EASING,
  type ScrollCaptureTarget,
} from "./reconstruct/scroll-capture-plan.js";
export type {
  TraceBuilderOptions,
  StateOptions,
  NarrationOptions,
  MusicOptions,
  ClickOptions as TraceClickOptions,
  TypeOptions as TraceTypeOptions,
  ScrollOptions as TraceScrollOptions,
  HoverOptions as TraceHoverOptions,
  WaitOptions as TraceWaitOptions,
} from "./sdk.js";
export * from "./audio/index.js";

// Backend enhancements: spring physics, hardware encoder detection, CDP agent attachment, and server
export { criticallyDampedSpring, continuousSpringPath } from "./motion.js";
export { resolveBestH264Encoder, type EncoderInfo } from "./ffmpeg.js";
export { connectToCdp } from "./browser.js";
export { TraceReelServer, startServer, type ServerOptions, type RenderJob } from "./server.js";
