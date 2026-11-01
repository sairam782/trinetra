import { createHash, timingSafeEqual } from "node:crypto";

export function authenticated(req, token) {
  if (!token) return true; // Configuration validation forbids this in production.
  const header = req.headers.authorization || "";
  let candidate = "";
  if (header.startsWith("Bearer ")) candidate = header.slice(7);
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    if (decoded.startsWith("trinetra:")) candidate = decoded.slice(9);
  }
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(token));
}

export function sameOriginMutation(req, publicBaseUrl) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients still require authentication.
  try {
    const expected = publicBaseUrl ? new URL(publicBaseUrl).origin : `http://${req.headers.host}`;
    return new URL(origin).origin === expected;
  } catch { return false; }
}
