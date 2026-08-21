import type { ProviderOptions } from "./types.ts";

export interface PluginOptions {
  refreshMs: number;
  timeoutMs: number;
  /** minimum interval between auto-refreshes (session start / busy / model switch) */
  minRefreshMs: number;
  /** provider to display when the active provider has no registered usage source */
  default: string;
  providers: Record<string, ProviderOptions>;
}

export function normalizeOptions(raw: unknown): PluginOptions {
  const obj = isRecord(raw) ? raw : {};
  return {
    refreshMs: positiveInt(obj.refreshMs, 300_000),
    timeoutMs: positiveInt(obj.timeoutMs, 10_000),
    minRefreshMs: positiveInt(obj.minRefreshMs, 30_000),
    default: typeof obj.default === "string" && obj.default.trim() ? obj.default.trim() : "opencode-go",
    providers: isRecord(obj.providers) ? normalizeProviders(obj.providers) : {},
  };
}

function normalizeProviders(
  raw: Record<string, unknown>,
): Record<string, ProviderOptions> {
  const result: Record<string, ProviderOptions> = {};
  for (const [id, value] of Object.entries(raw)) {
    const rec = isRecord(value) ? value : {};
    result[id] = {
      enabled: typeof rec.enabled === "boolean" ? rec.enabled : true,
      apiKey: typeof rec.apiKey === "string" && rec.apiKey.trim() ? rec.apiKey.trim() : undefined,
    };
  }
  return result;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
