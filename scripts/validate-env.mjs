import { existsSync, readFileSync } from "node:fs";

const env = {
  ...parseEnv(existsSync(".env.example") ? readFileSync(".env.example", "utf8") : ""),
  ...parseEnv(existsSync(".env") ? readFileSync(".env", "utf8") : ""),
  ...process.env
};

const checks = [
  ["Qwen fallback mode", env.QWEN_LIVE_CALLS !== "true" || Boolean(env.QWEN_API_KEY || env.DASHSCOPE_API_KEY), "Set QWEN_API_KEY/DASHSCOPE_API_KEY or keep QWEN_LIVE_CALLS=false"],
  ["Remediation safety", env.REMEDIATION_EXECUTION_MODE === "dry-run" || env.REMEDIATION_EXECUTION_MODE === "execute", "Set REMEDIATION_EXECUTION_MODE=dry-run or execute"],
  ["Slack approvers", Boolean(env.SLACK_APPROVER_IDS), "Set SLACK_APPROVER_IDS for gated writes"],
  ["Alibaba region", Boolean(env.ALIBABA_CLOUD_REGION), "Set ALIBABA_CLOUD_REGION"],
  ["GitHub MCP", env.MCP_GITHUB_LIVE !== "true" || Boolean(env.GITHUB_TOKEN), "Set GITHUB_TOKEN or keep MCP_GITHUB_LIVE=false"],
  ["Slack MCP", env.MCP_CHAT_LIVE !== "true" || Boolean(env.SLACK_BOT_TOKEN), "Set SLACK_BOT_TOKEN or keep MCP_CHAT_LIVE=false"],
  ["Logs MCP", env.MCP_LOGS_LIVE !== "true" || Boolean(env.DATADOG_API_KEY), "Set DATADOG_API_KEY or keep MCP_LOGS_LIVE=false"],
  ["Prometheus MCP", env.MCP_METRICS_LIVE !== "true" || Boolean(env.PROMETHEUS_BASE_URL && env.PROMETHEUS_USER && env.PROMETHEUS_PASSWORD), "Set PROMETHEUS_BASE_URL/PROMETHEUS_USER/PROMETHEUS_PASSWORD or keep MCP_METRICS_LIVE=false"],
  ["Jira MCP", env.MCP_TICKETS_LIVE !== "true" || Boolean(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN), "Set JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN or keep MCP_TICKETS_LIVE=false"],
  ["Pager MCP", env.MCP_PAGER_LIVE !== "true" || Boolean(env.PAGERDUTY_API_TOKEN), "Set PAGERDUTY_API_TOKEN or keep MCP_PAGER_LIVE=false"],
  ["Deploy MCP", env.MCP_DEPLOY_LIVE !== "true" || Boolean(env.KUBECONFIG_PATH || env.ALIBABA_CLOUD_ACCESS_KEY_ID), "Set KUBECONFIG_PATH/Alibaba keys or keep MCP_DEPLOY_LIVE=false"]
];

console.log("Trinetra environment readiness\n");
let failures = 0;
for (const [name, ok, hint] of checks) {
  console.log(`${ok ? "OK " : "NO "} ${name}`);
  if (!ok) {
    failures += 1;
    console.log(`   ${hint}`);
  }
}

console.log("\nMode summary");
console.log(`- Qwen: ${env.QWEN_LIVE_CALLS === "true" ? "live API calls" : "fallback/shadow"}`);
console.log(`- Qwen key: ${env.QWEN_API_KEY || env.DASHSCOPE_API_KEY ? "configured" : "not configured"}`);
console.log(`- Remediation: ${env.REMEDIATION_EXECUTION_MODE || "dry-run"}`);
console.log(`- Live MCPs: ${liveMcps(env).join(", ") || "none"}`);

if (failures) process.exitCode = 1;

function parseEnv(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return result;
}

function liveMcps(values) {
  return Object.entries(values)
    .filter(([key, value]) => key.startsWith("MCP_") && key.endsWith("_LIVE") && value === "true")
    .map(([key]) => key.replace(/^MCP_/, "").replace(/_LIVE$/, "").toLowerCase());
}
