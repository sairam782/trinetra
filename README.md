# Trinetra

Trinetra is an AI incident-response console for a breakable demo storefront. It ingests an incident, runs Qwen-backed agents over logs, metrics, traces, and memory, selects an approved runbook, waits at a human gate when risk requires it, executes only registered remediation tools, verifies recovery, and persists the full audit trail.

The live remediation loop is intentionally constrained. Qwen can reason and select tools, but it cannot edit arbitrary files, run shell commands, or access the filesystem.

## What It Demonstrates

- Real-time incident pipeline: Ingest -> Commander -> Specialists -> Adjudication -> Triage -> Gate -> Verify -> Done
- Qwen agent calls with prompts, responses, latency, token usage, parsed output, and tool decisions
- Safe tool-calling remediation with a fixed backend tool registry
- Human approval through Slack or a local browser fallback for reviewers without workspace access
- A demo storefront that can be broken, repaired, restarted, and verified
- JSONL audit logging for runs, tool calls, verification, and approval events
- MCP-style observability and workflow connector registry, with simulation clearly separated from live configuration

## Quick Start

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:4173
```

The app loads `.env` automatically when present.

## Demo Walkthrough

1. Open Trinetra and switch to **Realtime**.
2. Pick a storefront failure from the error selector.
3. Click **Inject error**.
4. Open `/demo-store` to show the broken target website.
5. Click **Run Trinetra pipeline**.
6. Watch the live pipeline move through agents, gate, tools, verification, and audit events.
7. If the run pauses at a human gate, approve it with either:
   - Slack approval or reaction, when Slack is configured.
   - **Approve in Trinetra**, the local browser fallback for judges/reviewers who cannot access your Slack workspace.
8. Trinetra resumes the same run with the matching request ID, executes the selected registered tools, and verifies `/demo-store`.

The local browser approval is recorded as `source: "local-console"` so it is auditable and never pretends to be Slack.

## Runtime Modes

### Demo

Use Demo mode to show the architecture and pipeline without focusing on the live storefront.

### Realtime

Use Realtime mode for the judged flow:

- Inject one of the supported website failures.
- Run the incident pipeline.
- Inspect Qwen prompts and outputs.
- Approve locally or through Slack.
- Watch tool execution and verification.

Supported storefront failures:

- Missing featured-products config
- Catalog API timeout
- Payment widget script crash
- Inventory schema drift
- CSS asset 404 / visual regression

## Architecture

```text
Alert / Synthetic failure
  -> Ingest and correlate
  -> Commander agent
  -> Logs / Metrics / Trace / Historical memory agents
  -> Adjudication
  -> Triage and runbook match
  -> Human or auto gate
  -> Qwen remediation tool agent
  -> Backend tool executor
  -> Verification
  -> Rollback or escalation if unhealthy
  -> Audit log and memory update
```

## Safe Remediation Tools

Qwen may only call tools that exist in the backend registry:

- `restore_feature_config()`
- `restart_demo()`
- `reload_cache()`
- `pin_payment_widget()`
- `restore_css()`
- `clear_inventory_mapper()`
- `enable_catalog_cache()`
- `verify_demo()`

The executor rejects unknown tool names. A successful incident must call `verify_demo()` before it can be marked resolved. If verification fails, Trinetra runs the rollback path and escalates when recovery is still unhealthy.

## Human Approval

Trinetra supports two approval paths.

### Slack Approval

Use Slack when the reviewer has access to the configured workspace.

Required environment:

```text
MCP_CHAT_LIVE=true
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
SLACK_APPROVAL_CHANNEL_ID=...
SLACK_APPROVER_IDS=U123,U456
PUBLIC_BASE_URL=https://your-public-url
```

Required Slack bot scopes:

```text
chat:write
reactions:read
```

If Slack interactive buttons are enabled, configure the Slack app interactivity request URL:

```text
https://your-public-url/api/slack/interactions
```

### Local Browser Approval

Use this for demos when the reviewer cannot access your Slack.

When a run pauses at the human gate, Trinetra shows an approval card in the console. Clicking **Approve in Trinetra** records a local approval for the current `incidentKey + requestId`, then resumes remediation.

The backend endpoint is:

```text
POST /api/approvals/local
```

Payload:

```json
{
  "incidentKey": "website",
  "requestId": "current-run-request-id"
}
```

The endpoint only succeeds when a matching pending gate is active.

## Qwen Configuration

The app can run in fallback/shadow mode without credentials. To enable live Qwen calls through DashScope compatible mode:

```bash
QWEN_API_KEY=your_key_here \
QWEN_API_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1 \
QWEN_MODEL_DEFAULT=qwen-plus \
QWEN_MODEL_REMEDIATION=qwen-plus \
QWEN_LIVE_CALLS=true \
npm run dev
```

You can override individual agents:

```text
QWEN_MODEL_COMMANDER
QWEN_MODEL_LOGS
QWEN_MODEL_METRICS
QWEN_MODEL_TRACES
QWEN_MODEL_MEMORY
QWEN_MODEL_TRIAGE
QWEN_MODEL_REMEDIATION
QWEN_MODEL_COMMUNICATION
QWEN_MODEL_DOCUMENTATION
```

## Remediation Mode

Use dry-run mode to show the plan without mutating the demo storefront:

```bash
REMEDIATION_EXECUTION_MODE=dry-run npm run dev
```

Use execute mode to let registered backend tools repair the demo storefront:

```bash
REMEDIATION_EXECUTION_MODE=execute npm run dev
```

Production-style demos should use `execute` so judges can see the broken website recover after approval and verification.

## Repository Layout

```text
trinetra/
  backend/
    server.mjs                 # API server, orchestrator, gates, tool executor
    logger.mjs                 # Redacted JSONL logger
    cloud/qwen-client.mjs      # DashScope/OpenAI-compatible Qwen client
    cloud/alibaba-client.mjs   # Alibaba deployment metadata helper
    mcps/live-connectors.mjs   # Live connector health checks
  frontend/
    index.html                 # Incident console
    app.js                     # Runtime UI, approval fallback, pipeline rendering
    styles.css                 # Enterprise console styling
    assets/                    # Trinetra logo and favicon assets
  scripts/
    smoke-test.mjs             # End-to-end smoke test
    setup-env.mjs              # .env helper
    validate-env.mjs           # Secret-safe environment validation
    check-mcps.mjs             # MCP readiness checks
    incubate-models.mjs        # Model/MCP incubation guide
  docs/
    API_KEYS_AND_MCPS.md       # Detailed integration guide
  deploy/render/
    README.md                  # Render deployment notes
  data/                        # Runtime logs/audit/memory, gitignored
  Dockerfile
  render.yaml
  package.json
  .env.example
