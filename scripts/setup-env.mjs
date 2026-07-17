import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const envPath = ".env";
const examplePath = ".env.example";

const secretKeys = new Set([
  "QWEN_API_KEY",
  "DASHSCOPE_API_KEY",
  "ALIBABA_CLOUD_ACCESS_KEY_ID",
  "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
  "ALIBABA_RDS_POSTGRES_URL",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "GITHUB_TOKEN",
  "DATADOG_API_KEY",
  "DATADOG_APP_KEY",
  "PROMETHEUS_PASSWORD",
  "PAGERDUTY_API_TOKEN",
  "JIRA_API_TOKEN",
  "CONFLUENCE_API_TOKEN"
]);

const recommended = {
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: "4173",
  MAX_BODY_BYTES: "64000",
  QWEN_API_BASE_URL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  QWEN_MODEL_DEFAULT: "qwen-plus",
  QWEN_MODEL_REMEDIATION: "qwen-plus",
  QWEN_AGENT_TIMEOUT_MS: "30000",
  QWEN_LIVE_CALLS: "false",
  REMEDIATION_EXECUTION_MODE: "dry-run",
  AUTO_EXECUTE_CONFIDENCE_THRESHOLD: "0.90",
  RUNBOOK_ALLOWLIST: "RB-101,RB-204,RB-330,RB-401,RB-510,RB-777",
  SLACK_APPROVER_IDS: "U-HACK-JUDGE,U-ONCALL-PRIMARY",
  SLACK_APPROVAL_CHANNEL_ID: "",
  PUBLIC_BASE_URL: "",
  MCP_ALERTS_LIVE: "false",
  MCP_LOGS_LIVE: "false",
  MCP_METRICS_LIVE: "false",
  MCP_TRACES_LIVE: "false",
  MCP_MEMORY_LIVE: "false",
  MCP_GITHUB_LIVE: "false",
  MCP_CHAT_LIVE: "false",
  MCP_TICKETS_LIVE: "false",
  MCP_DEPLOY_LIVE: "false",
  MCP_DOCS_LIVE: "false",
  MCP_PAGER_LIVE: "false"
};

const prompts = [
  ["QWEN_API_KEY", "Qwen/DashScope API key"],
  ["QWEN_LIVE_CALLS", "Enable live Qwen calls? true/false"],
  ["REMEDIATION_EXECUTION_MODE", "Remediation mode: dry-run/execute"],
  ["SLACK_APPROVER_IDS", "Comma-separated approver IDs"],
  ["SLACK_APPROVAL_CHANNEL_ID", "Slack channel ID for approval messages"],
  ["PUBLIC_BASE_URL", "Public backend URL for Slack interactivity, if using a tunnel/deploy"],
  ["ALIBABA_CLOUD_REGION", "Alibaba Cloud region"],
  ["ALIBABA_CLOUD_ACCESS_KEY_ID", "Alibaba access key id"],
  ["ALIBABA_CLOUD_ACCESS_KEY_SECRET", "Alibaba access key secret"],
  ["ALIBABA_RDS_POSTGRES_URL", "Alibaba RDS/PolarDB Postgres URL"],
  ["GITHUB_TOKEN", "GitHub token for repo/deploy MCP"],
  ["SLACK_BOT_TOKEN", "Slack bot token for chat approval MCP"],
  ["SLACK_SIGNING_SECRET", "Slack signing secret"],
  ["DATADOG_API_KEY", "Datadog API key for logs MCP"],
  ["DATADOG_APP_KEY", "Datadog app key for logs MCP"],
  ["PROMETHEUS_BASE_URL", "Prometheus base URL"],
  ["PROMETHEUS_USER", "Prometheus/Grafana Cloud user or instance id"],
  ["PROMETHEUS_PASSWORD", "Prometheus/Grafana Cloud password token"],
  ["JIRA_BASE_URL", "Jira base URL"],
  ["JIRA_EMAIL", "Jira account email"],
  ["JIRA_API_TOKEN", "Jira API token"],
  ["PAGERDUTY_API_TOKEN", "PagerDuty API token"]
];

