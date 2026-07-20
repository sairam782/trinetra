import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const port = 4197;
const slackSigningSecret = "test-signing-secret";
const child = spawn(process.execPath, ["backend/server.mjs"], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    QWEN_LIVE_CALLS: "false",
    REMEDIATION_EXECUTION_MODE: "dry-run",
    SLACK_SIGNING_SECRET: slackSigningSecret,
    SLACK_APPROVER_IDS: "U-HACK-JUDGE",
    SYNTHETIC_CHECK_INTERVAL_MS: "1000",
    RUNBOOK_ALLOWLIST: "RB-101,RB-204,RB-330,RB-401,RB-510,RB-777"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForServer(port);
  const health = await requestJson("/api/health");
  const readiness = await requestJson("/api/readiness");
  const analysis = await requestJson("/api/incidents/analyze", {
    method: "POST",
    body: JSON.stringify({ incidentKey: "deploy", approval: "approved", approverId: "U-HACK-JUDGE" })
  });
  const failures = await requestJson("/api/demo-site/failures");
  await requestJson("/api/demo-site/inject-error", {
    method: "POST",
    body: JSON.stringify({ failureId: "apiTimeout" })
  });
  const brokenSite = await requestText("/demo-store", { expectedStatus: 504 });
  const approvalRequestId = "smoke-website-approval";
  await approveIncident("website", approvalRequestId);
  const websiteAnalysis = await requestJson("/api/incidents/analyze", {
    method: "POST",
    body: JSON.stringify({ incidentKey: "website", approval: "approved", approvalRequestId })
  });
  const approvals = await requestJson("/api/approvals");
  const synthetic = await requestJson("/api/synthetic/status");
  const dryRunStatus = await requestJson("/api/demo-site/status");
  const runbooks = await requestJson("/api/runbooks");
  const alibaba = await requestJson("/api/cloud/alibaba");
  const realtime = await requestJson("/api/realtime/status");
  const runs = await requestJson("/api/runs");

  assert(health.ok, "health endpoint should be ok");
  assert(readiness.ready, "readiness endpoint should be ready");
  assert(analysis.audit.length >= 10, "analysis should include audited agent calls");
  assert(analysis.mcps.length >= 10, "analysis should include MCP registry");
  assert(analysis.qwen.models.commander, "commander should expose configured Qwen model");
  assert(analysis.qwen.models.triage, "triage should expose configured Qwen model");
  assert(analysis.route.name === "P1 fast-path", "deploy scenario should route to P1 fast-path");
  assert(analysis.adjudication.reasoning, "analysis should include adjudication reasoning");
  assert(analysis.gate.reason, "analysis should include remediation gate reason");
  assert(failures.length >= 5, "demo storefront should expose at least five injectable failures");
  assert(brokenSite.includes("Catalog API timeout"), "demo storefront should expose selected injected error");
  assert(approvals.signed.some((item) => item.incidentKey === "website"), "Slack-signed approval should be recorded");
  assert(websiteAnalysis.triage.runbook.id === "RB-777", "website incident should select the storefront config runbook");
  assert(websiteAnalysis.gate.kind === "approved", "website remediation should require a real signed approval");
  assert(websiteAnalysis.verification.status.includes("dry-run mode left /demo-store unchanged"), "website remediation should stay dry-run by default");
  assert(!dryRunStatus.healthy, "demo storefront should remain broken in dry-run mode");
  assert(synthetic.targetUrl.includes("/demo-store"), "synthetic status should expose the live target URL");
  assert(runbooks.some((book) => book.version && book.approved), "runbooks should be structured and versioned");
  assert(alibaba.provider === "Alibaba Cloud", "Alibaba deployment proof should be exposed");
  assert(realtime.qwen.readiness.length >= 6, "realtime status should include model readiness");
  assert(realtime.mcps.length >= 10, "realtime status should include MCP readiness");
  assert(realtime.liveEvents.length >= 3, "realtime status should include live events");
  assert(runs.length >= 1, "analysis should persist a run");
  console.log("smoke test passed");
} finally {
  child.kill("SIGTERM");
}

async function approveIncident(incidentKey, requestId) {
  const payload = {
    type: "block_actions",
    user: { id: "U-HACK-JUDGE" },
    actions: [{ action_id: "approve_remediation", value: JSON.stringify({ incidentKey, requestId }) }]
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${crypto.createHmac("sha256", slackSigningSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  await requestJson("/api/slack/interactions", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature
    }
  });
}

function requestText(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: options.portNumber || port,
      path,
      method: "GET"
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        const expected = options.expectedStatus || 200;
        if (res.statusCode !== expected) {
          reject(new Error(`${path} returned ${res.statusCode}, expected ${expected}: ${raw}`));
          return;
        }
        resolve(raw);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForServer(portNumber) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await requestJson("/api/health", { portNumber });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("server did not become healthy");
}

function requestJson(path, options = {}) {
  const body = options.body || null;
  const headers = {
    ...(options.headers || {})
  };
  if (body) {
    headers["content-type"] = headers["content-type"] || "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: options.portNumber || port,
      path,
      method: options.method || "GET",
      headers
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode > 299) {
          reject(new Error(`${path} returned ${res.statusCode}: ${raw}`));
          return;
        }
        resolve(JSON.parse(raw));
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
