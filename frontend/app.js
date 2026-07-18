const els = {
  demoModeButton: document.querySelector("#demoModeButton"),
  realtimeModeButton: document.querySelector("#realtimeModeButton"),
  workspaceKicker: document.querySelector("#workspaceKicker"),
  workspaceTitle: document.querySelector("#workspaceTitle"),
  workspaceDescription: document.querySelector("#workspaceDescription"),
  demoPanel: document.querySelector("#demoPanel"),
  realtimePanel: document.querySelector("#realtimePanel"),
  interfaceStatus: document.querySelector("#interfaceStatus"),
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
  drawerStatus: document.querySelector("#drawerStatus"),
  drawerToggle: document.querySelector("#drawerToggle")
};

let currentMode = "demo";
let lastRunData = null;
let currentLogs = [];
let activePage = getActivePage();
const PLACEHOLDER = "—";
const pollers = {
  realtime: { timer: null, active: false, failures: 0, baseDelay: 4_000, maxDelay: 60_000, task: null },
  logs: { timer: null, active: false, failures: 0, baseDelay: 6_000, maxDelay: 60_000, task: null }
};

els.demoModeButton.addEventListener("click", () => setMode("demo"));
els.realtimeModeButton.addEventListener("click", () => setMode("realtime"));
els.runButton.addEventListener("click", runAgents);
els.incidentSelect.addEventListener("change", () => setInterfaceStatus("Scenario updated. Ready to analyze."));
els.approvalSelect.addEventListener("change", () => setInterfaceStatus("Execution policy updated. Ready to analyze."));
els.injectErrorButton.addEventListener("click", injectDemoError);
els.solveWebsiteButton.addEventListener("click", solveWebsiteIncident);
els.refreshLogsButton.addEventListener("click", refreshLogs);
els.logSearch.addEventListener("input", () => renderLogs(currentLogs));
els.drawerToggle.addEventListener("click", () => {
  const drawer = document.querySelector(".bottom-drawer");
  setDrawerOpen(drawer.classList.contains("collapsed"));
});
els.agentGraph.addEventListener("click", (event) => {
  const node = event.target.closest("[data-node]");
  if (node) inspectGraphNode(node.dataset.node);
});
document.addEventListener("visibilitychange", handleVisibilityChange);
document.querySelectorAll("[data-evidence-tab]").forEach((button) => {
  button.addEventListener("click", () => selectEvidenceTab(button.dataset.evidenceTab, true));
});

applyPage(activePage);
selectEvidenceTab(new URLSearchParams(window.location.search).get("tab") || "logs");
if (activePage === "runtime") setMode("realtime");

loadFailureOptions();
runAgents();
refreshOpsStatus();
refreshDemoSiteStatus();
refreshLogs();
startPolling("logs", refreshLogs);

function setMode(mode) {
  if (mode === "realtime" && activePage !== "runtime") {
    window.location.assign("/runtime");
    return;
  }
  if (mode === "demo" && activePage === "runtime") {
    window.location.assign("/");
    return;
  }

  currentMode = mode;
  const realtime = mode === "realtime";
  document.body.dataset.mode = mode;
  els.demoModeButton.classList.toggle("active", !realtime);
  els.realtimeModeButton.classList.toggle("active", realtime);
  els.demoPanel.classList.toggle("hidden", realtime || activePage !== "overview");
  els.realtimePanel.classList.toggle("hidden", !realtime || activePage !== "runtime");
  els.runButton.textContent = realtime ? "Analyze live target" : "Analyze incident";
  setInterfaceStatus(realtime ? "Realtime target selected. Refreshing live readiness." : "Demo scenario selected. Ready to analyze.");

  if (realtime) {
    els.incidentSelect.value = "website";
    refreshRealtimeStatus();
    refreshDemoSiteStatus();
    startPolling("realtime", refreshRealtimeStatus);
  } else {
    stopPolling("realtime");
  }
}

function startPolling(name, task) {
  const poller = pollers[name];
  poller.active = true;
  poller.task = task;
  schedulePoll(name);
}

function stopPolling(name) {
  const poller = pollers[name];
  poller.active = false;
  if (poller.timer) window.clearTimeout(poller.timer);
  poller.timer = null;
}

function schedulePoll(name, immediate = false) {
  const poller = pollers[name];
  if (!poller.active || document.hidden) return;
  if (poller.timer) window.clearTimeout(poller.timer);
  const delay = immediate ? 0 : Math.min(poller.maxDelay, poller.baseDelay * (2 ** poller.failures));
  poller.timer = window.setTimeout(async () => {
    poller.timer = null;
    if (!document.hidden && poller.active) await poller.task({ polling: true });
    schedulePoll(name);
  }, delay);
}

function recordPollOutcome(name, successful) {
  const poller = pollers[name];
  poller.failures = successful ? 0 : Math.min(poller.failures + 1, 10);
}

function handleVisibilityChange() {
  for (const name of Object.keys(pollers)) {
    const poller = pollers[name];
    if (document.hidden) {
      if (poller.timer) window.clearTimeout(poller.timer);
      poller.timer = null;
    } else if (poller.active) {
      schedulePoll(name, true);
    }
  }
}

