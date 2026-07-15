export async function checkLiveMcpHealth(env = process.env) {
  const checks = await Promise.allSettled([
    checkSlack(env),
    checkJira(env),
    checkPrometheus(env)
  ]);
  return Object.fromEntries(checks.map((result) => {
    const value = result.status === "fulfilled" ? result.value : { id: "unknown", status: "error", message: result.reason?.message || "health check failed" };
    return [value.id, value];
  }));
}

async function checkSlack(env) {
  if (env.MCP_CHAT_LIVE !== "true") return skipped("chat");
  if (!env.SLACK_BOT_TOKEN) return missing("chat", "SLACK_BOT_TOKEN");
  const response = await fetchWithTimeout("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/x-www-form-urlencoded"
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    return unhealthy("chat", payload.error || `Slack returned ${response.status}`);
  }
  return connected("chat", `workspace=${payload.team || "unknown"}, bot=${payload.user || payload.bot_id || "bot"}`);
}

async function checkJira(env) {
  if (env.MCP_TICKETS_LIVE !== "true") return skipped("tickets");
  if (!env.JIRA_BASE_URL) return missing("tickets", "JIRA_BASE_URL");
  if (!env.JIRA_API_TOKEN) return missing("tickets", "JIRA_API_TOKEN");
  if (!env.JIRA_EMAIL) return missing("tickets", "JIRA_EMAIL");
  const baseUrl = env.JIRA_BASE_URL.replace(/\/$/, "");
  const auth = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64");
  const response = await fetchWithTimeout(`${baseUrl}/rest/api/3/myself`, {
    headers: {
      "authorization": `Basic ${auth}`,
      "accept": "application/json"
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return unhealthy("tickets", payload.errorMessages?.join("; ") || `Jira returned ${response.status}`);
  return connected("tickets", `account=${payload.displayName || payload.accountId || "jira-user"}`);
}

async function checkPrometheus(env) {
  if (env.MCP_METRICS_LIVE !== "true") return skipped("metrics");
  if (!env.PROMETHEUS_BASE_URL) return missing("metrics", "PROMETHEUS_BASE_URL");
  if (!env.PROMETHEUS_USER || !env.PROMETHEUS_PASSWORD) return missing("metrics", "PROMETHEUS_USER/PROMETHEUS_PASSWORD");
  const baseUrl = env.PROMETHEUS_BASE_URL.replace(/\/$/, "");
  const auth = Buffer.from(`${env.PROMETHEUS_USER}:${env.PROMETHEUS_PASSWORD}`).toString("base64");
  const response = await fetchWithTimeout(`${baseUrl}/api/v1/query?query=up`, {
    headers: {
      "authorization": `Basic ${auth}`,
      "accept": "application/json"
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === "error") {
    return unhealthy("metrics", payload.error || `Prometheus returned ${response.status}`);
  }
  return connected("metrics", `series=${payload.data?.result?.length ?? 0}`);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = Number(process.env.MCP_HEALTH_TIMEOUT_MS || 6000)) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function skipped(id) {
  return { id, status: "simulated", message: "live toggle is disabled" };
}

function missing(id, key) {
  return { id, status: "missing-config", message: `missing ${key}` };
}

function unhealthy(id, message) {
  return { id, status: "unhealthy", message };
}

function connected(id, message) {
  return { id, status: "connected", message };
}
