import { readFileSync } from "node:fs";
import type { ResolveKeyContext } from "../types.ts";

// Legacy auth.json stores API keys as { type: "api", key } and OAuth as { refresh, access }.
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

export interface OAuthCredentials {
  access: string;
  accountId?: string;
}

export function storedOAuthCredentials(entry: string, ctx: ResolveKeyContext): OAuthCredentials | undefined {
  const content = ctx.env["OPENCODE_AUTH_CONTENT"];
  if (content) {
    try {
      const credentials = asOAuthCredentials(JSON.parse(content)?.[entry]);
      if (credentials) return credentials;
    } catch {
      // malformed; try the auth store
    }
  }
  for (const dir of candidateAuthDirs(ctx.stateDir)) {
    try {
      const credentials = asOAuthCredentials(JSON.parse(readFileSync(`${dir}/auth.json`, "utf8"))?.[entry]);
      if (credentials) return credentials;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function asOAuthCredentials(stored: unknown): OAuthCredentials | undefined {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return undefined;
  const credentials = stored as Record<string, unknown>;
  if (credentials["type"] !== "oauth" || typeof credentials["access"] !== "string" || !credentials["access"]) {
    return undefined;
  }
  return {
    access: credentials["access"],
    ...(typeof credentials["accountId"] === "string" ? { accountId: credentials["accountId"] } : {}),
  };
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
 * Resolve in order: plugin option, injected auth, active SQLite credential,
 * legacy auth.json, then the provider environment variable.
 */
export async function storedApiKey(entry: string, ctx: ResolveKeyContext, envKey?: string): Promise<string | undefined> {
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
  try {
    const credential = (await ctx.listCredentials?.())
      ?.find((item) => item.integrationID === entry && item.active)?.value;
    if (credential?.type === "key" && credential.key) return credential.key;
    if (credential?.type === "oauth" && (credential.refresh || credential.access)) {
      return credential.refresh || credential.access;
    }
  } catch {
    // try the legacy auth store
  }
  const fromStore = readKeyFromAuth(entry, ctx.stateDir);
  if (fromStore) return fromStore;
  if (envKey) {
    const fromEnv = ctx.env[envKey]?.trim();
    if (fromEnv) return fromEnv;
  }
  return undefined;
}
