const els = {
  demoModeButton: document.querySelector("#demoModeButton"),
  realtimeModeButton: document.querySelector("#realtimeModeButton"),
  demoPanel: document.querySelector("#demoPanel"),
  realtimePanel: document.querySelector("#realtimePanel"),
  realtimeGeneratedAt: document.querySelector("#realtimeGeneratedAt"),
  realtimeEvents: document.querySelector("#realtimeEvents"),
  qwenReadiness: document.querySelector("#qwenReadiness"),
  modelReadiness: document.querySelector("#modelReadiness"),
  mcpReadiness: document.querySelector("#mcpReadiness"),
  incidentSelect: document.querySelector("#incidentSelect"),
  approvalSelect: document.querySelector("#approvalSelect"),
  runButton: document.querySelector("#runButton"),
  failureSelect: document.querySelector("#failureSelect"),
  injectErrorButton: document.querySelector("#injectErrorButton"),
  solveWebsiteButton: document.querySelector("#solveWebsiteButton"),
  demoSiteTitle: document.querySelector("#demoSiteTitle"),
  demoSiteText: document.querySelector("#demoSiteText"),
  modeText: document.querySelector("#modeText"),
  healthText: document.querySelector("#healthText"),
  readinessText: document.querySelector("#readinessText"),
  runIdText: document.querySelector("#runIdText"),
  requestIdText: document.querySelector("#requestIdText"),
  routeText: document.querySelector("#routeText"),
  callCount: document.querySelector("#callCount"),
  avgConfidence: document.querySelector("#avgConfidence"),
  runCost: document.querySelector("#runCost"),
  severityBadge: document.querySelector("#severityBadge"),
  incidentTitle: document.querySelector("#incidentTitle"),
  incidentAlert: document.querySelector("#incidentAlert"),
  serviceName: document.querySelector("#serviceName"),
  impactText: document.querySelector("#impactText"),
  blastRadius: document.querySelector("#blastRadius"),
  routingText: document.querySelector("#routingText"),
  rootCause: document.querySelector("#rootCause"),
  confidenceText: document.querySelector("#confidenceText"),
  gateLabel: document.querySelector("#gateLabel"),
  gateAction: document.querySelector("#gateAction"),
  verificationStatus: document.querySelector("#verificationStatus"),
  metricDelta: document.querySelector("#metricDelta"),
  remediationTimeline: document.querySelector("#remediationTimeline"),
  agentCards: document.querySelector("#agentCards"),
  auditRows: document.querySelector("#auditRows"),
  mcpGrid: document.querySelector("#mcpGrid"),
  mcpTrace: document.querySelector("#mcpTrace"),
  executionTimeline: document.querySelector("#executionTimeline"),
  qwenTrace: document.querySelector("#qwenTrace"),
  recentRuns: document.querySelector("#recentRuns")
};

let currentMode = "demo";
let realtimeTimer = null;

els.demoModeButton.addEventListener("click", () => setMode("demo"));
els.realtimeModeButton.addEventListener("click", () => setMode("realtime"));
els.runButton.addEventListener("click", runAgents);
els.incidentSelect.addEventListener("change", runAgents);
els.approvalSelect.addEventListener("change", runAgents);
els.injectErrorButton.addEventListener("click", injectDemoError);
els.solveWebsiteButton.addEventListener("click", solveWebsiteIncident);

loadFailureOptions();
runAgents();
refreshOpsStatus();
refreshDemoSiteStatus();

function setMode(mode) {
  currentMode = mode;
  const realtime = mode === "realtime";
  els.demoModeButton.classList.toggle("active", !realtime);
  els.realtimeModeButton.classList.toggle("active", realtime);
  els.demoPanel.classList.toggle("hidden", realtime);
  els.realtimePanel.classList.toggle("hidden", !realtime);
  els.runButton.textContent = realtime ? "Run realtime probe" : "Run demo pipeline";

  if (realtime) {
    els.incidentSelect.value = "website";
    refreshRealtimeStatus();
    refreshDemoSiteStatus();
    realtimeTimer = setInterval(refreshRealtimeStatus, 4000);
  } else if (realtimeTimer) {
    clearInterval(realtimeTimer);
    realtimeTimer = null;
  }
}

