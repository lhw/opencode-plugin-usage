import { fetchJSON, isRecord, num } from "../fetch.ts";
import { storedApiKey } from "./auth.ts";
import type { BalanceInfo, FetchContext, Provider, ProviderUsage, ResolveKeyContext } from "../types.ts";

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const AUTH_ENTRY = "deepseek";
const API_KEY_ENV = "DEEPSEEK_API_KEY";

export async function fetchUsage(apiKey: string, ctx: FetchContext): Promise<ProviderUsage> {
  const data = (await fetchJSON(
    BALANCE_URL,
    { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    ctx.timeoutMs,
  )) as Record<string, unknown>;

  const infos = Array.isArray(data["balance_infos"]) ? data["balance_infos"] : [];
  return {
    provider: "deepseek",
    windows: [],
    balance: parseBalance(infos),
    isAvailable: data["is_available"] !== false,
    fetchedAt: Date.now(),
  };
}

export function parseBalance(infos: unknown): BalanceInfo[] {
  if (!Array.isArray(infos)) return [];
  const result: BalanceInfo[] = [];
  for (const raw of infos) {
    if (!isRecord(raw)) continue;
    const total = num(raw["total_balance"]);
    if (total === undefined) continue;
    result.push({
      currency: typeof raw["currency"] === "string" ? raw["currency"] : "USD",
      total,
    });
  }
  return result;
}

export const deepseekProvider: Provider = {
  id: "deepseek",
  name: "DeepSeek",
  resolveApiKey(ctx: ResolveKeyContext): string | undefined {
    return storedApiKey(AUTH_ENTRY, ctx, API_KEY_ENV);
  },
  fetchUsage,
};