async function runAgents() {
  setLoading(true);
  setInterfaceStatus(currentMode === "realtime" ? "Analyzing the live target…" : "Analyzing incident evidence…");
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
    setInterfaceStatus(`Analysis complete for ${data.incident?.id || "the selected incident"}.`);
  } catch (error) {
    console.error(error);
    els.rootCause.textContent = "Could not run incident agents";
    els.confidenceText.textContent = "Check the local server and try again.";
    els.headerStatus.textContent = "offline";
    setInterfaceStatus("Analysis could not be completed. Check server availability and try again.", true);
  } finally {
    setLoading(false);
    refreshLogs();
  }
}

function render(data) {
  lastRunData = data;
  const { incident, commander, specialists, adjudication, triage, remediationPlan, gate, verification, audit, totals, mcps, mcpTrace, executionTimeline, qwenTrace, runId, requestId, mode, route, qwen } = data;
  els.modeText.textContent = mode;
  els.headerIncident.textContent = incident?.id || PLACEHOLDER;
  els.runIdText.textContent = runId || PLACEHOLDER;
  els.requestIdText.textContent = requestId || PLACEHOLDER;
  els.routeText.textContent = route?.name || PLACEHOLDER;
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
  els.headerStatus.textContent = verification.status || gate.label || PLACEHOLDER;
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
    els.readinessText.textContent = PLACEHOLDER;
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
    els.demoSiteTitle.textContent = `Storefront status: ${PLACEHOLDER}`;
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
  try {
    setInterfaceStatus("Injecting selected storefront failure…");
    await fetchJson("/api/demo-site/inject-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ failureId: els.failureSelect.value })
    });
    els.incidentSelect.value = "website";
    els.approvalSelect.value = "pending";
    await refreshDemoSiteStatus();
    await refreshRealtimeStatus();
    setInterfaceStatus("Storefront failure injected. Run the analysis when ready.");
  } catch (error) {
    console.error(error);
    setInterfaceStatus("Unable to inject the selected storefront failure.", true);
  }
}

function getActivePage() {
  const pageByPath = {
    "/": "overview",
    "/runtime": "runtime",
    "/evidence": "evidence",
    "/integrations": "integrations"
  };
  return pageByPath[window.location.pathname] || "overview";
}

function applyPage(page) {
  const pages = {
    overview: {
      kicker: "Incident intelligence",
      title: "Command overview",
      description: "Choose an incident, guide the analysis, and make an informed next decision."
    },
    runtime: {
      kicker: "Live system view",
      title: "Runtime operations",
      description: "Monitor execution, agent outputs, logs, and the recorded history of every run."
    },
    evidence: {
      kicker: "Decision record",
      title: "Evidence and reasoning",
      description: "Inspect the execution timeline, model trace, prompts, responses, and verification evidence."
    },
    integrations: {
      kicker: "Connected capabilities",
      title: "Integrations",
      description: "Review MCP connector readiness and the activity that informed the incident response."
    }
  };
  const details = pages[page] || pages.overview;

  document.body.dataset.page = page;
  document.querySelectorAll("[data-page]").forEach((section) => {
    section.classList.toggle("page-hidden", !section.dataset.page.split(" ").includes(page));
  });
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const active = link.dataset.nav === page;
    link.classList.toggle("active", active);
    link.toggleAttribute("aria-current", active);
  });
  els.workspaceKicker.textContent = details.kicker;
  els.workspaceTitle.textContent = details.title;
  els.workspaceDescription.textContent = details.description;
  document.title = `Trinetra · ${details.title}`;
}

function selectEvidenceTab(tab, updateUrl = false) {
  const validTabs = new Set(["logs", "audit", "timeline", "qwen", "connectors", "mcp", "runs"]);
  const selected = validTabs.has(tab) ? tab : "logs";
  document.querySelectorAll("[data-evidence-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.evidencePanel !== selected;
  });
  document.querySelectorAll("[data-evidence-tab]").forEach((button) => {
    const active = button.dataset.evidenceTab === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });

  const navForTab = ["connectors", "mcp"].includes(selected) ? "integrations" : "evidence";
  const selectedNav = activePage === "runtime" ? "runtime" : navForTab;
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const active = activePage === "overview" ? link.dataset.nav === "overview" : link.dataset.nav === selectedNav;
    link.classList.toggle("active", active);
    link.toggleAttribute("aria-current", active);
  });

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.pathname = `/${navForTab}`;
    url.searchParams.set("tab", selected);
    window.history.replaceState({}, "", url);
  }
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

