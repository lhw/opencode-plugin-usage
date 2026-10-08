import { fetchJSON, isRecord, num } from "../fetch.ts";
import { storedOAuthCredentials } from "./auth.ts";
import type { FetchContext, Provider, ProviderCredentials, ProviderUsage, ResolveKeyContext, UsageWindow } from "../types.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const AUTH_ENTRY = "openai";

export async function fetchUsage(accessToken: string, ctx: FetchContext): Promise<ProviderUsage> {
  const data = await fetchJSON(USAGE_URL, {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "codex-cli",
    ...(ctx.accountId ? { "ChatGPT-Account-Id": ctx.accountId } : {}),
  }, ctx.timeoutMs);
  const windows = parseCodexUsage(data, Date.now() / 1000);
  if (windows.length === 0) throw new Error("no Codex usage windows found in response");
  return { provider: "openai", windows, fetchedAt: Date.now() };
}

export function parseCodexUsage(data: unknown, nowSec: number): UsageWindow[] {
  if (!isRecord(data) || !isRecord(data["rate_limit"])) return [];
  const rateLimit = data["rate_limit"];
  return [
    codexWindow(rateLimit["primary_window"], "rolling", "5h", nowSec),
    codexWindow(rateLimit["secondary_window"], "weekly", "Week", nowSec),
  ].filter((window): window is UsageWindow => window !== undefined);
}

export async function resolveCredentials(ctx: ResolveKeyContext): Promise<ProviderCredentials | undefined> {
  const credential = (await ctx.listCredentials?.())
    ?.find((entry) => entry.integrationID === AUTH_ENTRY && entry.active && entry.value.type === "oauth");
  if (credential?.value.access) {
    const accountId = credential.value.metadata?.["accountID"] ?? credential.value.metadata?.["accountId"];
    return {
      token: credential.value.access,
      ...(typeof accountId === "string" ? { accountId } : {}),
    };
  }
  const legacy = storedOAuthCredentials(AUTH_ENTRY, ctx);
  return legacy ? { token: legacy.access, ...(legacy.accountId ? { accountId: legacy.accountId } : {}) } : undefined;
}

function codexWindow(value: unknown, fallbackId: UsageWindow["id"], fallbackLabel: string, nowSec: number): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const percent = num(value["used_percent"]);
  if (percent === undefined) return undefined;
  const resetAt = num(value["reset_at"]);
  // Codex moves a weekly-only limit into the primary slot, so classify by the
  // window's own duration instead of its slot. Fall back to the slot's label.
  const seconds = num(value["limit_window_seconds"]);
  const kind = seconds === undefined
    ? undefined
    : seconds <= 6 * 3600
      ? { id: "rolling" as const, label: "5h" }
      : seconds <= 8 * 24 * 3600
        ? { id: "weekly" as const, label: "Week" }
        : { id: "monthly" as const, label: "Month" };
  const { id, label } = kind ?? { id: fallbackId, label: fallbackLabel };
  return {
    id,
    label,
    percent: Math.max(0, Math.min(100, percent)),
    resetInSec: resetAt === undefined ? 0 : Math.max(0, resetAt - nowSec),
  };
}

export const openaiProvider: Provider = {
  id: "openai",
  name: "OpenAI Codex",
  resolveApiKey(ctx: ResolveKeyContext): string | undefined {
    return storedOAuthCredentials(AUTH_ENTRY, ctx)?.access;
  },
  resolveCredentials,
  resolveAccountId(ctx: ResolveKeyContext): string | undefined {
    return storedOAuthCredentials(AUTH_ENTRY, ctx)?.accountId;
  },
  fetchUsage,
};