async function runAgents() {
  setLoading(true);
  try {
    render(await fetchJson("/api/incidents/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        incidentKey: els.incidentSelect.value,
        approval: els.approvalSelect.value
      })
    }));
  } catch (error) {
    console.error(error);
    els.rootCause.textContent = "Could not run incident agents";
    els.confidenceText.textContent = "Check the local server and try again.";
  } finally {
    setLoading(false);
  }
}

function render(data) {
  const { incident, commander, specialists, adjudication, triage, remediationPlan, gate, verification, audit, totals, mcps, mcpTrace, executionTimeline, qwenTrace, runId, requestId, mode, route, qwen } = data;
  els.modeText.textContent = mode;
  els.runIdText.textContent = runId;
  els.requestIdText.textContent = requestId;
  els.routeText.textContent = route?.name || "--";
  els.callCount.textContent = totals.calls;
  els.avgConfidence.textContent = formatPercent(totals.confidence);
  els.runCost.textContent = formatCost(totals.cost);

  els.severityBadge.textContent = commander.severity;
  els.severityBadge.className = commander.severity === "P1" ? "hot" : "warm";
  els.incidentTitle.textContent = `${incident.id}: ${incident.title}`;
  els.incidentAlert.textContent = incident.alert;
  els.serviceName.textContent = incident.service;
  els.impactText.textContent = incident.customerImpact;
  els.blastRadius.textContent = commander.blastRadius;
  els.routingText.textContent = commander.routing;

  els.rootCause.textContent = adjudication.rootCause;
  els.confidenceText.textContent = `Confidence: ${formatPercent(adjudication.confidence)}. Winner: ${valueOrNA(adjudication.winner)}. Runbook: ${valueOrNA(triage.runbook?.id)}. Triage model: ${valueOrNA(qwen.models?.triage)}.`;
  els.gateLabel.textContent = gate.label;
  els.gateAction.textContent = `${gate.action}. Reason: ${gate.reason}. Risk: ${triage.runbook.risk}. Steps: ${triage.runbook.steps.join(" -> ")}.`;
  els.verificationStatus.textContent = verification.status;
  renderMetricDelta(incident.metrics, verification.after);
  renderRemediationTimeline(remediationPlan);
  renderAgents(specialists);
  renderAudit(audit);
  renderExecutionTimeline(executionTimeline || []);
  renderQwenTrace(qwenTrace || []);
  renderMcps(mcps);
  renderMcpTrace(mcpTrace);
  refreshRecentRuns();
}

function renderRemediationTimeline(remediationPlan = {}) {
  const timeline = remediationPlan.timeline || [];
  if (!timeline.length) {
    els.remediationTimeline.replaceChildren(emptyTimelineRow("Waiting for remediation agent"));
    return;
  }
  els.remediationTimeline.replaceChildren(...timeline.slice(-10).map((event) => {
    const row = document.createElement("article");
    row.className = `tool-step ${event.status || "pending"}`;
    row.innerHTML = `
      <span>${statusMark(event.status)}</span>
      <div>
        <strong>${escapeHtml(event.label || "Tool step")}</strong>
        <p>${escapeHtml(event.detail || "")}</p>
      </div>
    `;
    return row;
  }));
}

function emptyTimelineRow(text) {
  const row = document.createElement("article");
  row.className = "tool-step pending";
  row.innerHTML = `<span>·</span><div><strong>${escapeHtml(text)}</strong><p>Run the pipeline to see tool calls.</p></div>`;
  return row;
}

function statusMark(status) {
  if (status === "completed") return "✓";
  if (status === "attention" || status === "blocked") return "!";
  if (status === "selected") return "→";
  return "•";
}

async function refreshOpsStatus() {
  const [health, readiness] = await Promise.allSettled([
    fetchJson("/api/health"),
    fetchJson("/api/readiness")
  ]);
  if (health.status === "fulfilled") {
    els.healthText.textContent = health.value.ok ? "healthy" : "degraded";
    els.modeText.textContent = health.value.mode;
  } else {
    els.healthText.textContent = "offline";
  }
  if (readiness.status === "fulfilled") {
    els.readinessText.textContent = readiness.value.ready ? "ready" : "not ready";
  } else {
    els.readinessText.textContent = "unknown";
  }
}

