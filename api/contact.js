import { getPool } from "./_db.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let schemaPromise;

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length > 3 && email.length <= 254 && EMAIL_PATTERN.test(email);
}

export const CONTACT_INTENTS = ["customer", "collaborator", "investor", "future-teammate"];
const INTENT_SET = new Set(CONTACT_INTENTS);
export const NAME_MAX_LENGTH = 120;
export const MESSAGE_MAX_LENGTH = 1000;

// Optional free-text fields are sanitized rather than rejected: a real person is
// never turned away, and the length cap keeps writes inside the column limits.
export function normalizeText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

// Intent must be one of our known values; anything else (drift, tampering, bots)
// is treated as "not provided" and stored as null.
export function normalizeIntent(value) {
  const intent = typeof value === "string" ? value.trim().toLowerCase() : "";
  return INTENT_SET.has(intent) ? intent : "";
}

export function parseBodyValue(value) {
  if (value == null || value === "") return {};
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  if (typeof value === "string") return JSON.parse(value);
  if (typeof value === "object" && !Array.isArray(value)) return value;
  throw new TypeError("The request body must be a JSON object.");
}

async function ensureSchema(database) {
  if (!schemaPromise) {
    schemaPromise = database.query(`
      CREATE TABLE IF NOT EXISTS public.contact_submissions (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email varchar(254) NOT NULL,
        name varchar(120),
        intent text,
        message varchar(1000),
        source text NOT NULL DEFAULT 'ohris-concepts',
        created_at timestamptz NOT NULL DEFAULT now()
      );

      ALTER TABLE public.contact_submissions ADD COLUMN IF NOT EXISTS name varchar(120);
      ALTER TABLE public.contact_submissions ADD COLUMN IF NOT EXISTS intent text;
      ALTER TABLE public.contact_submissions ADD COLUMN IF NOT EXISTS message varchar(1000);

      -- Move to an append-only model: each submission is its own row, so a
      -- returning person's new intent or message is never overwritten.
      ALTER TABLE public.contact_submissions DROP CONSTRAINT IF EXISTS contact_submissions_email_key;
      CREATE INDEX IF NOT EXISTS contact_submissions_email_idx ON public.contact_submissions (email);

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_submissions_intent_check') THEN
          ALTER TABLE public.contact_submissions
            ADD CONSTRAINT contact_submissions_intent_check
            CHECK (intent IS NULL OR intent IN ('customer', 'collaborator', 'investor', 'future-teammate'));
        END IF;
      END $$;

      ALTER TABLE public.contact_submissions ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE public.contact_submissions FROM anon, authenticated;
    `).catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }

  return schemaPromise;
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function getContentType(request) {
  if (typeof request.headers?.get === "function") {
    return request.headers.get("content-type") || "";
  }
  return request.headers?.["content-type"] || "";
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  if (!getContentType(request).toLowerCase().startsWith("application/json")) {
    return sendJson(response, 415, { error: "Content-Type must be application/json." });
  }

  let body;
  try {
    body = parseBodyValue(request.body);
  } catch {
    return sendJson(response, 400, { error: "The request body must be valid JSON." });
  }

  // Honeypot field: bots receive the normal success response without a write.
  if (typeof body.website === "string" && body.website.trim()) {
    return sendJson(response, 200, { message: "Thanks — we'll be in touch soon." });
  }

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) {
    return sendJson(response, 400, { error: "Enter a valid email address." });
  }

  const name = normalizeText(body.name, NAME_MAX_LENGTH);
  const intent = normalizeIntent(body.intent);
  const message = normalizeText(body.message, MESSAGE_MAX_LENGTH);

  try {
    const database = getPool();
    await ensureSchema(database);
    await database.query(
      `INSERT INTO public.contact_submissions (email, name, intent, message)
       VALUES ($1, $2, $3, $4)`,
      [email, name || null, intent || null, message || null]
    );

    return sendJson(response, 200, { message: "Thanks — we'll be in touch soon." });
  } catch (error) {
    const configurationError = error.message?.startsWith("DATABASE_URL");
    console.error("contact_submission_failed", { code: error.code, message: error.message });
    response.setHeader("Retry-After", "30");
    return sendJson(response, 503, {
      error: configurationError
        ? "The contact form is not configured yet. Please try again later."
        : "We could not save your request right now. Please try again."
    });
  }
}
