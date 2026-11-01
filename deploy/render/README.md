# Render deployment

The blueprint runs one Node service with a persistent disk. It selects a paid `starter` service because [Render persistent disks require paid services](https://render.com/docs/disks). Deploying the blueprint provisions paid resources; editing this file does not deploy anything.

1. Create a Blueprint from the repository only when ready to provision the service.
2. Set `PUBLIC_BASE_URL` to the exact HTTPS service/custom-domain origin.
3. Retrieve the generated `TRINETRA_AUTH_TOKEN` from your service settings. Log into the console as `trinetra` with that token as the password.
4. Confirm `/api/health` and `/api/readiness` return 200.
5. Keep the default dry-run mode while checking logs and storage. Configure model and Slack credentials separately before enabling live calls or gated execution.

The blueprint mounts `/var/data/trinetra` and sets `DATA_DIR` accordingly. Do not add replicas or remove the persistent disk. Ephemeral in-memory approvals are invalidated on restart; audit and memory files remain on disk.

For Slack buttons set `SLACK_INTERACTIVE_BUTTONS=true` and the interactivity URL to `https://<your-host>/api/slack/interactions`. Set `MCP_CHAT_LIVE=true`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APPROVAL_CHANNEL_ID`, and real `SLACK_APPROVER_IDS`. A new analysis creates a pending request; approve that request in Slack and resume using its actual request ID. Arbitrary pre-created approval IDs are rejected.

See [production operations](../../docs/PRODUCTION.md) for authentication, rollout, backup, limitations, and recovery procedures. See [Render's blueprint reference](https://render.com/docs/blueprint-spec) for hosting configuration.
