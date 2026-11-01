import { isAbsolute } from "node:path";

export function validateRuntimeConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const errors = [];
  const bounds = {
    PORT: [1, 65535], MAX_BODY_BYTES: [1024, 1048576],
    VERIFICATION_TIMEOUT_MS: [100, 3600000], DEDUPE_WINDOW_MS: [1000, 3600000],
    SYNTHETIC_CHECK_INTERVAL_MS: [1000, 3600000],
    ANALYZE_RATE_LIMIT_WINDOW_MS: [1000, 3600000], ANALYZE_RATE_LIMIT_MAX: [1, 1000],
    QWEN_AGENT_TIMEOUT_MS: [100, 120000], QWEN_AGENT_RETRY_COUNT: [0, 3],
    QWEN_STREAM_IDLE_TIMEOUT_MS: [100, 120000], QWEN_MAX_OUTPUT_TOKENS: [1, 16384],
    MCP_HEALTH_TIMEOUT_MS: [100, 30000], SLACK_REACTION_POLL_INTERVAL_MS: [1000, 60000],
    STREAM_HEARTBEAT_INTERVAL_MS: [2000, 60000], SIGNED_APPROVALS_MAX: [50, 10000]
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (env[key] === undefined || env[key] === "") continue;
    const value = Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) errors.push(`${key} must be an integer between ${min} and ${max}`);
  }
  if (env.AUTO_EXECUTE_CONFIDENCE_THRESHOLD !== undefined &&
      (!Number.isFinite(Number(env.AUTO_EXECUTE_CONFIDENCE_THRESHOLD)) || Number(env.AUTO_EXECUTE_CONFIDENCE_THRESHOLD) < 0.72 || Number(env.AUTO_EXECUTE_CONFIDENCE_THRESHOLD) > 1)) {
    errors.push("AUTO_EXECUTE_CONFIDENCE_THRESHOLD must be between 0.72 and 1");
  }
  for (const key of [...Object.keys(env).filter((key) => /^MCP_.*_LIVE$/.test(key)), "QWEN_LIVE_CALLS", "ENABLE_LOCAL_APPROVAL", "DEMO_CONTROLS_ENABLED", "SLACK_INTERACTIVE_BUTTONS"]) {
    if (env[key] && !["true", "false"].includes(env[key])) errors.push(`${key} must be true or false`);
  }
  if (!["dry-run", "execute"].includes(env.REMEDIATION_EXECUTION_MODE || "dry-run")) errors.push("REMEDIATION_EXECUTION_MODE must be dry-run or execute");
  if (env.QWEN_LIVE_CALLS === "true" && !(env.QWEN_API_KEY || env.DASHSCOPE_API_KEY)) errors.push("Live Qwen requires QWEN_API_KEY or DASHSCOPE_API_KEY");
  if (env.MCP_CHAT_LIVE === "true") {
    for (const key of ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_APPROVER_IDS"]) {
      if (!env[key]?.trim()) errors.push(`Live Slack requires ${key}`);
    }
    if (!(env.SLACK_APPROVAL_CHANNEL_ID || env.SLACK_CHANNEL_ID)) errors.push("Live Slack requires SLACK_APPROVAL_CHANNEL_ID");
  }
  if (production) {
    if (env.FORCE_QWEN_FAILURE_ROLE || env.FORCE_VERIFICATION_FAIL) errors.push("Demo failure overrides are not allowed in production");
    if ((env.TRINETRA_AUTH_TOKEN || "").length < 32) errors.push("Production requires TRINETRA_AUTH_TOKEN with at least 32 characters");
    if (!env.DATA_DIR || !isAbsolute(env.DATA_DIR)) errors.push("Production requires an absolute DATA_DIR on persistent storage");
    if (["1", "true"].includes(env.VERCEL)) errors.push("Stateful production runs require a long-lived single Node process; Vercel is unsupported");
    if (env.ENABLE_LOCAL_APPROVAL === "true") errors.push("Local console approval is demo-only; use allowlisted Slack reviewers in production");
    if (env.REMEDIATION_EXECUTION_MODE === "execute" && env.MCP_CHAT_LIVE !== "true") errors.push("Production execute mode requires live Slack approval");
  }
  for (const key of ["PUBLIC_BASE_URL", "QWEN_API_BASE_URL", "SYNTHETIC_TARGET_URL", "JIRA_BASE_URL", "PROMETHEUS_BASE_URL"]) {
    if (!env[key]) continue;
    try {
      const url = new URL(env[key]);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (production && url.protocol !== "https:")) throw new Error();
    } catch { errors.push(`${key} must be an HTTP(S) URL without credentials (HTTPS in production)`); }
  }
  if (production && !env.PUBLIC_BASE_URL) errors.push("Production requires PUBLIC_BASE_URL for origin validation");
  if (errors.length) throw new Error(`Invalid runtime configuration:\n- ${errors.join("\n- ")}`);
  return { production, localApprovalEnabled: !production && env.ENABLE_LOCAL_APPROVAL !== "false", demoControlsEnabled: env.DEMO_CONTROLS_ENABLED === "true" || (!production && env.DEMO_CONTROLS_ENABLED !== "false") };
}
