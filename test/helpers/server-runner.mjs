import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

export const testSigningSecret = "test-signing-secret";

export async function startServer(overrides = {}) {
  let port;
  const dataDir = await mkdtemp(join(tmpdir(), "trinetra-test-"));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"].includes(key)));
  const child = spawn(process.execPath, ["backend/server.mjs"], {
    env: {
      ...inherited,
      DATA_DIR: dataDir,
      PORT: "0",
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
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.stdout.on("data", (chunk) => { output += chunk; });
  const stopped = once(child, "exit");
  child.on("error", () => {});
  try {
    port = await waitForBoundPort(child, () => output);
    await waitForHealthy(port, child, () => output);
  }
  catch (error) { child.kill("SIGKILL"); await stopped.catch(() => {}); await rm(dataDir, { recursive: true, force: true }); throw error; }
  return {
    port,
    dataDir,
    async kill() {
      child.kill("SIGTERM");
      await stopped;
      await rm(dataDir, { recursive: true, force: true });
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
    req.setTimeout(15000, () => req.destroy(new Error("Test request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function waitForBoundPort(child, output) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onMessage = (message) => {
      if (message?.type !== "ready" || !Number.isInteger(message.port)) return;
      cleanup();
      resolve(message.port);
    };
    const onExit = () => { cleanup(); reject(new Error(`Test server exited: ${output()}`)); };
    const onError = (error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Test server did not bind: ${output()}`)); }, 5000);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function waitForHealthy(port, child, output) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Test server exited: ${output()}`);
    try {
      const res = await request(port, "/api/health");
      if (res.status === 200) return;
    } catch {
      // still starting up
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server did not become healthy on port ${port}: ${output()}`);
}
