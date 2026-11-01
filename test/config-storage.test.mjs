import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRuntimeConfig } from "../backend/config/runtime.mjs";
import { appendJsonLine, atomicWriteJson, readRecentJsonLines, serialize } from "../backend/storage.mjs";
import { redact } from "../backend/logger.mjs";

it("fails closed on incomplete production configuration and invalid numeric controls", () => {
  assert.throws(() => validateRuntimeConfig({ NODE_ENV: "production" }), /TRINETRA_AUTH_TOKEN/);
  const valid = { NODE_ENV: "production", TRINETRA_AUTH_TOKEN: "x".repeat(32), DATA_DIR: "/persistent", PUBLIC_BASE_URL: "https://trinetra.example" };
  assert.equal(validateRuntimeConfig(valid).localApprovalEnabled, false);
  for (const override of [{ PORT: "NaN" }, { MAX_BODY_BYTES: "-1" }, { QWEN_AGENT_RETRY_COUNT: "100" }, { REMEDIATION_EXECUTION_MODE: "typo" }, { ENABLE_LOCAL_APPROVAL: "true" }, { QWEN_LIVE_CALLS: "true" }, { PUBLIC_BASE_URL: "http://example.com" }, { VERCEL: "1" }, { REMEDIATION_EXECUTION_MODE: "execute" }]) {
    assert.throws(() => validateRuntimeConfig({ ...valid, ...override }), /Invalid runtime configuration/);
  }
});

it("serializes concurrent writes and retains parseable recent audit records", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "trinetra-storage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "audit.jsonl");
  await Promise.all(Array.from({ length: 40 }, (_, id) => appendJsonLine(path, { id, text: "✓" })));
  const records = await readRecentJsonLines(path, 40);
  assert.equal(records.length, 40);
  assert.deepEqual(records.map((r) => r.id), Array.from({ length: 40 }, (_, i) => 39 - i));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{"id":40}\n{"broken":', { flag: "a" });
  assert.equal((await readRecentJsonLines(path, 1))[0].id, 40);
});

it("bounds tail reads and keeps history available across rotation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "trinetra-tail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "audit.jsonl");
  await writeFile(path, "x".repeat(10 * 1024 * 1024) + '\n{"id":1}\n');
  assert.deepEqual(await readRecentJsonLines(path, 1, 100), [{ id: 1 }]);
  await appendJsonLine(path, { id: 2 });
  assert.deepEqual(await readRecentJsonLines(path, 2, 100), [{ id: 2 }, { id: 1 }]);
  await assert.rejects(readRecentJsonLines(path, NaN), /limit/);
});

it("atomically replaces memory without losing serialized concurrent updates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "trinetra-memory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "memory.json");
  await atomicWriteJson(path, []);
  await Promise.all(Array.from({ length: 20 }, (_, id) => serialize(path, async () => {
    const current = JSON.parse(await readFile(path, "utf8"));
    await atomicWriteJson(path, [...current, id]);
  })));
  assert.equal(JSON.parse(await readFile(path, "utf8")).length, 20);
});

it("redacts configured secrets even when embedded in text", () => {
  process.env.TEST_API_KEY = "secret-test-value-123";
  try {
    const value = redact({ nested: { apiKey: "other-secret" }, message: "provider said secret-test-value-123; Bearer abc.def.ghi" });
    assert.equal(value.nested.apiKey, "[redacted]");
    assert.ok(!JSON.stringify(value).includes("secret-test-value-123"));
    assert.ok(!JSON.stringify(value).includes("abc.def.ghi"));
  } finally { delete process.env.TEST_API_KEY; }
});
