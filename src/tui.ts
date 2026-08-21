import { createElement, insert, setProp } from "@opentui/solid";
import { createTextAttributes } from "@opentui/core";
import { createSignal } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { normalizeOptions, type PluginOptions } from "./config.ts";
import { deepseekProvider } from "./providers/deepseek.ts";
import { opencodeGoProvider } from "./providers/opencode-go.ts";
import type { BalanceInfo, ProviderUsage, UsageWindow } from "./types.ts";

type Child = JSX.Element | string | number | null | undefined | false;

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
const BAR_WIDTH = 12;
const LABEL_WIDTH = 6;
const BOLD = createTextAttributes({ bold: true });
const SLOT_ORDER = 60;

const providers = [opencodeGoProvider, deepseekProvider];
const providerById = (id: string) => providers.find((p) => p.id === id);

// Replicates xdg-basedir's xdgData, which opencode uses for Global.Path.data.
function xdgDataDir(): string | undefined {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
  const home = process.env.HOME;
  if (process.platform === "darwin") return home ? `${home}/Library/Application Support` : undefined;
  if (process.platform === "win32") {
    if (process.env.APPDATA) return process.env.APPDATA;
    return home ? `${home}/AppData/Roaming` : undefined;
  }
  return home ? `${home}/.local/share` : undefined;
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-plugin-usage",
  tui: async (api, rawOptions) => {
    const config = normalizeOptions(rawOptions);
    const state: State = { usageByProvider: {}, errorByProvider: {}, refreshing: false, lastFetchAt: 0 };
    let lastDisplay: string | undefined;

    // Reactive repaint: solid signal read inside the slot so the host re-renders
    // it when we bump it (api.renderer.requestRender alone does not repaint here).
    const [getRenderTick, setRenderTick] = createSignal(0);
    const repaint = () => {
      setRenderTick((n) => n + 1);
      api.renderer.requestRender();
    };
    // opencode stores auth.json in Global.Path.data, not api.state.path.state
    // (the state dir). Replicate xdg-basedir's xdgData + "/opencode".
    const dataDir = () => {
      const base = xdgDataDir();
      return base ? `${base}/opencode` : undefined;
    };

    // The provider actually being used by the active session: last assistant
    // message's providerID, else the configured default model's provider.
    function activeProvider(): string | undefined {
      const route = api.route.current;
      if (route.name === "session") {
        const sessionId = route.params?.sessionID as string | undefined;
        if (sessionId) {
          const messages = api.state.session.messages(sessionId);
          for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i] as { role?: string; providerID?: string };
            if (message.role === "assistant" && message.providerID) return message.providerID;
          }
        }
      }
      const model = api.state.config.model;
      if (typeof model === "string" && model.includes("/")) return model.split("/")[0];
      return undefined;
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
        state.errorByProvider[providerId] = `no API key — add "providers.${providerId}.apiKey" to the plugin options in tui.json, or export OPENCODE_API_KEY`;
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

    const unsubs = [
      api.event.on("message.updated", applyActive),
      api.event.on("session.created", () => void refresh()),
      api.event.on("session.updated", applyActive),
      api.event.on("session.status", (event) => {
        if (event.properties.status.type === "busy") void refresh();
      }),
      api.event.on("session.idle", () => void refresh()),
    ];
    const refreshTimer = setInterval(() => void refresh(), config.refreshMs);
    // Self-heal: re-derive the active provider and fetch data it doesn't have yet,
    // even when no event/render signals it (e.g. session recovery).
    const ensureTimer = setInterval(applyActive, 5_000);

    api.lifecycle.onDispose(() => {
      for (const unsub of unsubs) unsub();
      clearInterval(refreshTimer);
      clearInterval(ensureTimer);
    });

    lastDisplay = resolveDisplay();
    void refresh();

    api.slots.register({
      order: SLOT_ORDER,
      slots: {
        sidebar_content(): JSX.Element {
          getRenderTick(); // subscribe to repaint bumps (solid-reactive)
          // Lazy self-heal: if the displayed provider has no data yet (e.g. after
          // loading an existing session, which may not emit events), fetch it.
          const display = resolveDisplay();
          const hasUsage = display !== undefined && state.usageByProvider[display] !== undefined;
          const hasError = display !== undefined && state.errorByProvider[display] !== undefined;
          if (!hasUsage && !hasError && !state.refreshing && display !== undefined) {
            void refresh();
          }
          return renderPanel(state, config, api.theme.current, resolveDisplay);
        },
      },
    });
  },
};

