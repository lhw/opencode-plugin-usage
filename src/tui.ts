import { createElement, insert, setProp } from "@opentui/solid";
import { createTextAttributes } from "@opentui/core";
import { createSignal } from "solid-js";
import type { JSX } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import { normalizeOptions, type PluginOptions } from "./config.ts";
import { deepseekProvider } from "./providers/deepseek.ts";
import { githubCopilotEnterpriseProvider, githubCopilotProvider } from "./providers/github-copilot.ts";
import { openaiProvider } from "./providers/openai.ts";
import { opencodeGoProvider } from "./providers/opencode-go.ts";
import { openrouterProvider } from "./providers/openrouter.ts";
import type { BalanceInfo, ProviderUsage, UsageWindow } from "./types.ts";

type Child = JSX.Element | string | number | null | undefined | false;
type Theme = Context["theme"];

interface LinePart {
  text: string;
  fg: unknown;
  /** fixed display width (pads the text element), e.g. to align the bar column */
  width?: number;
  /** render bold, like the built-in sidebar block headers */
  bold?: boolean;
}

interface Line {
  parts: LinePart[];
  /** right-aligned group (e.g. percent + reset time) */
  right?: LinePart[];
}

interface State {
  usageByProvider: Record<string, ProviderUsage>;
  errorByProvider: Record<string, string>;
  refreshing: boolean;
  lastFetchAt: number;
}

const BAR_FULL = "━";
const BAR_WIDTH = 10;
const LABEL_WIDTH = 6;
const BOLD = createTextAttributes({ bold: true });

const providers = [
  opencodeGoProvider,
  deepseekProvider,
  openrouterProvider,
  openaiProvider,
  githubCopilotProvider,
  githubCopilotEnterpriseProvider,
];
const providerById = (id: string) => providers.find((p) => p.id === id);

// opencode stores auth at ~/.local/share/opencode/auth.json even on darwin (not Library/Application Support)
function xdgDataDir(): string | undefined {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
  const home = process.env.HOME;
  if (process.platform === "win32") {
    if (process.env.APPDATA) return process.env.APPDATA;
    return home ? `${home}/AppData/Roaming` : undefined;
  }
  return home ? `${home}/.local/share` : undefined;
}

