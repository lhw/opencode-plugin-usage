// Parser self-check. Run: node scripts/check-parser.mjs
import assert from "node:assert/strict";
import { parseUsageResponse } from "../src/providers/opencode-go.ts";
import { parseBalance } from "../src/providers/deepseek.ts";

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
