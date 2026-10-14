# TraceReel

Turn AI-agent browser traces into polished demo videos.

Live agent footage is jumpy: every pause while the model thinks ends up on camera. TraceReel splits the job. Your agent captures screenshots and a state/action trace from the browser it actually drives — with its real logged-in state, not a fresh headless browser pretending to be you. Then TraceReel reconstructs a full recording from that trace: eased 60 Hz cursor glides, click ripples, per-character typing, settled camera shots, crossfades — rendered at 1080p, 60 fps.

```
ANY SUPPORTED AI BROWSER AGENT
            ↓
       Agent Adapter
            ↓
      TraceReel Trace
            ↓
   Reconstruction Engine
            ↓
    Professional Video
```

The renderer never sees agent identity. Adapters normalize each agent's trace format into one neutral Trace Format v1; the video plan is computed from that, so adding a new agent means writing an adapter, not touching the renderer.

**Status of integrations:** Muse is the tested reference integration. The architecture is fully generic — Grokbot is a planned/reference integration, and any future agent's traces normalize through the same pipeline with no renderer changes.

## Live demo

See real TraceReel outputs — reconstructed demo videos, no screen recording involved:

**https://vinayak19112003.github.io/tracereel/**

## Install

```bash
npm install tracereel
```

Or install globally for the CLI:

```bash
npm install -g tracereel
```

For development or source installation, clone the repository:

```bash
git clone https://github.com/Vinayak19112003/tracereel.git
cd tracereel
npm ci
npm run build
```

Then check the machine: `tracereel doctor` (node ≥ 20, ffmpeg, a Chromium renderer, disk space). `npm link` gives you a global `tracereel`. The old `takeone` and `muse-takeone` commands still work but print a deprecation warning.

The bundled skill teaches an agent the whole workflow — see [`skills/tracereel/SKILL.md`](skills/tracereel/SKILL.md). Agent-specific capture skills live under [`skills/adapters/`](skills/adapters/).

## The workflow

```
generate → validate --json → repair → inspect --json → repair → render → QA → rerender
```

```bash
tracereel validate trace.json --json   # machine-readable schema + semantics check
tracereel inspect trace.json --json    # what will happen: agent, states, shots, timing, QA
tracereel reconstruct trace.json -o demo.mp4
# optional narration + music (agent supplies the audio files; TraceReel mixes):
tracereel audio demo.mp4 --trace trace.json -o demo-narrated.mp4 --subtitles both
```

## Narrated videos

```
Agent browser trace
  → agent narration (the agent writes the script AND generates the voice clips with its own TTS)
  → TraceReel visual reconstruction (silent MP4)
  → TraceReel audio mix (narration placed on scenes, music, ducking, loudness mastering)
  → final narrated MP4
```

TraceReel has no built-in TTS: the agent generates voice clips with its own
text-to-speech and lists them in the trace; TraceReel receives the clips and
produces the final audio/video. Minimal example (matches the v0.3.0 schema):

```json
{
  "narration": [
    {
      "state": "intro",
      "text": "Welcome to the demo.",
      "audio": "audio/narration/intro.mp3"
    }
  ],
  "audio": {
    "music": {
      "file": "audio/music/background.m4a",
      "volume": 0.10,
      "loop": true,
      "duckUnderNarration": true
    },
    "loudness": {
      "targetLUFS": -16,
      "maxTruePeakDbTP": -1.5
    }
  }
}
```

Field notes: `narration` is top-level (not under `audio`); each clip uses
`audio` (not `file`) for the clip path and `state` for scene placement.
Music level is `volume` (0..1 linear, not `levelDb`); ducking is
`music.duckUnderNarration` (there is no `audio.ducking` block).

```bash
tracereel audio demo.mp4 --trace trace.json -o demo-narrated.mp4 --subtitles both
```