export default Plugin.define({
  id: "opencode-plugin-usage",
  async setup(context) {
    const config = normalizeOptions(context.options);
    const state: State = { usageByProvider: {}, errorByProvider: {}, refreshing: false, lastFetchAt: 0 };
    let lastDisplay: string | undefined;
    // Session whose sidebar we last rendered; used when the router has no session route.
    let sidebarSessionID: string | undefined;
    // Provider of opencode's configured default model, resolved once as a fallback.
    let defaultProviderID: string | undefined;

    // Reactive repaint: solid signal read inside the slot so the host re-renders
    // it when we bump it (renderer.requestRender alone does not repaint the slot).
    const [getRenderTick, setRenderTick] = createSignal(0);
    const repaint = () => {
      setRenderTick((n) => n + 1);
      context.renderer.requestRender();
    };

    // opencode stores auth.json in its data dir, not the state dir.
    const dataDir = () => {
      const base = xdgDataDir();
      return base ? `${base}/opencode` : undefined;
    };

    // The provider actually being used by the active session: the model of the
    // last assistant message, else the configured default model's provider.
    function activeProvider(): string | undefined {
      const route = context.ui.router.current();
      const sessionID = route.type === "session" ? route.sessionID : sidebarSessionID;
      if (sessionID) {
        const messages = context.data.session.message.list(sessionID);
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i];
          if (message.type === "assistant") return message.model.providerID;
        }
      }
      return defaultProviderID;
    }

    // What we render: the active provider when it has a usage source; otherwise
    // the configured default (e.g. show your Go subscription on any other provider).
    function resolveDisplay(): string | undefined {
      const active = activeProvider();
      if (active && providerById(active)) return active;
      if (config.default && providerById(config.default)) return config.default;
      return active;
    }

    async function refresh(): Promise<void> {
      const providerId = resolveDisplay();
      const provider = providerId ? providerById(providerId) : undefined;
      if (!providerId || !provider) return;
      const options = config.providers[providerId];
      if (options && options.enabled === false) return;
      if (state.refreshing) return;
      // Don't hammer the API: honor a minimum interval once we have data.
      if (state.usageByProvider[providerId] && Date.now() - state.lastFetchAt < config.minRefreshMs) return;

      const apiKey = provider.resolveApiKey({
        options,
        env: process.env,
        stateDir: dataDir(),
      });
      if (!apiKey) {
        state.errorByProvider[providerId] = `no API key — add "providers.${providerId}.apiKey" or run opencode auth login for ${providerId}`;
        delete state.usageByProvider[providerId];
        repaint();
        return;
      }

      state.refreshing = true;
      try {
        const usage = await provider.fetchUsage(apiKey, { timeoutMs: config.timeoutMs });
        state.lastFetchAt = Date.now();
        state.usageByProvider[providerId] = usage;
        delete state.errorByProvider[providerId];
      } catch (error) {
        state.errorByProvider[providerId] = String(error).slice(0, 120);
      } finally {
        state.refreshing = false;
        repaint();
      }
    }

    function applyActive(): void {
      const display = resolveDisplay();
      const changed = display !== lastDisplay;
      if (changed) lastDisplay = display;
      // Refresh on provider change, or when the displayed provider has no data yet
      // (e.g. right after loading an existing session).
      const needsData = display !== undefined && !state.usageByProvider[display] && !state.errorByProvider[display];
      if (changed || needsData) {
        void refresh();
        repaint();
      }
    }

    // v2 emits `session.status` for every status transition and `session.idle`
    // when a turn settles; the interval below is the in-turn backstop.
    const unsubs = [
      context.data.on("session.created", () => void refresh()),
      context.data.on("session.status", (event) => {
        applyActive();
        if (event.data.status.type === "busy") void refresh();
      }),
      context.data.on("session.idle", () => void refresh()),
    ];
    const refreshTimer = setInterval(() => void refresh(), config.refreshMs);
    // Self-heal: re-derive the active provider and fetch data it doesn't have yet,
    // even when no event/render signals it (e.g. session recovery).
    const ensureTimer = setInterval(applyActive, 5_000);

    // Resolve the configured default model's provider for the fallback above.
    void context.client
      .model.default()
      .then((result) => {
        defaultProviderID = result.data?.providerID;
        applyActive();
      })
      .catch(() => {
        // no default model resolved; active-session detection still works
      });

    lastDisplay = resolveDisplay();
    void refresh();

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        sidebarSessionID = input.sessionID;
        getRenderTick(); // subscribe to repaint bumps (solid-reactive)
        // Lazy self-heal: if the displayed provider has no data yet (e.g. after
        // loading an existing session, which may not emit events), fetch it.
        const display = resolveDisplay();
        const hasUsage = display !== undefined && state.usageByProvider[display] !== undefined;
        const hasError = display !== undefined && state.errorByProvider[display] !== undefined;
        if (!hasUsage && !hasError && !state.refreshing && display !== undefined) {
          void refresh();
        }
        return renderPanel(state, config, context.theme, resolveDisplay);
      },
    });

    return () => {
      for (const unsub of unsubs) unsub();
      clearInterval(refreshTimer);
      clearInterval(ensureTimer);
      unregister();
    };
  },
});

function renderPanel(
  state: State,
  config: PluginOptions,
  theme: Theme,
  getDisplay: () => string | undefined,
): JSX.Element {
  const lines = buildLines(state, config, theme, getDisplay);
  return box(
    { width: "100%", flexDirection: "column" },
    lines.map((line) =>
      box({ flexDirection: "row", width: "100%", justifyContent: "space-between" }, [
        box({ flexDirection: "row" }, line.parts.map((part) =>
          text(
            {
              fg: part.fg,
              ...(part.bold ? { attributes: BOLD } : {}),
              ...(part.width !== undefined ? { width: part.width } : {}),
            },
            [truncate(part.text)],
          ),
        )),
        ...(line.right
          ? [box({ flexDirection: "row" }, line.right.map((part) =>
              text(
                {
                  fg: part.fg,
                  ...(part.bold ? { attributes: BOLD } : {}),
                  ...(part.width !== undefined ? { width: part.width } : {}),
                },
                [truncate(part.text)],
              ),
            ))]
          : []),
      ]),
    ),
  );
}

