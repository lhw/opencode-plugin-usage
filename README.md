# opencode-plugin-usage

An OpenCode **TUI plugin** that shows the active provider's usage in the sidebar —
stacked windows for providers with usage limits, remaining credit for providers
with a balance.

- **opencode-go** — rolling 5h / weekly / monthly usage limits as thin colored bars
- **deepseek** — remaining API credit (green when available, red when not)
- **openrouter** — remaining credit balance
- **openai** — remaining API credit balance (requires an org admin key)

It follows the provider actually in use for the active session, and shows a
configurable **default** provider (e.g. your Go subscription) when the active
provider has no usage source.

```
Usage limits
OpenCode Go                     updated just now
5h    ━━━━━━━━━ 78%             · resets 55m
Week  ━━━━ 37%                  · resets 2d 2h
Month ━━ 18%                    · resets 27d 15h
```

Bar colors: green `<50%`, amber `50–74%`, orange `75–99%`, red `100%`.

## Requirements

- OpenCode `>= 1.18.0`

## Install

### From npm

Once published:

```sh
opencode plugin opencode-plugin-usage@latest --global --force
```

### Local development

```sh
git clone <this-repo> && cd opencode-plugin-usage
npm install
npm run dev:install        # builds dist/tui.js and copies it into ~/.config/opencode/usage-limits/
```

Then register it in `~/.config/opencode/tui.json` and restart OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["./usage-limits/tui.js", { "providers": { "opencode-go": { "enabled": true } } }]]
}
```

The plugin must NOT be placed in the auto-discovered `~/.config/opencode/plugins/`
directory — that directory is for server plugins, and opencode would reject this
TUI-only module. TUI plugins are only loaded via `tui.json`.

## Configuration

All options are optional. `tui.json` plugin entry:

```jsonc
{
  "refreshMs": 300000,     // how often to re-fetch usage (ms)
  "minRefreshMs": 30000,   // minimum interval between extra refreshes (session start / query busy)
  "timeoutMs": 10000,      // per-request timeout (ms)
  "default": "opencode-go",  // provider shown when the active provider has no usage source
  "providers": {
    "opencode-go": { "enabled": true, "apiKey": "sk-..." },  // apiKey is optional
    "deepseek": { "enabled": true }
  }
}
```

Per-provider options:

| Option    | Default                              | Description             |
| --------- | ------------------------------------ | ----------------------- |
| `enabled` | `true`                               | show/hide this provider |
| `apiKey`  | (resolved automatically, see below)  | explicit key override   |

## API keys

Keys are resolved automatically from what opencode itself uses, in order:

1. `providers.<id>.apiKey` in the plugin options
2. `OPENCODE_AUTH_CONTENT` (opencode's injectable auth file)
3. opencode's auth store — `auth.json` in the opencode **data directory**
   (`~/.local/share/opencode/` on Linux, `~/Library/Application Support/opencode/`
   on macOS, `%APPDATA%\opencode\` on Windows) under the provider id
4. provider env var: `OPENCODE_API_KEY` (opencode-go) / `DEEPSEEK_API_KEY` (deepseek)

So if you've already connected a provider in OpenCode (e.g. `opencode auth login`
or `/connect`), no extra configuration is needed.

## How it works

- Registers a `sidebar_content` slot (order `60`), rendered with `@opentui/solid`.
- Detects the active provider from the last assistant message's `providerID`,
  falling back to the configured default model's provider; re-derives live on
  every render, on session/message events, and every 30s.
- **Refreshes before you query**: on startup, on new session, when a query turns
  `busy`, when the active provider changes, on `session.idle`, and every `refreshMs`.
  Extra triggers are throttled to at most one fetch per `minRefreshMs` once data
  is already shown, so the balance/usage is fresh before a query without hammering
  the APIs.

## Providers

| Provider    | Source                                           | Display                          |
| ----------- | ------------------------------------------------ | -------------------------------- |
| opencode-go | `https://opencode.ai/zen/go/v1/usage`            | 5h/week/month windows + bars     |
| deepseek    | `https://api.deepseek.com/user/balance`          | remaining credit                 |
| openrouter  | `https://openrouter.ai/api/v1/credits`           | remaining credit (`credits` key) |
| openai      | `https://api.openai.com/v1/dashboard/billing/credit_grants` | remaining credit (org admin key) |

Adding a provider is one new file in `src/providers/` implementing the
`Provider` interface (key resolution + a `fetchUsage`) and adding it to the
`providers` array in `src/tui.ts`.

Key env vars: `OPENCODE_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`,
`OPENAI_API_KEY` (or the matching `auth.json` entry / `providers.<id>.apiKey`).

## Development

```sh
npm run typecheck    # tsc --noEmit
npm test             # parser/self checks (node, no deps)
npm run build        # esbuild → dist/tui.js
npm run dev:install  # build + install into ~/.config/opencode/usage-limits/
npm publish          # runs typecheck + build + test first
```

## License

MIT
