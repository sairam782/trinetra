import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const queues = new Map();
export function serialize(path, operation) {
  const next = (queues.get(path) || Promise.resolve()).then(operation);
  const settled = next.catch(() => {});
  queues.set(path, settled);
  void settled.then(() => { if (queues.get(path) === settled) queues.delete(path); });
  return next;
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

// Bounded local retention: current file plus five archives, each up to 10 MiB.
// Ship these files to durable log storage before rotation for longer retention.
export function appendJsonLine(path, value) {
  const line = Buffer.from(`${JSON.stringify(value)}\n`);
  if (line.length > 4 * 1024 * 1024) return Promise.reject(new Error("Audit record exceeds 4 MiB"));
  return serialize(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const size = await stat(path).then((s) => s.size, (error) => { if (error.code === "ENOENT") return 0; throw error; });
    if (size + line.length > 10 * 1024 * 1024) {
      await rm(`${path}.5`, { force: true });
      for (let index = 4; index >= 0; index -= 1) {
        await rename(index ? `${path}.${index}` : path, `${path}.${index + 1}`).catch((error) => { if (error.code !== "ENOENT") throw error; });
      }
    }
    const file = await open(path, "a", 0o600);
    try { await file.writeFile(line); await file.sync(); } finally { await file.close(); }
  });
}

export async function readRecentJsonLines(path, limit = 100, maxBytes = 4 * 1024 * 1024) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError("limit must be between 1 and 500");
  const records = [];
  let remaining = maxBytes;
  for (let archive = 0; archive <= 5 && records.length < limit && remaining > 0; archive += 1) {
    let file;
    try { file = await open(archive ? `${path}.${archive}` : path, "r"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    try {
      const { size } = await file.stat();
      const length = Math.min(size, remaining);
      remaining -= length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, size - length);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (size > length) lines.shift(); // Never parse a partial first record.
      for (const line of lines.reverse()) {
        if (!line || records.length >= limit) continue;
        try { records.push(JSON.parse(line)); } catch { /* Ignore a torn or malformed record. */ }
      }
    } finally { await file.close(); }
  }
  return records;
}

export async function flushWrites() {
  await Promise.all([...queues.values()]);
}
