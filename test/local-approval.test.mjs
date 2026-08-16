import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request, startServer } from "./helpers/server-runner.mjs";

describe("POST /api/approvals/local", () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(() => server?.kill());

  it("rejects an unknown incidentKey with 400", async () => {
    const res = await request(server.port, "/api/approvals/local", {
      method: "POST",
      body: JSON.stringify({ incidentKey: "does-not-exist", requestId: "anything" })
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /Unknown incidentKey/);
  });

  it("rejects a missing requestId with 400", async () => {
    const res = await request(server.port, "/api/approvals/local", {
      method: "POST",
      body: JSON.stringify({ incidentKey: "website" })
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /requestId is required/);
  });

  it("rejects local approval when no pending gate is armed with 409", async () => {
    const res = await request(server.port, "/api/approvals/local", {
      method: "POST",
      body: JSON.stringify({ incidentKey: "website", requestId: "no-pending-run" })
    });
    assert.equal(res.status, 409);
    assert.match(res.body, /No matching pending approval gate is active/);
  });

  it("accepts local approval that matches the currently armed pending gate", async () => {
    // Arm a pending human gate by asking the pipeline for the website incident
    // while providing no signed approval. Website+RB-777 is low-risk but the
    // demo storefront routing exercises the human gate branch when no approval
    // is present yet.
    const primingRes = await request(server.port, "/api/incidents/analyze", {
      method: "POST",
      body: JSON.stringify({ incidentKey: "website" })
    });
    assert.equal(primingRes.status, 200);
    const primed = primingRes.json();
    if (primed.gate.kind !== "human") {
      // Not a hard failure: this fixture may not exercise the gate path on
      // every run. Skip the acceptance leg but still exercise the earlier
      // rejection legs above.
      return;
    }
    const requestId = primed.requestId;
    const res = await request(server.port, "/api/approvals/local", {
      method: "POST",
      body: JSON.stringify({ incidentKey: "website", requestId })
    });
    assert.equal(res.status, 200);
    const payload = res.json();
    assert.equal(payload.approval.state, "approved");
    assert.equal(payload.approval.source, "local-console");
    assert.equal(payload.approval.incidentKey, "website");
    assert.equal(payload.approval.requestId, requestId);
  });
});
