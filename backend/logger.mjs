import { appendJsonLine, readRecentJsonLines } from "./storage.mjs";

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
    await appendJsonLine(path, entry).catch((error) => {
      console.error("Trinetra log persistence failed", error.code || error.name);
      throw error;
    });
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
  return readRecentJsonLines(path, limit);
}

export function redact(value) {
  if (typeof value === "string") {
    for (const [key, secret] of Object.entries(process.env)) {
      if (secretKeyPattern.test(key) && secret.length >= 8) value = value.split(secret).join("[redacted]");
    }
    return value.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    secretKeyPattern.test(key) ? "[redacted]" : redact(item)
  ]));
}
