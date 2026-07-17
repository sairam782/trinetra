const els = {
  demoModeButton: document.querySelector("#demoModeButton"),
  realtimeModeButton: document.querySelector("#realtimeModeButton"),
  demoPanel: document.querySelector("#demoPanel"),
  realtimePanel: document.querySelector("#realtimePanel"),
  realtimeGeneratedAt: document.querySelector("#realtimeGeneratedAt"),
  realtimeEvents: document.querySelector("#realtimeEvents"),
  headerIncident: document.querySelector("#headerIncident"),
  headerStatus: document.querySelector("#headerStatus"),
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
  agentGraph: document.querySelector("#agentGraph"),
  graphStatus: document.querySelector("#graphStatus"),
  graphNodeDetails: document.querySelector("#graphNodeDetails"),
  mcpGrid: document.querySelector("#mcpGrid"),
  mcpTrace: document.querySelector("#mcpTrace"),
  executionTimeline: document.querySelector("#executionTimeline"),
  qwenTrace: document.querySelector("#qwenTrace"),
  recentRuns: document.querySelector("#recentRuns"),
  liveLogs: document.querySelector("#liveLogs"),
  logSearch: document.querySelector("#logSearch"),
  logStatus: document.querySelector("#logStatus"),
  refreshLogsButton: document.querySelector("#refreshLogsButton"),
  traceInspector: document.querySelector("#traceInspector"),
  drawerStatus: document.querySelector("#drawerStatus")
};

let currentMode = "demo";
let realtimeTimer = null;
let logTimer = null;
let lastRunData = null;
let currentLogs = [];

els.demoModeButton.addEventListener("click", () => setMode("demo"));
els.realtimeModeButton.addEventListener("click", () => setMode("realtime"));
els.runButton.addEventListener("click", runAgents);
els.incidentSelect.addEventListener("change", runAgents);
els.approvalSelect.addEventListener("change", runAgents);
els.injectErrorButton.addEventListener("click", injectDemoError);
els.solveWebsiteButton.addEventListener("click", solveWebsiteIncident);
els.refreshLogsButton.addEventListener("click", refreshLogs);
els.logSearch.addEventListener("input", () => renderLogs(currentLogs));
els.agentGraph.addEventListener("click", (event) => {
  const node = event.target.closest("[data-node]");
  if (node) inspectGraphNode(node.dataset.node);
});

loadFailureOptions();
runAgents();
refreshOpsStatus();
refreshDemoSiteStatus();
refreshLogs();
logTimer = setInterval(refreshLogs, 6000);

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
    renderLoadingTrace();
    const data = await fetchJson("/api/incidents/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        incidentKey: els.incidentSelect.value,
        approval: els.approvalSelect.value
      })
    });
    render(data);
  } catch (error) {
    console.error(error);
    els.rootCause.textContent = "Could not run incident agents";
    els.confidenceText.textContent = "Check the local server and try again.";
    els.headerStatus.textContent = "offline";
  } finally {
    setLoading(false);
    refreshLogs();
  }
}

function render(data) {
  lastRunData = data;
  const { incident, commander, specialists, adjudication, triage, remediationPlan, gate, verification, audit, totals, mcps, mcpTrace, executionTimeline, qwenTrace, runId, requestId, mode, route, qwen } = data;
  els.modeText.textContent = mode;
  els.headerIncident.textContent = incident?.id || "Not available";
  els.runIdText.textContent = runId;
  els.requestIdText.textContent = requestId;
  els.routeText.textContent = route?.name || "--";
  animateNumber(els.callCount, totals.calls);
  els.avgConfidence.textContent = formatPercent(totals.confidence);
  els.runCost.textContent = formatTokens(totalUsage(qwenTrace));

  els.severityBadge.textContent = commander.severity;
  els.severityBadge.className = commander.severity === "P1" ? "status-pill error" : "status-pill warning";
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
  els.headerStatus.textContent = verification.status || gate.label || "Not available";
  renderMetricDelta(incident.metrics, verification.after);
  renderRemediationTimeline(remediationPlan, true);
  renderAgents(specialists);
  renderAudit(audit);
  renderExecutionTimeline(executionTimeline || [], true);
  renderQwenTrace(qwenTrace || []);
  renderMcps(mcps);
  renderMcpTrace(mcpTrace);
  renderExecutionGraph(data);
  refreshRecentRuns();
}

