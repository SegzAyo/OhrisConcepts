import { createHash, timingSafeEqual } from "node:crypto";

import { getDatabaseUrl, getPool } from "./_db.js";

// A shorter secret is treated as "not configured" so the admin view never opens
// on a weak or accidentally blank token.
export const MIN_ADMIN_TOKEN_LENGTH = 16;

// Cap the read so a single request stays inside the function's time budget.
const MAX_ROWS = 1000;

export function getAdminToken() {
  const token = process.env.ADMIN_TOKEN?.trim();
  return token && token.length >= MIN_ADMIN_TOKEN_LENGTH ? token : "";
}

// Constant-length, constant-time comparison: hashing first means the compare
// never leaks the token's length and never throws on a mismatch.
export function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || !provided) return false;
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function getHeader(request, name) {
  if (typeof request.headers?.get === "function") {
    return request.headers.get(name) || "";
  }
  return request.headers?.[name] || "";
}

export function getBearerToken(request) {
  const header = getHeader(request, "authorization");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  // Personal contact data must never be indexed or cached by intermediaries.
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.end(JSON.stringify(payload));
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  const expectedToken = getAdminToken();
  if (!expectedToken) {
    return sendJson(response, 503, {
      error: "Admin access is not configured. Set a strong ADMIN_TOKEN to enable it."
    });
  }

  if (!tokensMatch(getBearerToken(request), expectedToken)) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="Ohris admin"');
    return sendJson(response, 401, { error: "Unauthorized." });
  }

  try {
    getDatabaseUrl();
    const database = getPool();
    const { rows } = await database.query(
      `SELECT id, email, name, intent, message, source, created_at
         FROM public.contact_submissions
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [MAX_ROWS]
    );

    return sendJson(response, 200, { submissions: rows, count: rows.length });
  } catch (error) {
    const configurationError = error.message?.startsWith("DATABASE_URL");
    console.error("contact_submissions_read_failed", { code: error.code, message: error.message });
    response.setHeader("Retry-After", "30");
    return sendJson(response, 503, {
      error: configurationError
        ? "The submissions store is not configured yet. Please try again later."
        : "We could not load submissions right now. Please try again."
    });
  }
}
