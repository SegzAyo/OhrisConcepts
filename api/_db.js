import pg from "pg";

const { Pool } = pg;

const PLACEHOLDER_PATTERN = /\[?YOUR(?:_|-)(?:PASSWORD|URL(?:_|-)ENCODED(?:_|-)PASSWORD)\]?/i;

let pool;

// Validates DATABASE_URL every call so a request can distinguish a missing or
// malformed configuration from a genuine query failure, regardless of whether
// the pool has already been created.
export function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl || PLACEHOLDER_PATTERN.test(databaseUrl)) {
    throw new Error("DATABASE_URL is not configured.");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use the postgres protocol.");
  }

  return databaseUrl;
}

// A single shared pool per function instance. Files under api/ that begin with
// an underscore are excluded from Vercel's routing, so this stays a helper.
export function getPool() {
  if (pool) return pool;

  const certificateAuthority = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();

  pool = new Pool({
    connectionString: getDatabaseUrl(),
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 8_000,
    query_timeout: 8_000,
    // Supabase's pooler requires TLS. Without its project CA this is equivalent
    // to sslmode=require; setting DATABASE_CA_CERT enables full CA validation.
    ssl: certificateAuthority
      ? { ca: certificateAuthority, rejectUnauthorized: true }
      : { rejectUnauthorized: false }
  });

  pool.on("error", (error) => {
    console.error("database_pool_error", { code: error.code, message: error.message });
  });

  return pool;
}
