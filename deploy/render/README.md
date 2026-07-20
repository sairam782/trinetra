# Render Free Deployment

Render is the recommended free hosted option for Trinetra because it runs the existing long-lived Node server and provides a public HTTPS URL for Slack button callbacks.

## Deploy

1. Push this repo to GitHub.
2. In Render, choose **New > Blueprint** and select this repo, or choose **New > Web Service** and use:

   ```text
   Build Command: npm install
   Start Command: node backend/server.mjs
   ```

3. Use the free instance type.
4. Add the secret environment variables from your local `.env`.

## Required Environment Variables

Set these in Render:

```text
QWEN_API_KEY
SLACK_APPROVER_IDS
SLACK_APPROVAL_CHANNEL_ID
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
PUBLIC_BASE_URL
```

Set `PUBLIC_BASE_URL` after Render gives you the service URL:

```text
https://<your-render-service>.onrender.com
```

The included `render.yaml` already sets the non-secret defaults for Qwen live mode, Slack button mode, and demo execution.

## Slack Buttons

In Slack app settings, set **Interactivity Request URL** to:

```text
https://<your-render-service>.onrender.com/api/slack/interactions
```

Reinstall the Slack app if scopes changed.

## Test

1. Wake the Render free service by opening:

   ```text
   https://<your-render-service>.onrender.com/api/health
   ```

2. Open the app:

   ```text
   https://<your-render-service>.onrender.com
   ```

3. Trigger an incident:

   ```bash
   curl -X POST https://<your-render-service>.onrender.com/api/incidents/analyze \
     -H "content-type: application/json" \
     -d '{"incidentKey":"website","approvalRequestId":"render-demo-001"}'
   ```

4. Click **Approve** in Slack.
5. Confirm approval:

   ```text
   https://<your-render-service>.onrender.com/api/approvals
   ```

## Free Tier Note

Render free services can sleep when idle. Before testing Slack buttons, open `/api/health` once to wake the service.
