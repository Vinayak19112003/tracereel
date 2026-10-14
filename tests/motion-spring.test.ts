import { test } from "node:test";
import assert from "node:assert/strict";
import { criticallyDampedSpring, resolveEasing, continuousSpringPath } from "../src/motion.js";
import { resolveBestH264Encoder } from "../src/ffmpeg.js";

test("critically damped spring eases from 0 to 1 with zero overshoot", () => {
  const spring = criticallyDampedSpring(8.5);
  assert.equal(spring(0), 0);
  assert.equal(spring(1), 1);

  // Check monotonic increase: zero ringing or overshoot (> 1.0)
  let prev = 0;
  for (let t = 0.05; t <= 0.95; t += 0.05) {
    const val = spring(t);
    assert.ok(val >= prev, `Spring must increase monotonically: t=${t}, val=${val}, prev=${prev}`);
    assert.ok(val <= 1.0, `Spring must never overshoot 1.0: t=${t}, val=${val}`);
    prev = val;
  }
});

test("presets include criticalSpring and organic", () => {
  const crit = resolveEasing("criticalSpring" as any);
  const org = resolveEasing("organic" as any);
  assert.equal(typeof crit, "function");
  assert.equal(typeof org, "function");
  assert.equal(crit(0), 0);
  assert.equal(crit(1), 1);
  assert.equal(org(0), 0);
  assert.equal(org(1), 1);
});

test("continuousSpringPath handles multi-point paths smoothly", () => {
  const path = continuousSpringPath([
    { x: 100, y: 100 },
    { x: 300, y: 400 },
    { x: 800, y: 600 }
  ]);
  const start = path(0);
  const mid = path(0.5);
  const end = path(1);

  assert.equal(Math.round(start.x), 100);
  assert.equal(Math.round(start.y), 100);
  assert.equal(Math.round(end.x), 800);
  assert.equal(Math.round(end.y), 600);
  assert.ok(mid.x > 100 && mid.x < 800);
  assert.ok(mid.y > 100 && mid.y < 600);
});

test("encoder detection resolves a valid H264 encoder configuration", () => {
  const enc = resolveBestH264Encoder(18);
  assert.ok(enc.name.length > 0);
  assert.ok(enc.args.length > 0);
  assert.ok(enc.args.includes("-c:v"));
  assert.equal(typeof enc.isHardware, "boolean");
});