function renderLoadingTrace() {
  const loading = document.createElement("article");
  loading.className = "trace-empty thinking";
  loading.innerHTML = `<span>Thinking</span><i></i><i></i><i></i>`;
  els.qwenTrace.replaceChildren(loading.cloneNode(true));
  els.executionTimeline.replaceChildren(loading);
  els.traceInspector.textContent = "Waiting for runtime response from the backend.";
  els.drawerStatus.textContent = "running";
}

function renderRemediationTimeline(remediationPlan = {}, animate = false) {
  const timeline = remediationPlan.timeline || [];
  if (!timeline.length) {
    els.remediationTimeline.replaceChildren(emptyTimelineRow("Waiting for remediation agent"));
    return;
  }
  const rows = timeline.slice(-12).map((event, index) => {
    const row = document.createElement("article");
    row.className = `tool-step ${statusClass(event.status)} ${animate ? "will-enter" : ""}`;
    row.style.setProperty("--delay", `${index * 65}ms`);
    row.innerHTML = `
      <span>${statusMark(event.status)}</span>
      <div>
        <strong>${escapeHtml(event.label || "Tool step")}</strong>
        <p>${escapeHtml(event.detail || "")}</p>
      </div>
    `;
    return row;
  });
  els.remediationTimeline.replaceChildren(...rows);
  requestAnimationFrame(() => rows.forEach((row) => row.classList.remove("will-enter")));
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

function statusClass(status) {
  if (status === "completed" || status === "healthy" || status === "success") return "success";
  if (status === "attention" || status === "blocked" || status === "failed" || status === "error") return "error";
  if (status === "selected" || status === "reasoning" || status === "pending") return "pending";
  return "inactive";
}

async function refreshOpsStatus() {
  const [health, readiness] = await Promise.allSettled([
    fetchJson("/api/health"),
    fetchJson("/api/readiness")
  ]);
  if (health.status === "fulfilled") {
    els.healthText.textContent = health.value.ok ? "healthy" : "degraded";
    els.headerStatus.textContent = health.value.ok ? "healthy" : "degraded";
    els.modeText.textContent = health.value.mode;
  } else {
    els.healthText.textContent = "offline";
    els.headerStatus.textContent = "offline";
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
    els.demoSiteTitle.className = status.healthy ? "status-pill success" : "status-pill error";
    els.demoSiteText.textContent = status.healthy
      ? `Recovered from ${status.failureLabel}. /demo-store returns ${status.httpStatus}. Pipeline action: ${status.lastAction || "not yet"}.`
      : `${status.failureLabel} active. /demo-store returns ${status.httpStatus}: ${status.error}. ${status.symptom}`;
  } catch {
    els.demoSiteTitle.textContent = "Storefront status: unknown";
    els.demoSiteTitle.className = "status-pill inactive";
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
  els.approvalSelect.value = "pending";
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

  const syntheticEvent = {
    stage: "Synthetic uptime check",
    status: status.synthetic?.healthy === null || status.synthetic?.healthy === undefined
      ? "Not available"
      : status.synthetic.healthy ? "healthy" : "unhealthy",
    text: status.synthetic?.lastCheckedAt
      ? `${status.synthetic.targetUrl || "Not available"} returned ${status.synthetic.status ?? "Not available"} in ${status.synthetic.latencyMs ?? "Not available"}ms`
      : "No live synthetic probe has completed yet.",
    timestamp: status.synthetic?.lastCheckedAt || null
  };
  const slackEvent = {
    stage: "Slack approval",
    status: status.slack?.readyToPostApprovalRequests ? "ready" : "not ready",
    text: status.slack?.readyToPostApprovalRequests
      ? `Posting approval requests to ${status.slack.approvalChannelId}`
      : status.slack?.approvalChannelConfigured === false
        ? "Missing SLACK_APPROVAL_CHANNEL_ID; approval requests are not posted to Slack."
        : "Not available",
    timestamp: status.generatedAt || null
  };
  els.realtimeEvents.replaceChildren(...[syntheticEvent, slackEvent, ...status.liveEvents].map((event) => {
    const row = document.createElement("article");
    row.className = `realtime-event ${statusClass(event.status)}`;
    row.innerHTML = `
      <span>${escapeHtml(event.stage)}</span>
      <strong>${escapeHtml(event.status)}</strong>
      <p>${escapeHtml(event.text)}</p>
    `;
    return row;
  }));

  els.modelReadiness.replaceChildren(...status.qwen.readiness.map((model) => {
    const card = document.createElement("article");
    card.className = `readiness-card ${statusClass(model.status)}`;
    card.innerHTML = `
      <strong>${escapeHtml(model.role)}</strong>
      <span>${escapeHtml(model.model)}</span>
      <em>${escapeHtml(model.status)}</em>
    `;
    return card;
  }));

  els.mcpReadiness.replaceChildren(...status.mcps.map((mcp) => {
    const card = document.createElement("article");
    card.className = `readiness-card ${statusClass(mcp.status)}`;
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
    card.className = `agent-card ${agent.agent?.toLowerCase?.().includes("qwen") ? "ai" : ""}`;
    card.innerHTML = `
      <div>
        <h3>${escapeHtml(valueOrNA(agent.agent))}</h3>
        <span class="metric-chip">${formatPercent(agent.confidence)}</span>
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

function renderExecutionTimeline(events = [], animate = false) {
  if (!events.length) {
    els.executionTimeline.replaceChildren(emptyTrace("No execution timeline available"));
    return;
  }
  const rows = events.map((event, index) => {
    const details = document.createElement("details");
    details.className = `trace-item ${animate ? "will-enter" : ""}`;
    details.style.setProperty("--delay", `${Math.min(index, 24) * 45}ms`);
    details.innerHTML = `
      <summary>
        <span>${escapeHtml(formatTime(event.timestamp))}</span>
        <strong>${escapeHtml(valueOrNA(event.label))}</strong>
        <em>${escapeHtml(valueOrNA(event.type))}</em>
      </summary>
      <pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre>
    `;
    return details;
  });
  els.executionTimeline.replaceChildren(...rows);
  requestAnimationFrame(() => rows.forEach((row) => row.classList.remove("will-enter")));
}

function renderQwenTrace(trace = []) {
  if (!trace.length) {
    els.qwenTrace.replaceChildren(emptyTrace("No Qwen calls available"));
    return;
  }
  els.qwenTrace.replaceChildren(...trace.map((call) => {
    const details = document.createElement("details");
    details.className = "trace-item qwen-call";
    details.addEventListener("toggle", () => {
      if (details.open) inspectQwenCall(call);
    });
    details.innerHTML = `
      <summary>
        <span>${escapeHtml(formatTime(call.timestamp))}</span>
        <strong>${escapeHtml(valueOrNA(call.agent || call.role))}</strong>
        <em>${escapeHtml(valueOrNA(call.model))} · ${escapeHtml(formatLatency(call.latencyMs))} · ${escapeHtml(formatTokens(call.usage))}</em>
      </summary>
      <div class="trace-actions">
        <button type="button" data-copy="system">Copy system</button>
        <button type="button" data-copy="user">Copy user</button>
        <button type="button" data-copy="raw">Copy raw</button>
      </div>
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
    details.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const type = button.dataset.copy;
        const text = type === "system" ? call.systemPrompt : type === "user" ? call.userPrompt : call.rawResponse;
        navigator.clipboard?.writeText(valueOrNA(text));
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = `Copy ${type}`; }, 1200);
      });
    });
    return details;
  }));
  if (trace[0]) inspectQwenCall(trace[0]);
}

