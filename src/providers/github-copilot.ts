import { fetchJSON, isRecord, num } from "../fetch.ts";
import { storedApiKey } from "./auth.ts";
import type { FetchContext, Provider, ProviderUsage, ResolveKeyContext, UsageWindow, UsageWindowId } from "../types.ts";

const QUOTA_URL = "https://api.github.com/copilot_internal/user";
const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const AUTH_ENTRY = "github-copilot";
const API_KEY_ENV = "GITHUB_TOKEN";

type Category = { id: UsageWindowId; label: string; keys: string[] };

const CATEGORIES: Category[] = [
  { id: "premium", label: "Premium", keys: ["premium_interactions", "premium", "premium_requests"] },
  { id: "chat", label: "Chat", keys: ["chat"] },
  { id: "completions", label: "Compl.", keys: ["completions"] },
];

export async function fetchUsage(apiKey: string, ctx: FetchContext): Promise<ProviderUsage> {
  let data: unknown;
  try {
    data = await fetchQuota(apiKey, ctx.timeoutMs);
  } catch (error) {
    const msg = String(error);
    const isAuthError = msg.includes("401") || msg.includes("403") || msg.includes("invalid or expired");
    if (!isAuthError) throw error;
    const exchanged = await exchangeToken(apiKey, ctx.timeoutMs);
    if (!exchanged) throw error;
    data = await fetchQuota(exchanged, ctx.timeoutMs);
  }
  const nowSec = Date.now() / 1000;
  const windows = parseCopilotQuota(data, nowSec);
  if (windows.length === 0) throw new Error("no copilot quota found in response");
  return { provider: "github-copilot", windows, fetchedAt: Date.now() };
}

async function fetchQuota(token: string, timeoutMs: number): Promise<unknown> {
  return fetchJSON(
    QUOTA_URL,
    {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opencode-plugin-usage/1.0",
    },
    timeoutMs,
  );
}

async function exchangeToken(oauthToken: string, timeoutMs: number): Promise<string | undefined> {
  try {
    const data = (await fetchJSON(
      TOKEN_URL,
      {
        Authorization: `Bearer ${oauthToken}`,
        Accept: "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opencode-plugin-usage/1.0",
      },
      timeoutMs,
    )) as Record<string, unknown>;
    if (isRecord(data) && typeof data["token"] === "string" && (data["token"] as string).length > 0) {
      return data["token"] as string;
    }
    // ponytail: enterprise uses copilot-api.{domain}, add base switch if TOKEN_URL fails
    return undefined;
  } catch {
    return undefined;
  }
}

// Exported for tests / self-check.
export function parseCopilotQuota(data: unknown, nowSec: number): UsageWindow[] {
  if (!isRecord(data)) return [];
  const snapshots = isRecord(data["quota_snapshots"])
    ? (data["quota_snapshots"] as Record<string, unknown>)
    : isRecord(data["quotaSnapshots"])
      ? (data["quotaSnapshots"] as Record<string, unknown>)
      : undefined;
  if (!snapshots) return [];

  const resetInSec = quotaResetInSec(data, nowSec);
  const result: UsageWindow[] = [];

  for (const cat of CATEGORIES) {
    let raw: Record<string, unknown> | undefined;
    for (const key of cat.keys) {
      if (isRecord(snapshots[key])) {
        raw = snapshots[key] as Record<string, unknown>;
        break;
      }
    }
    if (!raw) continue;
    if (raw["unlimited"] === true) continue;

    const entitlement = num(raw["entitlement"]);
    // free tier completions may have 0 entitlement but still limited (should skip if 0)
    // premium always has entitlement >0
    const remaining =
      num(raw["remaining"]) ?? num(raw["quota_remaining"]) ?? num(raw["quotaRemaining"]) ?? num(raw["remaining_quota"]);
    const percentRemaining =
      num(raw["percent_remaining"]) ?? num(raw["percentRemaining"]) ?? num(raw["percent_remaining_quota"]);

    let percent: number | undefined;
    if (percentRemaining !== undefined) {
      percent = clampPercent(100 - percentRemaining);
    } else if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
      percent = clampPercent(((entitlement - remaining) / entitlement) * 100);
    } else {
      continue;
    }

    // Skip chat/completions that are 0% used and unlimited-like (entitlement 0)
    if (entitlement === 0) continue;

    result.push({
      id: cat.id,
      label: cat.label,
      percent,
      resetInSec,
    });
  }

  return result;
}

function quotaResetInSec(data: Record<string, unknown>, nowSec: number): number {
  const raw =
    data["quota_reset_date"] ?? data["quota_reset_date_utc"] ?? data["quotaResetDate"] ?? data["quota_reset_dateUTC"];
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      // Date-only like "2026-05-01" parses as UTC midnight; that's the reset.
      return Math.max(0, Math.round(parsed / 1000 - nowSec));
    }
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const sec = raw > 1e11 ? raw / 1000 : raw;
    return Math.max(0, Math.round(sec - nowSec));
  }
  return 0;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export const githubCopilotProvider: Provider = {
  id: "github-copilot",
  name: "GitHub Copilot",
  resolveApiKey(ctx: ResolveKeyContext): string | undefined {
    const fromPrimary = storedApiKey(AUTH_ENTRY, ctx, API_KEY_ENV);
    if (fromPrimary) return fromPrimary;
    // fallback envs that users commonly set for GitHub
    const fallback =
      ctx.env["GH_TOKEN"]?.trim() ||
      ctx.env["GITHUB_COPILOT_TOKEN"]?.trim() ||
      ctx.env["COPILOT_GITHUB_TOKEN"]?.trim() ||
      ctx.env["GITHUB_COPILOT_API_TOKEN"]?.trim();
    if (fallback) return fallback;
    // opencode also stores enterprise variant under github-copilot-enterprise
    const fromEnterprise = storedApiKey("github-copilot-enterprise", ctx);
    if (fromEnterprise) return fromEnterprise;
    return undefined;
  },
  fetchUsage,
};

export const githubCopilotEnterpriseProvider: Provider = {
  id: "github-copilot-enterprise",
  name: "GitHub Copilot",
  resolveApiKey(ctx: ResolveKeyContext): string | undefined {
    const fromEnterprise = storedApiKey("github-copilot-enterprise", ctx);
    if (fromEnterprise) return fromEnterprise;
    return githubCopilotProvider.resolveApiKey(ctx);
  },
  fetchUsage: async (apiKey: string, ctx: FetchContext): Promise<ProviderUsage> => {
    const usage = await fetchUsage(apiKey, ctx);
    return { ...usage, provider: "github-copilot-enterprise" };
  },
};
