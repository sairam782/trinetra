import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request, startServer } from "./helpers/server-runner.mjs";

describe("Remediation gate branch selection via /api/incidents/analyze", () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(() => server?.kill());

  it("routes the identity-edge deploy incident to a human gate (mid-risk, no approval)", async () => {
    const res = await request(server.port, "/api/incidents/analyze", {
      method: "POST",
      body: JSON.stringify({ incidentKey: "deploy" })
    });
    assert.equal(res.status, 200);
    const payload = res.json();
    assert.equal(payload.gate.kind, "human");
    assert.equal(payload.triage.runbook.id, "RB-330");
  });

  it("routes the checkout latency incident to a human or escalate gate (never auto without approval)", async () => {
    const res = await request(server.port, "/api/incidents/analyze", {
      method: "POST",
      body: JSON.stringify({ incidentKey: "latency" })
    });
    assert.equal(res.status, 200);
    const payload = res.json();
    assert.notEqual(payload.gate.kind, "auto");
    assert.notEqual(payload.gate.kind, "approved");
  });

  it("routes the orders-db disk pressure incident to a human or escalate gate without approval", async () => {
    const res = await request(server.port, "/api/incidents/analyze", {
      method: "POST",
      body: JSON.stringify({ incidentKey: "disk" })
    });
    assert.equal(res.status, 200);
    const payload = res.json();
    assert.notEqual(payload.gate.kind, "auto");
    assert.notEqual(payload.gate.kind, "approved");
  });

  it("returns a well-formed remediation gate object on every run", async () => {
    const res = await request(server.port, "/api/incidents/analyze", {
      method: "POST",
      body: JSON.stringify({ incidentKey: "website" })
    });
    assert.equal(res.status, 200);
    const payload = res.json();
    assert.ok(payload.gate.kind);
    assert.ok(payload.gate.label);
    assert.ok(payload.gate.runbook);
    assert.ok(typeof payload.gate.confidence === "number");
    assert.ok(payload.gate.reason);
  });
});
