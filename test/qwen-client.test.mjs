import { it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { parseJsonObject, qwenChatJson } from "../backend/cloud/qwen-client.mjs";
import { checkLiveMcpHealth } from "../backend/mcps/live-connectors.mjs";
import { request, startServer } from "./helpers/server-runner.mjs";

async function provider(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function call(baseUrl, extra = {}) {
  return qwenChatJson({ role: "test", model: "test", system: "test", prompt: "test", fallback: { confidence: 0.5, reasoning: "fallback" }, env: { QWEN_LIVE_CALLS: "true", QWEN_API_KEY: "fake-test-key", QWEN_API_BASE_URL: baseUrl, QWEN_AGENT_TIMEOUT_MS: "200", QWEN_AGENT_RETRY_COUNT: "0" }, ...extra });
}

it("rejects non-object and malformed model JSON", () => {
  for (const content of ["null", "[]", '[{"confidence":1}]', '"text"', "12", "not json", ""]) assert.throws(() => parseJsonObject(content));
  assert.deepEqual(parseJsonObject('```json\n{"reasoning":"a { brace }"}\n```'), { reasoning: "a { brace }" });
});

it("accepts valid model output but does not let it overwrite backend metadata", async (t) => {
  const base = await provider(t, (req, res) => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ confidence: 0.9, reasoning: "valid", mcp: { status: "connected" }, provider: "spoofed" }) } }] })));
  const result = await call(base);
  assert.equal(result.provider, "qwen-live");
  assert.equal(result.confidence, 0.9);
  assert.equal(result.mcp, undefined);
});

it("falls back on malformed and type-invalid model output", async (t) => {
  for (const content of ["not JSON", "null", JSON.stringify({ confidence: "certain" }), JSON.stringify({ confidence: 4 }), JSON.stringify({ reasoning: {} }), "{}"] ) {
    const base = await provider(t, (req, res) => res.end(JSON.stringify({ choices: [{ message: { content } }] })));
    const result = await call(base);
    assert.equal(result.provider, "local-fallback", content);
    assert.equal(result.confidence, 0.5);
  }
});

it("times out a body that stalls after successful response headers", async (t) => {
  const base = await provider(t, (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders(); });
  const started = Date.now();
  const result = await call(base);
  assert.equal(result.provider, "local-fallback");
  assert.ok(Date.now() - started < 2000);
});

it("bounds model response size", async (t) => {
  const base = await provider(t, (req, res) => res.end("x".repeat(1024 * 1024 + 1)));
  const result = await call(base);
  assert.equal(result.provider, "local-fallback");
  assert.match(result.fallback, /exceeds 1 MiB/);
});

it("streams valid model JSON and enforces idle stream timeouts", async (t) => {
  const base = await provider(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"confidence":0.8,"reasoning":"streamed"}' } }] })}\n\ndata: [DONE]\n\n`);
  });
  let text = "";
  assert.equal((await call(base, { onToken: (chunk) => { text += chunk; } })).provider, "qwen-live");
  assert.match(text, /streamed/);
  const idle = await provider(t, (req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); });
  const result = await call(idle, { onToken() {}, env: { QWEN_LIVE_CALLS: "true", QWEN_API_KEY: "fake", QWEN_API_BASE_URL: idle, QWEN_AGENT_TIMEOUT_MS: "2000", QWEN_AGENT_RETRY_COUNT: "0", QWEN_STREAM_IDLE_TIMEOUT_MS: "100" } });
  assert.equal(result.provider, "local-fallback");
  assert.match(result.fallback, /idle/);
});

it("preserves provider identity when connector health checks fail", async (t) => {
  const base = await provider(t, (req, res) => res.destroy());
  const result = await checkLiveMcpHealth({ MCP_TICKETS_LIVE: "true", JIRA_BASE_URL: base, JIRA_EMAIL: "test@example.com", JIRA_API_TOKEN: "fake" });
  assert.equal(result.tickets.status, "error");
  assert.equal(result.unknown, undefined);
});

it("rejects concurrent analysis and injection while a website run owns the state", async (t) => {
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const base = await provider(t, (req, res) => {
    notifyStarted();
    setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: '{"reasoning":"test model"}' } }] })), 100);
  });
  const server = await startServer({ QWEN_LIVE_CALLS: "true", QWEN_API_KEY: "fake", QWEN_API_BASE_URL: base, QWEN_AGENT_RETRY_COUNT: "0" });
  t.after(() => server.kill());
  const options = { method: "POST", body: JSON.stringify({ incidentKey: "website" }) };
  const first = request(server.port, "/api/incidents/analyze", options);
  await started;
  assert.equal((await request(server.port, "/api/incidents/analyze", options)).status, 409);
  assert.equal((await request(server.port, "/api/demo-site/inject-error", { method: "POST", body: JSON.stringify({ failureId: "apiTimeout" }) })).status, 409);
  assert.equal((await first).status, 200);
});
