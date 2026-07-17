# Trinetra

Trinetra is a Qwen-native autonomous incident response system for the Qwen Cloud hackathon Agent Society track. It watches a broken demo website, reasons across alerts/logs/metrics/traces/history, selects an approved runbook, remediates safely, verifies recovery, and writes a full audit trail.

## Repo Structure

```text
trinetra/
  backend/
    server.mjs                 # Node API, async orchestrator, gated remediation executor
    logger.mjs                 # Redacting JSONL backend logger
    cloud/qwen-client.mjs      # DashScope/OpenAI-compatible Qwen client
    cloud/alibaba-client.mjs   # Alibaba Cloud deployment proof seam
  frontend/
    index.html                 # Trinetra dashboard
    app.js                     # UI orchestration
    styles.css                 # Dashboard styling
  scripts/
    smoke-test.mjs             # End-to-end smoke test
    setup-env.mjs              # Local .env writer for API keys and MCP toggles
    validate-env.mjs           # Secret-safe readiness checker
  docs/
    API_KEYS_AND_MCPS.md       # Full key/MCP setup guide
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

Run a second local copy with backend logging on another port:

```bash
npm run start:logger
```

Open [http://127.0.0.1:4174](http://127.0.0.1:4174). Recent backend events are available at `/api/logs`, and the JSONL log file is written to `data/backend-events.jsonl`.

## Demo Story

Trinetra has two dashboard modes:

- **Demo** - a non-mutating pipeline and project tour. Use it to explain the architecture, repo folders, agent flow, MCP registry, and audit path.
- **Realtime** - the live target website mode. Use it to inject storefront failures into `/demo-store`, observe the generated incident, route it through Trinetra, execute the selected runbook action, and verify recovery. This is also where real Qwen calls and live MCP adapters can be promoted later.

1. Switch to **Realtime**.
2. Choose one of five storefront failures in the **Error type** selector.
3. Click **Inject error**.
4. Click **Open website** and show `/demo-store` returning the selected failure.
5. Click **Run Trinetra pipeline**.
6. Trinetra runs the incident pipeline, asks Qwen to triage the root cause, then runs an autonomous remediation agent that may call only registered backend tools such as `restore_feature_config()`, `pin_payment_widget()`, `restart_demo()`, and `verify_demo()`.
7. By default, execution is dry-run only, so `/demo-store` stays broken while Trinetra shows the planned action. Set `REMEDIATION_EXECUTION_MODE=execute` only when you want the executor to mutate the target website.

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
npm run incubate
```

The smoke test covers:

- health/readiness endpoints
- Qwen model tier metadata
- Alibaba Cloud proof endpoint
- MCP registry
- structured runbooks
- broken website injection
- dry-run remediation planning and verification
- persisted run audit
- realtime status endpoint

## Core Endpoints

- `GET /` - Trinetra dashboard
- `GET /demo-store` - intentionally breakable demo website
- `GET /api/demo-site/failures` - selectable website failure catalog
- `GET /api/realtime/status` - realtime model/MCP readiness and live event stream
- `POST /api/demo-site/inject-error` - inject storefront failure
- `POST /api/incidents/analyze` - run the Trinetra agent pipeline
- `GET /api/runs` - recent persisted production runs
- `GET /api/logs` - recent redacted backend log events
- `GET /api/mcps` - MCP connector registry
- `GET /api/runbooks` - structured approved runbook library
- `GET /api/cloud/alibaba` - Alibaba Cloud deployment proof/config metadata
- `GET /api/health` and `GET /api/readiness` - operational checks

## Agent Model Tiers

- Default local/international model: `qwen-plus`
- Override all agents with `QWEN_MODEL_DEFAULT`
- Override one agent with `QWEN_MODEL_COMMANDER`, `QWEN_MODEL_LOGS`, `QWEN_MODEL_METRICS`, `QWEN_MODEL_TRACES`, `QWEN_MODEL_MEMORY`, `QWEN_MODEL_TRIAGE`, `QWEN_MODEL_REMEDIATION`, `QWEN_MODEL_COMMUNICATION`, or `QWEN_MODEL_DOCUMENTATION`

Local runs are deterministic without credentials, but each agent call still records model, token estimate, confidence, latency, fallback state, MCP action, and reasoning.

## Agentic Remediation Tool Calling

The remediation phase is intentionally constrained. Qwen never receives shell access, filesystem access, or arbitrary edit capability. It receives incident context, specialist findings, the matched runbook, and a registry of safe tools:

- `restore_feature_config()`
- `restart_demo()`
- `reload_cache()`
- `pin_payment_widget()`
- `restore_css()`
- `clear_inventory_mapper()`
- `enable_catalog_cache()`
- `verify_demo()`

The backend execution loop validates every tool name against the registry, executes the approved backend function, appends the tool result to the agent transcript, and requires `verify_demo()` before the incident can be marked resolved. These tools repair the demo application's desired configuration and runtime state; they do not flip a generic success flag. `restart_demo()` reloads repaired configuration into the active storefront runtime, `reload_cache()` refreshes the active CSS/config cache, and `verify_demo()` renders the storefront and checks for healthy page signals before declaring success. If verification fails, Trinetra runs the rollback path (`restart_demo()` followed by `verify_demo()`) and escalates to a human if the system is still unhealthy.

To enable real Qwen calls through Alibaba Cloud Model Studio / DashScope compatible mode:

```bash
QWEN_API_KEY=your_key_here \
QWEN_API_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1 \
QWEN_MODEL_DEFAULT=qwen-plus \
QWEN_LIVE_CALLS=true \
npm start
```

To also allow Trinetra to mutate the demo website after the runbook gate:

```bash
REMEDIATION_EXECUTION_MODE=execute npm start
```

Keep `REMEDIATION_EXECUTION_MODE=dry-run` for judging walkthroughs where you want to show diagnosis and approval without automatically fixing the injected failure.

## Environment

Copy `.env.example` when you are ready to wire real services:

```bash
cp .env.example .env
```

Or use the setup helper:

```bash
npm run env:setup:interactive
npm run env:check
```

`npm start` automatically loads local `.env`, so you do not need to export variables manually.

Full guide: [docs/API_KEYS_AND_MCPS.md](docs/API_KEYS_AND_MCPS.md)

Important variables:

- `QWEN_API_KEY` or `DASHSCOPE_API_KEY`
- `QWEN_API_BASE_URL`
- `QWEN_MODEL_DEFAULT`
- `QWEN_MODEL_REMEDIATION`
- `QWEN_LIVE_CALLS`
- `REMEDIATION_EXECUTION_MODE`
- `ALIBABA_CLOUD_REGION`
- `ALIBABA_RDS_POSTGRES_URL`
- `AUTO_EXECUTE_CONFIDENCE_THRESHOLD`
- `RUNBOOK_ALLOWLIST`
- `SLACK_APPROVER_IDS`
- `MCP_*_LIVE`

## Container

```bash
docker build -t trinetra .
docker run --rm -p 4173:4173 trinetra
```

## Next Planned Modifications

- Replace simulated MCP adapters with real MCP clients.
- Persist audit/memory to Alibaba RDS for PostgreSQL or PolarDB.
- Add Slack interactive approval webhook.
- Deploy backend to Alibaba Cloud ECS or Function Compute.

## Incubating Models and MCPs

Run:

```bash
npm run incubate
```

The recommended order is:

1. Demo simulation
2. Qwen shadow mode
3. Read-only MCPs
4. Approval-gated writes
5. Safe auto-execute
6. Production persistence on Alibaba Cloud
