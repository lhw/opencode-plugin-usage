import { readFileSync } from "node:fs";
import type { ResolveKeyContext } from "../types.ts";

// opencode stores API keys in auth.json under the provider id: { type: "api", key }.
// github-copilot stores oauth tokens as { type: "oauth", refresh, access }.
export function readKeyFromAuth(entry: string, stateDir: string | undefined): string | undefined {
  if (!stateDir) return undefined;
  try {
    const text = readFileSync(`${stateDir}/auth.json`, "utf8");
    const stored = JSON.parse(text)[entry];
    if (typeof stored?.key === "string" && stored.key.length > 0) return stored.key;
    if (typeof stored?.refresh === "string" && stored.refresh.length > 0) return stored.refresh;
    if (typeof stored?.access === "string" && stored.access.length > 0) return stored.access;
    return undefined;
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
      if (typeof stored?.refresh === "string" && stored.refresh.length > 0) return stored.refresh;
      if (typeof stored?.access === "string" && stored.access.length > 0) return stored.access;
    } catch {
      // malformed; ignore
    }
  }
  const fromStore = readKeyFromAuth(entry, ctx.stateDir);
  if (fromStore) return fromStore;
  if (envKey) {
    const fromEnv = ctx.env[envKey]?.trim();
    if (fromEnv) return fromEnv;
  }
  return undefined;
}
