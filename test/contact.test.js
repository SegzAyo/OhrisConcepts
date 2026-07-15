import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";
import handler, {
  CONTACT_INTENTS,
  isValidEmail,
  normalizeEmail,
  normalizeIntent,
  normalizeText,
  parseBodyValue
} from "../api/contact.js";

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

test("email helpers normalize and validate addresses", () => {
  assert.equal(normalizeEmail("  Hello@Example.COM "), "hello@example.com");
  assert.equal(isValidEmail("hello@example.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(isValidEmail("x".repeat(255) + "@example.com"), false);
});

test("normalizeText trims, caps length, and ignores non-strings", () => {
  assert.equal(normalizeText("  Ada Lovelace  ", 120), "Ada Lovelace");
  assert.equal(normalizeText("x".repeat(200), 120).length, 120);
  assert.equal(normalizeText(1234, 120), "");
  assert.equal(normalizeText(undefined, 120), "");
});

test("normalizeIntent accepts known values and rejects the rest", () => {
  assert.equal(normalizeIntent("Investor"), "investor");
  assert.equal(normalizeIntent("  future-teammate "), "future-teammate");
  for (const intent of CONTACT_INTENTS) {
    assert.equal(normalizeIntent(intent), intent);
  }
  assert.equal(normalizeIntent("hacker"), "");
  assert.equal(normalizeIntent(""), "");
  assert.equal(normalizeIntent(42), "");
});

test("body parser accepts objects, strings, and buffers", () => {
  assert.deepEqual(parseBodyValue({ email: "a@b.com" }), { email: "a@b.com" });
  assert.deepEqual(parseBodyValue('{"email":"a@b.com"}'), { email: "a@b.com" });
  assert.deepEqual(parseBodyValue(Buffer.from('{"email":"a@b.com"}')), { email: "a@b.com" });
  assert.throws(() => parseBodyValue([]), /JSON object/);
});

test("handler rejects unsupported methods", async () => {
  const response = makeResponse();
  await handler({ method: "GET", headers: {} }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.getHeader("allow"), "POST");
});

test("handler requires a JSON content type and valid JSON", async () => {
  const unsupportedResponse = makeResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "person@example.com"
  }, unsupportedResponse);
  assert.equal(unsupportedResponse.statusCode, 415);

  const malformedResponse = makeResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{"
  }, malformedResponse);
  assert.equal(malformedResponse.statusCode, 400);
});

test("handler rejects invalid email before opening a database connection", async () => {
  const response = makeResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { email: "invalid" }
  }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /valid email/i);
});

test("honeypot submissions return success without a database", async () => {
  const response = makeResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { email: "person@example.com", website: "https://spam.example" }
  }, response);
  assert.equal(response.statusCode, 200);
});

test("valid submissions explain a missing server configuration safely", async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalConsoleError = console.error;
  delete process.env.DATABASE_URL;
  console.error = () => {};

  try {
    const response = makeResponse();
    await handler({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { email: "person@example.com" }
    }, response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /not configured/i);
  } finally {
    console.error = originalConsoleError;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test("a successful submission writes the sanitized fields to the insert", async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalQuery = pg.Pool.prototype.query;
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";

  const queries = [];
  pg.Pool.prototype.query = async function (text, params) {
    queries.push({ text, params });
    return { rows: [], rowCount: 1 };
  };

  try {
    const response = makeResponse();
    await handler({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        email: "  Person@Example.com  ",
        name: "  Ada Lovelace  ",
        intent: "Investor",
        message: "  Would love to learn more.  ",
        website: ""
      }
    }, response);

    assert.equal(response.statusCode, 200);
    const insert = queries.find((query) => /INSERT INTO/i.test(query.text));
    assert.ok(insert, "expected an INSERT query to run");
    // The trimmed, lowercased, allow-listed values must reach the parameters.
    assert.deepEqual(insert.params, [
      "person@example.com",
      "Ada Lovelace",
      "investor",
      "Would love to learn more."
    ]);
  } finally {
    pg.Pool.prototype.query = originalQuery;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test("an unknown intent is stored as null rather than rejected", async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalQuery = pg.Pool.prototype.query;
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";

  const queries = [];
  pg.Pool.prototype.query = async function (text, params) {
    queries.push({ text, params });
    return { rows: [], rowCount: 1 };
  };

  try {
    const response = makeResponse();
    await handler({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { email: "person@example.com", intent: "spy", name: "   " }
    }, response);

    assert.equal(response.statusCode, 200);
    const insert = queries.find((query) => /INSERT INTO/i.test(query.text));
    assert.ok(insert, "expected an INSERT query to run");
    // Unknown intent and whitespace-only name coerce to null.
    assert.deepEqual(insert.params, ["person@example.com", null, null, null]);
  } finally {
    pg.Pool.prototype.query = originalQuery;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});
