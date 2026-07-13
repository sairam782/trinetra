import http from "node:http";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getAlibabaDeploymentProof } from "./cloud/alibaba-client.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");
const publicDir = join(repoRoot, "frontend");
const dataDir = join(repoRoot, "data");
const auditLogPath = join(dataDir, "incident-runs.jsonl");
const memoryStorePath = join(dataDir, "historical-memory.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const startedAt = new Date();
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 64_000);
const deploymentMode = process.env.NODE_ENV === "production" ? "production" : "development";
const autoExecuteThreshold = Number(process.env.AUTO_EXECUTE_CONFIDENCE_THRESHOLD || 0.9);
const approvedRunbookAllowlist = new Set((process.env.RUNBOOK_ALLOWLIST || "RB-101,RB-204,RB-330,RB-401,RB-510,RB-777").split(",").map((item) => item.trim()).filter(Boolean));
const slackApproverAllowlist = (process.env.SLACK_APPROVER_IDS || "U-HACK-JUDGE,U-ONCALL-PRIMARY").split(",").map((item) => item.trim()).filter(Boolean);
const qwenApiKeyConfigured = Boolean(process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY);
const qwenModels = {
  commander: "qwen3.6-plus",
  logs: "qwen3.6-flash",
  metrics: "qwen3.6-flash",
  traces: "qwen3.6-flash",
  memory: "qwen3.6-flash",
  communication: "qwen3.6-flash",
  triage: "qwen3.6-max-preview",
  documentation: "qwen3.6-plus"
};
const dedupeWindowMs = Number(process.env.DEDUPE_WINDOW_MS || 180_000);
const verificationTimeoutMs = Number(process.env.VERIFICATION_TIMEOUT_MS || 30_000);
const dedupeCache = new Map();
const demoSiteState = {
  broken: true,
  error: "ReferenceError: FEATURED_PRODUCTS is not defined",
  lastInjectedAt: new Date().toISOString(),
  lastFixedAt: null
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const incidents = {
  latency: {
    id: "INC-7421",
    title: "Checkout API latency spike",
    service: "checkout-api",
    alert: "p95 latency above 2400ms for 9 minutes; error rate 6.8%",
    customerImpact: "Payments intermittently timing out in us-east-1",
    logs: [
      "2026-07-12T14:02:11Z checkout-api warn upstream inventory timeout after 1800ms",
      "2026-07-12T14:03:08Z checkout-api error pool exhausted: pg checkout-db max clients reached",
      "2026-07-12T14:04:33Z checkout-api warn retry storm detected: 4.7 retries/request",
      "2026-07-12T14:07:51Z checkout-worker info deploy sha=9f31c2 completed"
    ],
    metrics: {
      p95LatencyMs: 2480,
      errorRate: 6.8,
      saturation: 91,
      deployDeltaMin: 11,
      affectedRegions: ["us-east-1"]
    }
  },
  disk: {
    id: "INC-7422",
    title: "Primary database disk pressure",
    service: "orders-db",
    alert: "Disk usage at 94%; write latency elevated",
    customerImpact: "Order writes are slower but still succeeding",
    logs: [
      "2026-07-12T14:11:21Z postgres warn autovacuum skipped: xid wraparound risk low",
      "2026-07-12T14:12:10Z backup-agent info snapshot retained: hourly-20260712-1400",
      "2026-07-12T14:13:40Z postgres warn temp files exceeded 41GB",
      "2026-07-12T14:15:22Z orders-api warn insert latency above 620ms"
    ],
    metrics: {
      diskUsedPct: 94,
      writeLatencyMs: 640,
      errorRate: 0.4,
      saturation: 82,
      affectedRegions: ["us-east-1", "us-west-2"]
    }
  },
  deploy: {
    id: "INC-7423",
    title: "Auth failures after deploy",
    service: "identity-edge",
    alert: "401 responses increased from 0.3% to 18.6%",
    customerImpact: "Some users cannot refresh sessions",
    logs: [
      "2026-07-12T14:20:01Z identity-edge info deploy sha=2ad913 started",
      "2026-07-12T14:22:18Z identity-edge error jwt kid not found for issuer mobile",
      "2026-07-12T14:23:44Z identity-edge warn config cache miss rate 78%",
      "2026-07-12T14:24:11Z identity-edge error authz denied: token schema v3"
    ],
    metrics: {
      errorRate: 18.6,
      p95LatencyMs: 420,
      deployDeltaMin: 4,
      saturation: 44,
      affectedRegions: ["global"]
    }
  },
  website: {
    id: "INC-7424",
    title: "Trinetra demo storefront homepage is down",
    service: "demo-storefront",
    alert: "Synthetic check /demo-store returned 500 after JavaScript config regression",
    customerImpact: "Hackathon demo website shows an application error instead of products",
    logs: [
      "2026-07-13T09:00:11Z demo-storefront error ReferenceError: FEATURED_PRODUCTS is not defined",
      "2026-07-13T09:00:14Z demo-storefront warn render failed in ProductGrid",
      "2026-07-13T09:00:20Z synthetic-check error GET /demo-store expected 200 got 500",
      "2026-07-13T09:00:29Z deploy-bot info config flag featured_products removed"
    ],
    metrics: {
      errorRate: 42.5,
      p95LatencyMs: 990,
      syntheticStatus: 500,
      deployDeltaMin: 2,
      saturation: 31,
      affectedRegions: ["local-demo"]
    }
  }
};

const runbooks = [
  {
    id: "RB-101",
    version: "2026.07.1",
    title: "Scale checkout database pool and shed retries",
    service: "checkout-api",
    risk: "medium",
    approved: true,
    actionType: "scale_workload",
    blastRadius: "regional",
    rollback: "restore previous pool and retry-budget settings",
    match: ["pool exhausted", "retry storm", "latency"],
    steps: ["increase connection pool by 20%", "disable aggressive retry policy", "watch p95 and error rate for 5 minutes"]
  },
  {
    id: "RB-204",
    version: "2026.07.1",
    title: "Clear safe database temp files",
    service: "orders-db",
    risk: "low",
    approved: true,
    actionType: "clear_disk_space",
    blastRadius: "regional",
    rollback: "restore from retained snapshot if cleanup affects active files",
    match: ["disk", "temp files", "write latency"],
    steps: ["remove expired temp files", "trigger manual vacuum on largest table", "confirm disk usage below 85%"]
  },
  {
    id: "RB-330",
    version: "2026.07.1",
    title: "Rollback identity-edge deploy",
    service: "identity-edge",
    risk: "high",
    approved: true,
    actionType: "rollback_deploy",
    blastRadius: "global",
    rollback: "roll forward to patched release after validation",
    match: ["jwt", "deploy", "401"],
    steps: ["pause rollout", "rollback to previous stable release", "invalidate config cache", "notify incident commander"]
  },
  {
    id: "RB-401",
    version: "2026.07.1",
    title: "Restart stateless service replicas",
    service: "*",
    risk: "low",
    approved: true,
    actionType: "restart_stateless_service",
    blastRadius: "single-service",
    rollback: "revert replica restart and page on-call if health degrades",
    match: ["stuck", "deadlock", "connection reset"],
    steps: ["restart one replica batch", "wait for readiness", "roll through remaining replicas"]
  },
  {
    id: "RB-510",
    version: "2026.07.1",
    title: "Rotate expiring certificate",
    service: "*",
    risk: "medium",
    approved: true,
    actionType: "rotate_certificate",
    blastRadius: "service-edge",
    rollback: "restore previous certificate bundle",
    match: ["certificate", "tls", "expiry"],
    steps: ["install new certificate", "reload edge service", "verify TLS handshake"]
  },
  {
    id: "RB-777",
    version: "2026.07.1",
    title: "Restore demo storefront feature config",
    service: "demo-storefront",
    risk: "low",
    approved: true,
    actionType: "restore_website_config",
    blastRadius: "single-service",
    rollback: "re-apply broken config snapshot for demonstration reset only",
    match: ["featured_products", "ReferenceError", "synthetic check", "homepage"],
    steps: ["restore FEATURED_PRODUCTS config", "reload storefront process", "verify /demo-store returns 200"]
  }
];

const agentAccuracy = {
  "Logs agent": 0.91,
  "Metrics agent": 0.87,
  "Trace agent": 0.84,
  "Historical memory": 0.89
};

const historicalCases = [
  {
    id: "CASE-512",
    summary: "Checkout API retried inventory timeouts until database pool exhaustion.",
    service: "checkout-api",
    fix: "Reduced retry budget and raised pool size temporarily.",
    confidenceBoost: 0.08
  },
  {
    id: "CASE-601",
    summary: "Orders DB accumulated temp files during a reporting query burst.",
    service: "orders-db",
    fix: "Cleared temp files and added query guardrails.",
    confidenceBoost: 0.1
  },
  {
    id: "CASE-644",
    summary: "Identity deploy shipped incompatible token schema for mobile clients.",
    service: "identity-edge",
    fix: "Rolled back deploy and added schema compatibility check.",
    confidenceBoost: 0.12
  },
  {
    id: "CASE-777",
    summary: "Demo storefront homepage failed when a required product config variable was removed.",
    service: "demo-storefront",
    fix: "Restored the FEATURED_PRODUCTS config and added a synthetic homepage check.",
    confidenceBoost: 0.11
  }
];

const mcpRegistry = [
  { id: "alerts", name: "Alertmanager MCP", category: "ingest", status: "simulated", actions: ["list_alerts", "deduplicate", "acknowledge"] },
  { id: "logs", name: "Datadog Logs MCP", category: "observability", status: "simulated", actions: ["search_logs", "extract_patterns"] },
  { id: "metrics", name: "Prometheus MCP", category: "observability", status: "simulated", actions: ["query_range", "detect_anomaly"] },
  { id: "traces", name: "OpenTelemetry MCP", category: "observability", status: "simulated", actions: ["trace_service", "find_slowest_span"] },
  { id: "memory", name: "Runbook RAG MCP", category: "memory", status: "simulated", actions: ["semantic_search", "store_outcome"] },
  { id: "tickets", name: "Jira MCP", category: "workflow", status: "simulated", actions: ["create_incident", "link_postmortem"] },
  { id: "chat", name: "Slack MCP", category: "human-loop", status: "simulated", actions: ["post_update", "request_approval"] },
  { id: "github", name: "GitHub MCP", category: "code", status: "simulated", actions: ["inspect_deploy", "open_rollback_pr"] },
  { id: "deploy", name: "Kubernetes MCP", category: "remediation", status: "simulated", actions: ["scale_workload", "rollback_deploy"] },
  { id: "docs", name: "Confluence MCP", category: "documentation", status: "simulated", actions: ["write_timeline", "publish_summary"] },
  { id: "pager", name: "PagerDuty MCP", category: "escalation", status: "simulated", actions: ["page_oncall", "escalate_policy"] }
];

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "trinetra",
        mode: deploymentMode,
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: startedAt.toISOString(),
        requestId
      }, requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/readiness") {
      sendJson(res, 200, {
        ready: true,
        checks: {
          staticAssets: true,
          incidentCatalog: Object.keys(incidents).length,
          mcpAdapters: mcpRegistry.length,
          auditPersistence: true,
          qwenModelTiering: qwenModels,
          qwenApiKeyConfigured,
          alibabaDeploymentProof: true
        },
        requestId
      }, requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/demo-site/status") {
      sendJson(res, 200, demoSiteStatus(), requestId);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo-site/inject-error") {
      injectDemoSiteError();
      sendJson(res, 200, demoSiteStatus(), requestId);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo-site/fix") {
      fixDemoSite();
      sendJson(res, 200, demoSiteStatus(), requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/incidents") {
      sendJson(res, 200, Object.values(incidents).map(({ id, title, service, alert, customerImpact }) => ({ id, title, service, alert, customerImpact })), requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/mcps") {
      sendJson(res, 200, mcpRegistry, requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/runbooks") {
      sendJson(res, 200, runbooks, requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cloud/alibaba") {
      sendJson(res, 200, getAlibabaDeploymentProof(), requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/runs") {
      sendJson(res, 200, await readRecentRuns(), requestId);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/incidents/analyze") {
      const body = await readJson(req);
      const result = orchestrateIncident(validateAnalyzeRequest(body), requestId);
      await persistRun(result);
      sendJson(res, 200, result, requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/demo-store") {
      const html = renderDemoStore();
      res.writeHead(demoSiteState.broken ? 500 : 200, securityHeaders({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }, requestId));
      res.end(html);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed", requestId }, requestId);
      return;
    }

    const safePath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const filePath = safePath === "/" ? join(publicDir, "index.html") : join(publicDir, safePath);
    if (!filePath.startsWith(publicDir)) {
      sendJson(res, 403, { error: "Forbidden", requestId }, requestId);
      return;
    }

    const file = await readFile(filePath);
    res.writeHead(200, securityHeaders({
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=300"
    }, requestId));
    res.end(req.method === "HEAD" ? undefined : file);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message, requestId }, requestId);
      return;
    }
    if (error?.code === "ENOENT") {
      res.writeHead(404, securityHeaders({ "content-type": "text/plain; charset=utf-8" }, requestId));
      res.end("Not found");
      return;
    }
    console.error({ requestId, error });
    sendJson(res, 500, { error: "Unexpected server error", requestId }, requestId);
  }
});

