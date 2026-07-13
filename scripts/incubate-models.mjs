const phases = [
  {
    name: "Phase 0 - Demo simulation",
    goal: "Keep deterministic agent outputs and simulated MCPs while validating the UX.",
    env: [],
    checks: ["npm run check", "npm run smoke"]
  },
  {
    name: "Phase 1 - Qwen shadow mode",
    goal: "Add Qwen calls beside deterministic results; log model output without trusting it yet.",
    env: ["QWEN_API_KEY or DASHSCOPE_API_KEY", "QWEN_API_BASE_URL"],
    checks: ["GET /api/realtime/status", "confirm qwen.apiKeyConfigured=true"]
  },
  {
    name: "Phase 2 - Read-only MCPs",
    goal: "Promote logs, metrics, traces, GitHub, and memory adapters to live read-only mode.",
    env: ["MCP_LOGS_LIVE=true", "MCP_METRICS_LIVE=true", "MCP_TRACES_LIVE=true", "MCP_GITHUB_LIVE=true", "MCP_MEMORY_LIVE=true"],
    checks: ["compare live MCP evidence with simulated decisions"]
  },
  {
    name: "Phase 3 - Approval-gated writes",
    goal: "Enable Slack approval and deployment actions only after human approval.",
    env: ["MCP_CHAT_LIVE=true", "MCP_DEPLOY_LIVE=true", "SLACK_APPROVER_IDS"],
    checks: ["verify medium/high-risk runbooks pause at human approval"]
  },
  {
    name: "Phase 4 - Safe auto-execute",
    goal: "Allow auto-execute only for low-risk allowlisted runbooks with strong confidence.",
    env: ["AUTO_EXECUTE_CONFIDENCE_THRESHOLD=0.95", "RUNBOOK_ALLOWLIST=RB-777"],
    checks: ["force verification failure once and confirm rollback/escalation"]
  },
  {
    name: "Phase 5 - Production persistence",
    goal: "Move JSONL audit and memory to Alibaba RDS/PolarDB and deploy backend on Alibaba Cloud.",
    env: ["ALIBABA_RDS_POSTGRES_URL", "ALIBABA_CLOUD_REGION", "ALIBABA_CLOUD_ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
    checks: ["GET /api/cloud/alibaba", "GET /api/readiness"]
  }
];

console.log("Trinetra model/MCP incubation script\n");
for (const [index, phase] of phases.entries()) {
  console.log(`${index + 1}. ${phase.name}`);
  console.log(`   Goal: ${phase.goal}`);
  console.log(`   Env: ${phase.env.length ? phase.env.join(", ") : "none"}`);
  console.log(`   Checks: ${phase.checks.join(" -> ")}`);
  console.log("");
}

console.log("Recommended order: Qwen shadow mode first, then read-only MCPs, then approval-gated writes, then auto-execute.");