async function refreshDemoSiteStatus() {
  try {
    const status = await fetchJson("/api/demo-site/status");
    if (status.failureId && els.failureSelect.value !== status.failureId) {
      els.failureSelect.value = status.failureId;
    }
    els.demoSiteTitle.textContent = `Storefront status: ${status.healthy ? "healthy" : "broken"}`;
    els.demoSiteText.textContent = status.healthy
      ? `Recovered from ${status.failureLabel}. /demo-store returns ${status.httpStatus}. Pipeline action: ${status.lastAction || "not yet"}.`
      : `${status.failureLabel} active. /demo-store returns ${status.httpStatus}: ${status.error}. ${status.symptom}`;
  } catch {
    els.demoSiteTitle.textContent = "Storefront status: unknown";
  }
}

async function loadFailureOptions() {
  try {
    const failures = await fetchJson("/api/demo-site/failures");
    els.failureSelect.replaceChildren(...failures.map((failure) => {
      const option = document.createElement("option");
      option.value = failure.id;
      option.textContent = `${failure.label} (${failure.httpStatus})`;
      return option;
    }));
  } catch (error) {
    console.warn(error);
  }
}

async function injectDemoError() {
  await fetchJson("/api/demo-site/inject-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ failureId: els.failureSelect.value })
  });
  els.incidentSelect.value = "website";
  els.approvalSelect.value = "pending";
  await refreshDemoSiteStatus();
  await runAgents();
}

async function solveWebsiteIncident() {
  els.incidentSelect.value = "website";
  els.approvalSelect.value = "approved";
  await runAgents();
  await refreshDemoSiteStatus();
}

async function refreshRecentRuns() {
  try {
    renderRecentRuns(await fetchJson("/api/runs"));
  } catch (error) {
    console.warn(error);
  }
}

async function refreshRealtimeStatus() {
  try {
    const status = await fetchJson("/api/realtime/status");
    renderRealtimeStatus(status);
  } catch (error) {
    console.warn(error);
    els.realtimeGeneratedAt.textContent = "offline";
  }
}

function renderRealtimeStatus(status) {
  els.realtimeGeneratedAt.textContent = new Date(status.generatedAt).toLocaleTimeString();
  els.qwenReadiness.textContent = status.qwen.liveEnabled
    ? "live Qwen calls enabled"
    : status.qwen.apiKeyConfigured ? "Qwen shadow mode" : "local fallback";

  els.realtimeEvents.replaceChildren(...status.liveEvents.map((event) => {
    const row = document.createElement("article");
    row.className = "realtime-event";
    row.innerHTML = `
      <span>${escapeHtml(event.stage)}</span>
      <strong>${escapeHtml(event.status)}</strong>
      <p>${escapeHtml(event.text)}</p>
    `;
    return row;
  }));

  els.modelReadiness.replaceChildren(...status.qwen.readiness.map((model) => {
    const card = document.createElement("article");
    card.className = "readiness-card";
    card.innerHTML = `
      <strong>${escapeHtml(model.role)}</strong>
      <span>${escapeHtml(model.model)}</span>
      <em>${escapeHtml(model.status)}</em>
    `;
    return card;
  }));

  els.mcpReadiness.replaceChildren(...status.mcps.map((mcp) => {
    const card = document.createElement("article");
    card.className = "readiness-card";
    card.innerHTML = `
      <strong>${escapeHtml(mcp.name)}</strong>
      <span>${escapeHtml(mcp.category)}</span>
      <em>${escapeHtml(mcp.status)}</em>
      ${mcp.health ? `<small>${escapeHtml(mcp.health)}</small>` : ""}
    `;
    return card;
  }));
}

async function fetchJson(url, options = {}) {
  if (typeof window.fetch === "function") {
    const response = await window.fetch(url, options);
    if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
    return response.json();
  }
  return xhrJson(url, options);
}

function xhrJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(options.method || "GET", url);
    for (const [key, value] of Object.entries(options.headers || {})) {
      request.setRequestHeader(key, value);
    }
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`${url} failed: ${request.status}`));
        return;
      }
      try {
        resolve(JSON.parse(request.responseText || "null"));
      } catch {
        reject(new Error(`${url} returned invalid JSON`));
      }
    };
    request.onerror = () => reject(new Error(`${url} network error`));
    request.send(options.body || null);
  });
}