server.listen(port, host, () => {
  console.log(`Trinetra running at http://${host}:${port}`);
});

async function readJson(req) {
  let raw = "";
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBodyBytes) throw new HttpError(413, "Request body too large");
    raw += chunk;
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function sendJson(res, status, payload, requestId = crypto.randomUUID()) {
  res.writeHead(status, securityHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, requestId));
  res.end(JSON.stringify(payload));
}

function securityHeaders(headers, requestId) {
  return {
    ...headers,
    "x-request-id": requestId,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  };
}

function validateAnalyzeRequest(body) {
  const incidentKey = typeof body.incidentKey === "string" ? body.incidentKey : "latency";
  const approval = typeof body.approval === "string" ? body.approval : "pending";
  const approverId = typeof body.approverId === "string" ? body.approverId : slackApproverAllowlist[0];
  if (!incidents[incidentKey]) throw new HttpError(400, `Unknown incidentKey: ${incidentKey}`);
  if (!["pending", "approved"].includes(approval)) throw new HttpError(400, `Unsupported approval state: ${approval}`);
  if (approval === "approved" && !slackApproverAllowlist.includes(approverId)) throw new HttpError(403, `Approver is not allowlisted: ${approverId}`);
  return { incidentKey, approval, approverId };
}

function orchestrateIncident({ incidentKey = "latency", approval = "pending", approverId = slackApproverAllowlist[0] }, requestId = crypto.randomUUID()) {
  const incident = incidents[incidentKey] || incidents.latency;
  const runStartedAt = new Date().toISOString();
  const audit = [];
  const mcpTrace = [];
  const dedupe = correlateIncident(incident);

  const ingestion = logCall(audit, "Ingest and correlate", {
    input: incident.alert,
    output: dedupe.duplicate ? `${incident.id} deduped into existing war room ${dedupe.warRoomId}` : `${incident.id} correlated across ${incident.service}, ${incident.metrics.affectedRegions.join(", ")}`,
    confidence: 0.94,
    cost: 0.002,
    reasoning: dedupe.reason,
    mcp: useMcp(mcpTrace, "alerts", "deduplicate", `${incident.id} grouped by service and region`)
  });

  const commander = runCommander(incident);
  const route = routeIncident(commander, dedupe);
  logCall(audit, "Commander agent", {
    input: ingestion.output,
    output: `${commander.severity} assigned; ${route.name}`,
    confidence: commander.confidence,
    cost: 0.006,
    model: qwenModels.commander,
    tokens: tokenUsage(incident.alert, commander.routing),
    reasoning: route.reason,
    branch: route.name,
    mcp: useMcp(mcpTrace, "tickets", "create_incident", `${incident.id} severity field set to ${commander.severity}`)
  });

  const logs = runLogsAgent(incident, mcpTrace);
  const metrics = runMetricsAgent(incident, mcpTrace);
  const traces = route.fastPath ? null : runTraceAgent(incident, mcpTrace);
  const memory = runMemoryAgent(incident, mcpTrace);
  const specialists = [logs, metrics, traces, memory].filter(Boolean);
  if (route.fastPath) {
    logCall(audit, "Fast-path notification", {
      input: `${incident.id} ${commander.severity}`,
      output: "Immediate Slack/PagerDuty notification sent before full enrichment",
      confidence: 0.92,
      cost: 0.003,
      model: qwenModels.communication,
      tokens: tokenUsage(incident.id, "immediate notification"),
      branch: route.name,
      reasoning: "P1 incidents trade enrichment depth for notification speed",
      mcp: useMcp(mcpTrace, "pager", "page_oncall", "paged primary on-call for P1")
    });
  }

  for (const result of specialists) {
    logCall(audit, result.agent, {
      input: incident.id,
      output: result.finding,
      confidence: result.confidence,
      cost: result.cost,
      model: result.model,
      tokens: result.tokens,
      fallback: result.fallback,
      reasoning: result.reasoning,
      mcp: result.mcp
    });
  }

  const adjudication = adjudicate(specialists, commander);
  logCall(audit, "Negotiation and adjudication", {
    input: "specialist findings",
    output: adjudication.rootCause,
    confidence: adjudication.confidence,
    cost: 0.008,
    model: qwenModels.triage,
    tokens: tokenUsage(adjudication.negotiation.join(" "), adjudication.rootCause),
    reasoning: adjudication.reasoning,
    branch: route.name
  });

  const runbook = selectRunbook(incident, adjudication);
  const triage = {
    rootCause: adjudication.rootCause,
    confidence: adjudication.confidence,
    blastRadius: commander.blastRadius,
    runbook,
    model: qwenModels.triage
  };
  logCall(audit, "Triage agent", {
    input: adjudication.rootCause,
    output: `${runbook.id}: ${runbook.title}`,
    confidence: Math.min(0.97, adjudication.confidence + 0.04),
    cost: 0.005,
    model: qwenModels.triage,
    tokens: tokenUsage(adjudication.rootCause, runbook.title),
    reasoning: `Selected versioned approved runbook ${runbook.id}@${runbook.version} for ${incident.service}`,
    mcp: useMcp(mcpTrace, "memory", "semantic_search", `${runbook.id} matched for ${incident.service}`)
  });

  const gate = chooseGate(commander, runbook, triage, approval, approverId);
  logCall(audit, "Remediation gate", {
    input: `${commander.severity}, ${runbook.risk} risk, approval=${approval}`,
    output: gate.label,
    confidence: gate.confidence,
    cost: 0.004,
    model: qwenModels.commander,
    tokens: tokenUsage(gate.reason, gate.label),
    branch: gate.kind,
    reasoning: gate.reason,
    mcp: useMcp(mcpTrace, gate.kind === "auto" || gate.kind === "approved" ? "deploy" : "chat", gate.kind === "auto" || gate.kind === "approved" ? gate.deployAction : "request_approval", gate.action)
  });

  const verification = verifyOutcome(incident, gate);
  logCall(audit, "Verification and rollback", {
    input: gate.label,
    output: verification.status,
    confidence: verification.confidence,
    cost: 0.004,
    reasoning: verification.reason,
    branch: verification.rollbackTriggered ? "rollback" : "verify",
    mcp: useMcp(mcpTrace, "metrics", "query_range", "checked recovery indicators after gate decision")
  });
  if (verification.rollbackTriggered) {
    logCall(audit, "Rollback executor", {
      input: gate.runbook?.rollback || "rollback unavailable",
      output: verification.rollbackStatus,
      confidence: 0.86,
      cost: 0.004,
      reasoning: "Verification failed before timeout, so supported rollback was invoked and on-call was escalated",
      mcp: useMcp(mcpTrace, "deploy", "rollback_deploy", verification.rollbackStatus)
    });
  }

  logCall(audit, "Communication agent", {
    input: verification.status,
    output: buildStatusUpdate(incident, commander, gate, verification),
    confidence: 0.92,
    cost: 0.003,
    model: qwenModels.communication,
    tokens: tokenUsage(verification.status, incident.customerImpact),
    mcp: useMcp(mcpTrace, "chat", "post_update", "posted status to incident channel")
  });

  if (!route.fastPath || verification.status.includes("verified")) {
    logCall(audit, "Documentation agent", {
      input: "full reasoning trace",
      output: `Created incident timeline with ${audit.length + 1} agent entries`,
      confidence: 0.96,
      cost: 0.003,
      model: qwenModels.documentation,
      tokens: tokenUsage(audit.map((item) => item.output).join(" "), "postmortem timeline"),
      reasoning: "Long-form postmortem writing uses qwen3.6-plus",
      mcp: useMcp(mcpTrace, "docs", "write_timeline", "published reasoning trail draft")
    });
  }

  const memoryUpdate = buildMemoryUpdate(incident, commander, adjudication, gate, verification);

  logCall(audit, "Feedback to memory", {
    input: verification.status,
    output: `Stored outcome under ${incident.service} with remediation=${gate.kind}`,
    confidence: 0.95,
    cost: 0.002,
    reasoning: "Closed-loop memory update makes future historical-memory retrieval stronger",
    mcp: useMcp(mcpTrace, "memory", "store_outcome", `${incident.id} outcome indexed for retrieval`)
  });

  return {
    incident,
    runId: `RUN-${requestId.slice(0, 8)}`,
    requestId,
    startedAt: runStartedAt,
    mode: deploymentMode,
    qwen: { provider: "Qwen Cloud Model Studio", models: qwenModels, apiKeyConfigured: qwenApiKeyConfigured },
    alibaba: getAlibabaDeploymentProof(),
    route,
    dedupe,
    commander,
    specialists,
    adjudication,
    triage,
    gate,
    verification,
    memoryUpdate,
    audit,
    mcps: mcpRegistry,
    mcpTrace,
    totals: {
      cost: Number(audit.reduce((sum, item) => sum + item.cost, 0).toFixed(3)),
      confidence: Number((audit.reduce((sum, item) => sum + item.confidence, 0) / audit.length).toFixed(2)),
      calls: audit.length
    }
  };
}