function buildLines(
  state: State,
  config: PluginOptions,
  theme: Theme,
  getDisplay: () => string | undefined,
): Line[] {
  const header: Line = { parts: [{ text: "Usage limits", fg: theme.text.base, bold: true }] };

  const providerId = getDisplay();
  if (!providerId) return [header, { parts: [{ text: "usage: no active provider", fg: theme.text.muted }] }];

  const provider = providerById(providerId);
  if (!provider) {
    return [header, { parts: [{ text: `usage: no source for ${providerId}`, fg: theme.text.muted }] }];
  }
  const options = config.providers[providerId];
  if (options && options.enabled === false) return [header];

  const usage = state.usageByProvider[providerId];
  const error = state.errorByProvider[providerId];

  const lines: Line[] = [header];
  if (usage) {
    const age = formatAge(Date.now() - usage.fetchedAt);
    lines.push({
      parts: [{ text: provider.name, fg: theme.text.muted }],
      right: [{ text: `updated ${age}`, fg: theme.text.muted }],
    });
    if (usage.balance && usage.balance.length > 0) {
      for (const balance of usage.balance) lines.push(balanceLine(balance, usage.isAvailable !== false, theme));
    } else {
      for (const window of usage.windows) lines.push(windowLine(window, theme));
    }
  } else if (error) {
    lines.push({ parts: [{ text: `${provider.name}: ${error}`, fg: theme.text.muted }] });
  } else {
    lines.push({ parts: [{ text: `${provider.name}: loading…`, fg: theme.text.muted }] });
  }
  return lines;
}

function balanceLine(balance: BalanceInfo, isAvailable: boolean, theme: Theme): Line {
  const fg = isAvailable ? theme.text.feedback.success.base : theme.text.feedback.error.base;
  return {
    parts: [
      { text: balance.currency, fg: theme.text.base, width: LABEL_WIDTH },
      { text: formatMoney(balance.total, balance.currency), fg },
    ],
    right: [{ text: isAvailable ? "remaining" : "insufficient", fg: theme.text.muted }],
  };
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function windowLine(window: UsageWindow, theme: Theme): Line {
  const color = tierColor(window.percent, theme);
  const right: LinePart[] = [];
  if (window.resetInSec > 0) {
    right.push({ text: `· resets ${formatReset(window.resetInSec)}`, fg: theme.text.muted });
  }
  return {
    parts: [
      { text: window.label, fg: theme.text.base, width: LABEL_WIDTH },
      { text: barString(window.percent), fg: color },
      { text: ` ${formatPercent(window.percent)}`, fg: color },
    ],
    right: right.length > 0 ? right : undefined,
  };
}

function tierColor(percent: number, theme: Theme): unknown {
  if (percent >= 100) return theme.text.feedback.error.base;
  if (percent >= 75) return theme.text.feedback.warning.base;
  if (percent >= 50) return theme.hue.accent[500];
  return theme.text.feedback.success.base;
}

function barString(percent: number, width = BAR_WIDTH): string {
  const filled = Math.round((percent / 100) * width);
  return BAR_FULL.repeat(filled) + " ".repeat(Math.max(0, width - filled));
}

function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

function formatReset(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function truncate(value: string, max = 60): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function element(
  tag: string,
  props: Record<string, unknown>,
  children: Child[] = [],
): JSX.Element {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) insert(node, child);
  }
  return node as unknown as JSX.Element;
}

function text(props: Record<string, unknown>, children: Child[] = []): JSX.Element {
  return element("text", props, children);
}

function box(props: Record<string, unknown>, children: Child[] = []): JSX.Element {
  return element("box", props, children);
}
