import { fetchJSON, isRecord, num } from "../fetch.ts";
import { storedApiKey } from "./auth.ts";
import type { BalanceInfo, FetchContext, Provider, ProviderUsage, ResolveKeyContext } from "../types.ts";

const CREDITS_URL = "https://api.openai.com/v1/dashboard/billing/credit_grants";
const AUTH_ENTRY = "openai";
const API_KEY_ENV = "OPENAI_API_KEY";

export async function fetchUsage(apiKey: string, ctx: FetchContext): Promise<ProviderUsage> {
  const data = await fetchJSON(
    CREDITS_URL,
    { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    ctx.timeoutMs,
  );

  const balance = parseCreditGrants(data);
  if (balance.length === 0) throw new Error("no credit data in response");
  return { provider: "openai", windows: [], balance, fetchedAt: Date.now() };
}

// GET /v1/dashboard/billing/credit_grants (org admin key) -> { total_available, ... } (USD).
export function parseCreditGrants(data: unknown): BalanceInfo[] {
  if (!isRecord(data)) return [];
  const available = num(data["total_available"]);
  if (available === undefined) return [];
  return [{ currency: "USD", total: available }];
}

export const openaiProvider: Provider = {
  id: "openai",
  name: "OpenAI",
  resolveApiKey(ctx: ResolveKeyContext): string | undefined {
    return storedApiKey(AUTH_ENTRY, ctx, API_KEY_ENV);
  },
  fetchUsage,
};
