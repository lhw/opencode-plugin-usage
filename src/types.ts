export type UsageWindowId = "rolling" | "weekly" | "monthly" | "premium" | "chat" | "completions";

export interface UsageWindow {
  id: UsageWindowId;
  label: string;
  /** 0..100 */
  percent: number;
  /** seconds until the window resets; 0 when unknown */
  resetInSec: number;
}

export interface BalanceInfo {
  currency: string;
  total: number;
}

export interface ProviderUsage {
  provider: string;
  windows: UsageWindow[];
  /** remaining credit, e.g. DeepSeek (alternative to windows) */
  balance?: BalanceInfo[];
  /** whether the account can still be used (DeepSeek's is_available) */
  isAvailable?: boolean;
  fetchedAt: number;
}

export interface ProviderOptions {
  enabled?: boolean;
  /** Explicit API key override. Falls back to env then opencode auth storage. */
  apiKey?: string;
}

export interface ResolveKeyContext {
  options?: ProviderOptions;
  env: Record<string, string | undefined>;
  /** OpenCode data dir (legacy auth.json fallback) */
  stateDir?: string;
  listCredentials?: () => Promise<StoredProviderCredential[]>;
}

export interface StoredProviderCredential {
  integrationID: string;
  active: boolean;
  value: {
    type: string;
    key?: string;
    access?: string;
    refresh?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface ProviderCredentials {
  token: string;
  accountId?: string;
}

export interface FetchContext {
  timeoutMs: number;
  accountId?: string;
}

export interface Provider {
  id: string;
  name: string;
  resolveApiKey(ctx: ResolveKeyContext): string | undefined | Promise<string | undefined>;
  resolveCredentials?(ctx: ResolveKeyContext): Promise<ProviderCredentials | undefined>;
  resolveAccountId?(ctx: ResolveKeyContext): string | undefined;
  fetchUsage(apiKey: string, ctx: FetchContext): Promise<ProviderUsage>;
}
