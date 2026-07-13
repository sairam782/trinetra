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
  agentCards: document.querySelector("#agentCards"),
  auditRows: document.querySelector("#auditRows"),
  mcpGrid: document.querySelector("#mcpGrid"),
  mcpTrace: document.querySelector("#mcpTrace"),
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
  els.runButton.textContent = realtime ? "Run realtime probe" : "Run agents";

  if (realtime) {
    refreshRealtimeStatus();
    realtimeTimer = setInterval(refreshRealtimeStatus, 4000);
  } else if (realtimeTimer) {
    clearInterval(realtimeTimer);
    realtimeTimer = null;
  }
}

async function runAgents() {
  setLoading(true);
  try {
    const response = await fetch("/api/incidents/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        incidentKey: els.incidentSelect.value,
        approval: els.approvalSelect.value
      })
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    render(await response.json());
  } catch (error) {
    console.error(error);
    els.rootCause.textContent = "Could not run incident agents";
    els.confidenceText.textContent = "Check the local server and try again.";
  } finally {
    setLoading(false);
  }
}

function render(data) {
  const { incident, commander, specialists, adjudication, triage, gate, verification, audit, totals, mcps, mcpTrace, runId, requestId, mode, route, qwen } = data;
  els.modeText.textContent = mode;
  els.runIdText.textContent = runId;
  els.requestIdText.textContent = requestId;
  els.routeText.textContent = route?.name || "--";
  els.callCount.textContent = totals.calls;
  els.avgConfidence.textContent = `${Math.round(totals.confidence * 100)}%`;
  els.runCost.textContent = `$${totals.cost.toFixed(3)}`;

  els.severityBadge.textContent = commander.severity;
  els.severityBadge.className = commander.severity === "P1" ? "hot" : "warm";
  els.incidentTitle.textContent = `${incident.id}: ${incident.title}`;
  els.incidentAlert.textContent = incident.alert;
  els.serviceName.textContent = incident.service;
  els.impactText.textContent = incident.customerImpact;
  els.blastRadius.textContent = commander.blastRadius;
  els.routingText.textContent = commander.routing;

  els.rootCause.textContent = adjudication.rootCause;
  els.confidenceText.textContent = `${Math.round(adjudication.confidence * 100)}% confidence after ${adjudication.negotiation.length} specialist votes. Winner: ${adjudication.winner}. Runbook selected: ${triage.runbook.id}. Triage model: ${qwen.models.triage}.`;
  els.gateLabel.textContent = gate.label;
  els.gateAction.textContent = `${gate.action}. Reason: ${gate.reason}. Risk: ${triage.runbook.risk}. Steps: ${triage.runbook.steps.join(" -> ")}.`;
  els.verificationStatus.textContent = verification.status;
  renderMetricDelta(incident.metrics, verification.after);
  renderAgents(specialists);
  renderAudit(audit);
  renderMcps(mcps);
  renderMcpTrace(mcpTrace);
  refreshRecentRuns();
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
      ? `Recovered from ${status.failureLabel}. /demo-store returns ${status.httpStatus}. Last fixed: ${status.lastFixedAt || "not yet"}.`
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
  els.qwenReadiness.textContent = status.qwen.apiKeyConfigured ? "live credentials detected" : "simulation mode";

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
    `;
    return card;
  }));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.json();
}

function renderAgents(specialists) {
  els.agentCards.replaceChildren(...specialists.map((agent) => {
    const card = document.createElement("article");
    card.className = "agent-card";
    card.innerHTML = `
      <div>
        <h3>${escapeHtml(agent.agent)}</h3>
        <span>${Math.round(agent.confidence * 100)}%</span>
      </div>
      <p>${escapeHtml(agent.finding)}</p>
      <em>${escapeHtml(agent.mcp?.name || "No MCP")} · ${escapeHtml(agent.mcp?.action || "local")}</em>
      <em>${escapeHtml(agent.model || "rule-fallback")} · ${agent.tokens?.total || 0} tokens${agent.fallback ? " · fallback" : ""}</em>
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
        <span>${item.id} · ${item.elapsedMs}ms · $${item.cost.toFixed(3)} · ${Math.round(item.confidence * 100)}%</span>
      </div>
      ${item.model ? `<div class="mcp-chip">${escapeHtml(item.model)} / ${item.tokens?.total || 0} tokens${item.fallback ? " / fallback" : ""}</div>` : ""}
      ${item.mcp ? `<div class="mcp-chip">${escapeHtml(item.mcp.name)} / ${escapeHtml(item.mcp.action)} / ${escapeHtml(item.mcp.status)}</div>` : ""}
      ${item.reasoning ? `<p><b>Reasoning:</b> ${escapeHtml(String(item.reasoning))}</p>` : ""}
      <p><b>Input:</b> ${escapeHtml(String(item.input))}</p>
      <p><b>Output:</b> ${escapeHtml(String(item.output))}</p>
    `;
    return row;
  }));
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
        <p>${escapeHtml(call.result)}</p>
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
      <small>${escapeHtml(run.startedAt)} · ${run.totals.calls} calls · $${run.totals.cost.toFixed(3)}</small>
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
  return evidence || "No supporting evidence";
}

function labelFor(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function setLoading(isLoading) {
  els.runButton.disabled = isLoading;
  if (isLoading) {
    els.runButton.textContent = currentMode === "realtime" ? "Probing..." : "Running...";
  } else {
    els.runButton.textContent = currentMode === "realtime" ? "Run realtime probe" : "Run agents";
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
