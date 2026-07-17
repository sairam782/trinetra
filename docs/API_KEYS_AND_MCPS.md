# Trinetra API Keys and MCP Setup

This guide shows how to add Qwen API keys and promote MCPs from simulated mode to live mode without committing secrets.

## Safety Rules

- Never commit `.env`. It is already listed in `.gitignore`.
- Keep `REMEDIATION_EXECUTION_MODE=dry-run` until the live MCPs are proven safe.
- Turn on live MCPs one group at a time.
- Start with read-only tools before write tools.
- Use Slack approval before enabling deploy actions.

## Quick Setup

Create `.env` from prompts:

```bash
npm run env:setup:interactive
```

Or create `.env` from shell variables:

```bash
QWEN_API_KEY=your_dashscope_key \
QWEN_LIVE_CALLS=true \
REMEDIATION_EXECUTION_MODE=dry-run \
npm run env:setup
```

Validate configuration:

```bash
npm run env:check
npm run mcps:check
```

Run locally:

```bash
npm start
```

## Qwen / DashScope

Minimum variables:

```bash
QWEN_API_KEY=your_dashscope_key
QWEN_API_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL_DEFAULT=qwen-plus
QWEN_MODEL_REMEDIATION=qwen-plus
QWEN_LIVE_CALLS=true
```

Use `DASHSCOPE_API_KEY` instead of `QWEN_API_KEY` if that is how your Alibaba Cloud key is named.

Recommended first run:

```bash
QWEN_API_KEY=your_dashscope_key \
QWEN_API_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1 \
QWEN_MODEL_DEFAULT=qwen-plus \
QWEN_MODEL_REMEDIATION=qwen-plus \
QWEN_LIVE_CALLS=true \
REMEDIATION_EXECUTION_MODE=dry-run \
npm start
```

This lets Qwen reason over incidents without mutating the demo website.

## Remediation Modes

Dry-run, recommended:

```bash
REMEDIATION_EXECUTION_MODE=dry-run
```

Execute, only after testing:

```bash
REMEDIATION_EXECUTION_MODE=execute
```

In dry-run mode, **Run Trinetra pipeline** selects a runbook and shows the planned action, but `/demo-store` remains broken.

In execute mode, an approved low-risk runbook can mutate the target. For the hackathon demo, `RB-777` can repair `/demo-store`.

## MCP Environment Variables

Trinetra currently exposes simulated MCP adapters in the UI. These env vars are the activation contract for connecting real MCP clients.

| MCP | Toggle | Required keys/config | First mode |
| --- | --- | --- | --- |
| Alertmanager | `MCP_ALERTS_LIVE=true` | `ALERTMANAGER_BASE_URL` | read-only |
| Datadog Logs | `MCP_LOGS_LIVE=true` | `DATADOG_API_KEY`, `DATADOG_APP_KEY` | read-only |
| Prometheus | `MCP_METRICS_LIVE=true` | `PROMETHEUS_BASE_URL`, `PROMETHEUS_USER`, `PROMETHEUS_PASSWORD` | read-only |
| OpenTelemetry | `MCP_TRACES_LIVE=true` | `OTEL_COLLECTOR_URL` | read-only |
| Runbook RAG | `MCP_MEMORY_LIVE=true` | `ALIBABA_RDS_POSTGRES_URL` or vector store URL | read/write after approval |
| GitHub | `MCP_GITHUB_LIVE=true` | `GITHUB_TOKEN` | read-only first |
| Slack | `MCP_CHAT_LIVE=true` | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APPROVER_IDS` | approval-gated write |
| Jira | `MCP_TICKETS_LIVE=true` | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | write after approval |
| Kubernetes/Deploy | `MCP_DEPLOY_LIVE=true` | `KUBECONFIG_PATH` or Alibaba deployment credentials | approval-gated write |
| Confluence | `MCP_DOCS_LIVE=true` | `CONFLUENCE_BASE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN` | write after verification |
| PagerDuty | `MCP_PAGER_LIVE=true` | `PAGERDUTY_API_TOKEN` | escalation write |

## Recommended Incubation Order

1. **Local fallback**

   ```bash
   QWEN_LIVE_CALLS=false REMEDIATION_EXECUTION_MODE=dry-run npm start
   ```

2. **Qwen live reasoning, no mutation**

   ```bash
   QWEN_API_KEY=your_dashscope_key \
   QWEN_API_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1 \
   QWEN_MODEL_DEFAULT=qwen-plus \
   QWEN_MODEL_REMEDIATION=qwen-plus \
   QWEN_LIVE_CALLS=true \
   REMEDIATION_EXECUTION_MODE=dry-run \
   npm start
   ```

3. **Read-only observability MCPs**

   ```bash
   MCP_LOGS_LIVE=true \
   MCP_METRICS_LIVE=true \
   MCP_TRACES_LIVE=true \
   REMEDIATION_EXECUTION_MODE=dry-run \
   npm start
   ```

4. **Read-only code and memory MCPs**

   ```bash
   MCP_GITHUB_LIVE=true \
   MCP_MEMORY_LIVE=true \
   REMEDIATION_EXECUTION_MODE=dry-run \
   npm start
   ```

5. **Human approval MCPs**

   ```bash
   MCP_CHAT_LIVE=true \
   MCP_TICKETS_LIVE=true \
   SLACK_APPROVER_IDS=U-HACK-JUDGE,U-ONCALL-PRIMARY \
   REMEDIATION_EXECUTION_MODE=dry-run \
   npm start
   ```

6. **Approval-gated execution**

   ```bash
   MCP_DEPLOY_LIVE=true \
   MCP_PAGER_LIVE=true \
   REMEDIATION_EXECUTION_MODE=execute \
   AUTO_EXECUTE_CONFIDENCE_THRESHOLD=0.95 \
   RUNBOOK_ALLOWLIST=RB-777 \
   npm start
   ```

## Full Local `.env` Template

```bash
NODE_ENV=development
HOST=127.0.0.1
PORT=4173