function renderPanel(
  state: State,
  config: PluginOptions,
  theme: TuiPluginApi["theme"]["current"],
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
  theme: TuiPluginApi["theme"]["current"],
  getDisplay: () => string | undefined,
): Line[] {
  const header: Line = { parts: [{ text: "Usage limits", fg: theme.text, bold: true }] };

  const providerId = getDisplay();
  if (!providerId) return [header, { parts: [{ text: "usage: no active provider", fg: theme.textMuted }] }];

  const provider = providerById(providerId);
  if (!provider) {
    return [header, { parts: [{ text: `usage: no source for ${providerId}`, fg: theme.textMuted }] }];
  }
  const options = config.providers[providerId];
  if (options && options.enabled === false) return [header];

  const usage = state.usageByProvider[providerId];
  const error = state.errorByProvider[providerId];

  const lines: Line[] = [header];
  if (usage) {
    const age = formatAge(Date.now() - usage.fetchedAt);
    lines.push({
      parts: [{ text: provider.name, fg: theme.textMuted }],
      right: [{ text: `updated ${age}`, fg: theme.textMuted }],
    });
    if (usage.balance && usage.balance.length > 0) {
      for (const balance of usage.balance) lines.push(balanceLine(balance, usage.isAvailable !== false, theme));
    } else {
      for (const window of usage.windows) lines.push(windowLine(window, theme));
    }
  } else if (error) {
    lines.push({ parts: [{ text: `${provider.name}: ${error}`, fg: theme.textMuted }] });
  } else {
    lines.push({ parts: [{ text: `${provider.name}: loading…`, fg: theme.textMuted }] });
  }
  return lines;
}

function balanceLine(balance: BalanceInfo, isAvailable: boolean, theme: TuiPluginApi["theme"]["current"]): Line {
  const fg = isAvailable ? theme.success : theme.error;
  return {
    parts: [
      { text: balance.currency, fg: theme.text, width: LABEL_WIDTH },
      { text: formatMoney(balance.total, balance.currency), fg },
    ],
    right: [{ text: isAvailable ? "remaining" : "insufficient", fg: theme.textMuted }],
  };
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function windowLine(window: UsageWindow, theme: TuiPluginApi["theme"]["current"]): Line {
  const color = tierColor(window.percent, theme);
  const right: LinePart[] = [];
  if (window.resetInSec > 0) {
    right.push({ text: `· resets ${formatReset(window.resetInSec)}`, fg: theme.textMuted });
  }
  return {
    parts: [
      { text: window.label, fg: theme.text, width: LABEL_WIDTH },
      { text: barString(window.percent), fg: color },
      { text: ` ${formatPercent(window.percent)}`, fg: color },
    ],
    right: right.length > 0 ? right : undefined,
  };
}

function tierColor(percent: number, theme: TuiPluginApi["theme"]["current"]): unknown {
  if (percent >= 100) return theme.error;
  if (percent >= 75) return theme.warning;
  if (percent >= 50) return theme.accent;
  return theme.success;
}

function barString(percent: number, width = BAR_WIDTH): string {
  const filled = Math.round((percent / 100) * width);
  return BAR_FULL.repeat(filled);
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
  return node as JSX.Element;
}

function text(props: Record<string, unknown>, children: Child[] = []): JSX.Element {
  return element("text", props, children);
}

function box(props: Record<string, unknown>, children: Child[] = []): JSX.Element {
  return element("box", props, children);
}

export default plugin;
