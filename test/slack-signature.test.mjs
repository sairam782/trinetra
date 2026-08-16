import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { request, slackApprovalBody, slackSignatureHeaders, startServer, testSigningSecret } from "./helpers/server-runner.mjs";

describe("POST /api/slack/interactions", () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(() => server?.kill());

  it("rejects requests missing the Slack signature headers with 401", async () => {
    const body = slackApprovalBody({ requestId: "req-missing-headers" });
    const res = await request(server.port, "/api/slack/interactions", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" }
    });
    assert.equal(res.status, 401);
    assert.match(res.body, /Missing Slack signature headers/);
  });

  it("rejects requests with a wrong HMAC signature with 401", async () => {
    const body = slackApprovalBody({ requestId: "req-bad-sig" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const wrongSig = `v0=${crypto.createHmac("sha256", "not-the-real-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const res = await request(server.port, "/api/slack/interactions", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": wrongSig
      }
    });
    assert.equal(res.status, 401);
    assert.match(res.body, /Invalid Slack signature/);
  });

  it("rejects timestamps older than 5 minutes with 401", async () => {
    const body = slackApprovalBody({ requestId: "req-stale" });
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 601);
    const signature = `v0=${crypto.createHmac("sha256", testSigningSecret).update(`v0:${staleTimestamp}:${body}`).digest("hex")}`;
    const res = await request(server.port, "/api/slack/interactions", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": staleTimestamp,
        "x-slack-signature": signature
      }
    });
    assert.equal(res.status, 401);
    assert.match(res.body, /Stale Slack signature timestamp/);
  });

  it("returns 200 ephemeral text for a valid signature with an allowlisted approver", async () => {
    const body = slackApprovalBody({ requestId: "req-valid" });
    const res = await request(server.port, "/api/slack/interactions", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...slackSignatureHeaders(body)
      }
    });
    assert.equal(res.status, 200);
    const payload = res.json();
    assert.equal(payload.approval.state, "approved");
    assert.equal(payload.approval.source, "slack-signed");
    assert.equal(payload.approval.incidentKey, "website");
    assert.equal(payload.approval.approverId, "U-TEST-JUDGE");
  });

  it("returns 200 ephemeral text (but 403-like message) for a valid signature from a non-allowlisted approver", async () => {
    const body = slackApprovalBody({ requestId: "req-not-allowlisted", approverId: "U-STRANGER" });
    const res = await request(server.port, "/api/slack/interactions", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...slackSignatureHeaders(body)
      }
    });
    // Slack handler swallows the 403 into an ephemeral 200 with the rejection message.
    assert.equal(res.status, 200);
    assert.match(res.body, /Slack approver is not allowlisted: U-STRANGER/);
  });
});
