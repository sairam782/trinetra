import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request, startServer } from "./helpers/server-runner.mjs";

describe("POST /api/incidents/analyze", () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(() => server?.kill());

  it("rejects an unknown incidentKey with 400", async () => {
    const res = await request(server.port, "/api/incidents/analyze", {
      method: "POST",
      body: JSON.stringify({ incidentKey: "nope" })
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /Unknown incidentKey/);
  });

  it("ignores client-supplied approval:approved and treats the run as pending", async () => {
    // The README claims client-sent approval:approved is ignored. Verify that
    // supplying it does NOT bypass the human gate for a mid-risk deploy incident.
    const res = await request(server.port, "/api/incidents/analyze", {
      method: "POST",
      body: JSON.stringify({ incidentKey: "deploy", approval: "approved", approverId: "U-STRANGER" })
    });
    assert.equal(res.status, 200);
    const payload = res.json();
    // A non-signed "approved" claim from the body must not produce gate.kind === "approved".
    assert.notEqual(payload.gate.kind, "approved");
  });

  it("rejects requests larger than MAX_BODY_BYTES with 413", async () => {
    const oversized = { incidentKey: "latency", pad: "x".repeat(80_000) };
    const res = await request(server.port, "/api/incidents/analyze", {
      method: "POST",
      body: JSON.stringify(oversized)
    });
    assert.equal(res.status, 413);
    assert.match(res.body, /Request body too large/);
  });
});
