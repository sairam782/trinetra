import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { request, startServer, slackApprovalBody, slackSignatureHeaders } from "./helpers/server-runner.mjs";

const token = "test-operator-credential-with-at-least-32-characters";
const post = (body, headers = {}) => ({ method: "POST", body: JSON.stringify(body), headers });
const analyze = (server, body) => request(server.port, "/api/incidents/analyze", post(body));
async function approve(server, requestId, actionId = "approve_remediation") {
  const body = slackApprovalBody({ requestId, actionId });
  return request(server.port, "/api/slack/interactions", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...slackSignatureHeaders(body) } });
}

describe("Production HTTP boundary", () => {
  it("requires authentication for the console and APIs while exposing minimal health probes", async (t) => {
    const server = await startServer({ NODE_ENV: "production", TRINETRA_AUTH_TOKEN: token, PUBLIC_BASE_URL: "https://trinetra.example" });
    t.after(() => server.kill());
    for (const path of ["/", "/app.js", "/api/logs", "/api/runs", "/api/approvals", "/api/realtime/status"]) {
      const denied = await request(server.port, path);
      assert.equal(denied.status, 401, path);
      assert.match(denied.headers["www-authenticate"], /Basic/);
    }
    const health = await request(server.port, "/api/readiness");
    assert.equal(health.status, 200);
    assert.equal(health.json().ready, true);
    assert.equal(health.json().checks.qwenRuntime, undefined);
    assert.equal((await request(server.port, "/api/runs", { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await request(server.port, "/", { headers: { authorization: `Basic ${Buffer.from(`trinetra:${token}`).toString("base64")}` } })).status, 200);
    assert.equal((await request(server.port, "/api/runs", { headers: { authorization: "Bearer wrong" } })).status, 401);
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await request(server.port, "/api/approvals/local", post({ incidentKey: "website", requestId: "x" }, headers))).status, 403);
    assert.equal((await request(server.port, "/api/demo-site/inject-error", post({ failureId: "apiTimeout" }, headers))).status, 403);
    assert.equal((await request(server.port, "/api/incidents/analyze", post({ incidentKey: "website" }, { ...headers, origin: "https://attacker.example" }))).status, 403);
    assert.equal((await request(server.port, "/api/incidents/analyze", post({ incidentKey: "website" }, { ...headers, "sec-fetch-site": "cross-site" }))).status, 403);
    const allowed = await request(server.port, "/api/incidents/analyze", post({ incidentKey: "website" }, { ...headers, origin: "https://trinetra.example" }));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json().gate.kind, "human");
  });

  it("rejects malformed JSON shapes, inherited catalog keys, invalid paths and SSE input before headers", async (t) => {
    const server = await startServer({ ANALYZE_RATE_LIMIT_MAX: "100" });
    t.after(() => server.kill());
    for (const body of [null, [], "x", 1, { incidentKey: "__proto__" }, { incidentKey: "constructor" }, { incidentKey: 1 }, { approvalRequestId: {} }]) {
      for (const path of ["/api/incidents/analyze", "/api/incidents/analyze/stream"]) {
        const result = await request(server.port, path, post(body));
        assert.equal(result.status, 400, `${path}: ${JSON.stringify(body)}`);
        assert.match(result.headers["content-type"], /application\/json/);
      }
    }
    assert.equal((await request(server.port, "/api/incidents/analyze", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } })).status, 415);
    assert.equal((await request(server.port, "/%not-encoded")).status, 400);
    assert.equal((await request(server.port, "/%2e%2e%2fpackage.json")).status, 403);
    assert.equal((await request(server.port, "/api/logs?limit=NaN")).status, 400);
    assert.equal((await request(server.port, "/api/does-not-exist")).status, 404);
    assert.equal((await request(server.port, "/api/demo-site/inject-error", post({ failureId: "constructor" }))).status, 400);
  });

  it("cannot evade analyze limits by forging forwarding headers", async (t) => {
    const server = await startServer({ ANALYZE_RATE_LIMIT_MAX: "1" });
    t.after(() => server.kill());
    assert.equal((await request(server.port, "/api/incidents/analyze", post({ incidentKey: "website" }, { "x-forwarded-for": "1.2.3.4" }))).status, 200);
    const limited = await request(server.port, "/api/incidents/analyze", post({ incidentKey: "website" }, { "x-forwarded-for": "5.6.7.8" }));
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers["retry-after"]) > 0);
  });

  it("reports unavailable storage instead of claiming readiness", async (t) => {
    const server = await startServer();
    t.after(async () => { await server.kill(); await rm(`${server.dataDir}-backup`, { recursive: true, force: true }); });
    await rename(server.dataDir, `${server.dataDir}-backup`);
    await writeFile(server.dataDir, "not a directory");
    const readiness = await request(server.port, "/api/readiness");
    assert.equal(readiness.status, 503);
    assert.equal(readiness.json().checks.auditPersistence, false);
    assert.equal((await request(server.port, "/api/health")).status, 200);
  });
});

