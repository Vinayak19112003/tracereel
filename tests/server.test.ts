import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";

test("TraceReelServer starts, responds to /health, and stops cleanly", async () => {
  const server = await startServer({ port: 4199, host: "127.0.0.1", log: () => {} });

  try {
    const res = await fetch("http://127.0.0.1:4199/health");
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.status, "ready");
    assert.equal(body.engine, "tracereel");
    assert.ok(body.hardwareEncoder);
    assert.ok(typeof body.hardwareEncoder.name === "string");
  } finally {
    await server.stop();
  }
});
