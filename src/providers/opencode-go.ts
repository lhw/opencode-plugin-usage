import { fetchJSON, isRecord, num } from "../fetch.ts";
import { storedApiKey } from "./auth.ts";
import type {
  FetchContext,
  Provider,
  ProviderUsage,
  ResolveKeyContext,
  UsageWindow,
  UsageWindowId,
} from "../types.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const AUTH_ENTRY = "opencode-go";
const API_KEY_ENV = "OPENCODE_API_KEY";

const WINDOW_ORDER: UsageWindowId[] = ["rolling", "weekly", "monthly"];
const WINDOW_LABELS: Record<UsageWindowId, string> = {
  rolling: "5h",
  weekly: "Week",
  monthly: "Month",
};

const PERCENT_KEYS = [
  "usagePercent", "usedPercent", "percentUsed", "percent",
  "usage_percent", "used_percent",
  "utilization", "utilizationPercent", "utilization_percent",
];
const USED_KEYS = ["used", "usage", "consumed", "count", "usedTokens"];
const LIMIT_KEYS = ["limit", "total", "quota", "max", "cap", "tokenLimit"];
const RESET_SEC_KEYS = [
  "resetInSec", "resetInSeconds", "resetSeconds",
  "reset_sec", "reset_in_sec", "resetsInSec", "resetsInSeconds",
  "resetIn", "resetSec",
];
const RESET_AT_KEYS = [
  "resetAt", "resetsAt", "reset_at", "resets_at",
  "nextReset", "next_reset", "renewAt", "renew_at",
];
const USAGE_WRAPPERS = ["data", "result", "usage", "billing", "payload"];

export async function fetchUsage(apiKey: string, ctx: FetchContext): Promise<ProviderUsage> {
  const data = await fetchJSON(
    USAGE_URL,
    {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    ctx.timeoutMs,
  );
  const windows = parseUsageResponse(data, Date.now() / 1000);
  if (windows.length === 0) {
    throw new Error("no usage windows found in response");
  }
  return { provider: "opencode-go", windows, fetchedAt: Date.now() };
}

/**
 * Parse the usage JSON. Returns windows in a stable order (rolling, weekly,
 * monthly); a window is included only when the response reports it.
 */
export function parseUsageResponse(data: unknown, nowSec: number): UsageWindow[] {
  const usage = findUsageDict(data);
  if (!usage) return [];

  const result: UsageWindow[] = [];
  for (const id of WINDOW_ORDER) {
    const window = windowFrom(usage, id);
    if (!window) continue;
    const percent = percentOf(window);
    if (percent === undefined) continue;
    result.push({
      id,
      label: WINDOW_LABELS[id],
      percent,
      resetInSec: resetOf(window, nowSec),
    });
  }
  return result;
}

function findUsageDict(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  if (hasWindow(data)) return data;
  for (const key of USAGE_WRAPPERS) {
    const nested = data[key];
    if (isRecord(nested) && hasWindow(nested)) return nested;
  }
  return findUsageNested(data, 0);
}

function findUsageNested(obj: Record<string, unknown>, depth: number): Record<string, unknown> | undefined {
  if (depth > 3) return undefined;
  for (const value of Object.values(obj)) {
    if (!isRecord(value)) continue;
    if (hasWindow(value)) return value;
    const nested = findUsageNested(value, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function hasWindow(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (keyMatchesWindow(key, "rolling")) return true;
  }
  return false;
}

function windowFrom(usage: Record<string, unknown>, id: UsageWindowId): Record<string, unknown> | undefined {
  const keys = Object.keys(usage);
  const preferred = id === "rolling"
    ? ["rollingUsage", "rolling", "rolling_usage", "rollingWindow", "rolling_window"]
    : id === "weekly"
      ? ["weeklyUsage", "weekly", "weekly_usage", "weeklyWindow", "weekly_window"]
      : ["monthlyUsage", "monthly", "monthly_usage", "monthlyWindow", "monthly_window"];
  for (const key of preferred) {
    const value = usage[key];
    if (isRecord(value)) return value;
  }
  for (const key of keys) {
    if (keyMatchesWindow(key, id) && isRecord(usage[key])) return usage[key];
  }
  return undefined;
}

function keyMatchesWindow(key: string, id: UsageWindowId): boolean {
  const lower = key.toLowerCase();
  if (id === "rolling") return lower.includes("rolling") || lower.includes("5h") || lower.includes("5-hour") || lower.includes("hour");
  if (id === "weekly") return lower.includes("weekly") || lower.includes("week");
  return lower.includes("monthly") || lower.includes("month");
}

function percentOf(window: Record<string, unknown>): number | undefined {
  for (const key of PERCENT_KEYS) {
    const value = num(window[key]);
    if (value !== undefined) {
      const direct = value <= 1 && value >= 0 ? value * 100 : value;
      return clampPercent(direct);
    }
  }
  for (const key of USED_KEYS) {
    const used = num(window[key]);
    if (used === undefined) continue;
    for (const limitKey of LIMIT_KEYS) {
      const limit = num(window[limitKey]);
      if (limit !== undefined && limit > 0) return clampPercent((used / limit) * 100);
    }
  }
  // "usage" alone (no limit) means a percent value, often a 0..1 fraction.
  const usage = num(window["usage"]);
  if (usage !== undefined) {
    const direct = usage <= 1 && usage >= 0 ? usage * 100 : usage;
    return clampPercent(direct);
  }
  return undefined;
}

function resetOf(window: Record<string, unknown>, nowSec: number): number {
  for (const key of RESET_SEC_KEYS) {
    const value = num(window[key]);
    if (value !== undefined && value >= 0) return Math.round(value);
  }
  for (const key of RESET_AT_KEYS) {
    const at = epochSeconds(window[key]);
    if (at === undefined) continue;
    return Math.max(0, Math.round(at - nowSec));
  }
  return 0;
}

function epochSeconds(value: unknown): number | undefined {
  const n = num(value);
  if (n !== undefined) {
    return n > 1e11 ? n / 1000 : n;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1000;
    const digits = num(value);
    if (digits !== undefined) return digits > 1e11 ? digits / 1000 : digits;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export const opencodeGoProvider: Provider = {
  id: "opencode-go",
  name: "OpenCode Go",
  resolveApiKey(ctx: ResolveKeyContext): string | undefined {
    return storedApiKey(AUTH_ENTRY, ctx, API_KEY_ENV);
  },
  fetchUsage,
};