function renderAgents(specialists) {
  els.agentCards.replaceChildren(...specialists.map((agent) => {
    const card = document.createElement("article");
    card.className = "agent-card";
    card.innerHTML = `
      <div>
        <h3>${escapeHtml(valueOrNA(agent.agent))}</h3>
        <span>${formatPercent(agent.confidence)}</span>
      </div>
      <p>${escapeHtml(valueOrNA(agent.finding))}</p>
      <em>${escapeHtml(valueOrNA(agent.mcp?.name))} · ${escapeHtml(valueOrNA(agent.mcp?.action))}</em>
      <em>${escapeHtml(valueOrNA(agent.model))} · ${escapeHtml(formatTokens(agent.tokens))}${agent.fallback ? " · fallback" : ""}</em>
      <small>${escapeHtml(formatEvidence(agent.evidence))}</small>
    `;
    return card;
  }));
}

function renderAudit(audit) {
  els.auditRows.replaceChildren(...audit.map((item) => {
    const row = document.createElement("article");
    row.className = "audit-row";
    row.innerHTML = `
      <div class="audit-meta">
        <strong>${escapeHtml(item.agent)}</strong>
        <span>${item.id} · ${formatLatency(item.latencyMs)} · ${formatPercent(item.confidence)}</span>
      </div>
      ${item.model ? `<div class="mcp-chip">${escapeHtml(item.model)} / ${escapeHtml(formatTokens(item.tokens))}${item.fallback ? " / fallback" : ""}</div>` : ""}
      ${item.mcp ? `<div class="mcp-chip">${escapeHtml(item.mcp.name)} / ${escapeHtml(item.mcp.action)} / ${escapeHtml(item.mcp.status)}</div>` : ""}
      ${item.reasoning ? `<p><b>Reasoning:</b> ${escapeHtml(String(item.reasoning))}</p>` : ""}
      <p><b>Input:</b> ${escapeHtml(String(item.input))}</p>
      <p><b>Output:</b> ${escapeHtml(String(item.output))}</p>
    `;
    return row;
  }));
}

function renderExecutionTimeline(events = []) {
  if (!events.length) {
    els.executionTimeline.replaceChildren(emptyTrace("No execution timeline available"));
    return;
  }
  els.executionTimeline.replaceChildren(...events.map((event) => {
    const details = document.createElement("details");
    details.className = "trace-item";
    details.innerHTML = `
      <summary>
        <span>${escapeHtml(formatTime(event.timestamp))}</span>
        <strong>${escapeHtml(valueOrNA(event.label))}</strong>
        <em>${escapeHtml(valueOrNA(event.type))}</em>
      </summary>
      <pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre>
    `;
    return details;
  }));
}

function renderQwenTrace(trace = []) {
  if (!trace.length) {
    els.qwenTrace.replaceChildren(emptyTrace("No Qwen calls available"));
    return;
  }
  els.qwenTrace.replaceChildren(...trace.map((call) => {
    const details = document.createElement("details");
    details.className = "trace-item";
    details.innerHTML = `
      <summary>
        <span>${escapeHtml(formatTime(call.timestamp))}</span>
        <strong>${escapeHtml(valueOrNA(call.agent || call.role))}</strong>
        <em>${escapeHtml(valueOrNA(call.model))} · ${escapeHtml(formatLatency(call.latencyMs))} · ${escapeHtml(formatTokens(call.usage))}</em>
      </summary>
      <section class="trace-block"><h3>System Prompt</h3><pre>${escapeHtml(valueOrNA(call.systemPrompt))}</pre></section>
      <section class="trace-block"><h3>User Prompt</h3><pre>${escapeHtml(valueOrNA(call.userPrompt))}</pre></section>
      <section class="trace-block"><h3>Raw Response</h3><pre>${escapeHtml(valueOrNA(call.rawResponse))}</pre></section>
      <section class="trace-block"><h3>Parsed Response</h3><pre>${escapeHtml(JSON.stringify(call.parsedResponse ?? null, null, 2))}</pre></section>
      <section class="trace-block"><h3>Runtime</h3><pre>${escapeHtml(JSON.stringify({
        provider: call.provider ?? null,
        finishReason: call.finishReason ?? null,
        usage: call.usage ?? null,
        latencyMs: call.latencyMs ?? null,
        timestamp: call.timestamp ?? null,
        error: call.error ?? null
      }, null, 2))}</pre></section>
    `;
    return details;
  }));
}