function emptyTrace(text) {
  const article = document.createElement("article");
  article.className = "trace-empty";
  article.textContent = text;
  return article;
}

function inspectQwenCall(call) {
  els.drawerStatus.textContent = `${valueOrNA(call.agent || call.role)} · ${valueOrNA(call.model)}`;
  els.traceInspector.innerHTML = `
    <div class="inspector-grid">
      <div><span>Latency</span><strong>${escapeHtml(formatLatency(call.latencyMs))}</strong></div>
      <div><span>Tokens</span><strong>${escapeHtml(formatTokens(call.usage))}</strong></div>
      <div><span>Finish reason</span><strong>${escapeHtml(valueOrNA(call.finishReason))}</strong></div>
      <div><span>Timestamp</span><strong>${escapeHtml(formatTime(call.timestamp))}</strong></div>
    </div>
    <section><h3>System Prompt</h3><pre>${escapeHtml(valueOrNA(call.systemPrompt))}</pre></section>
    <section><h3>User Prompt</h3><pre>${escapeHtml(valueOrNA(call.userPrompt))}</pre></section>
    <section><h3>Raw Response</h3><pre>${escapeHtml(valueOrNA(call.rawResponse))}</pre></section>
    <section><h3>Parsed Response</h3><pre>${escapeHtml(JSON.stringify(call.parsedResponse ?? null, null, 2))}</pre></section>
  `;
}