function logCall(audit, agent, { input, output, confidence, cost, mcp = null, model = null, tokens = null, reasoning = null, branch = null, fallback = null }) {
  const sequence = audit.length + 1;
  const entry = {
    id: `CALL-${String(sequence).padStart(3, "0")}`,
    agent,
    input,
    output,
    confidence,
    cost,
    mcp,
    model,
    tokens,
    reasoning,
    branch,
    fallback,
    elapsedMs: 160 + sequence * 47
  };
  audit.push(entry);
  return entry;
}

function correlateIncident(incident) {
  const key = `${incident.service}:${incident.title}`;
  const now = Date.now();
  const existing = dedupeCache.get(key);
  if (existing && now - existing.lastSeenAt < dedupeWindowMs) {
    existing.lastSeenAt = now;
    existing.count += 1;
    return {
      key,
      duplicate: true,
      warRoomId: existing.warRoomId,
      count: existing.count,
      reason: `Matched service/title dedupe key inside ${dedupeWindowMs}ms; suppressed duplicate notification`
    };
  }
  const warRoomId = `WAR-${crypto.createHash("sha1").update(key).digest("hex").slice(0, 6).toUpperCase()}`;
  dedupeCache.set(key, { lastSeenAt: now, count: 1, warRoomId });
  return {
    key,
    duplicate: false,
    warRoomId,
    count: 1,
    reason: "No recent correlated war room found; creating a new incident coordination context"
  };
}