function emptyTrace(text) {
  const article = document.createElement("article");
  article.className = "trace-empty";
  article.textContent = text;
  return article;
}

function renderMcps(mcps = []) {
  els.mcpGrid.replaceChildren(...mcps.map((mcp) => {
    const card = document.createElement("article");
    card.className = "mcp-card";
    card.innerHTML = `
      <div>
        <strong>${escapeHtml(mcp.name)}</strong>
        <span>${escapeHtml(mcp.status)}</span>
      </div>
      <p>${escapeHtml(mcp.category)}</p>
      <small>${escapeHtml(mcp.actions.join(" · "))}</small>
      ${mcp.health ? `<small>${escapeHtml(mcp.health)}</small>` : ""}
    `;
    return card;
  }));
}

function renderMcpTrace(trace = []) {
  els.mcpTrace.replaceChildren(...trace.map((call, index) => {
    const row = document.createElement("article");
    row.className = "mcp-trace-row";
    row.innerHTML = `
      <span>${String(index + 1).padStart(2, "0")}</span>
      <div>
        <strong>${escapeHtml(call.name)} / ${escapeHtml(call.action)}</strong>
        <p>${escapeHtml(call.note || "")}</p>
        <pre>${escapeHtml(JSON.stringify({ request: call.request, response: call.response, latencyMs: call.latencyMs, status: call.status }, null, 2))}</pre>
      </div>
    `;
    return row;
  }));
}

function renderRecentRuns(runs = []) {
  els.recentRuns.replaceChildren(...runs.slice(0, 8).map((run) => {
    const row = document.createElement("article");
    row.className = "recent-run";
    row.innerHTML = `
      <strong>${escapeHtml(run.runId)} · ${escapeHtml(run.incidentId)} · ${escapeHtml(run.severity)}</strong>
      <span>${escapeHtml(run.service)} / ${escapeHtml(run.route?.name || "route")} / ${escapeHtml(run.gate)} / ${escapeHtml(run.verification)}</span>
      <span>${escapeHtml(run.adjudication?.rootCause || "no root cause")} · ${escapeHtml(run.gateReason || "no gate reason")}</span>
      <small>${escapeHtml(run.startedAt)} · ${run.totals.calls} calls · cost ${escapeHtml(formatCost(run.totals.cost))}</small>
    `;
    return row;
  }));
}

function renderMetricDelta(before, after = {}) {
  const keys = Object.keys(before).filter((key) => typeof before[key] === "number");
  els.metricDelta.replaceChildren(...keys.slice(0, 4).map((key) => {
    const chip = document.createElement("div");
    const improved = after[key] !== undefined && after[key] < before[key];
    chip.className = improved ? "delta good" : "delta";
    chip.innerHTML = `<span>${labelFor(key)}</span><strong>${before[key]} → ${after[key] ?? before[key]}</strong>`;
    return chip;
  }));
}

function formatEvidence(evidence) {
  if (Array.isArray(evidence)) return evidence.join(" | ");
  if (evidence && typeof evidence === "object") return Object.entries(evidence).map(([key, value]) => `${labelFor(key)}=${Array.isArray(value) ? value.join(",") : value}`).join(" · ");
  return evidence || "Not available";
}

function valueOrNA(value) {
  if (value === null || value === undefined || value === "") return "Not available";
  return String(value);
}

function formatPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "Not available";
  return `${Math.round(value * 100)}%`;
}

function formatCost(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "Not available";
  return `$${value.toFixed(4)}`;
}

function formatLatency(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "Not available";
  return `${Math.round(value)} ms`;
}

function formatTokens(tokens) {
  if (!tokens) return "Tokens not available";
  const total = tokens.total_tokens ?? tokens.total;
  if (typeof total !== "number") return "Tokens not available";
  return `${total} tokens`;
}

function formatTime(timestamp) {
  if (!timestamp) return "Not available";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Not available";
  return date.toLocaleTimeString();
}

function labelFor(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function setLoading(isLoading) {
  els.runButton.disabled = isLoading;
  if (isLoading) {
    els.runButton.textContent = currentMode === "realtime" ? "Probing..." : "Running...";
  } else {
    els.runButton.textContent = currentMode === "realtime" ? "Run realtime probe" : "Run demo pipeline";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
