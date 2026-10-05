// Real OpenTUI cell rendering; requires Node >=26.4 (OpenTUI's Node runtime).
import assert from "node:assert/strict";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { renderPanel } from "../src/tui.ts";
import { normalizeOptions } from "../src/config.ts";
import { parseCopilotQuota } from "../src/providers/github-copilot.ts";
import { parseUsageResponse } from "../src/providers/opencode-go.ts";

const theme = { text: { base: "#ffffff", muted: "#999999", feedback: {
  success: { base: "#00ff00" }, warning: { base: "#ffff00" }, error: { base: "#ff0000" },
} }, hue: { accent: { 500: "#ffaa00" } } };
const now = Date.now() / 1000;
const copilot = parseCopilotQuota({
  quota_reset_date: new Date((now + 27 * 86400 + 15 * 3600) * 1000).toISOString(),
  quota_snapshots: {
    premium_interactions: { entitlement: 100, remaining: 0 },
    chat: { entitlement: 100, remaining: 91 },
    completions: { entitlement: 100, remaining: 63 },
  },
}, now);
const go = parseUsageResponse({ usage: {
  rollingUsage: { usedPercent: 9, resetInSec: 55 * 60 },
  weeklyUsage: { usedPercent: 37, resetInSec: 2 * 86400 + 2 * 3600 },
  monthlyUsage: { usedPercent: 100, resetInSec: 27 * 86400 + 15 * 3600 },
} }, now);

const cases = [
  ["github-copilot", copilot, ["27d 15h", "27d 15h", "27d 15h"]],
  ["github-copilot-enterprise", copilot, ["27d 15h", "27d 15h", "27d 15h"]],
  ["opencode-go", go, ["55m", "2d 2h", "27d 15h"]],
  ["opencode-go", go.map((window, i) => ({
    ...window, percent: [0, 10, 99][i], resetInSec: [0, 59, 3600 + 59 * 60][i],
  })), ["", "59s", "1h 59m"]],
];

for (const width of [34, 36, 40, 48]) {
  for (const [provider, windows, resets] of cases) {
    const test = await createTestRenderer({ width, height: 12 });
    try {
      render(() => renderPanel({
        usageByProvider: { [provider]: { provider, windows, fetchedAt: Date.now() } },
        errorByProvider: {}, refreshing: false, lastFetchAt: 0,
      }, normalizeOptions({}), theme, () => provider), test.renderer);
      await test.renderOnce();
      const frame = test.captureCharFrame();
      if (process.env.SHOW_LAYOUT) console.log(`${provider}, ${width} columns:\n${frame.trimEnd()}`);
      const rows = frame.split("\n");
      for (const [i, window] of windows.entries()) {
        const row = rows[i + 2];
        assert.equal(row.slice(0, 8), window.label.padEnd(8), `label overlaps: ${window.label}`);
        assert.equal(row.slice(8, 18), "━".repeat(Math.round(window.percent / 10)).padEnd(10));
        assert.equal(row.slice(18, 23), ` ${Math.round(window.percent)}%`.padStart(5));
        assert.equal(row.slice(23, width - 10).trim(), "", "missing gap before reset");
        assert.equal(row.slice(width - 10).trimEnd(), resets[i] ? `in ${resets[i]}` : "");
      }
      assert.ok(rows.slice(windows.length + 2).every((row) => !row.trim()), "wrapped usage row");
    } finally {
      test.renderer.destroy();
    }
  }
}
console.log("layout checks passed (Copilot, Enterprise, Go; 34/36/40/48 columns)");
