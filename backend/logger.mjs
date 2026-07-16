import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const secretKeyPattern = /(api[_-]?key|token|secret|password|authorization|cookie|credential)/i;

export function createLogger({ path, service = "trinetra-backend", consoleEnabled = true }) {
  const write = async (level, event, fields = {}) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      service,
      event,
      ...redact(fields)
    };
    const line = `${JSON.stringify(entry)}\n`;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, "utf8");
    if (consoleEnabled) {
      const message = `${entry.ts} ${level.toUpperCase()} ${event}`;
      if (level === "error") console.error(message, entry);
      else console.log(message, entry);
    }
    return entry;
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}

export async function readRecentLogEntries(path, limit = 100) {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function redact(value) {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    secretKeyPattern.test(key) ? "[redacted]" : redact(item)
  ]));
}
