# Trinetra

Trinetra is a Qwen-native autonomous incident response system for the Qwen Cloud hackathon Agent Society track. It watches a broken demo website, reasons across alerts/logs/metrics/traces/history, selects an approved runbook, remediates safely, verifies recovery, and writes a full audit trail.

## Repo Structure

```text
trinetra/
  backend/
    server.mjs                 # Node API, orchestrator, remediation simulator
    cloud/alibaba-client.mjs   # Alibaba Cloud deployment proof seam
  frontend/
    index.html                 # Trinetra dashboard
    app.js                     # UI orchestration
    styles.css                 # Dashboard styling
  scripts/
    smoke-test.mjs             # End-to-end smoke test
  data/                        # Runtime JSONL audit + memory store, gitignored
  Dockerfile
  package.json
  .env.example
```

## Quick Start

```bash
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

## Demo Story

1. Choose one of five storefront failures in the **Error type** selector.
2. Click **Inject error**.
3. Click **Open website** and show `/demo-store` returning the selected failure.
4. Click **Use Trinetra to solve**.
5. Trinetra runs the incident pipeline, selects `RB-777`, applies the matching storefront remediation, verifies `/demo-store` returns healthy, and records the full reasoning chain.

Available failure modes:

- Missing featured-products config
- Catalog API timeout
- Payment widget script crash
- Inventory schema drift
- CSS asset 404 / visual regression

## Verification

```bash
npm run check
npm run smoke
```

The smoke test covers:

- health/readiness endpoints
- Qwen model tier metadata
- Alibaba Cloud proof endpoint
- MCP registry
- structured runbooks
- broken website injection
- Trinetra remediation and verification
- persisted run audit

## Core Endpoints

- `GET /` - Trinetra dashboard
- `GET /demo-store` - intentionally breakable demo website
- `GET /api/demo-site/failures` - selectable website failure catalog
- `POST /api/demo-site/inject-error` - inject storefront failure
- `POST /api/incidents/analyze` - run the Trinetra agent pipeline
- `GET /api/runs` - recent persisted production runs
- `GET /api/mcps` - MCP connector registry
- `GET /api/runbooks` - structured approved runbook library
- `GET /api/cloud/alibaba` - Alibaba Cloud deployment proof/config metadata
- `GET /api/health` and `GET /api/readiness` - operational checks

## Agent Model Tiers

- Commander: `qwen3.6-plus`
- Logs/Metrics/Trace/Communication: `qwen3.6-flash`
- Triage/adjudication: `qwen3.6-max-preview`
- Documentation: `qwen3.6-plus`

Local runs are deterministic without credentials, but each agent call still records model, token estimate, confidence, latency, fallback state, MCP action, and reasoning.

## Environment

Copy `.env.example` when you are ready to wire real services:

```bash
cp .env.example .env
```

Important variables:

- `QWEN_API_KEY` or `DASHSCOPE_API_KEY`
- `QWEN_API_BASE_URL`
- `ALIBABA_CLOUD_REGION`
- `ALIBABA_RDS_POSTGRES_URL`
- `AUTO_EXECUTE_CONFIDENCE_THRESHOLD`
- `RUNBOOK_ALLOWLIST`
- `SLACK_APPROVER_IDS`

## Container

```bash
docker build -t trinetra .
docker run --rm -p 4173:4173 trinetra
```

## Next Planned Modifications

- Replace deterministic `runQwenAgent` output with live Qwen Cloud calls.
- Replace simulated MCP adapters with real MCP clients.
- Persist audit/memory to Alibaba RDS for PostgreSQL or PolarDB.
- Add Slack interactive approval webhook.
- Deploy backend to Alibaba Cloud ECS or Function Compute.