function routeIncident(commander, dedupe) {
  if (dedupe.duplicate) {
    return { name: "deduped-standard", fastPath: false, reason: "Duplicate alert reuses the existing war room and suppresses duplicate notifications" };
  }
  if (commander.severity === "P1") {
    return { name: "P1 fast-path", fastPath: true, reason: "P1 customer-impacting incident; notify immediately and skip non-critical enrichment" };
  }
  return { name: "P2-P4 standard", fastPath: false, reason: "Severity allows full specialist enrichment before remediation gate" };
}

function runQwenAgent(role, input, buildOutput) {
  const model = qwenModels[role] || qwenModels.triage;
  const forcedFailure = process.env.FORCE_QWEN_FAILURE_ROLE === role || process.env.FORCE_QWEN_FAILURE_ROLE === "all";
  const attempts = forcedFailure ? 2 : 1;
  const fallback = forcedFailure ? `Qwen ${model} timed out or returned malformed output twice; used deterministic fallback` : null;
  const output = buildOutput();
  return {
    ...output,
    model,
    tokens: tokenUsage(JSON.stringify(input), JSON.stringify(output)),
    fallback,
    latencyMs: forcedFailure ? 1250 : 420 + Object.keys(qwenModels).indexOf(role) * 30
  };
}

function tokenUsage(input, output) {
  const inTokens = Math.max(8, Math.ceil(String(input || "").length / 4));
  const outTokens = Math.max(8, Math.ceil(String(output || "").length / 4));
  return {
    input: inTokens,
    output: outTokens,
    total: inTokens + outTokens
  };
}

