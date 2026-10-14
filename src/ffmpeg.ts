import { spawn, execSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolveFfmpeg(): string {
  const fromEnv = process.env.FFMPEG_PATH ?? process.env.TRACEREEL_FFMPEG_PATH ?? process.env.TAKEONE_FFMPEG_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`ffmpeg not found at ${fromEnv}`);
    return fromEnv;
  }
  try {
    const p: string | null = require("ffmpeg-static");
    if (p && existsSync(p)) return p;
  } catch {}
  try {
    const which = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const out = execSync(which, { encoding: "utf8" }).trim().split("\n")[0];
    if (out && existsSync(out)) return out;
  } catch {}
  throw new Error("ffmpeg not found. Install ffmpeg or set FFMPEG_PATH.");
}

export function ffmpegVersion(): string | undefined {
  try {
    // execFileSync: no shell, so ffmpeg paths with spaces or $ stay intact.
    return execFileSync(resolveFfmpeg(), ["-version"], { encoding: "utf8" }).split("\n")[0];
  } catch {
    return undefined;
  }
}

export interface FfmpegProcess {
  stdin: NodeJS.WritableStream;
  done: Promise<void>;
  write: (buf: Buffer) => Promise<void>;
  end: () => Promise<void>;
}

/** Spawn ffmpeg with the given args, returning a handle that respects backpressure on stdin. */
export function spawnFfmpeg(args: string[], opts: { onLog?: (s: string) => void } = {}): FfmpegProcess {
  const bin = resolveFfmpeg();
  const proc = spawn(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["pipe", "inherit", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
    opts.onLog?.(d.toString());
  });
  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}\n${stderr}`))));
  });
  // Swallow EPIPE if ffmpeg dies early; the `done` promise carries the real error.
  proc.stdin.on("error", () => {});
  const write = (buf: Buffer) =>
    new Promise<void>((resolve) => {
      if (proc.stdin.write(buf)) resolve();
      else proc.stdin.once("drain", () => resolve());
    });
  const end = () =>
    new Promise<void>((resolve) => {
      proc.stdin.end(() => resolve());
    });
  return { stdin: proc.stdin, done, write, end };
}

export function runFfmpeg(args: string[]): Promise<void> {
  const p = spawnFfmpeg(args);
  return p.end().then(() => p.done);
}

export interface EncoderInfo {
  name: string;
  args: string[];
  isHardware: boolean;
  description: string;
}

let cachedEncoder: EncoderInfo | undefined;

/**
 * Probe and return the best available H.264 video encoder.
 * Checks for hardware encoders (VideoToolbox on macOS, NVENC on NVIDIA, QSV/VAAPI on Linux/Intel),
 * verifying functionality with a zero-length test frame, and falling back to libx264.
 */
export function resolveBestH264Encoder(crf = 18): EncoderInfo {
  if (cachedEncoder) return cachedEncoder;

  const envOverride = process.env.TRACEREEL_ENCODER;
  if (envOverride) {
    cachedEncoder = {
      name: envOverride,
      args: ["-c:v", envOverride],
      isHardware: envOverride !== "libx264",
      description: `Manual override (${envOverride})`,
    };
    return cachedEncoder;
  }

  const bin = resolveFfmpeg();
  let encoderList = "";
  try {
    encoderList = execFileSync(bin, ["-encoders"], { encoding: "utf8" });
  } catch {
    encoderList = "";
  }

  const candidates = [
    {
      name: "h264_videotoolbox",
      platform: "darwin",
      args: ["-c:v", "h264_videotoolbox", "-b:v", "12M", "-pix_fmt", "yuv420p"],
      desc: "Apple VideoToolbox (Hardware accelerated)",
    },
    {
      name: "h264_nvenc",
      platform: "any",
      args: ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", String(crf), "-pix_fmt", "yuv420p"],
      desc: "NVIDIA NVENC (Hardware accelerated)",
    },
    {
      name: "h264_qsv",
      platform: "any",
      args: ["-c:v", "h264_qsv", "-global_quality", String(crf), "-pix_fmt", "nv12"],
      desc: "Intel QuickSync (Hardware accelerated)",
    },
    {
      name: "h264_vaapi",
      platform: "linux",
      args: ["-c:v", "h264_vaapi", "-qp", String(crf)],
      desc: "VA-API (Hardware accelerated)",
    },
  ];

  for (const cand of candidates) {
    if (cand.platform !== "any" && cand.platform !== process.platform) continue;
    if (!encoderList.includes(cand.name)) continue;

    // Probe if the hardware device is actually initialized and usable
    try {
      execFileSync(
        bin,
        ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=64x64:d=0.04", ...cand.args, "-f", "null", "-"],
        { timeout: 3000, stdio: "pipe" }
      );
      cachedEncoder = {
        name: cand.name,
        args: cand.args,
        isHardware: true,
        description: cand.desc,
      };
      return cachedEncoder;
    } catch {
      // Driver or device not available on this host; try next candidate
    }
  }

  // CPU Fallback
  cachedEncoder = {
    name: "libx264",
    args: ["-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-pix_fmt", "yuv420p", "-threads", "2"],
    isHardware: false,
    description: "libx264 CPU (high-fidelity software fallback)",
  };
  return cachedEncoder;
}
