// Parser self-check. Run: node scripts/check-parser.mjs
import assert from "node:assert/strict";
import { parseUsageResponse } from "../src/providers/opencode-go.ts";
import { parseBalance } from "../src/providers/deepseek.ts";
import { parseCredits } from "../src/providers/openrouter.ts";
import { fetchUsage as fetchOpenAIUsage, openaiProvider, parseCodexUsage } from "../src/providers/openai.ts";
import { storedApiKey } from "../src/providers/auth.ts";

const now = 1_752_000_000;

// canonical shape: usage windows with direct percent
let w = parseUsageResponse(
  {
    usage: {
      rollingUsage: { usedPercent: 38.2, resetInSec: 7200 },
      weeklyUsage: { usagePercent: 12, resetInSec: 172800 },
      monthlyUsage: { usagePercent: 55, resetInSec: 1036800 },
    },
  },
  now,
);
assert.deepEqual(
  w.map((x) => [x.id, x.percent, x.resetInSec]),
  [
    ["rolling", 38.2, 7200],
    ["weekly", 12, 172800],
    ["monthly", 55, 1036800],
  ],
);

// fraction percent (0..1) is scaled to 0..100
w = parseUsageResponse(
  { data: { rolling: { usage: 0.42, resetSec: 600 } } },
  now,
);
assert.equal(w.length, 1);
assert.equal(w[0].id, "rolling");
assert.equal(w[0].percent, 42);
assert.equal(w[0].resetInSec, 600);

// used/limit derived percent
w = parseUsageResponse(
  {
    result: {
      rollingUsage: { used: 30, limit: 100, resetInSeconds: 900 },
      weeklyUsage: { used: 75, total: 100 },
    },
  },
  now,
);
assert.deepEqual(
  w.map((x) => [x.id, x.percent]),
  [
    ["rolling", 30],
    ["weekly", 75],
  ],
);

// reset via resetAt timestamp (ms) and ISO string
w = parseUsageResponse(
  { rollingUsage: { percent: 10, resetAt: (now + 3600) * 1000 } },
  now,
);
assert.equal(w[0].resetInSec, 3600);

// clamped, out-of-range percent
w = parseUsageResponse({ rollingUsage: { percent: 250 } }, now);
assert.equal(w[0].percent, 100);

// top-level window object (no wrapper)
w = parseUsageResponse(
  { rollingUsage: { percent: 5, resetInSec: 100 } },
  now,
);
assert.equal(w.length, 1);
assert.equal(w[0].id, "rolling");

// no windows -> empty
assert.deepEqual(parseUsageResponse({ hello: "world" }, now), []);
assert.deepEqual(parseUsageResponse(42, now), []);

console.log("parser checks passed");

// deepseek balance parse
let b = parseBalance([
  { currency: "USD", total_balance: "7.85", granted_balance: "0.00", topped_up_balance: "7.85" },
  { currency: "CNY", total_balance: "110.00" },
  { foo: "bar" },
]);
assert.deepEqual(
  b.map((x) => [x.currency, x.total]),
  [
    ["USD", 7.85],
    ["CNY", 110],
  ],
);
assert.deepEqual(parseBalance([]), []);
assert.deepEqual(parseBalance(null), []);

console.log("deepseek balance checks passed");

// openrouter credits
assert.deepEqual(parseCredits({ data: { total_credits: 10, total_usage: 3.5 } }), [{ currency: "USD", total: 6.5 }]);
assert.deepEqual(parseCredits({ data: { total_credits: 2, total_usage: 5 } }), [{ currency: "USD", total: 0 }]);
assert.deepEqual(parseCredits({ data: { total_usage: 1 } }), []);
assert.deepEqual(parseCredits({}), []);
assert.deepEqual(parseCredits(null), []);

// Codex OAuth resolution uses the access token and account ID, never the refresh token.
const openaiAuthContext = {
  env: {
    OPENCODE_AUTH_CONTENT: JSON.stringify({
      openai: { type: "oauth", access: "access-token", refresh: "refresh-token", accountId: "account-123" },
    }),
  },
};
assert.equal(openaiProvider.resolveApiKey(openaiAuthContext), "access-token");
assert.equal(openaiProvider.resolveAccountId(openaiAuthContext), "account-123");
assert.deepEqual(await openaiProvider.resolveCredentials({
  env: {},
  listCredentials: async () => [
    { integrationID: "openrouter", active: true, value: { type: "oauth", access: "wrong-provider" } },
    { integrationID: "openai", active: false, value: { type: "oauth", access: "inactive" } },
    {
      integrationID: "openai",
      active: true,
      value: { type: "oauth", access: "sqlite-access", metadata: { accountID: "sqlite-account" } },
    },
  ],
}), { token: "sqlite-access", accountId: "sqlite-account" });
assert.deepEqual(await openaiProvider.resolveCredentials(openaiAuthContext), {
  token: "access-token",
  accountId: "account-123",
});
assert.equal(await storedApiKey("deepseek", {
  env: {},
  listCredentials: async () => [
    { integrationID: "deepseek", active: true, value: { type: "key", key: "sqlite-api-key" } },
  ],
}), "sqlite-api-key");

// Codex usage windows report used_percent and reset_at Unix seconds.
const codexUsage = {
  rate_limit: {
    primary_window: { used_percent: 38, reset_at: now + 3600, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 74, reset_at: now + 86400, limit_window_seconds: 604800 },
  },
};
assert.deepEqual(parseCodexUsage(codexUsage, now), [
  { id: "rolling", label: "5h", percent: 38, resetInSec: 3600 },
  { id: "weekly", label: "Week", percent: 74, resetInSec: 86400 },
]);
assert.deepEqual(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 120 } } }, now), [
  { id: "rolling", label: "5h", percent: 100, resetInSec: 0 },
]);
// A weekly-only limit in the primary slot (secondary null) is labelled Week, not 5h.
assert.deepEqual(parseCodexUsage({
  rate_limit: { primary_window: { used_percent: 12, reset_at: now + 3600, limit_window_seconds: 604800 }, secondary_window: null },
}, now), [
  { id: "weekly", label: "Week", percent: 12, resetInSec: 3600 },
]);
assert.deepEqual(parseCodexUsage({}), []);

// Verify the request uses the Codex endpoint and account-scoped OAuth headers.
const originalFetch = globalThis.fetch;
let request;
globalThis.fetch = async (url, options) => {
  request = { url, options };
  return new Response(JSON.stringify(codexUsage), { status: 200, headers: { "Content-Type": "application/json" } });
};
try {
  await fetchOpenAIUsage("access-token", { timeoutMs: 1000, accountId: "account-123" });
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(request.url, "https://chatgpt.com/backend-api/wham/usage");
assert.equal(request.options.headers.Authorization, "Bearer access-token");
assert.equal(request.options.headers["ChatGPT-Account-Id"], "account-123");

console.log("openrouter + OpenAI Codex checks passed");

// percent of exactly 1 is 1%, not 100% (fraction heuristic must not fire on integer percents)
w = parseUsageResponse({ rollingUsage: { percent: 1, resetInSec: 600 } }, now);
assert.equal(w.length, 1);
assert.equal(w[0].percent, 1);
w = parseUsageResponse({ rollingUsage: { percent: 0, resetInSec: 600 } }, now);
assert.equal(w[0].percent, 0);