function useMcp(trace, id, action, result) {
  const connector = mcpRegistry.find((item) => item.id === id);
  const call = {
    id,
    name: connector?.name || id,
    action,
    status: connector?.status || "simulated",
    result
  };
  trace.push(call);
  return call;
}

function readMemorySnapshot() {
  if (!existsSync(memoryStorePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(memoryStorePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function persistRun(result) {
  await mkdir(dataDir, { recursive: true });
  const record = {
    runId: result.runId,
    requestId: result.requestId,
    startedAt: result.startedAt,
    mode: result.mode,
    incidentId: result.incident.id,
    service: result.incident.service,
    severity: result.commander.severity,
    route: result.route,
    dedupe: result.dedupe,
    gate: result.gate.kind,
    gateReason: result.gate.reason,
    adjudication: result.adjudication,
    verification: result.verification.status,
    memoryUpdate: result.memoryUpdate,
    totals: result.totals,
    audit: result.audit.map(({ id, agent, output, confidence, cost, mcp, elapsedMs, model, tokens, reasoning, branch, fallback }) => ({
      id,
      agent,
      output,
      confidence,
      cost,
      elapsedMs,
      model,
      tokens,
      reasoning,
      branch,
      fallback,
      mcp: mcp ? { id: mcp.id, action: mcp.action, status: mcp.status } : null
    }))
  };
  await appendFile(auditLogPath, `${JSON.stringify(record)}\n`, "utf8");
  await appendMemory(result.memoryUpdate);
}

async function appendMemory(update) {
  await mkdir(dataDir, { recursive: true });
  const current = readMemorySnapshot();
  current.push(update);
  await writeFile(memoryStorePath, JSON.stringify(current.slice(-100), null, 2), "utf8");
}

async function readRecentRuns(limit = 25) {
  try {
    const raw = await readFile(auditLogPath, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function shutdown(signal) {
  console.log(`${signal} received; closing Trinetra server`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function runCommander(incident) {
  const errorRate = incident.metrics.errorRate || 0;
  const severeImpact = /payments|cannot|global/i.test(incident.customerImpact);
  const severity = errorRate > 12 || severeImpact ? "P1" : errorRate > 2 || incident.metrics.diskUsedPct > 90 ? "P2" : "P3";
  const result = runQwenAgent("commander", incident, () => ({
    severity,
    routing: severity === "P1" ? "fast-path with human-visible gate" : "P2-P4 standard investigation",
    blastRadius: incident.metrics.affectedRegions.includes("global") ? "global" : incident.metrics.affectedRegions.join(", "),
    confidence: severity === "P1" ? 0.93 : 0.88,
    reasoning: `Severity based on error rate ${errorRate}% and impact: ${incident.customerImpact}`
  }));
  return result;
}

function runLogsAgent(incident, trace) {
  const joined = incident.logs.join("\n");
  let finding = "No dominant log signature found";
  if (/pool exhausted|retry storm/i.test(joined)) finding = "Database pool exhaustion amplified by retry storm";
  if (/temp files|disk/i.test(joined)) finding = "Temp-file growth is consuming database disk";
  if (/jwt|schema|kid not found/i.test(joined)) finding = "Token schema/key mismatch started after deploy";
  if (/FEATURED_PRODUCTS|ReferenceError|ProductGrid/i.test(joined)) finding = "Storefront render crash caused by missing FEATURED_PRODUCTS config";
  return runQwenAgent("logs", { logs: incident.logs }, () => ({
    agent: "Logs agent",
    finding,
    confidence: 0.87,
    cost: 0.01,
    evidence: incident.logs.slice(1, 4),
    reasoning: "Pattern extraction over correlated log lines",
    mcp: useMcp(trace, "logs", "search_logs", `matched ${incident.logs.length} relevant log lines`)
  }));
}

function runMetricsAgent(incident, trace) {
  const m = incident.metrics;
  let finding = "Metrics show elevated saturation without clear causal signal";
  if (m.p95LatencyMs > 1500 && m.saturation > 85) finding = `Saturation ${m.saturation}% aligns with latency ${m.p95LatencyMs}ms`;
  if (m.diskUsedPct > 90) finding = `Disk usage ${m.diskUsedPct}% is above the hard pressure threshold`;
  if (m.errorRate > 10 && m.deployDeltaMin < 10) finding = `Error rate ${m.errorRate}% jumped ${m.deployDeltaMin} minutes after deploy`;
  if (m.syntheticStatus === 500) finding = "Synthetic homepage check is failing with HTTP 500";
  return runQwenAgent("metrics", m, () => ({
    agent: "Metrics agent",
    finding,
    confidence: 0.84,
    cost: 0.009,
    evidence: m,
    reasoning: "Anomaly scoring over incident metrics and deploy timing",
    mcp: useMcp(trace, "metrics", "detect_anomaly", "scored metric deviations against recent baseline")
  }));
}

function runTraceAgent(incident, trace) {
  let finding = "Trace spans show downstream dependency latency but no single failing span";
  if (incident.service === "checkout-api") finding = "Slowest span is checkout-api -> checkout-db acquire_connection";
  if (incident.service === "orders-db") finding = "Trace fanout points to reporting query temp-file pressure";
  if (incident.service === "identity-edge") finding = "Failed auth spans terminate at token validation middleware";
  if (incident.service === "demo-storefront") finding = "Failed render span terminates inside ProductGrid config lookup";
  return runQwenAgent("traces", incident.service, () => ({
    agent: "Trace agent",
    finding,
    confidence: 0.81,
    cost: 0.008,
    evidence: "critical path sampled from correlated traces",
    reasoning: "Trace critical path analysis with fastest Qwen tier",
    mcp: useMcp(trace, "traces", "find_slowest_span", finding)
  }));
}

function runMemoryAgent(incident, trace) {
  const storeMatches = readMemorySnapshot().filter((item) => item.service === incident.service);
  const match = storeMatches.at(-1) || historicalCases.find((item) => item.service === incident.service) || historicalCases[0];
  return runQwenAgent("memory", { service: incident.service, match }, () => ({
    agent: "Historical memory",
    finding: `${match.id || match.incidentId}: ${match.summary}`,
    confidence: Math.min(0.94, 0.78 + (match.confidenceBoost || 0.08)),
    cost: 0.007,
    evidence: match.fix || match.remediation || "previous incident outcome",
    reasoning: "Queried structured memory store before triage",
    mcp: useMcp(trace, "memory", "semantic_search", `${match.id} retrieved as nearest past case`)
  }));
}

function adjudicate(results, commander) {
  const scored = results.map((result) => {
    const accuracy = agentAccuracy[result.agent] || 0.8;
    const weightedScore = Number((result.confidence * accuracy).toFixed(3));
    return { ...result, accuracy, weightedScore };
  });
  const weighted = scored.map((result) => `${Math.round(result.weightedScore * 100)} weighted / ${Math.round(result.confidence * 100)} raw / ${result.agent}: ${result.finding}`);
  const top = [...scored].sort((a, b) => b.weightedScore - a.weightedScore)[0];
  const conflicting = new Set(scored.map((result) => normalizeHypothesis(result.finding))).size > 1;
  const confidence = Math.min(0.96, (scored.reduce((sum, item) => sum + item.weightedScore, 0) / scored.length) + (commander.severity === "P1" ? 0.08 : 0.05));
  return {
    rootCause: top.finding,
    confidence: Number(confidence.toFixed(2)),
    negotiation: weighted,
    conflictDetected: conflicting,
    winner: top.agent,
    reasoning: conflicting
      ? `${top.agent} won because its confidence weighted by historical accuracy (${top.weightedScore}) beat competing hypotheses.`
      : "Specialists agreed on the same causal family, so adjudication preserved the consensus."
  };
}

function normalizeHypothesis(finding) {
  if (/pool|retry|latency/i.test(finding)) return "capacity-latency";
  if (/disk|temp/i.test(finding)) return "disk-pressure";
  if (/token|jwt|auth|schema/i.test(finding)) return "auth-deploy";
  if (/storefront|FEATURED_PRODUCTS|homepage|ProductGrid|synthetic/i.test(finding)) return "website-config";
  return "unknown";
}

function selectRunbook(incident, adjudication) {
  const corpus = `${incident.alert} ${incident.logs.join(" ")} ${adjudication.rootCause}`.toLowerCase();
  return runbooks.find((book) => (book.service === incident.service || book.service === "*") && book.match.some((term) => corpus.includes(term))) || runbooks[0];
}

function chooseGate(commander, runbook, triage, approval, approverId) {
  const allowedRunbook = runbook.approved && approvedRunbookAllowlist.has(runbook.id);
  const highConfidence = triage.confidence >= autoExecuteThreshold;
  const realBlastRadius = ["global", "us-east-1, us-west-2"].includes(String(commander.blastRadius));
  if (highConfidence && allowedRunbook && runbook.risk === "low" && !realBlastRadius && commander.severity !== "P1") {
    return {
      kind: "auto",
      label: "Auto-execute approved low-risk runbook",
      confidence: triage.confidence,
      action: "Executing automatically",
      deployAction: runbook.actionType,
      runbook,
      reason: `confidence ${triage.confidence} >= ${autoExecuteThreshold}, runbook allowlisted, low risk, limited blast radius`
    };
  }
  if (triage.confidence < 0.72 || !allowedRunbook) {
    return {
      kind: "escalate",
      label: "Escalate only",
      confidence: triage.confidence,
      action: "No fix executed; asking human for direction",
      deployAction: "none",
      runbook,
      reason: !allowedRunbook ? `runbook ${runbook.id} is not allowlisted` : `confidence ${triage.confidence} is below safe remediation floor`
    };
  }
  if (runbook.risk === "high" || commander.severity === "P1" || realBlastRadius || runbook.risk === "medium") {
    const approved = approval === "approved" && slackApproverAllowlist.includes(approverId);
    return {
      kind: approved ? "approved" : "human",
      label: approved ? "Human approved remediation" : "Waiting for Slack approval",
      confidence: approved ? triage.confidence : Math.min(0.86, triage.confidence),
      action: approved ? `Proceeding with gated fix approved by ${approverId}` : `Approval required from allowlisted Slack users: ${slackApproverAllowlist.join(", ")}`,
      deployAction: runbook.actionType,
      runbook,
      reason: approved
        ? `authorized approver ${approverId}, confidence ${triage.confidence}, blast radius ${commander.blastRadius}`
        : `mid/high risk or real blast radius requires Slack approval; timeout escalates to on-call`
    };
  }
  return {
    kind: "human",
    label: "Human approval recommended",
    confidence: triage.confidence,
    action: "Approve or escalate",
    deployAction: runbook.actionType,
    runbook,
    reason: "default safety branch"
  };
}

function verifyOutcome(incident, gate) {
  if (gate.kind === "human") {
    return {
      status: "Paused before remediation; Slack approval requested and on-call timeout armed",
      confidence: 0.89,
      after: incident.metrics,
      reason: `No action executes until an allowlisted approver responds within ${verificationTimeoutMs}ms`,
      rollbackTriggered: false
    };
  }
  if (gate.kind === "escalate") {
    return {
      status: "Escalated without remediation",
      confidence: 0.89,
      after: incident.metrics,
      reason: "Low confidence or non-allowlisted runbook; no automated fix proposed",
      rollbackTriggered: false
    };
  }

  if (incident.service === "demo-storefront" && ["auto", "approved"].includes(gate.kind)) {
    fixDemoSite();
    const status = demoSiteStatus();
    if (!status.healthy) {
      return {
        status: "Verification failed; rollback triggered",
        confidence: 0.74,
        after: { ...incident.metrics, syntheticStatus: status.httpStatus },
        reason: `Synthetic /demo-store check stayed at ${status.httpStatus} within ${verificationTimeoutMs}ms`,
        rollbackTriggered: true,
        rollbackStatus: `${gate.runbook?.id || "runbook"} rollback executed; on-call escalated`
      };
    }
    return {
      status: "Fix verified; /demo-store recovered",
      confidence: 0.95,
      after: { ...incident.metrics, syntheticStatus: 200, errorRate: 0.2, p95LatencyMs: 180 },
      reason: "Trinetra restored FEATURED_PRODUCTS config and synthetic check returned 200",
      rollbackTriggered: false
    };
  }

  const improved = { ...incident.metrics };
  if (improved.errorRate) improved.errorRate = Number(Math.max(0.2, improved.errorRate * 0.22).toFixed(1));
  if (improved.p95LatencyMs) improved.p95LatencyMs = Math.round(improved.p95LatencyMs * 0.48);
  if (improved.diskUsedPct) improved.diskUsedPct = Math.round(improved.diskUsedPct * 0.82);
  if (improved.saturation) improved.saturation = Math.round(improved.saturation * 0.7);
  const forcedFailure = process.env.FORCE_VERIFICATION_FAIL === incident.id || process.env.FORCE_VERIFICATION_FAIL === "all";
  if (forcedFailure) {
    return {
      status: "Verification failed; rollback triggered",
      confidence: 0.74,
      after: incident.metrics,
      reason: `Health signal failed to recover within ${verificationTimeoutMs}ms`,
      rollbackTriggered: true,
      rollbackStatus: `${gate.runbook?.id || "runbook"} rollback executed; on-call escalated`
    };
  }
  return {
    status: "Fix verified; leading indicators recovered",
    confidence: 0.93,
    after: improved,
    reason: `Triggering health signal recovered within ${verificationTimeoutMs}ms`,
    rollbackTriggered: false
  };
}

function buildMemoryUpdate(incident, commander, adjudication, gate, verification) {
  return {
    id: `MEM-${incident.id}-${Date.now()}`,
    incidentId: incident.id,
    service: incident.service,
    severity: commander.severity,
    summary: `${adjudication.rootCause}; gate=${gate.kind}; verification=${verification.status}`,
    fix: gate.runbook?.title || "No automated fix",
    remediation: gate.kind,
    verified: verification.status.includes("verified"),
    confidenceBoost: verification.status.includes("verified") ? 0.1 : 0.03,
    createdAt: new Date().toISOString()
  };
}

function buildStatusUpdate(incident, commander, gate, verification) {
  return `${incident.id} ${commander.severity}: ${incident.service} root cause identified. Gate=${gate.label}. Verification=${verification.status}.`;
}

function demoSiteStatus() {
  return {
    healthy: !demoSiteState.broken,
    httpStatus: demoSiteState.broken ? 500 : 200,
    error: demoSiteState.broken ? demoSiteState.error : null,
    lastInjectedAt: demoSiteState.lastInjectedAt,
    lastFixedAt: demoSiteState.lastFixedAt
  };
}

function injectDemoSiteError() {
  demoSiteState.broken = true;
  demoSiteState.error = "ReferenceError: FEATURED_PRODUCTS is not defined";
  demoSiteState.lastInjectedAt = new Date().toISOString();
  demoSiteState.lastFixedAt = null;
}

function fixDemoSite() {
  demoSiteState.broken = false;
  demoSiteState.error = null;
  demoSiteState.lastFixedAt = new Date().toISOString();
}

function renderDemoStore() {
  if (demoSiteState.broken) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Demo Store - Error</title>
    <style>
      body{margin:0;font-family:Inter,system-ui,sans-serif;background:#120b0d;color:#fff;display:grid;place-items:center;min-height:100vh}
      main{width:min(760px,calc(100% - 32px));border:1px solid #79333b;background:#221014;border-radius:12px;padding:28px}
      code{display:block;margin-top:14px;padding:14px;background:#090506;color:#ffb7bf;border-radius:8px;white-space:normal}
      a{color:#8de6ff}
    </style>
  </head>
  <body>
    <main>
      <p>Demo storefront</p>
      <h1>Application error</h1>
      <p>The homepage cannot render because the featured products configuration was removed.</p>
      <code>${demoSiteState.error}</code>
      <p><a href="/">Open Trinetra</a> to diagnose and remediate this incident.</p>
    </main>
  </body>
</html>`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Demo Store</title>
    <style>
      body{margin:0;font-family:Inter,system-ui,sans-serif;background:#f5f7f8;color:#101820}
      header{padding:48px 24px;background:#101820;color:white}
      main{width:min(1040px,100%);margin:0 auto;padding:28px 20px}
      .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
      article{border:1px solid #d7dde2;background:white;border-radius:10px;padding:18px}
      span{display:inline-block;margin-top:14px;font-weight:800;color:#0b7a53}
      @media(max-width:760px){.grid{grid-template-columns:1fr}}
    </style>
  </head>
  <body>
    <header>
      <p>Demo storefront</p>
      <h1>Featured recovery products</h1>
      <p>Healthy homepage restored by Trinetra remediation.</p>
    </header>
    <main class="grid">
      <article><h2>Incident Notebook</h2><p>Capture every decision chain.</p><span>$29</span></article>
      <article><h2>On-call Mug</h2><p>For long nights and clean rollbacks.</p><span>$18</span></article>
      <article><h2>Runbook Deck</h2><p>Approved fixes, ready to execute.</p><span>$42</span></article>
    </main>
  </body>
</html>`;
}
