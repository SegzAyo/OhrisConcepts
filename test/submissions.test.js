import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";
import handler, {
  MIN_ADMIN_TOKEN_LENGTH,
  getAdminToken,
  getBearerToken,
  tokensMatch
} from "../api/submissions.js";

const STRONG_TOKEN = "s".repeat(MIN_ADMIN_TOKEN_LENGTH);

function makeResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: "",
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    end(value = "") {
      this.body = value;
    }
  };
}

function makeRequest({ method = "GET", token } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return { method, headers };
}

// Runs a test body with ADMIN_TOKEN / DATABASE_URL set, restoring both after.
async function withEnv({ adminToken, databaseUrl }, body) {
  const originalAdmin = process.env.ADMIN_TOKEN;
  const originalDb = process.env.DATABASE_URL;
  const originalConsoleError = console.error;
  console.error = () => {};

  if (adminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = adminToken;
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;

  try {
    return await body();
  } finally {
    console.error = originalConsoleError;
    if (originalAdmin === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = originalAdmin;
    if (originalDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDb;
  }
}

test("getBearerToken parses the Authorization header, tolerating casing", () => {
  assert.equal(getBearerToken({ headers: { authorization: "Bearer abc123" } }), "abc123");
  assert.equal(getBearerToken({ headers: { authorization: "bearer  spaced " } }), "spaced");
  assert.equal(getBearerToken({ headers: {} }), "");
  assert.equal(getBearerToken({ headers: { authorization: "Basic abc" } }), "");
});

test("getAdminToken rejects missing and too-short tokens", async () => {
  await withEnv({ adminToken: undefined }, () => assert.equal(getAdminToken(), ""));
  await withEnv({ adminToken: "  " }, () => assert.equal(getAdminToken(), ""));
  await withEnv({ adminToken: "short" }, () => assert.equal(getAdminToken(), ""));
  await withEnv({ adminToken: `  ${STRONG_TOKEN}  ` }, () =>
    assert.equal(getAdminToken(), STRONG_TOKEN)
  );
});

test("tokensMatch is exact and never throws on length mismatch", () => {
  assert.equal(tokensMatch("abc", "abc"), true);
  assert.equal(tokensMatch("abc", "abcd"), false);
  assert.equal(tokensMatch("", "abc"), false);
  assert.equal(tokensMatch(undefined, "abc"), false);
});

test("handler rejects non-GET methods", async () => {
  await withEnv({ adminToken: STRONG_TOKEN }, async () => {
    const response = makeResponse();
    await handler(makeRequest({ method: "POST", token: STRONG_TOKEN }), response);
    assert.equal(response.statusCode, 405);
    assert.equal(response.getHeader("allow"), "GET");
  });
});

test("handler returns 503 when no admin token is configured", async () => {
  await withEnv({ adminToken: undefined }, async () => {
    const response = makeResponse();
    await handler(makeRequest({ token: "anything" }), response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /not configured/i);
  });
});

test("handler treats a weak configured token as not configured", async () => {
  await withEnv({ adminToken: "tooshort" }, async () => {
    const response = makeResponse();
    await handler(makeRequest({ token: "tooshort" }), response);
    assert.equal(response.statusCode, 503);
  });
});

test("handler returns 401 without or with a wrong token", async () => {
  await withEnv({ adminToken: STRONG_TOKEN }, async () => {
    const missing = makeResponse();
    await handler(makeRequest(), missing);
    assert.equal(missing.statusCode, 401);
    assert.match(missing.getHeader("www-authenticate") || "", /Bearer/);

    const wrong = makeResponse();
    await handler(makeRequest({ token: "w".repeat(MIN_ADMIN_TOKEN_LENGTH) }), wrong);
    assert.equal(wrong.statusCode, 401);
  });
});

test("a valid token returns the submissions newest-first", async () => {
  const originalQuery = pg.Pool.prototype.query;
  const sample = [
    { id: 2, email: "b@example.com", name: "Bee", intent: "investor", message: null,
      source: "ohris-concepts", created_at: "2026-07-15T10:00:00.000Z" },
    { id: 1, email: "a@example.com", name: null, intent: null, message: "hi",
      source: "ohris-concepts", created_at: "2026-07-14T10:00:00.000Z" }
  ];
  const queries = [];
  pg.Pool.prototype.query = async function (text, params) {
    queries.push({ text, params });
    return { rows: sample, rowCount: sample.length };
  };

  try {
    await withEnv(
      { adminToken: STRONG_TOKEN, databaseUrl: "postgres://user:pass@localhost:5432/db" },
      async () => {
        const response = makeResponse();
        await handler(makeRequest({ token: STRONG_TOKEN }), response);

        assert.equal(response.statusCode, 200);
        const payload = JSON.parse(response.body);
        assert.equal(payload.count, 2);
        assert.deepEqual(payload.submissions, sample);
        assert.equal(response.getHeader("cache-control"), "no-store");

        const select = queries.find((q) => /SELECT/i.test(q.text));
        assert.ok(select, "expected a SELECT query to run");
        assert.match(select.text, /ORDER BY created_at DESC/i);
      }
    );
  } finally {
    pg.Pool.prototype.query = originalQuery;
  }
});

test("a missing DATABASE_URL surfaces a configuration error", async () => {
  await withEnv({ adminToken: STRONG_TOKEN, databaseUrl: undefined }, async () => {
    const response = makeResponse();
    await handler(makeRequest({ token: STRONG_TOKEN }), response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /not configured/i);
  });
});