const existing = parseEnv(existsSync(envPath) ? readFileSync(envPath, "utf8") : "");
const example = parseEnv(existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "");
const values = { ...example, ...recommended, ...existing };

const mode = process.argv.includes("--interactive") ? "interactive" : "from-env";

if (mode === "interactive") {
  const rl = createInterface({ input, output });
  console.log("Trinetra local .env setup");
  console.log("Press Enter to keep the current/default value. Secrets are not printed back.\n");
  for (const [key, label] of prompts) {
    const current = values[key] || "";
    const display = secretKeys.has(key) && current ? "[set]" : current || "(blank)";
    const answer = await rl.question(`${label} (${key}) [${display}]: `);
    if (answer.trim()) values[key] = answer.trim();
  }
  await rl.close();
} else {
  for (const key of new Set([...Object.keys(recommended), ...prompts.map(([key]) => key)])) {
    if (process.env[key]) values[key] = process.env[key];
  }
}

writeFileSync(envPath, renderEnv(values), "utf8");
console.log(`Wrote ${envPath}. It is gitignored; do not commit real secrets.`);
console.log("Next: npm run env:check");

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

function renderEnv(values) {
  const sections = [
    ["Runtime", ["NODE_ENV", "HOST", "PORT", "MAX_BODY_BYTES"]],
    ["Qwen Cloud / Alibaba Cloud Model Studio", ["QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_BASE_URL", "QWEN_MODEL_DEFAULT", "QWEN_MODEL_REMEDIATION", "QWEN_AGENT_TIMEOUT_MS", "QWEN_AGENT_RETRY_COUNT", "QWEN_LIVE_CALLS"]],
    ["Alibaba Cloud deployment proof and managed data targets", ["ALIBABA_CLOUD_REGION", "ALIBABA_CLOUD_ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_SECRET", "ALIBABA_COMPUTE_TARGET", "ALIBABA_DATABASE_TARGET", "ALIBABA_RDS_POSTGRES_URL"]],
    ["Safety controls", ["AUTO_EXECUTE_CONFIDENCE_THRESHOLD", "RUNBOOK_ALLOWLIST", "SLACK_APPROVER_IDS", "SLACK_APPROVAL_CHANNEL_ID", "PUBLIC_BASE_URL", "DEDUPE_WINDOW_MS", "VERIFICATION_TIMEOUT_MS", "REMEDIATION_EXECUTION_MODE"]],
    ["MCP live toggles", ["MCP_ALERTS_LIVE", "MCP_LOGS_LIVE", "MCP_METRICS_LIVE", "MCP_TRACES_LIVE", "MCP_MEMORY_LIVE", "MCP_GITHUB_LIVE", "MCP_CHAT_LIVE", "MCP_TICKETS_LIVE", "MCP_DEPLOY_LIVE", "MCP_DOCS_LIVE", "MCP_PAGER_LIVE"]],
    ["MCP provider credentials", ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "GITHUB_TOKEN", "DATADOG_API_KEY", "DATADOG_APP_KEY", "PAGERDUTY_API_TOKEN", "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "CONFLUENCE_BASE_URL", "CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN", "PROMETHEUS_BASE_URL", "PROMETHEUS_USER", "PROMETHEUS_PASSWORD", "OTEL_COLLECTOR_URL", "KUBECONFIG_PATH"]],
    ["Demo/test toggles", ["FORCE_QWEN_FAILURE_ROLE", "FORCE_VERIFICATION_FAIL"]]
  ];

  const lines = [];
  for (const [title, keys] of sections) {
    lines.push(`# ${title}`);
    for (const key of keys) lines.push(`${key}=${values[key] || ""}`);
    lines.push("");
  }
  return lines.join("\n");
}