Output is AAC 48 kHz stereo at −16 LUFS / −1.5 dBTP (configurable), with the
video stream copied untouched (`-c:v copy`). Full reference:
[`docs/AUDIO.md`](docs/AUDIO.md).

A trace is states and actions, not frames and hacks:

```json
{
  "version": 1,
  "source": { "type": "agent-browser", "agent": "muse", "session": "main" },
  "viewport": { "width": 1919, "height": 992 },
  "states": [
    { "id": "home", "screenshot": "01-open.png", "caption": "Open the repo" },
    { "id": "merged", "screenshot": "02-merged.png", "caption": "Merged" }
  ],
  "actions": [
    { "kind": "click", "from": "home", "to": "merged", "x": 1520, "y": 147, "stateDelayMs": 900 }
  ]
}
```

Prefer states + actions. The older frames-with-actions form still works — TraceReel converts it to states internally — and `muse-managed-browser` provenance from v0.1.x normalizes to `agent-browser` / agent `muse` with a deprecation warning.

The full input contract lives in [`docs/TRACE_FORMAT.md`](docs/TRACE_FORMAT.md) and [`schema/reconstruction.schema.json`](schema/reconstruction.schema.json). Annotated examples in [`examples/`](examples/). Programmatic traces via the TypeScript SDK:

```ts
import { TraceBuilder } from "tracereel";

const t = new TraceBuilder({ agent: "muse", viewport: { width: 1919, height: 992 } });
t.state("home", "01-open.png", { caption: "Open the repo." });
t.state("merged", "02-merged.png", { caption: "Merged." });
t.click({ from: "home", to: "merged", x: 1520, y: 147, stateDelayMs: 900 });
const trace = t.build();
```

Portable bundles — one directory with the trace, its frames, and metadata:

```bash
tracereel import agent-output.json --adapter muse -o demo.tracereel
tracereel reconstruct demo.tracereel/trace.json -o demo.mp4
```

**Capture rules that matter:**

- The screenshots must come from **the browser the agent is already driving** — its logged-in state, cookies, avatar, theme. Never launch another browser to obtain footage; TraceReel's Chromium is for **rendering only** and never browses the target site.
- One UI state per screenshot: capture before *and* after every UI-changing action, settled, never mid-animation.
- Screenshots usually contain the OS cursor baked in — paint it out per frame before rendering, or the video shows two cursors.
- `source.type` is **declarative provenance metadata**, not cryptographic proof. `--require-source muse-managed-browser` keeps working and fails loudly on the wrong source — no silent fresh-Chromium footage, ever.

**Camera philosophy: SHOT = CAMERA MOVE.** The camera is planned in settled shots, not clicks. Nearby interactions share one framing; cuts never move the camera (short output-time crossfade); reframes are direct, never zoom-out/zoom-in; only the final shot releases to the overview. See [`docs/architecture.md`](docs/architecture.md).

**Local by default.** Reconstruction and rendering happen on your machine. TraceReel never uploads your screenshots, traces, or videos anywhere. Redact regions at copy time (`redactions: [{ x, y, width, height, mode: "blur" | "solid" | "pixelate" }]`) — the pixels never reach the video. `{ "kind": "type", "sensitive": true }` hides the key pill. Never type real credentials for a demo; use fake ones. Treat the frames directory like credentials. More: [`docs/privacy.md`](docs/privacy.md).

**Verified platforms:** Linux VPS, node 20+, a system Chromium path, system or bundled ffmpeg. macOS and Windows are not verified yet.

**Describe the result honestly:** "reconstructed from real screenshots" (real frames, rebuilt cursor path) — never "a captured live recording". See [`docs/limitations.md`](docs/limitations.md).

## CLI reference

