import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";

export const testSigningSecret = "test-signing-secret";

export async function startServer(overrides = {}) {
  const port = await findFreePort();
  const child = spawn(process.execPath, ["backend/server.mjs"], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      QWEN_LIVE_CALLS: "false",
      REMEDIATION_EXECUTION_MODE: "dry-run",
      SLACK_SIGNING_SECRET: testSigningSecret,
      SLACK_APPROVER_IDS: "U-TEST-JUDGE",
      SYNTHETIC_CHECK_INTERVAL_MS: "60000",
      LOG_TO_CONSOLE: "false",
      RUNBOOK_ALLOWLIST: "RB-101,RB-204,RB-330,RB-401,RB-510,RB-777",
      ...overrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", () => {});
  child.stdout.on("data", () => {});
  await waitForHealthy(port);
  return {
    port,
    kill() {
      child.kill("SIGTERM");
    }
  };
}

export function slackSignatureHeaders(rawBody, secret = testSigningSecret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const base = `v0:${timestamp}:${rawBody}`;
  const signature = `v0=${crypto.createHmac("sha256", secret).update(base).digest("hex")}`;
  return { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature };
}

export function slackApprovalBody({ incidentKey = "website", requestId, approverId = "U-TEST-JUDGE", actionId = "approve_remediation" }) {
  const payload = {
    type: "block_actions",
    user: { id: approverId },
    actions: [{ action_id: actionId, value: JSON.stringify({ incidentKey, requestId }) }]
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

export function request(port, path, options = {}) {
  const body = options.body || null;
  const headers = { ...(options.headers || {}) };
  if (body && !headers["content-type"]) headers["content-type"] = "application/json";
  if (body && !headers["content-length"]) headers["content-length"] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method: options.method || "GET",
      headers
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: raw,
          json: () => raw ? JSON.parse(raw) : null
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealthy(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "/api/health");
      if (res.status === 200) return;
    } catch {
      // still starting up
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server did not become healthy on port ${port}`);
}