function inspectGraphNode(node) {
  const data = lastRunData;
  if (!data) {
    els.graphNodeDetails.textContent = "No runtime execution is available yet.";
    return;
  }
  const matching = nodeEvents(data, node);
  els.agentGraph.querySelectorAll("[data-node]").forEach((el) => {
    el.classList.toggle("selected", el.dataset.node === node);
  });
  els.graphNodeDetails.innerHTML = `
    <strong>${escapeHtml(labelFor(node))}</strong>
    <span>${matching.length ? `${matching.length} runtime entries` : "Not available"}</span>
    <pre>${escapeHtml(JSON.stringify(matching.slice(0, 4), null, 2))}</pre>
  `;
}

function renderExecutionGraph(data) {
  const nodeOrder = ["ingest", "commander", "specialists", "adjudication", "triage", "gate", "remediation", "verification", "memory"];
  const activeIndex = nodeOrder.findLastIndex((node) => nodeEvents(data, node).length > 0);
  els.graphStatus.textContent = activeIndex >= 0 ? "runtime mapped" : "Not available";
  els.agentGraph.querySelectorAll("[data-node]").forEach((nodeEl, index) => {
    const node = nodeEl.dataset.node;
    const events = nodeEvents(data, node);
    nodeEl.classList.remove("completed", "current", "future", "inactive", "failed");
    if (events.some((event) => /fail|error|unhealthy|blocked|escalate/i.test(JSON.stringify(event)))) {
      nodeEl.classList.add("failed");
    } else if (events.length) {
      nodeEl.classList.add(index === activeIndex ? "current" : "completed");
    } else if (activeIndex >= 0 && index > activeIndex) {
      nodeEl.classList.add("future");
    } else {
      nodeEl.classList.add("inactive");
    }
  });
  inspectGraphNode(nodeOrder[Math.max(activeIndex, 0)]);
}

function nodeEvents(data, node) {
  const timeline = data.executionTimeline || [];
  const qwenTrace = data.qwenTrace || [];
  const remediationTimeline = data.remediationPlan?.timeline || [];
  const audit = data.audit || [];
  const matchers = {
    ingest: (event) => /alert|incident|ingest/i.test(`${event.label || ""} ${event.type || ""}`),
    commander: (event) => /commander/i.test(`${event.label || ""} ${event.agent || ""}`),
    specialists: (event) => /logs|metrics|trace|memory|specialist/i.test(`${event.label || ""} ${event.agent || ""}`),
    adjudication: (event) => /adjudicat|negotiat|winner/i.test(`${event.label || ""} ${event.type || ""}`),
    triage: (event) => /triage|runbook/i.test(`${event.label || ""} ${event.agent || ""}`),
    gate: (event) => /gate|approval|slack/i.test(`${event.label || ""} ${event.type || ""}`),
    remediation: (event) => /remediation|tool|restore|restart|verify/i.test(`${event.label || ""} ${event.type || ""}`),
    verification: (event) => /verification|verify/i.test(`${event.label || ""} ${event.type || ""}`),
    memory: (event) => /memory|audit|persist/i.test(`${event.label || ""} ${event.type || ""}`)
  };
  const matcher = matchers[node] || (() => false);
  const source = [...timeline, ...qwenTrace, ...remediationTimeline, ...audit];
  if (node === "gate" && data.gate) source.push(data.gate);
  if (node === "verification" && data.verification) source.push(data.verification);
  return source.filter(matcher);
}