describe("Approval lifecycle", () => {
  it("requires a pending run, recognizes only supported actions, and consumes an approval once", async (t) => {
    const server = await startServer();
    t.after(() => server.kill());
    assert.equal((await approve(server, "nonexistent")).status, 409);
    const primed = (await analyze(server, { incidentKey: "website" })).json();
    assert.equal(primed.gate.kind, "human");
    assert.equal((await approve(server, primed.requestId, "unknown-action")).status, 400);
    assert.equal((await approve(server, primed.requestId)).status, 200);
    const resumed = await analyze(server, { incidentKey: "website", approvalRequestId: primed.requestId });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.json().gate.kind, "approved");
    assert.equal((await analyze(server, { incidentKey: "website", approvalRequestId: primed.requestId })).status, 409);
    assert.equal((await approve(server, primed.requestId)).status, 409);
  });

  it("rejects expired approvals", async (t) => {
    const server = await startServer({ VERIFICATION_TIMEOUT_MS: "100" });
    t.after(() => server.kill());
    const primed = (await analyze(server, { incidentKey: "website" })).json();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await approve(server, primed.requestId)).status, 409);
  });

  it("does not let an old Slack callback clear or approve a newer pending run", async (t) => {
    const server = await startServer();
    t.after(() => server.kill());
    const older = (await analyze(server, { incidentKey: "website" })).json();
    const newer = (await analyze(server, { incidentKey: "website" })).json();
    assert.equal((await approve(server, older.requestId)).status, 409);
    assert.equal((await approve(server, newer.requestId)).status, 200);
  });

  it("invalidates an approval when storefront state changes", async (t) => {
    const server = await startServer();
    t.after(() => server.kill());
    const primed = (await analyze(server, { incidentKey: "website" })).json();
    assert.equal((await approve(server, primed.requestId)).status, 200);
    await request(server.port, "/api/demo-site/inject-error", post({ failureId: "apiTimeout" }));
    assert.equal((await analyze(server, { incidentKey: "website", approvalRequestId: primed.requestId })).status, 409);
  });

  it("repairs and verifies each supported storefront failure after explicit approval", async (t) => {
    const server = await startServer({ REMEDIATION_EXECUTION_MODE: "execute", ANALYZE_RATE_LIMIT_MAX: "100" });
    t.after(() => server.kill());
    const failures = (await request(server.port, "/api/demo-site/failures")).json();
    for (const failure of failures) {
      await request(server.port, "/api/demo-site/inject-error", post({ failureId: failure.id }));
      const primed = (await analyze(server, { incidentKey: "website" })).json();
      assert.equal(primed.gate.kind, "human", failure.id);
      assert.equal((await approve(server, primed.requestId)).status, 200);
      const result = (await analyze(server, { incidentKey: "website", approvalRequestId: primed.requestId })).json();
      assert.equal(result.gate.kind, "approved", failure.id);
      assert.ok(result.remediationPlan.toolsExecuted.some((tool) => tool.name === "verify_demo" && tool.result.healthy), failure.id);
      assert.equal((await request(server.port, "/demo-store")).status, 200, failure.id);
    }
  });
});

it("does not invent infrastructure recovery or label simulated adapters live", async (t) => {
  const server = await startServer({ REMEDIATION_EXECUTION_MODE: "execute", MCP_DEPLOY_LIVE: "true" });
  t.after(() => server.kill());
  const primed = (await analyze(server, { incidentKey: "deploy" })).json();
  assert.equal(primed.gate.kind, "human");
  const approved = await request(server.port, "/api/approvals/local", post({ incidentKey: "deploy", requestId: primed.requestId }));
  assert.equal(approved.status, 200);
  const result = (await analyze(server, { incidentKey: "deploy", approvalRequestId: primed.requestId })).json();
  assert.equal(result.verification.simulated, true);
  assert.deepEqual(result.verification.after, result.incident.metrics);
  assert.equal(result.memoryUpdate.verified, false);
  assert.ok(result.mcpTrace.filter((call) => call.id === "deploy").every((call) => call.simulation && call.status === "simulated"));
  const mcps = (await request(server.port, "/api/mcps")).json();
  assert.equal(mcps.find((mcp) => mcp.id === "deploy").status, "not-implemented");
});

it("fails closed before mutation when the authorization audit cannot be written", async (t) => {
  const server = await startServer({ REMEDIATION_EXECUTION_MODE: "execute" });
  t.after(() => server.kill());
  const primed = (await analyze(server, { incidentKey: "website" })).json();
  assert.equal((await approve(server, primed.requestId)).status, 200);
  await rename(`${server.dataDir}/incident-runs.jsonl`, `${server.dataDir}/incident-runs.backup`);
  await mkdir(`${server.dataDir}/incident-runs.jsonl`);
  const result = await analyze(server, { incidentKey: "website", approvalRequestId: primed.requestId });
  assert.equal(result.status, 503);
  assert.equal((await request(server.port, "/api/demo-site/status")).json().healthy, false);
  assert.equal((await analyze(server, { incidentKey: "website" })).status, 503);
  assert.equal((await request(server.port, "/api/readiness")).status, 503);
});
