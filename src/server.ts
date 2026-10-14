import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, createReadStream, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolveBestH264Encoder } from "./ffmpeg.js";
import { connectToCdp } from "./browser.js";
import { renderRecording } from "./compositor/render.js";
import { buildReconstructionManifest } from "./reconstruct/build.js";
import { traceToReconstructionInput } from "./adapters/normalize.js";
import { resolveConfig, RECONSTRUCTION_DEFAULTS } from "./config.js";
import type { TraceReelTrace } from "./trace/types.js";
import type { UserScenarioConfig } from "./types.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  cdpEndpoint?: string | number;
  log?: (msg: string) => void;
}

export interface RenderJob {
  id: string;
  status: "queued" | "rendering" | "completed" | "failed";
  progress: number;
  totalFrames: number;
  renderedFrames: number;
  createdAt: number;
  completedAt?: number;
  outFile?: string;
  error?: string;
}

export class TraceReelServer {
  private port: number;
  private host: string;
  private log: (msg: string) => void;
  private server: ReturnType<typeof createServer>;
  private jobs = new Map<string, RenderJob>();
  private activeCdpEndpoint?: string | number;

  constructor(opts: ServerOptions = {}) {
    this.port = opts.port ?? 4100;
    this.host = opts.host ?? "127.0.0.1";
    this.log = opts.log ?? ((msg) => console.log(`[tracereel-server] ${msg}`));
    this.activeCdpEndpoint = opts.cdpEndpoint ?? process.env.TRACEREEL_CDP_URL ?? process.env.CDP_URL;

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  public async start(): Promise<{ port: number; host: string }> {
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        this.log(`TraceReel API Server running on http://${this.host}:${this.port}`);
        resolve({ port: this.port, host: this.host });
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async parseBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > 50 * 1024 * 1024) {
          reject(new Error("Payload too large (>50MB)"));
        }
      });
      req.on("end", () => {
        if (!data) return resolve({} as T);
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, body: Record<string, any>) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end(JSON.stringify(body));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
    const pathname = url.pathname;

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      return res.end();
    }

    try {
      // GET /api/status or /health
      if (req.method === "GET" && (pathname === "/api/status" || pathname === "/health")) {
        const encoder = resolveBestH264Encoder();
        return this.sendJson(res, 200, {
          status: "ready",
          engine: "tracereel",
          version: "0.3.1",
          hardwareEncoder: {
            name: encoder.name,
            isHardware: encoder.isHardware,
            description: encoder.description,
          },
          agentBrowserCdp: this.activeCdpEndpoint ? String(this.activeCdpEndpoint) : null,
          activeJobs: Array.from(this.jobs.values()).filter((j) => j.status === "rendering" || j.status === "queued").length,
        });
      }

      // POST /api/cdp/attach -> Attach to agent's main running browser
      if (req.method === "POST" && pathname === "/api/cdp/attach") {
        const body = await this.parseBody<{ endpoint: string | number }>(req);
        if (!body.endpoint) {
          return this.sendJson(res, 400, { error: "Missing 'endpoint' in request body" });
        }
        try {
          const launched = await connectToCdp(body.endpoint, { timeout: 5000, headless: true, sameTabLinks: true });
          const pages = launched.context.pages();
          const pageTitle = pages[0] ? await pages[0].title().catch(() => "") : "";
          await launched.close();
          this.activeCdpEndpoint = body.endpoint;
          return this.sendJson(res, 200, {
            connected: true,
            endpoint: String(body.endpoint),
            activePages: pages.length,
            title: pageTitle,
          });
        } catch (err: any) {
          return this.sendJson(res, 502, {
            connected: false,
            endpoint: String(body.endpoint),
            error: err.message,
          });
        }
      }

      // POST /api/render -> Start background video rendering job
      if (req.method === "POST" && pathname === "/api/render") {
        const body = await this.parseBody<{
          trace?: TraceReelTrace;
          recordingDir?: string;
          config?: UserScenarioConfig;
        }>(req);

        let targetDir = body.recordingDir;

        // If direct trace provided, serialize to a temporary directory with manifest
        if (body.trace) {
          targetDir = join(tmpdir(), `tracereel-job-${Date.now()}-${randomUUID().slice(0, 8)}`);
          mkdirSync(targetDir, { recursive: true });
          const input = traceToReconstructionInput(body.trace);
          const manifest = buildReconstructionManifest(
            input,
            resolveConfig(RECONSTRUCTION_DEFAULTS, body.config)
          );
          writeFileSync(join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2));
        }

        if (!targetDir || !existsSync(join(targetDir, "manifest.json"))) {
          return this.sendJson(res, 400, {
            error: "Must supply either a valid 'trace' object or an existing 'recordingDir' containing manifest.json",
          });
        }

        const jobId = randomUUID();
        const job: RenderJob = {
          id: jobId,
          status: "queued",
          progress: 0,
          totalFrames: 0,
          renderedFrames: 0,
          createdAt: Date.now(),
        };
        this.jobs.set(jobId, job);

        // Run rendering in background
        this.runJob(jobId, targetDir, body.config).catch((err) => {
          this.log(`Job ${jobId} failed: ${err.message}`);
        });

        return this.sendJson(res, 202, {
          jobId,
          status: "queued",
          message: "Render job queued successfully",
        });
      }

      // GET /api/jobs/:id -> Query job status
      if (req.method === "GET" && pathname.startsWith("/api/jobs/")) {
        const parts = pathname.split("/");
        const id = parts[3];
        const isVideoReq = parts[4] === "video";
        const job = this.jobs.get(id);

        if (!job) {
          return this.sendJson(res, 404, { error: `Job ${id} not found` });
        }

        if (isVideoReq) {
          if (job.status !== "completed" || !job.outFile || !existsSync(job.outFile)) {
            return this.sendJson(res, 400, { error: `Video for job ${id} is not ready (status: ${job.status})` });
          }

          const stat = statSync(job.outFile);
          const fileSize = stat.size;
          const range = req.headers.range;

          if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = end - start + 1;
            const stream = createReadStream(job.outFile, { start, end });
            res.writeHead(206, {
              "Content-Range": `bytes ${start}-${end}/${fileSize}`,
              "Accept-Ranges": "bytes",
              "Content-Length": chunksize,
              "Content-Type": "video/mp4",
            });
            return stream.pipe(res);
          } else {
            res.writeHead(200, {
              "Content-Length": fileSize,
              "Content-Type": "video/mp4",
              "Accept-Ranges": "bytes",
            });
            return createReadStream(job.outFile).pipe(res);
          }
        }

        return this.sendJson(res, 200, job);
      }

      // Fallback
      return this.sendJson(res, 404, { error: "Route not found" });
    } catch (err: any) {
      this.log(`Error handling ${req.method} ${pathname}: ${err.stack || err.message}`);
      return this.sendJson(res, 500, { error: err.message || "Internal server error" });
    }
  }

  private async runJob(jobId: string, recordingDir: string, configOverrides?: UserScenarioConfig) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "rendering";
    try {
      const result = await renderRecording({
        recordingDir,
        config: configOverrides,
        log: (msg) => this.log(`[Job ${jobId}] ${msg}`),
        onProgress: (done, total) => {
          job.renderedFrames = done;
          job.totalFrames = total;
          job.progress = total > 0 ? Math.round((done / total) * 100) : 0;
        },
      });

      job.status = "completed";
      job.outFile = result.outFile;
      job.completedAt = Date.now();
      job.progress = 100;
      this.log(`Job ${jobId} finished successfully -> ${result.outFile}`);
    } catch (err: any) {
      job.status = "failed";
      job.error = err.message;
      job.completedAt = Date.now();
      this.log(`Job ${jobId} render error: ${err.message}`);
    }
  }
}

export async function startServer(opts: ServerOptions = {}): Promise<TraceReelServer> {
  const server = new TraceReelServer(opts);
  await server.start();
  return server;
}
