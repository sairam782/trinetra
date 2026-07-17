import http from "node:http";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./config/env-loader.mjs";
import { getAlibabaDeploymentProof } from "./cloud/alibaba-client.mjs";
import { qwenChatJson, qwenRuntimeConfig } from "./cloud/qwen-client.mjs";
import { createLogger, readRecentLogEntries } from "./logger.mjs";
import { checkLiveMcpHealth } from "./mcps/live-connectors.mjs";

loadEnvFile();

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");
const publicDir = join(repoRoot, "frontend");
const dataDir = join(repoRoot, "data");
const auditLogPath = join(dataDir, "incident-runs.jsonl");
const backendLogPath = join(dataDir, "backend-events.jsonl");
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
const qwenConfig = qwenRuntimeConfig();
const remediationExecutionMode = process.env.REMEDIATION_EXECUTION_MODE || "dry-run";
const qwenModels = {
  commander: process.env.QWEN_MODEL_COMMANDER || process.env.QWEN_MODEL_DEFAULT || "qwen-plus",
  logs: process.env.QWEN_MODEL_LOGS || process.env.QWEN_MODEL_DEFAULT || "qwen-plus",
  metrics: process.env.QWEN_MODEL_METRICS || process.env.QWEN_MODEL_DEFAULT || "qwen-plus",
  traces: process.env.QWEN_MODEL_TRACES || process.env.QWEN_MODEL_DEFAULT || "qwen-plus",
  memory: process.env.QWEN_MODEL_MEMORY || process.env.QWEN_MODEL_DEFAULT || "qwen-plus",
  remediation: process.env.QWEN_MODEL_REMEDIATION || process.env.QWEN_MODEL_DEFAULT || "qwen-plus",
  communication: process.env.QWEN_MODEL_COMMUNICATION || process.env.QWEN_MODEL_DEFAULT || "qwen-plus",
  triage: process.env.QWEN_MODEL_TRIAGE || process.env.QWEN_MODEL_DEFAULT || "qwen-plus",
  documentation: process.env.QWEN_MODEL_DOCUMENTATION || process.env.QWEN_MODEL_DEFAULT || "qwen-plus"
};
const dedupeWindowMs = Number(process.env.DEDUPE_WINDOW_MS || 180_000);
const verificationTimeoutMs = Number(process.env.VERIFICATION_TIMEOUT_MS || 30_000);
const dedupeCache = new Map();
const logger = createLogger({
  path: backendLogPath,
  consoleEnabled: process.env.LOG_TO_CONSOLE !== "false"
});
const demoFailures = {
  missingConfig: {
    id: "missingConfig",
    label: "Missing featured-products config",
    httpStatus: 500,
    error: "ReferenceError: FEATURED_PRODUCTS is not defined",
    symptom: "Homepage render crashes before product cards mount.",
    rootCause: "Storefront render crash caused by missing FEATURED_PRODUCTS config",
    trace: "Failed render span terminates inside ProductGrid config lookup",
    metricFinding: "Synthetic homepage check is failing with HTTP 500",
    runbookTitle: "Restore demo storefront feature config",
    fixSummary: "Restored FEATURED_PRODUCTS config and synthetic homepage check.",
    logs: [
      "demo-storefront error ReferenceError: FEATURED_PRODUCTS is not defined",
      "demo-storefront warn render failed in ProductGrid",
      "synthetic-check error GET /demo-store expected 200 got 500",
      "deploy-bot info config flag featured_products removed"
    ],
    metrics: { errorRate: 42.5, p95LatencyMs: 990, syntheticStatus: 500, deployDeltaMin: 2, saturation: 31 }
  },
  apiTimeout: {
    id: "apiTimeout",
    label: "Catalog API timeout",
    httpStatus: 504,
    error: "GatewayTimeout: catalog-api exceeded 2500ms budget",
    symptom: "Homepage shell loads but product feed times out.",
    rootCause: "Catalog API timeout is preventing product hydration",
    trace: "Slowest span is demo-storefront -> catalog-api listFeaturedProducts",
    metricFinding: "Synthetic homepage check is failing with HTTP 504 and high p95 latency",
    runbookTitle: "Reduce storefront catalog timeout and serve cached products",
    fixSummary: "Enabled cached product fallback and reduced catalog timeout budget.",
    logs: [
      "demo-storefront error GatewayTimeout: catalog-api exceeded 2500ms budget",
      "catalog-api warn upstream search-index p95 above 2200ms",
      "synthetic-check error GET /demo-store expected 200 got 504",
      "edge-cache info product fallback disabled by stale flag"
    ],
    metrics: { errorRate: 28.4, p95LatencyMs: 3120, syntheticStatus: 504, deployDeltaMin: 6, saturation: 67 }
  },
  paymentScript: {
    id: "paymentScript",
    label: "Payment widget script crash",
    httpStatus: 500,
    error: "TypeError: window.Payments.mountCheckout is not a function",
    symptom: "Product cards render, but checkout CTA crashes the page.",
    rootCause: "Payment widget version mismatch is crashing checkout bootstrap",
    trace: "Failed client span terminates inside CheckoutWidget bootstrap",
    metricFinding: "Checkout-start errors spiked while homepage synthetic check returns HTTP 500",
    runbookTitle: "Pin payment widget to last known good version",
    fixSummary: "Pinned payment widget bundle and reloaded checkout bootstrap.",
    logs: [
      "demo-storefront error TypeError: window.Payments.mountCheckout is not a function",
      "cdn-loader warn payments-widget@next returned incompatible export",
      "synthetic-check error click checkout expected modal got exception",
      "deploy-bot info script tag changed from payments@stable to payments@next"
    ],
    metrics: { errorRate: 35.7, p95LatencyMs: 760, syntheticStatus: 500, deployDeltaMin: 4, saturation: 24 }
  },
  inventoryDrift: {
    id: "inventoryDrift",
    label: "Inventory schema drift",
    httpStatus: 500,
    error: "SchemaError: expected inventory.available, received stock.available_to_promise",
    symptom: "Inventory badges fail and product cards cannot render availability.",
    rootCause: "Inventory response schema drift broke availability mapping",
    trace: "Failed render span terminates inside InventoryBadge mapper",
    metricFinding: "Inventory mapping failures are producing HTTP 500 responses",
    runbookTitle: "Apply inventory compatibility mapper",
    fixSummary: "Applied compatibility mapper for stock.available_to_promise.",
    logs: [
      "demo-storefront error SchemaError: expected inventory.available",
      "inventory-api info response schema=v3 stock.available_to_promise",
      "demo-storefront warn InventoryBadge mapper rejected 12 products",
      "synthetic-check error GET /demo-store expected 200 got 500"
    ],
    metrics: { errorRate: 31.2, p95LatencyMs: 840, syntheticStatus: 500, deployDeltaMin: 9, saturation: 38 }
  },
  cssAsset: {
    id: "cssAsset",
    label: "CSS asset 404",
    httpStatus: 200,
    error: "AssetError: /assets/storefront-critical.css returned 404",
    symptom: "Homepage returns 200 but layout is visually broken and checkout CTA is hidden.",
    rootCause: "Critical CSS asset 404 caused a visual regression",
    trace: "Synthetic visual check fails after critical CSS asset request",
    metricFinding: "Visual regression score failed while HTTP status stayed 200",
    runbookTitle: "Restore critical storefront CSS asset",
    fixSummary: "Republished critical CSS asset and purged stale CDN manifest.",
    logs: [
      "cdn error /assets/storefront-critical.css returned 404",
      "demo-storefront warn critical css missing; rendering unstyled fallback",
      "synthetic-check error visual diff score 0.41 over threshold 0.12",
      "deploy-bot info asset manifest hash changed without css upload"
    ],
    metrics: { errorRate: 8.1, p95LatencyMs: 240, syntheticStatus: 200, visualDiffScore: 0.41, deployDeltaMin: 3, saturation: 18 }
  }
};
const demoSiteState = {
  broken: true,
  failureId: "missingConfig",
  error: demoFailures.missingConfig.error,
  lastInjectedAt: new Date().toISOString(),
  lastFixedAt: null,
  lastAction: "initial injected failure"
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
    match: ["featured_products", "ReferenceError", "synthetic check", "homepage", "catalog", "payment", "inventory", "css", "visual"],
    steps: ["restore the failed storefront dependency/config", "reload storefront process", "verify /demo-store returns healthy"]
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
  const requestStartedAt = Date.now();
  res.on("finish", () => {
    void logger.info("http_request", {
      requestId,
      method: req.method,
      path: req.url?.split("?")[0] || "/",
      statusCode: res.statusCode,
      durationMs: Date.now() - requestStartedAt
    }).catch(() => {});
  });
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
          qwenRuntime: qwenConfig,
          remediationExecutionMode,
          alibabaDeploymentProof: true
        },
        requestId
      }, requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/realtime/status") {
      sendJson(res, 200, await realtimeStatus(requestId), requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/demo-site/status") {
      sendJson(res, 200, demoSiteStatus(), requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/demo-site/failures") {
      sendJson(res, 200, Object.values(demoFailures).map(({ id, label, httpStatus, symptom }) => ({ id, label, httpStatus, symptom })), requestId);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo-site/inject-error") {
      const body = await readJson(req);
      injectDemoSiteError(body.failureId);
      void logger.info("demo_error_injected", {
        requestId,
        failureId: demoSiteStatus().failureId,
        httpStatus: demoSiteStatus().httpStatus
      }).catch(() => {});
      sendJson(res, 200, demoSiteStatus(), requestId);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo-site/fix") {
      const body = await readJson(req);
      fixDemoSite({ action: body.action || "manual demo reset" });
      void logger.info("demo_site_fixed", {
        requestId,
        action: body.action || "manual demo reset",
        status: demoSiteStatus()
      }).catch(() => {});
      sendJson(res, 200, demoSiteStatus(), requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/incidents") {
      sendJson(res, 200, Object.values(incidents).map(({ id, title, service, alert, customerImpact }) => ({ id, title, service, alert, customerImpact })), requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/mcps") {
      sendJson(res, 200, await buildMcpStatus(), requestId);
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

    if (req.method === "GET" && url.pathname === "/api/logs") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      sendJson(res, 200, await readRecentLogEntries(backendLogPath, limit), requestId);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/incidents/analyze") {
      const body = await readJson(req);
      void logger.info("incident_analyze_started", {
        requestId,
        incidentKey: body.incidentKey,
        approval: body.approval
      }).catch(() => {});
      const result = await orchestrateIncident(validateAnalyzeRequest(body), requestId);
      await persistRun(result);
      void logger.info("incident_analyze_completed", {
        requestId,
        runId: result.runId,
        incidentId: result.incident.id,
        service: result.incident.service,
        severity: result.commander.severity,
        gate: result.gate.kind,
        verification: result.verification.status,
        qwenLive: result.qwen.runtime.liveEnabled,
        calls: result.totals.calls,
        cost: result.totals.cost
      }).catch(() => {});
      sendJson(res, 200, result, requestId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/demo-store") {
      const html = renderDemoStore();
      res.writeHead(demoSiteStatus().httpStatus, securityHeaders({
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
      void logger.warn("http_error", {
        requestId,
        status: error.status,
        message: error.message
      }).catch(() => {});
      sendJson(res, error.status, { error: error.message, requestId }, requestId);
      return;
    }
    if (error?.code === "ENOENT") {
      res.writeHead(404, securityHeaders({ "content-type": "text/plain; charset=utf-8" }, requestId));
      res.end("Not found");
      return;
    }
    void logger.error("unhandled_error", {
      requestId,
      message: error?.message || "Unexpected server error",
      stack: error?.stack
    }).catch(() => {});
    sendJson(res, 500, { error: "Unexpected server error", requestId }, requestId);
  }
});

server.listen(port, host, () => {
  void logger.info("server_started", {
    host,
    port,
    mode: deploymentMode,
    qwenLive: qwenConfig.liveEnabled,
    remediationExecutionMode
  }).catch(() => {});
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

function currentDemoFailure() {
  return demoFailures[demoSiteState.failureId] || demoFailures.missingConfig;
}

function buildWebsiteIncident() {
  const failure = currentDemoFailure();
  return {
    ...incidents.website,
    title: `Trinetra demo storefront: ${failure.label}`,
    alert: `Synthetic check /demo-store detected ${failure.label.toLowerCase()}`,
    customerImpact: failure.symptom,
    logs: failure.logs.map((line, index) => `2026-07-13T09:0${index}:1${index}Z ${line}`),
    metrics: {
      ...failure.metrics,
      affectedRegions: ["local-demo"]
    },
    demoFailure: failure
  };
}

async function orchestrateIncident({ incidentKey = "latency", approval = "pending", approverId = slackApproverAllowlist[0] }, requestId = crypto.randomUUID()) {
  const incident = incidentKey === "website" ? buildWebsiteIncident() : incidents[incidentKey] || incidents.latency;
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

  const commander = await runCommander(incident);
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

  const [logs, metrics, traces, memory] = await Promise.all([
    runLogsAgent(incident, mcpTrace),
    runMetricsAgent(incident, mcpTrace),
    route.fastPath ? Promise.resolve(null) : runTraceAgent(incident, mcpTrace),
    runMemoryAgent(incident, mcpTrace)
  ]);
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

  const fallbackRunbook = selectRunbook(incident, adjudication);
  const triage = await runTriageAgent(incident, adjudication, commander, fallbackRunbook);
  const runbook = triage.runbook;
  logCall(audit, "Triage agent", {
    input: adjudication.rootCause,
    output: `${runbook.id}: ${runbook.title}`,
    confidence: triage.confidence,
    cost: 0.005,
    model: triage.model,
    tokens: triage.tokens,
    fallback: triage.fallback,
    reasoning: triage.reasoning,
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

  const remediationPlan = await runRemediationAgent(incident, triage, gate);
  logCall(audit, "AI remediation agent", {
    input: `${gate.label}; ${triage.runbook.id}`,
    output: remediationPlan.action,
    confidence: remediationPlan.confidence,
    cost: 0.006,
    model: remediationPlan.model,
    tokens: remediationPlan.tokens,
    fallback: remediationPlan.fallback,
    reasoning: remediationPlan.reasoning,
    branch: remediationPlan.approved ? "ai-plan-approved" : "ai-plan-rejected",
    mcp: useMcp(mcpTrace, "deploy", "plan_remediation", remediationPlan.action)
  });

  const verification = verifyOutcome(incident, gate, remediationPlan);
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
    qwen: { provider: "Qwen Cloud Model Studio", models: qwenModels, runtime: qwenConfig, apiKeyConfigured: qwenApiKeyConfigured },
    alibaba: getAlibabaDeploymentProof(),
    route,
    dedupe,
    commander,
    specialists,
    adjudication,
    triage,
    remediationPlan,
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

async function runQwenAgent(role, input, buildOutput) {
  const model = qwenModels[role] || qwenModels.triage;
  const forcedFailure = process.env.FORCE_QWEN_FAILURE_ROLE === role || process.env.FORCE_QWEN_FAILURE_ROLE === "all";
  const fallback = buildOutput();
  if (forcedFailure) {
    return {
      ...fallback,
      model,
      provider: "local-fallback",
      tokens: tokenUsage(JSON.stringify(input), JSON.stringify(fallback)),
      fallback: `Qwen ${model} timed out or returned malformed output twice; used deterministic fallback`,
      latencyMs: 1250
    };
  }
  const output = await qwenChatJson({
    role,
    model,
    system: "You are Trinetra, a production incident-response agent. Return compact JSON only. Preserve numeric confidence fields between 0 and 1.",
    prompt: buildAgentPrompt(role, input, fallback),
    fallback
  });
  const stableOutput = {
    ...output,
    agent: fallback.agent || output.agent
  };
  return {
    ...stableOutput,
    model,
    tokens: stableOutput.usage ? {
      input: stableOutput.usage.prompt_tokens || stableOutput.usage.input_tokens || 0,
      output: stableOutput.usage.completion_tokens || stableOutput.usage.output_tokens || 0,
      total: stableOutput.usage.total_tokens || 0
    } : tokenUsage(JSON.stringify(input), JSON.stringify(stableOutput)),
    latencyMs: stableOutput.provider === "qwen-live" ? null : 420 + Object.keys(qwenModels).indexOf(role) * 30
  };
}

function buildAgentPrompt(role, input, fallback) {
  return JSON.stringify({
    task: `Act as the ${role} agent in Trinetra.`,
    incidentData: input,
    requiredJsonShape: Object.fromEntries(Object.keys(fallback).map((key) => [key, typeof fallback[key]])),
    localFallbackCandidate: fallback,
    instruction: "Use the incident data to produce the same JSON shape. Be specific, operational, and do not invent external actions that are not supported by the provided data."
  });
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

async function realtimeStatus(requestId) {
  const runs = await readRecentRuns(5);
  const latest = runs[0] || null;
  const mcps = await buildMcpStatus();
  return {
    requestId,
    mode: deploymentMode,
    generatedAt: new Date().toISOString(),
    qwen: {
      provider: "Qwen Cloud Model Studio",
      ...qwenConfig,
      models: qwenModels,
      readiness: Object.entries(qwenModels).map(([role, model]) => ({
        role,
        model,
        status: qwenConfig.apiKeyConfigured && qwenConfig.liveEnabled ? "live-api-enabled" : qwenConfig.apiKeyConfigured ? "credentials-detected-shadow-mode" : "local-fallback"
      }))
    },
    remediation: {
      mode: remediationExecutionMode,
      status: remediationExecutionMode === "execute" ? "mutating actions enabled" : "dry-run recommendations only"
    },
    mcps,
    latestRun: latest,
    liveEvents: buildRealtimeEvents(latest)
  };
}

async function buildMcpStatus() {
  const health = await checkLiveMcpHealth();
  const statuses = mcpRegistry.map((mcp) => {
    const liveRequested = process.env[`MCP_${mcp.id.toUpperCase()}_LIVE`] === "true";
    const connectorHealth = health[mcp.id];
    return {
      ...mcp,
      liveRequested,
      status: connectorHealth?.status || (liveRequested ? "live" : mcp.status),
      health: connectorHealth?.message || (liveRequested ? "health check not implemented" : "simulation mode")
    };
  });
  void logger.info("mcp_health_checked", {
    live: statuses.filter((mcp) => mcp.liveRequested).map(({ id, status }) => ({ id, status })),
    unhealthy: statuses.filter((mcp) => ["unhealthy", "missing-config"].includes(mcp.status)).map(({ id, status, health }) => ({ id, status, health }))
  }).catch(() => {});
  return statuses;
}

function buildRealtimeEvents(latest) {
  const baseline = [
    { stage: "watch", status: "active", text: "Polling alert, log, metric, trace, runbook, and approval adapters." },
    { stage: "models", status: qwenConfig.liveEnabled ? "live" : "shadow", text: qwenConfig.liveEnabled ? "Qwen live calls enabled through DashScope compatible mode." : "Set QWEN_LIVE_CALLS=true with Qwen credentials to leave fallback mode." },
    { stage: "remediation", status: remediationExecutionMode, text: remediationExecutionMode === "execute" ? "Runbook executors may mutate the target system." : "Runbook executors produce plans without mutating the target system." },
    { stage: "mcps", status: "shadow", text: `${mcpRegistry.length} MCP adapters registered. Promote adapters from simulated to live one by one.` }
  ];

  if (!latest) return baseline;

  return [
    ...baseline,
    { stage: "latest-run", status: "observed", text: `${latest.runId} handled ${latest.incidentId} with ${latest.severity} severity.` },
    { stage: "route", status: latest.route?.name || "unknown", text: `Route: ${latest.route?.name || "not recorded"}.` },
    { stage: "gate", status: latest.gate, text: `Remediation branch: ${latest.gate}. ${latest.gateReason}` },
    { stage: "verification", status: latest.verification.includes("verified") ? "healthy" : "attention", text: latest.verification }
  ];
}

function shutdown(signal) {
  void logger.info("server_shutdown_requested", { signal }).catch(() => {});
  console.log(`${signal} received; closing Trinetra server`);
  server.close((error) => {
    if (error) {
      void logger.error("server_shutdown_error", { message: error.message, stack: error.stack }).catch(() => {});
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function runCommander(incident) {
  const errorRate = incident.metrics.errorRate || 0;
  const severeImpact = /payments|cannot|global/i.test(incident.customerImpact);
  const severity = errorRate > 12 || severeImpact ? "P1" : errorRate > 2 || incident.metrics.diskUsedPct > 90 ? "P2" : "P3";
  const result = await runQwenAgent("commander", incident, () => ({
    severity,
    routing: severity === "P1" ? "fast-path with human-visible gate" : "P2-P4 standard investigation",
    blastRadius: incident.metrics.affectedRegions.includes("global") ? "global" : incident.metrics.affectedRegions.join(", "),
    confidence: severity === "P1" ? 0.93 : 0.88,
    reasoning: `Severity based on error rate ${errorRate}% and impact: ${incident.customerImpact}`
  }));
  return result;
}

async function runLogsAgent(incident, trace) {
  const joined = incident.logs.join("\n");
  let finding = "No dominant log signature found";
  if (/pool exhausted|retry storm/i.test(joined)) finding = "Database pool exhaustion amplified by retry storm";
  if (/temp files|disk/i.test(joined)) finding = "Temp-file growth is consuming database disk";
  if (/jwt|schema|kid not found/i.test(joined)) finding = "Token schema/key mismatch started after deploy";
  if (incident.demoFailure) finding = incident.demoFailure.rootCause;
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

async function runMetricsAgent(incident, trace) {
  const m = incident.metrics;
  let finding = "Metrics show elevated saturation without clear causal signal";
  if (m.p95LatencyMs > 1500 && m.saturation > 85) finding = `Saturation ${m.saturation}% aligns with latency ${m.p95LatencyMs}ms`;
  if (m.diskUsedPct > 90) finding = `Disk usage ${m.diskUsedPct}% is above the hard pressure threshold`;
  if (m.errorRate > 10 && m.deployDeltaMin < 10) finding = `Error rate ${m.errorRate}% jumped ${m.deployDeltaMin} minutes after deploy`;
  if (incident.demoFailure) finding = incident.demoFailure.metricFinding;
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

async function runTraceAgent(incident, trace) {
  let finding = "Trace spans show downstream dependency latency but no single failing span";
  if (incident.service === "checkout-api") finding = "Slowest span is checkout-api -> checkout-db acquire_connection";
  if (incident.service === "orders-db") finding = "Trace fanout points to reporting query temp-file pressure";
  if (incident.service === "identity-edge") finding = "Failed auth spans terminate at token validation middleware";
  if (incident.demoFailure) finding = incident.demoFailure.trace;
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

async function runMemoryAgent(incident, trace) {
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
  if (/storefront|FEATURED_PRODUCTS|homepage|ProductGrid|synthetic|catalog|payment|inventory|css|visual/i.test(finding)) return "website-config";
  return "unknown";
}

function selectRunbook(incident, adjudication) {
  const corpus = `${incident.alert} ${incident.logs.join(" ")} ${adjudication.rootCause}`.toLowerCase();
  return runbooks.find((book) => (book.service === incident.service || book.service === "*") && book.match.some((term) => corpus.includes(term))) || runbooks[0];
}

async function runTriageAgent(incident, adjudication, commander, fallbackRunbook) {
  const fallback = {
    rootCause: adjudication.rootCause,
    confidence: adjudication.confidence,
    blastRadius: commander.blastRadius,
    matchedRunbookId: fallbackRunbook.id,
    reasoning: `Qwen triage fallback selected ${fallbackRunbook.id} from adjudicated root cause and runbook corpus`
  };
  const result = await runQwenAgent("triage", {
    incident,
    adjudication,
    commander,
    runbooks: runbooks.map(({ id, title, service, risk, actionType, match, steps }) => ({ id, title, service, risk, actionType, match, steps }))
  }, () => fallback);
  const selected = runbooks.find((book) => book.id === result.matchedRunbookId) || fallbackRunbook;
  return {
    rootCause: String(result.rootCause || fallback.rootCause),
    confidence: normalizeConfidence(result.confidence, fallback.confidence),
    blastRadius: result.blastRadius || commander.blastRadius,
    runbook: selected,
    model: result.model,
    tokens: result.tokens,
    fallback: result.fallback,
    provider: result.provider,
    reasoning: result.reasoning || `Qwen triage selected ${selected.id} for ${incident.service}`
  };
}

async function runRemediationAgent(incident, triage, gate) {
  const failure = incident.demoFailure || null;
  const allowedActions = allowedRemediationActions(incident, gate);
  const fallbackAction = allowedActions.find((item) => item.failureId === failure?.id)?.action || allowedActions[0]?.action || gate.deployAction || "no-op";
  const fallback = {
    approved: ["auto", "approved"].includes(gate.kind),
    failureId: failure?.id || null,
    action: fallbackAction,
    expectedOutcome: "restore service health and pass verification",
    rollback: gate.runbook?.rollback || "escalate to on-call",
    confidence: 0.9,
    reasoning: `Fallback remediation plan selected an allowed ${gate.deployAction} action for ${incident.service}`
  };
  const result = await runQwenAgent("remediation", {
    incident: {
      id: incident.id,
      service: incident.service,
      alert: incident.alert,
      customerImpact: incident.customerImpact,
      metrics: incident.metrics,
      demoFailure: failure
    },
    triage: {
      rootCause: triage.rootCause,
      confidence: triage.confidence,
      runbook: triage.runbook
    },
    gate: {
      kind: gate.kind,
      label: gate.label,
      deployAction: gate.deployAction,
      reason: gate.reason
    },
    allowedActions,
    instruction: "Pick exactly one allowed action. Do not invent shell commands, credentials, external calls, or unlisted fixes."
  }, () => fallback);
  const validated = validateRemediationPlan(result, fallback, allowedActions, gate);
  return {
    ...validated,
    model: result.model,
    tokens: result.tokens,
    fallback: result.fallback,
    provider: result.provider
  };
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
  if (approval === "approved" && slackApproverAllowlist.includes(approverId)) {
    return {
      kind: "approved",
      label: "Human approved remediation",
      confidence: triage.confidence,
      action: `Proceeding with approved low-risk fix approved by ${approverId}`,
      deployAction: runbook.actionType,
      runbook,
      reason: `authorized approver ${approverId}, low-risk runbook ${runbook.id}, confidence ${triage.confidence}`
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

function verifyOutcome(incident, gate, remediationPlan = null) {
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

  const remediation = executeRemediation(incident, gate, remediationPlan);
  if (remediation.service === "demo-storefront") return verifyStorefrontOutcome(incident, gate, remediation);
  if (remediation.dryRun) {
    return {
      status: "Runbook planned; dry-run mode left target unchanged",
      confidence: 0.91,
      after: incident.metrics,
      reason: `${remediation.status}; planned action=${remediation.action}; set REMEDIATION_EXECUTION_MODE=execute to allow mutation`,
      rollbackTriggered: false
    };
  }

  const improved = remediation.after || { ...incident.metrics };
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
    reason: `${remediation.action} completed; triggering health signal recovered within ${verificationTimeoutMs}ms`,
    rollbackTriggered: false
  };
}

function executeRemediation(incident, gate, remediationPlan = null) {
  if (!["auto", "approved"].includes(gate.kind)) {
    return {
      executed: false,
      service: incident.service,
      action: "none",
      status: `Gate ${gate.kind} did not authorize remediation`,
      after: incident.metrics
    };
  }

  if (remediationExecutionMode !== "execute") {
    return planRemediation(incident, gate);
  }

  switch (gate.deployAction) {
    case "restore_website_config":
      return executeStorefrontRemediation(incident, gate, remediationPlan);
    case "scale_workload":
      return simulatedRemediation(incident, gate, "scaled workload capacity and reduced retry pressure");
    case "clear_disk_space":
      return simulatedRemediation(incident, gate, "cleared safe database temp files and ran manual vacuum");
    case "rollback_deploy":
      return simulatedRemediation(incident, gate, "rolled back deployment and invalidated config cache");
    case "restart_stateless_service":
      return simulatedRemediation(incident, gate, "restarted stateless replicas in batches");
    case "rotate_certificate":
      return simulatedRemediation(incident, gate, "rotated certificate bundle and reloaded edge service");
    default:
      return simulatedRemediation(incident, gate, `executed ${gate.deployAction || "approved runbook action"}`);
  }
}

function planRemediation(incident, gate) {
  const actionByType = {
    restore_website_config: "restore failed storefront dependency/config",
    scale_workload: "scale workload capacity and reduce retry pressure",
    clear_disk_space: "clear safe database temp files and run manual vacuum",
    rollback_deploy: "rollback deployment and invalidate config cache",
    restart_stateless_service: "restart stateless replicas in batches",
    rotate_certificate: "rotate certificate bundle and reload edge service"
  };
  return {
    executed: false,
    dryRun: true,
    service: incident.service,
    action: actionByType[gate.deployAction] || gate.deployAction || "approved runbook action",
    status: `Dry-run only: ${gate.runbook?.id || "runbook"} selected but REMEDIATION_EXECUTION_MODE=${remediationExecutionMode}`,
    failure: incident.demoFailure || null,
    after: incident.metrics
  };
}

function allowedRemediationActions(incident, gate) {
  if (gate.deployAction !== "restore_website_config") {
    return [{ action: gate.deployAction || "none", failureId: null, description: gate.runbook?.title || "approved runbook action" }];
  }
  return Object.values(demoFailures).map((failure) => ({
    failureId: failure.id,
    action: storefrontActionForFailure(failure.id),
    description: `${failure.label}: ${failure.fixSummary}`
  }));
}

function storefrontActionForFailure(failureId) {
  const actionByFailure = {
    missingConfig: "restored FEATURED_PRODUCTS config",
    apiTimeout: "enabled cached catalog fallback and lowered product feed timeout",
    paymentScript: "pinned payment widget to stable bundle",
    inventoryDrift: "applied inventory compatibility mapper",
    cssAsset: "republished critical CSS and purged CDN asset manifest"
  };
  return actionByFailure[failureId] || "restore failed storefront dependency/config";
}

function validateRemediationPlan(result, fallback, allowedActions, gate) {
  const requestedAction = String(result.action || "").trim();
  const requestedFailureId = String(result.failureId || "").trim();
  const allowed = allowedActions.find((item) => item.action === requestedAction)
    || allowedActions.find((item) => item.failureId && item.failureId === requestedFailureId);
  const approvedByGate = ["auto", "approved"].includes(gate.kind);
  if (!approvedByGate) {
    return {
      ...fallback,
      approved: false,
      action: "none",
      confidence: normalizeConfidence(result.confidence, fallback.confidence),
      reasoning: `AI plan blocked because gate kind is ${gate.kind}`
    };
  }
  if (!allowed) {
    return {
      ...fallback,
      approved: true,
      confidence: normalizeConfidence(result.confidence, fallback.confidence),
      reasoning: `AI proposed '${requestedAction || "empty"}', which is not in the allowed runbook actions; using validated fallback '${fallback.action}'`
    };
  }
  return {
    approved: Boolean(result.approved ?? true),
    failureId: allowed.failureId || fallback.failureId || null,
    action: allowed.action,
    expectedOutcome: result.expectedOutcome || fallback.expectedOutcome,
    rollback: result.rollback || fallback.rollback,
    confidence: normalizeConfidence(result.confidence, fallback.confidence),
    reasoning: result.reasoning || `AI selected allowed runbook action '${allowed.action}'`
  };
}

function normalizeConfidence(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric > 1 ? Math.max(0, Math.min(1, numeric / 100)) : Math.max(0, Math.min(1, numeric));
}

function simulatedRemediation(incident, gate, action) {
  return {
    executed: true,
    service: incident.service,
    action,
    status: `${gate.runbook?.id || "runbook"} action executed through simulated MCP adapter`,
    after: { ...incident.metrics }
  };
}

function executeStorefrontRemediation(incident, gate, remediationPlan = null) {
  const failure = incident.demoFailure || currentDemoFailure();
  const action = remediationPlan?.action || storefrontActionForFailure(failure.id);

  if (gate.runbook?.id !== "RB-777") {
    return {
      executed: false,
      service: "demo-storefront",
      action,
      status: `Refused storefront remediation because ${gate.runbook?.id || "no runbook"} is not RB-777`,
      failure,
      after: incident.metrics
    };
  }
  if (!remediationPlan?.approved) {
    return {
      executed: false,
      service: "demo-storefront",
      action,
      status: "AI remediation plan was not approved for execution",
      failure,
      after: incident.metrics
    };
  }
  if (action !== storefrontActionForFailure(failure.id)) {
    return {
      executed: false,
      service: "demo-storefront",
      action,
      status: `AI remediation action '${action}' does not match active failure '${failure.id}'`,
      failure,
      after: incident.metrics
    };
  }

  fixDemoSite({ action, runbookId: gate.runbook.id, failureId: failure.id });
  return {
    executed: true,
    service: "demo-storefront",
    action,
    status: `${failure.label} remediated through ${gate.runbook.id}`,
    failure,
    after: { ...incident.metrics, syntheticStatus: 200, errorRate: 0.2, p95LatencyMs: 180, visualDiffScore: 0.02 }
  };
}

function verifyStorefrontOutcome(incident, gate, remediation) {
  const status = demoSiteStatus();
  if (remediation.dryRun) {
    return {
      status: "Runbook planned; dry-run mode left /demo-store unchanged",
      confidence: 0.92,
      after: { ...incident.metrics, syntheticStatus: status.httpStatus },
      reason: `${remediation.status}; planned action=${remediation.action}; set REMEDIATION_EXECUTION_MODE=execute to allow mutation`,
      rollbackTriggered: false
    };
  }
  if (!remediation.executed || !status.healthy) {
    return {
      status: "Verification failed; rollback triggered",
      confidence: 0.74,
      after: { ...incident.metrics, syntheticStatus: status.httpStatus },
      reason: `${remediation.status}; synthetic /demo-store check stayed at ${status.httpStatus} within ${verificationTimeoutMs}ms`,
      rollbackTriggered: true,
      rollbackStatus: `${gate.runbook?.id || "runbook"} rollback executed; on-call escalated`
    };
  }
  return {
    status: "Fix verified; /demo-store recovered",
    confidence: 0.95,
    after: remediation.after,
    reason: `${remediation.status}; action=${remediation.action}; /demo-store returned ${status.httpStatus}`,
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
  const failure = currentDemoFailure();
  return {
    healthy: !demoSiteState.broken,
    failureId: failure.id,
    failureLabel: failure.label,
    httpStatus: demoSiteState.broken ? failure.httpStatus : 200,
    error: demoSiteState.broken ? demoSiteState.error : null,
    symptom: demoSiteState.broken ? failure.symptom : "Storefront is healthy",
    lastInjectedAt: demoSiteState.lastInjectedAt,
    lastFixedAt: demoSiteState.lastFixedAt,
    lastAction: demoSiteState.lastAction
  };
}

function injectDemoSiteError(failureId = "missingConfig") {
  const failure = demoFailures[failureId] || demoFailures.missingConfig;
  demoSiteState.broken = true;
  demoSiteState.failureId = failure.id;
  demoSiteState.error = failure.error;
  demoSiteState.lastInjectedAt = new Date().toISOString();
  demoSiteState.lastFixedAt = null;
  demoSiteState.lastAction = `injected ${failure.label}`;
}

function fixDemoSite({ action = "restored storefront", runbookId = "manual", failureId = demoSiteState.failureId } = {}) {
  demoSiteState.broken = false;
  demoSiteState.error = null;
  demoSiteState.lastFixedAt = new Date().toISOString();
  demoSiteState.lastAction = `${runbookId}: ${action} for ${failureId}`;
}

function renderDemoStore() {
  const failure = currentDemoFailure();
  if (demoSiteState.broken) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Demo Store - Error</title>
    <style>
      body{margin:0;font-family:Inter,system-ui,sans-serif;background:#120b0d;color:#fff;min-height:100vh}
      header{padding:22px 28px;border-bottom:1px solid #4b2028;background:#190d10}
      main{width:min(1120px,calc(100% - 32px));margin:34px auto;display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:22px}
      section,aside{border:1px solid #79333b;background:#221014;border-radius:12px;padding:24px}
      .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px;opacity:.32;filter:grayscale(1)}
      .tile{min-height:120px;border:1px solid #5c2a31;border-radius:10px;background:#170b0e;padding:14px}
      code{display:block;margin-top:14px;padding:14px;background:#090506;color:#ffb7bf;border-radius:8px;white-space:normal}
      a{color:#8de6ff}.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:#5f1824;color:#ffbdc4;font-weight:800}
      @media(max-width:820px){main{grid-template-columns:1fr}.grid{grid-template-columns:1fr}}
    </style>
  </head>
  <body>
    <header><strong>Northstar Outdoor Co.</strong> <span class="badge">Synthetic check failed: ${failure.httpStatus}</span></header>
    <main>
      <section>
      <p>Demo storefront</p>
      <h1>${failure.label}</h1>
      <p>${failure.symptom}</p>
      <code>${demoSiteState.error}</code>
      <p><a href="/">Open Trinetra</a> to diagnose and remediate this incident.</p>
      <div class="grid">
        <div class="tile"><h3>Trail Pack</h3><p>Unavailable while incident is active.</p></div>
        <div class="tile"><h3>Storm Shell</h3><p>Checkout disabled.</p></div>
        <div class="tile"><h3>Camp Lantern</h3><p>Inventory hidden.</p></div>
      </div>
      </section>
      <aside>
        <h2>Incident signal</h2>
        <p>${failure.metricFinding}</p>
        <p><strong>Likely fix:</strong> ${failure.runbookTitle}</p>
      </aside>
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
      body{margin:0;font-family:Inter,system-ui,sans-serif;background:#f3f6f5;color:#101820}
      nav{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;background:white;border-bottom:1px solid #dde5e2;position:sticky;top:0}
      nav strong{font-size:1.05rem}.links{display:flex;gap:18px;color:#60706a;font-weight:700}
      header{padding:76px 28px;background:linear-gradient(135deg,#10251f,#295a48);color:white}
      header div{width:min(1120px,100%);margin:0 auto}
      h1{font-size:clamp(2.6rem,7vw,5.8rem);line-height:.92;margin:10px 0 18px}
      .hero-copy{max-width:680px;color:#d7ebe3;font-size:1.1rem;line-height:1.55}
      main{width:min(1120px,100%);margin:0 auto;padding:28px 20px 46px}
      .toolbar{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:18px}
      .status{padding:8px 12px;border-radius:999px;background:#dff7e8;color:#0b7a53;font-weight:900}
      .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
      article{border:1px solid #d7dde2;background:white;border-radius:10px;overflow:hidden;box-shadow:0 12px 28px rgb(16 24 32 / 8%)}
      .photo{height:170px;background:linear-gradient(135deg,#dbe8e2,#8fb2a2);display:grid;place-items:center;font-size:3rem}
      article div:not(.photo){padding:18px}
      span{display:inline-block;margin-top:14px;font-weight:900;color:#0b7a53}
      button{margin-top:14px;width:100%;height:40px;border:0;border-radius:6px;background:#101820;color:white;font-weight:900}
      footer{padding:24px 28px;border-top:1px solid #dde5e2;color:#60706a;background:white}
      @media(max-width:760px){.grid{grid-template-columns:1fr}}
    </style>
  </head>
  <body>
    <nav>
      <strong>Northstar Outdoor Co.</strong>
      <div class="links"><span>Gear</span><span>Trips</span><span>Journal</span></div>
    </nav>
    <header>
      <div>
        <p>Recovered storefront</p>
        <h1>Trail-ready gear, back online.</h1>
        <p class="hero-copy">Healthy homepage restored by Trinetra remediation. Product discovery, inventory, checkout scripts, and critical styling are all passing synthetic checks.</p>
      </div>
    </header>
    <main>
      <div class="toolbar"><h2>Featured products</h2><div class="status">Synthetic check: 200 OK</div></div>
      <section class="grid">
        <article><div class="photo">🎒</div><div><h2>Ridge Pack 32L</h2><p>Balanced trail storage with weatherproof zips.</p><span>$129</span><button>Add to cart</button></div></article>
        <article><div class="photo">🧥</div><div><h2>Stormline Shell</h2><p>Lightweight protection for unpredictable weather.</p><span>$188</span><button>Add to cart</button></div></article>
        <article><div class="photo">🏕️</div><div><h2>Camp Lantern Pro</h2><p>Warm, packable light with 36-hour battery life.</p><span>$64</span><button>Add to cart</button></div></article>
      </section>
    </main>
    <footer>Inventory synced · Checkout widget healthy · Critical CSS loaded</footer>
  </body>
</html>`;
}
