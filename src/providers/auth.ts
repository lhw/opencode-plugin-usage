import { readFileSync } from "node:fs";
import type { ResolveKeyContext } from "../types.ts";

// opencode stores API keys in auth.json under the provider id: { type: "api", key }.
export function readKeyFromAuth(entry: string, stateDir: string | undefined): string | undefined {
  if (!stateDir) return undefined;
  try {
    const text = readFileSync(`${stateDir}/auth.json`, "utf8");
    const stored = JSON.parse(text)[entry];
    return typeof stored?.key === "string" && stored.key.length > 0 ? stored.key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a provider's API key the way opencode would: explicit option override,
 * opencode's injectable auth env, the auth store, then a provider env var.
 */
export function storedApiKey(entry: string, ctx: ResolveKeyContext, envKey?: string): string | undefined {
  const trimmed = ctx.options?.apiKey?.trim();
  if (trimmed) return trimmed;
  const authContent = ctx.env["OPENCODE_AUTH_CONTENT"];
  if (authContent) {
    try {
      const stored = JSON.parse(authContent)?.[entry];
      if (typeof stored?.key === "string" && stored.key.length > 0) return stored.key;
    } catch {
      // malformed; ignore
    }
  }
  const fromStore = readKeyFromAuth(entry, ctx.stateDir);
  if (fromStore) return fromStore;
  return envKey ? ctx.env[envKey]?.trim() : undefined;
}