```

## Useful Commands

```bash
npm run dev              # local app on 127.0.0.1:4173
npm run check            # syntax checks
npm run smoke            # end-to-end smoke test
npm run env:setup        # write .env defaults
npm run env:setup:interactive
npm run env:check
npm run mcps:check
npm run incubate
```

## Core Endpoints

```text
GET  /                                  dashboard
GET  /demo-store                        breakable demo storefront
GET  /api/health                        liveness
GET  /api/readiness                     readiness and runtime config
GET  /api/realtime/status               Qwen/MCP/synthetic status
GET  /api/demo-site/status              current storefront health
GET  /api/demo-site/failures            injectable failure catalog
POST /api/demo-site/inject-error        inject a storefront failure
POST /api/incidents/analyze             run the pipeline
POST /api/incidents/analyze/stream      stream the pipeline
GET  /api/approvals                     pending and recorded approvals
POST /api/approvals/local               local browser approval fallback
GET  /api/slack/status                  Slack approval readiness
POST /api/slack/interactions            Slack-signed interactive callback
GET  /api/mcps                          MCP registry and health
GET  /api/runbooks                      approved runbook catalog
GET  /api/runs                          recent persisted runs
GET  /api/logs                          recent backend log events
GET  /api/cloud/alibaba                 Alibaba/Qwen deployment metadata
```

## Audit and Observability

Runtime data is written under `data/`:

- `incident-runs.jsonl`
- `backend-events.jsonl`
- `historical-memory.json`

The UI exposes:

- Live execution timeline
- Agent graph
- Qwen prompt/response inspector
- Tool execution trace
- MCP/API status
- Verification output
- Backend log stream

If a value is unavailable at runtime, the UI should display `Not available` rather than inventing data.

## Environment

Start from:

```bash
cp .env.example .env
```

Most important variables:

```text
QWEN_API_KEY
DASHSCOPE_API_KEY
QWEN_API_BASE_URL
QWEN_LIVE_CALLS
QWEN_MODEL_DEFAULT
QWEN_MODEL_REMEDIATION
REMEDIATION_EXECUTION_MODE
AUTO_EXECUTE_CONFIDENCE_THRESHOLD
RUNBOOK_ALLOWLIST
VERIFICATION_TIMEOUT_MS
SYNTHETIC_CHECK_INTERVAL_MS
MCP_*_LIVE
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
SLACK_APPROVAL_CHANNEL_ID
SLACK_APPROVER_IDS
PUBLIC_BASE_URL
```

Full setup notes are in [docs/API_KEYS_AND_MCPS.md](docs/API_KEYS_AND_MCPS.md).

## Render Deployment

This repo includes `render.yaml` for a free Render web service.

1. Push the repo to GitHub.
2. Create a Render Blueprint or Web Service from the repo.
3. Add secret environment variables in Render.
4. Set `PUBLIC_BASE_URL` to the Render URL.
5. If using Slack buttons, set Slack Interactivity to:

```text
https://your-render-service.onrender.com/api/slack/interactions
```

More details: [deploy/render/README.md](deploy/render/README.md).

## Docker

```bash
docker build -t trinetra .
docker run --rm -p 4173:4173 trinetra
```

## Incubation Path

Recommended rollout order:

1. Local simulation with fallback models.
2. Live Qwen in shadow mode.
3. Read-only MCPs for logs, metrics, traces, and memory.
4. Slack or local human approval gate.
5. Approval-gated write tools.
6. Execute mode for the demo storefront.
7. Production persistence and real remediation adapters.

## Safety Boundaries

- Qwen cannot run shell commands.
- Qwen cannot edit arbitrary files.
- Qwen cannot call tools outside the registered remediation tool list.
- Client-sent `approval: "approved"` is ignored.
- Slack approvals must be signed or reaction-verified.
- Local browser approvals only work for the currently pending run ID.
- Verification is required before resolution.