QWEN_API_KEY=
DASHSCOPE_API_KEY=
QWEN_API_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL_DEFAULT=qwen-plus
QWEN_MODEL_REMEDIATION=qwen-plus
QWEN_LIVE_CALLS=false
QWEN_AGENT_TIMEOUT_MS=30000
QWEN_AGENT_RETRY_COUNT=1

REMEDIATION_EXECUTION_MODE=dry-run
AUTO_EXECUTE_CONFIDENCE_THRESHOLD=0.90
RUNBOOK_ALLOWLIST=RB-101,RB-204,RB-330,RB-401,RB-510,RB-777
SLACK_APPROVER_IDS=U-HACK-JUDGE,U-ONCALL-PRIMARY

MCP_ALERTS_LIVE=false
MCP_LOGS_LIVE=false
MCP_METRICS_LIVE=false
MCP_TRACES_LIVE=false
MCP_MEMORY_LIVE=false
MCP_GITHUB_LIVE=false
MCP_CHAT_LIVE=false
MCP_TICKETS_LIVE=false
MCP_DEPLOY_LIVE=false
MCP_DOCS_LIVE=false
MCP_PAGER_LIVE=false

ALERTMANAGER_BASE_URL=
DATADOG_API_KEY=
DATADOG_APP_KEY=
PROMETHEUS_BASE_URL=
PROMETHEUS_USER=
PROMETHEUS_PASSWORD=
OTEL_COLLECTOR_URL=
GITHUB_TOKEN=
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
JIRA_BASE_URL=
JIRA_EMAIL=
JIRA_API_TOKEN=
CONFLUENCE_BASE_URL=
CONFLUENCE_EMAIL=
CONFLUENCE_API_TOKEN=
PAGERDUTY_API_TOKEN=
KUBECONFIG_PATH=

ALIBABA_CLOUD_REGION=us-west-1
ALIBABA_CLOUD_ACCESS_KEY_ID=
ALIBABA_CLOUD_ACCESS_KEY_SECRET=
ALIBABA_RDS_POSTGRES_URL=
```

## Verification Checklist

```bash
npm run env:check
npm run mcps:check
npm run check
npm run smoke
npm run incubate
```

## Current Live Connector Notes

- Slack uses `auth.test` and reports connected when the bot token is valid.
- Prometheus uses Grafana Cloud basic auth: `PROMETHEUS_USER` is the instance/user id and `PROMETHEUS_PASSWORD` is the access token.
- Jira Cloud requires all three values: `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN`. The token alone is not enough for Atlassian Basic auth.

Then open:

```text
http://127.0.0.1:4173
```

Expected safe behavior:

- Qwen enabled: model readiness says live Qwen calls are enabled.
- Dry-run enabled: Trinetra diagnoses and plans, but does not repair `/demo-store`.
- Execute enabled: approved `RB-777` can repair `/demo-store`.
