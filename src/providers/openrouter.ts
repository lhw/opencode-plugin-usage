import { fetchJSON, isRecord, num } from "../fetch.ts";
import { storedApiKey } from "./auth.ts";
import type { BalanceInfo, FetchContext, Provider, ProviderUsage, ResolveKeyContext } from "../types.ts";

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const AUTH_ENTRY = "openrouter";
const API_KEY_ENV = "OPENROUTER_API_KEY";

export async function fetchUsage(apiKey: string, ctx: FetchContext): Promise<ProviderUsage> {
  const data = (await fetchJSON(
    CREDITS_URL,
    { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    ctx.timeoutMs,
  )) as Record<string, unknown>;

  const balance = parseCredits(data);
  if (balance.length === 0) throw new Error("no credits data in response");
  return { provider: "openrouter", windows: [], balance, fetchedAt: Date.now() };
}

// GET /api/v1/credits -> { data: { total_credits, total_usage } }; balance = credits - usage.
export function parseCredits(data: unknown): BalanceInfo[] {
  const info = isRecord(data) && isRecord(data["data"]) ? data["data"] : {};
  const total = num(info["total_credits"]);
  if (total === undefined) return [];
  const used = num(info["total_usage"]) ?? 0;
  return [{ currency: "USD", total: Math.max(0, total - used) }];
}

export const openrouterProvider: Provider = {
  id: "openrouter",
  name: "OpenRouter",
  resolveApiKey(ctx: ResolveKeyContext): string | undefined {
    return storedApiKey(AUTH_ENTRY, ctx, API_KEY_ENV);
  },
  fetchUsage,
};