| command | does |
|---|---|
| `tracereel validate trace.json [--json]` | schema + semantics check; structured codes, paths, suggestions |
| `tracereel inspect trace.json [--json]` | agent, adapter, trace form, states, actions, duration, camera shots, QA |
| `tracereel capabilities [agent] [--json]` | what each agent's traces can express (verified vs planned) |
| `tracereel import <agent-trace> --adapter <name> -o demo.tracereel` | normalize an agent's raw trace into a portable bundle |
| `tracereel doctor [--json]` | machine readiness: node, ffmpeg, Chromium renderer, disk, write perms |
| `tracereel reconstruct trace.json -o demo.mp4` | validate → manifest → 1080p60 MP4 + contact sheet + QA report |
| `tracereel audio silent.mp4 --trace trace.json -o final.mp4` | mix agent-supplied narration/music onto the video; video stream copied (`-c:v copy`) |
| `tracereel render <dir>` | re-render a kept work dir (`--keep-work-dir`) with different styling |
| `tracereel assemble ./frames` | Ken Burns-style video from stills, no cursor (upstream feature) |
| `tracereel setup` | download Chromium once, check ffmpeg (upstream feature) |

The original takeone workflow (rehearse live → export scenario → record) is fully intact for agents that drive their own browser. The reconstruction features above are the TraceReel additions; upstream functionality is documented in [`skills/tracereel/references/scenario-api.md`](skills/tracereel/references/scenario-api.md).

## How it works

`reconstruct` normalizes the trace through the agent adapter, copies the screenshots into a working dir (applying redactions), writes a `manifest.json` with `mode: "reconstructed"`, and synthesizes the 60 Hz cursor/click/key event stream plus camera shots from the state/action plan. The compositor then renders the video from that manifest, split across browser workers that each encode a segment with ffmpeg. Cursor path and camera moves are computed from the log, not from the capture, so they stay smooth even when the page stutters. Output is H.264 MP4 by default, or VP9 WebM.

The render is deterministic: the same trace always produces the same video. Crossfades are measured in output time and every frame names its own images, so parallel workers can't disagree. (The intermediate manifest stamps a wall-clock `createdAt` for provenance; it is metadata only and never affects a pixel.)

How it works in detail: [`docs/architecture.md`](docs/architecture.md). The trace format: [`docs/TRACE_FORMAT.md`](docs/TRACE_FORMAT.md). Agent audio (narration + music): [`docs/AUDIO.md`](docs/AUDIO.md). Privacy and security notes: [`docs/privacy.md`](docs/privacy.md). Known limitations: [`docs/limitations.md`](docs/limitations.md).

## Development

```bash
npm test          # unit tests (node:test + tsx)
npm run typecheck
npm run build
npm run visual-qa # render fixtures, diff contact sheets vs baselines (manual gate)
```

Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md). Changelog: [`CHANGELOG.md`](CHANGELOG.md).

### TestSprite verification

Every pull request to the `demo` branch (the branch that serves the live demo page) is gated by a TestSprite check. The gate workflow (`.github/workflows/testsprite.yml` on the `demo` branch) publishes the PR's version of the demo page to a per-PR preview URL, then runs the TestSprite suite against that preview. A failing suite fails the check, so a broken demo page cannot merge.

The suite lives in the TestSprite portal and exercises the demo page's key interactions: the hero and gallery videos loading and playing, the navigation anchors, and the copy-install button. The workflow needs a `TESTSPRITE_API_KEY` repo secret and a `TESTSPRITE_PROJECT_ID` repo variable.

## Origins and attribution

TraceReel began as a fork/extension of [TakeOne](https://github.com/atharvadeosthale/takeone) by Atharva Deosthale, MIT licensed. The original TakeOne remains MIT licensed by its original author.

TraceReel adds the agent-trace reconstruction architecture: the Trace Format v1 capture protocol, the adapter system (Muse reference adapter, Grokbot reference, generic fallback), the state/action model, shot-planner changes, provenance handling, structured validation, the bundle format, the TypeScript SDK, privacy tooling, and the integrations around them. No upstream endorsement is implied.

## License

MIT — see [LICENSE](LICENSE).
