import { readFileSync } from "node:fs";
import type { ResolveKeyContext } from "../types.ts";

// opencode stores API keys in auth.json under the provider id: { type: "api", key }.
// github-copilot stores oauth tokens as { type: "oauth", refresh, access }.
export function readKeyFromAuth(entry: string, stateDir: string | undefined): string | undefined {
  for (const dir of candidateAuthDirs(stateDir)) {
    try {
      const text = readFileSync(`${dir}/auth.json`, "utf8");
      const stored = JSON.parse(text)[entry];
      if (typeof stored?.key === "string" && stored.key.length > 0) return stored.key;
      if (typeof stored?.refresh === "string" && stored.refresh.length > 0) return stored.refresh;
      if (typeof stored?.access === "string" && stored.access.length > 0) return stored.access;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function candidateAuthDirs(stateDir: string | undefined): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const push = (d: string | undefined) => {
    if (!d || seen.has(d)) return;
    seen.add(d);
    dirs.push(d);
  };
  push(stateDir);
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) push(`${xdg}/opencode`);
  const home = process.env.HOME;
  if (home) {
    push(`${home}/.local/share/opencode`);
    // opencode currently uses ~/.local/share even on darwin, but keep Library fallback for older installs
    push(`${home}/Library/Application Support/opencode`);
  }
  if (process.platform === "win32") {
    if (process.env.APPDATA) push(`${process.env.APPDATA}/opencode`);
    else if (home) push(`${home}/AppData/Roaming/opencode`);
  }
  return dirs;
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