async function refreshRealtimeStatus({ polling = false } = {}) {
  try {
    const status = await fetchJson("/api/realtime/status");
    renderRealtimeStatus(status);
    if (polling) recordPollOutcome("realtime", true);
  } catch (error) {
    console.warn(error);
    els.realtimeGeneratedAt.textContent = "offline";
    if (polling) recordPollOutcome("realtime", false);
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
      ? PLACEHOLDER
      : status.synthetic.healthy ? "healthy" : "unhealthy",
    text: status.synthetic?.lastCheckedAt
      ? `${status.synthetic.targetUrl || PLACEHOLDER} returned ${status.synthetic.status ?? PLACEHOLDER} in ${status.synthetic.latencyMs ?? PLACEHOLDER}ms`
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
        : PLACEHOLDER,
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
  const requestUrl = withApiBase(url);
  if (typeof window.fetch === "function") {
    const response = await window.fetch(requestUrl, options);
    if (!response.ok) throw new Error(`${requestUrl} failed: ${response.status}`);
    return response.json();
  }
  return xhrJson(requestUrl, options);
}

function withApiBase(url) {
  if (/^https?:\/\//i.test(url)) return url;
  const apiBase = document.querySelector('meta[name="api-base"]')?.content?.trim() || "";
  if (!apiBase) return url;
  return `${apiBase.replace(/\/$/, "")}/${String(url).replace(/^\//, "")}`;
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
        <span>${escapeHtml(item.id)} · ${formatLatency(item.latencyMs)} · ${formatPercent(item.confidence)}</span>
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
      if (details.open) inspectQwenCall(call, true);
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

function inspectQwenCall(call, openInspector = false) {
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
  if (openInspector) setDrawerOpen(true);
}

function setDrawerOpen(open) {
  const drawer = document.querySelector(".bottom-drawer");
  drawer.classList.toggle("collapsed", !open);
  els.drawerToggle.textContent = open ? "Close inspector" : "Open inspector";
  els.drawerToggle.setAttribute("aria-expanded", String(open));
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
    <span>${matching.length ? `${matching.length} runtime entries` : PLACEHOLDER}</span>
    <pre>${escapeHtml(JSON.stringify(matching.slice(0, 4), null, 2))}</pre>
  `;
}

function renderExecutionGraph(data) {
  const nodeOrder = ["ingest", "commander", "specialists", "adjudication", "triage", "gate", "remediation", "verification", "memory"];
  const activeIndex = nodeOrder.findLastIndex((node) => nodeEvents(data, node).length > 0);
  els.graphStatus.textContent = activeIndex >= 0 ? "runtime mapped" : PLACEHOLDER;
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
  els.agentGraph.querySelectorAll("[data-to]").forEach((connector) => {
    const target = connector.dataset.to;
    const targetIndex = nodeOrder.indexOf(target);
    const events = nodeEvents(data, target);
    connector.classList.remove("completed", "current", "failed");
    if (events.some((event) => /fail|error|unhealthy|blocked|escalate/i.test(JSON.stringify(event)))) {
      connector.classList.add("failed");
    } else if (events.length) {
      connector.classList.add(targetIndex === activeIndex ? "current" : "completed");
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

async function refreshLogs({ polling = false } = {}) {
  try {
    const logs = await fetchJson("/api/logs?limit=160");
    currentLogs = Array.isArray(logs) ? logs : [];
    els.logStatus.textContent = currentLogs.length ? `${currentLogs.length} entries` : PLACEHOLDER;
    renderLogs(currentLogs);
    if (polling) recordPollOutcome("logs", true);
  } catch (error) {
    console.warn(error);
    els.logStatus.textContent = "offline";
    els.liveLogs.replaceChildren(emptyTrace("Log endpoint is not available"));
    if (polling) recordPollOutcome("logs", false);
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
      <code>${escapeHtml(entry.event || entry.message || PLACEHOLDER)}</code>
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
  return evidence || PLACEHOLDER;
}

function valueOrNA(value) {
  if (value === null || value === undefined || value === "") return PLACEHOLDER;
  return String(value);
}

function formatPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return PLACEHOLDER;
  return `${Math.round(value * 100)}%`;
}

function formatCost(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return PLACEHOLDER;
  return `$${value.toFixed(4)}`;
}

function formatLatency(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return PLACEHOLDER;
  return `${Math.round(value)} ms`;
}

function formatTokens(tokens) {
  if (!tokens) return PLACEHOLDER;
  const total = tokens.total_tokens ?? tokens.total;
  if (typeof total !== "number") return PLACEHOLDER;
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
  if (!timestamp) return PLACEHOLDER;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return PLACEHOLDER;
  return date.toLocaleTimeString();
}

function labelFor(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function setLoading(isLoading) {
  document.querySelector(".shell").setAttribute("aria-busy", String(isLoading));
  document.body.classList.toggle("is-loading", isLoading);
  if (!isLoading) document.querySelectorAll("[data-skeleton]").forEach((element) => element.removeAttribute("data-skeleton"));
  els.runButton.disabled = isLoading;
  els.solveWebsiteButton.disabled = isLoading;
  if (isLoading) {
    els.runButton.textContent = currentMode === "realtime" ? "Probing..." : "Running...";
    els.solveWebsiteButton.textContent = "Running...";
  } else {
    els.runButton.textContent = currentMode === "realtime" ? "Analyze live target" : "Analyze incident";
    els.solveWebsiteButton.textContent = "Run Trinetra pipeline";
  }
}

function setInterfaceStatus(message, isError = false) {
  els.interfaceStatus.textContent = message;
  els.interfaceStatus.classList.toggle("error", isError);
}

function animateNumber(element, value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    element.textContent = PLACEHOLDER;
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