function renderMcps(mcps = []) {
  els.mcpGrid.replaceChildren(...mcps.map((mcp) => {
    const card = document.createElement("article");
    card.className = `mcp-card ${statusClass(mcp.status)}`;
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
  if (!trace.length) {
    els.mcpTrace.replaceChildren(emptyTrace("No MCP activity available"));
    return;
  }
  els.mcpTrace.replaceChildren(...trace.map((call, index) => {
    const row = document.createElement("article");
    row.className = `mcp-trace-row ${statusClass(call.status)}`;
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
      <small>${escapeHtml(run.startedAt)} · ${run.totals.calls} calls · ${escapeHtml(formatTokens(run.totals.usage || null))}</small>
    `;
    return row;
  }));
}

async function refreshLogs() {
  try {
    const logs = await fetchJson("/api/logs?limit=160");
    currentLogs = Array.isArray(logs) ? logs : [];
    els.logStatus.textContent = currentLogs.length ? `${currentLogs.length} entries` : "Not available";
    renderLogs(currentLogs);
  } catch (error) {
    console.warn(error);
    els.logStatus.textContent = "offline";
    els.liveLogs.replaceChildren(emptyTrace("Log endpoint is not available"));
  }
}

function renderLogs(logs = []) {
  const query = els.logSearch.value.trim().toLowerCase();
  const filtered = logs.filter((entry) => {
    if (!query) return true;
    return JSON.stringify(entry).toLowerCase().includes(query);
  }).slice(0, 80);
  if (!filtered.length) {
    els.liveLogs.replaceChildren(emptyTrace("No log entries match the current filter"));
    return;
  }
  els.liveLogs.replaceChildren(...filtered.map((entry) => {
    const row = document.createElement("article");
    const level = String(entry.level || entry.severity || "info").toLowerCase();
    row.className = `log-row ${level}`;
    row.innerHTML = `
      <span>${escapeHtml(formatTime(entry.ts || entry.timestamp || entry.time))}</span>
      <strong>${escapeHtml(level.toUpperCase())}</strong>
      <code>${escapeHtml(entry.event || entry.message || "Not available")}</code>
      <pre>${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
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

function totalUsage(trace = []) {
  const usage = trace.reduce((acc, call) => {
    const item = call.usage || {};
    const prompt = item.prompt_tokens ?? item.prompt ?? 0;
    const completion = item.completion_tokens ?? item.completion ?? 0;
    const total = item.total_tokens ?? item.total ?? prompt + completion;
    if (typeof prompt === "number") acc.prompt_tokens += prompt;
    if (typeof completion === "number") acc.completion_tokens += completion;
    if (typeof total === "number") acc.total_tokens += total;
    return acc;
  }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  return usage.total_tokens ? usage : null;
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
  els.solveWebsiteButton.disabled = isLoading;
  if (isLoading) {
    els.runButton.textContent = currentMode === "realtime" ? "Probing..." : "Running...";
    els.solveWebsiteButton.textContent = "Running...";
  } else {
    els.runButton.textContent = currentMode === "realtime" ? "Run realtime probe" : "Run demo pipeline";
    els.solveWebsiteButton.textContent = "Run Trinetra pipeline";
  }
}

function animateNumber(element, value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    element.textContent = "Not available";
    return;
  }
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) {
    element.textContent = String(value);
    return;
  }
  const start = Number(element.textContent) || 0;
  const duration = 450;
  const started = performance.now();
  function step(now) {
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = String(Math.round(start + (value - start) * eased));
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
