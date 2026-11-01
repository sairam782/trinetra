# Operating Trinetra safely

Trinetra is a **single-process incident-response demo with hardened hosting controls**. Its only real remediation target is the bundled storefront. Most MCP actions are simulations; enabling a live toggle does not implement a production adapter. Do not connect this executor to customer infrastructure without implementing and reviewing those adapters.

## Supported deployment

Run one long-lived Node 22 or 24 process, behind an HTTPS reverse proxy, with a persistent local volume. Node 26 also passes local checks. Do not use multiple workers, replicas, network-shared storage, or serverless invocations. Pending approvals, deduplication and storefront state are intentionally held in memory; a restart discards them and requires a new investigation and approval. Audit files and historical memory survive when `DATA_DIR` is on a persistent volume.

The server refuses incomplete production configuration. Set:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=4173
DATA_DIR=/var/lib/trinetra
PUBLIC_BASE_URL=https://trinetra.example.com
TRINETRA_AUTH_TOKEN=<random-secret-at-least-32-characters>
REMEDIATION_EXECUTION_MODE=dry-run
QWEN_LIVE_CALLS=false
MCP_CHAT_LIVE=false
ENABLE_LOCAL_APPROVAL=false
DEMO_CONTROLS_ENABLED=false
```

Generate a credential with `openssl rand -hex 32`, save it in your deployment secret manager, and never commit it. Validate the actual environment with `npm run env:check` before starting. It does not merge `.env.example` values into production configuration.

## Access and approval

The console and all operational APIs require authentication when a token is configured. Production requires that token. Browser login uses HTTP Basic: username **trinetra**, password **the token**. API clients use `Authorization: Bearer <token>`. Credentials are never embedded in frontend code or browser storage. TLS must terminate at your trusted reverse proxy; expose only that proxy publicly and redirect HTTP to HTTPS.

This is one shared operator credential, not a multi-user identity or RBAC system. Use a trusted SSO gateway for organization access and rotate the application token when access changes. Do not treat operator audit entries as individually attributable identities. Gate approvals in production require an allowlisted Slack user; local console approvals are unavailable in production.

Only `GET /api/health`, `GET /api/readiness`, `GET /demo-store` and the signed Slack callback are public. The demo storefront is a deliberately public synthetic target. Readiness exposes booleans, not model settings or credentials. Browser cross-origin mutations are rejected; clients without an Origin header still require authentication. Keep `PUBLIC_BASE_URL` equal to the actual browser-facing origin.

To enable gated demo execution, configure live Slack (`MCP_CHAT_LIVE=true`), a bot token, signing secret, approval channel, and real `SLACK_APPROVER_IDS`; then opt into `REMEDIATION_EXECUTION_MODE=execute`. Live model execution needs `QWEN_LIVE_CALLS=true` and a provider key. If execute mode encounters a model fallback in production, the run stops instead of applying the fallback plan. Leave execution disabled until you have tested the entire flow in staging.

Each approval is bound to the current incident snapshot, pending request ID and selected runbook. Expired, superseded, nonexistent and consumed approvals are rejected. A run consumes its approval once before making model calls; a failed resume requires a new investigation and approval. Re-analysis may select a different runbook, which also requires fresh approval. Production never auto-approves based on model confidence alone.

The per-address analysis limiter deliberately uses the socket peer and ignores forwarding headers. Behind one proxy it acts as a shared limit for that proxy. Configure per-user rate limiting and a 64 KiB body limit at your gateway rather than trusting arbitrary `X-Forwarded-For` values. Apply request/connection limits to all public routes at the gateway.

## Persistence and recovery

`DATA_DIR` contains:

- `incident-runs.jsonl`: completed run records and pre-execution authorization records.
- `backend-events.jsonl`: redacted operational events.
- `historical-memory.json`: the most recent 100 memory entries, replaced atomically.

Appends are serialized and synced; memory updates serialize read/modify/write operations and rename a completed temporary file. Records over 4 MiB are rejected. Each JSONL stream rotates at 10 MiB and keeps five archives (`.1` through `.5`), newest first. Recent-record queries read at most 4 MiB and skip incomplete or malformed lines. They can return fewer rows when records are large. This is bounded local retention, not an immutable compliance archive. Ship records to protected external storage before rotation, restrict volume access, and test backup restoration.

A pre-execution audit failure blocks mutation. A completed-run persistence failure marks the process unhealthy and blocks further analysis. Restore writable storage and restart; inspect pre-execution records for actions that may have completed before a crash or later persistence failure. Execution and filesystem audit writes are not one transaction, so exactly-once remediation across crashes is not guaranteed. Never automatically retry a real infrastructure mutation based only on a missing completion record.

Readiness checks actual static files and a synced storage write. It returns HTTP 503 on failure or draining. Liveness reports whether the HTTP process responds. SIGTERM/SIGINT stop new requests, allow in-flight requests to drain, and impose a 15-second shutdown deadline. Clients that disconnect from SSE do not cancel an already-authorized operation; the run completes and is audited. Slow SSE consumers are disconnected to bound the response buffer.

Set gateway upstream timeouts to fit the pipeline's bounded model calls (each call has a deadline and at most three retries). Run one analysis per incident at a time; concurrent requests return 409. At most four incidents run concurrently. Storefront injection/reset is blocked while its pipeline is active.

## Container

```bash
docker build -t trinetra .
docker volume create trinetra-data
docker run --rm --name trinetra \
  --env-file /secure/path/trinetra-production.env \
  -e DATA_DIR=/app/data \
  --mount source=trinetra-data,target=/app/data \
  -p 127.0.0.1:4173:4173 trinetra
```

Put the HTTPS proxy in front of this localhost port. The image runs as the unprivileged `node` user and checks `/api/readiness`. Bind-mounted directories must be writable by UID 1000. No dependencies, test data or secrets are copied into the runtime image. Rebuild regularly for base-image security fixes.

## Release checks

```bash
npm ci --ignore-scripts
npm run ci
npm audit --omit=dev
```

CI runs syntax checks, regression tests and smoke tests on Node 22 and 24, then builds and checks the container. Tests use isolated temporary data directories and fake provider credentials. They cover authentication, CSRF origin checks, approval lifecycle, all five storefront repairs, request validation, rate limiting, concurrent runs, storage failures, bounded reads, model timeouts and malformed model output. Live Slack, Qwen credentials and cloud deployment are separate staging checks.

Before real incident operations, implement durable transactional job/approval state, individually attributable identity and permissions, real read/write adapters, idempotent mutation and rollback contracts, centralized monitoring, backup/restore drills, capacity tests, and independent security review. Those capabilities are not provided by the demo connectors.

Implementation references: [Node HTTP lifecycle](https://nodejs.org/api/http.html), [Node filesystem APIs](https://nodejs.org/api/fs.html), [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/).
