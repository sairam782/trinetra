import http from "node:http";
import { spawn } from "node:child_process";

const port = 4197;
const child = spawn(process.execPath, ["backend/server.mjs"], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "test" },
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
  const websiteAnalysis = await requestJson("/api/incidents/analyze", {
    method: "POST",
    body: JSON.stringify({ incidentKey: "website", approval: "approved", approverId: "U-HACK-JUDGE" })
  });
  const fixedStatus = await requestJson("/api/demo-site/status");
  const fixedSite = await requestText("/demo-store", { expectedStatus: 200 });
  const runbooks = await requestJson("/api/runbooks");
  const alibaba = await requestJson("/api/cloud/alibaba");
  const runs = await requestJson("/api/runs");

  assert(health.ok, "health endpoint should be ok");
  assert(readiness.ready, "readiness endpoint should be ready");
  assert(analysis.audit.length >= 10, "analysis should include audited agent calls");
  assert(analysis.mcps.length >= 10, "analysis should include MCP registry");
  assert(analysis.qwen.models.commander === "qwen3.6-plus", "commander should use qwen3.6-plus");
  assert(analysis.qwen.models.triage === "qwen3.6-max-preview", "triage should use qwen3.6-max-preview");
  assert(analysis.route.name === "P1 fast-path", "deploy scenario should route to P1 fast-path");
  assert(analysis.adjudication.reasoning, "analysis should include adjudication reasoning");
  assert(analysis.gate.reason, "analysis should include remediation gate reason");
  assert(failures.length >= 5, "demo storefront should expose at least five injectable failures");
  assert(brokenSite.includes("Catalog API timeout"), "demo storefront should expose selected injected error");
  assert(websiteAnalysis.triage.runbook.id === "RB-777", "website incident should select the storefront config runbook");
  assert(websiteAnalysis.verification.status.includes("/demo-store recovered"), "website remediation should verify recovery");
  assert(fixedStatus.healthy, "demo storefront should be healthy after Trinetra remediation");
  assert(fixedSite.includes("Healthy homepage restored by Trinetra remediation"), "fixed storefront should render healthy page");
  assert(runbooks.some((book) => book.version && book.approved), "runbooks should be structured and versioned");
  assert(alibaba.provider === "Alibaba Cloud", "Alibaba deployment proof should be exposed");
  assert(runs.length >= 1, "analysis should persist a run");
  console.log("smoke test passed");
} finally {
  child.kill("SIGTERM");
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
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: options.portNumber || port,
      path,
      method: options.method || "GET",
      headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}
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
