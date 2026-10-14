import { chromium, type Browser, type BrowserContext } from "playwright";
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { BrowserConfig, ViewportConfig } from "./types.js";

export function resolveExecutablePath(cfg: BrowserConfig): string | undefined {
  const fromEnv = process.env.TRACEREEL_CHROMIUM_PATH ?? process.env.TAKEONE_CHROMIUM_PATH;
  const p = cfg.executablePath ?? fromEnv;
  if (p) {
    if (!existsSync(p)) throw new Error(`Chromium executable not found at ${p}`);
    return p;
  }
  return undefined;
}

/** Make sure the Playwright-managed Chromium exists, downloading it if needed. */
export function ensureChromium(cfg: BrowserConfig, log: (s: string) => void = () => {}) {
  // If we are connecting to an existing AI agent browser via CDP, no Chromium download is required
  if (cfg.cdp || process.env.TRACEREEL_CDP_URL || process.env.CDP_URL) return;
  if (resolveExecutablePath(cfg)) return;
  const managed = chromium.executablePath();
  if (managed && existsSync(managed)) return;
  log("Chromium not found, downloading via Playwright (one time)...");
  const res = spawnSync(process.execPath, [playwrightCli(), "install", "chromium"], {
    stdio: "inherit",
  });
  if (res.status !== 0) throw new Error("Failed to install Chromium. Run `npx playwright install chromium` manually or set browser.executablePath.");
}

// `require` shim for ESM
import { createRequire } from "node:module";
import { dirname as dirOf, join as joinPath } from "node:path";
const require = createRequire(import.meta.url);

/** Playwright's own CLI. Its package exports do not include "./cli", so find it next to package.json. */
export function playwrightCli(): string {
  return joinPath(dirOf(require.resolve("playwright/package.json")), "cli.js");
}

/** Keeps target=_blank links and window.open in the recorded tab. */
export const SAME_TAB_SCRIPT = `document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
    if (a) a.target = '_self';
  }, true); window.open = (u) => { if (u) location.href = String(u); return window; };`;

/**
 * Scenario files are compiled by tsx, whose esbuild settings wrap every named function in
 * a `__name()` call. A function passed to `page.evaluate` is serialized without that
 * helper, so the page needs its own copy or the call throws `__name is not defined`.
 */
export const NAME_HELPER_SCRIPT = `globalThis.__name ??= (fn) => fn;`;

export interface LaunchedBrowser {
  browser?: Browser;
  context: BrowserContext;
  close: () => Promise<void>;
  isAttached?: boolean;
}

/**
 * Connect directly to an already-running AI agent browser session via CDP.
 * Supports:
 * - A port number (e.g. 9222) -> http://127.0.0.1:9222
 * - A full HTTP or WebSocket CDP URL (e.g. http://localhost:9222 or ws://...)
 *
 * TraceReel never launches a new Chromium instance when attaching to an active agent session,
 * preserving cookies, tabs, logins, and viewport state.
 */
export async function connectToCdp(endpoint: string | number, cfg: BrowserConfig): Promise<LaunchedBrowser> {
  const url = typeof endpoint === "number" || /^\d+$/.test(String(endpoint).trim())
    ? `http://127.0.0.1:${endpoint}`
    : String(endpoint).trim();

  const browser = await chromium.connectOverCDP(url);
  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext().catch(() => undefined));
  if (!context) throw new Error(`Agent browser at ${url} has no accessible browser context.`);
  context.setDefaultTimeout(cfg.timeout);

  return {
    browser,
    context,
    isAttached: true,
    close: async () => {
      // Detach only; NEVER close or terminate the agent's main browser
      await browser.close().catch(() => {});
    },
  };
}

export async function launchBrowser(cfg: BrowserConfig, viewport: ViewportConfig, log?: (s: string) => void): Promise<LaunchedBrowser> {
  // Check if an AI agent main browser CDP endpoint was provided in config or env
  const cdpEndpoint = cfg.cdp ?? process.env.TRACEREEL_CDP_URL ?? process.env.CDP_URL;
  if (cdpEndpoint) {
    log?.(`Connecting directly to agent browser over CDP at ${cdpEndpoint}...`);
    return connectToCdp(cdpEndpoint, cfg);
  }

  ensureChromium(cfg, log);
  const executablePath = resolveExecutablePath(cfg);
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--hide-scrollbars",
    "--disable-smooth-scrolling",
    "--font-render-hinting=none",
    "--disable-features=TranslateUI",
    "--autoplay-policy=no-user-gesture-required",
    ...(cfg.args ?? []),
  ];
  const contextOptions = {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    locale: cfg.locale,
    timezoneId: cfg.timezoneId,
    colorScheme: cfg.colorScheme,
    ignoreHTTPSErrors: true,
  };

  const sameTab = SAME_TAB_SCRIPT;

  if (cfg.userDataDir) {
    const context = await chromium.launchPersistentContext(cfg.userDataDir, {
      headless: cfg.headless,
      executablePath,
      args,
      ...contextOptions,
    });
    context.setDefaultTimeout(cfg.timeout);
    await context.addInitScript(NAME_HELPER_SCRIPT);
    if (cfg.sameTabLinks) await context.addInitScript(sameTab);
    return { context, close: () => context.close(), isAttached: false };
  }

  const browser = await chromium.launch({ headless: cfg.headless, executablePath, args });
  const context = await browser.newContext({
    ...contextOptions,
    storageState: cfg.storageState,
  });
  context.setDefaultTimeout(cfg.timeout);
  await context.addInitScript(NAME_HELPER_SCRIPT);
  if (cfg.sameTabLinks) await context.addInitScript(sameTab);
  return {
    browser,
    context,
    isAttached: false,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

/**
 * Connect to a browser started by `takeone session start`, instead of launching one. The
 * returned handle never closes the browser: the daemon owns its lifetime.
 */
export async function connectToSession(port: number, cfg: BrowserConfig): Promise<LaunchedBrowser> {
  return connectToCdp(port, cfg);
}

export function chromiumInfo(cfg: BrowserConfig): { path: string; version?: string } {
  const path = resolveExecutablePath(cfg) ?? chromium.executablePath();
  let version: string | undefined;
  try {
    version = execSync(`"${path}" --version`, { encoding: "utf8", timeout: 5000 }).trim();
  } catch {}
  return { path, version };
}
