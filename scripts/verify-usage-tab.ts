// bun scripts/verify-usage-tab.ts [output-directory]
// Routes Chromium requests straight to Hono: in-process with no listener.
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/usage");
mkdirSync(output, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const checks: unknown[] = [];

try {
  for (const theme of ["light", "dark"]) for (const width of [1440, 400]) {
    const { app, hub, store } = createApp(":memory:", "preview-only");

    const now = Date.now();
    // Device 1: online laptop with Claude (3 windows), Antigravity (2 groups), Codex (weekly), OpenCode (totals-only), prime-agent (error)
    const dev1 = store.addDevice("laptop");
    const usageLaptop = {
      claude: {
        source: "claude -p /usage",
        observedAt: now - 3 * 60_000,
        windows: [
          { label: "Current session", window: "session", usedFraction: 0.07, resetsAt: now + 3 * 3600_000 },
          { label: "Current week (all models)", window: "weekly", usedFraction: 0.04, resetsAt: now + (5 * 24 + 19) * 3600_000 },
          { label: "Current week (Fable)", window: "weekly", usedFraction: 0.0, resetsAt: now + (5 * 24 + 20) * 3600_000 },
        ],
      },
      antigravity: {
        source: "agy -p /usage",
        observedAt: now - 3 * 60_000,
        windows: [
          { label: "Gemini 2.5 Flash · 5 hour", window: "5h", usedFraction: 0.25, resetsAt: now + 4 * 3600_000 },
          { label: "Claude 3.7 Sonnet · Weekly", window: "weekly", usedFraction: 0.60, resetsAt: now + (3 * 24 + 8) * 3600_000 },
        ],
      },
      codex: {
        source: "codex session files",
        observedAt: now - 3 * 60_000,
        windows: [
          { label: "Weekly (all models)", window: "weekly", usedFraction: 0.42, resetsAt: now + (2 * 24 + 14) * 3600_000 },
        ],
      },
      opencode: {
        source: "opencode stats",
        observedAt: now - 3 * 60_000,
        windows: [],
        totals: {
          sessions: 48,
          prompts: 1250,
          tokens: 310800000,
          note: "Plan limit is only on the OpenCode Go dashboard",
        },
      },
      "prime-agent": {
        source: "prime-agent stats",
        observedAt: now - 3 * 60_000,
        windows: [],
        error: "prime-agent not logged in",
      },
    };
    store.db.query("UPDATE devices SET info = ?, last_seen = ? WHERE id = ?").run(
      JSON.stringify({
        hostname: "mbp-m2.local",
        harnesses: [
          { id: "claude", label: "Claude Code" },
          { id: "antigravity", label: "Antigravity" },
          { id: "codex", label: "Codex" },
          { id: "opencode", label: "opencode" },
          { id: "prime-agent", label: "prime-agent" },
        ],
        roots: ["/home/example/coding"],
        usage: usageLaptop,
      }),
      now - 20_000,
      dev1.id
    );

    // Device 2: offline build-server with a stale reading (>15 min)
    const dev2 = store.addDevice("build-server");
    const usageBuild = {
      codex: {
        source: "codex session files",
        observedAt: now - 28 * 60_000,
        windows: [
          { label: "Weekly (all models)", window: "weekly", usedFraction: 0.88, resetsAt: now + 18 * 3600_000 },
        ],
      },
    };
    store.db.query("UPDATE devices SET info = ?, last_seen = ? WHERE id = ?").run(
      JSON.stringify({
        hostname: "ci-node-04.infra",
        harnesses: [{ id: "codex", label: "Codex" }],
        roots: ["/var/build"],
        usage: usageBuild,
      }),
      now - 45 * 60_000,
      dev2.id
    );

    const page = await browser.newPage({ viewport: { width, height: 1200 }, colorScheme: theme, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));

    await page.route("**/*", async (route: any) => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === "/api/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": preview\n\n" });
      const response = await app.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }));
      const body = await response.text();
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
    });

    try {
      await page.goto("http://fleet.test/?token=preview-only#/usage");
      await page.locator("#v-usage:not([hidden])").waitFor();
      await page.locator(".usage-device").first().waitFor();

      // Check sideways overflow
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error(`Sideways overflow at ${width}px in ${theme} mode`);

      // Verify fixtures
      const textContent = await page.locator("#v-usage").innerText();
      const lowerText = textContent.toLowerCase();
      if (!lowerText.includes("current session") || !lowerText.includes("current week (all models)") || !lowerText.includes("current week (fable)")) {
        throw new Error("Missing 3-window Claude block");
      }
      if (!lowerText.includes("gemini 2.5 flash · 5 hour") || !lowerText.includes("claude 3.7 sonnet · weekly")) {
        throw new Error("Missing Antigravity two-group block");
      }
      if (!lowerText.includes("weekly (all models)")) {
        throw new Error("Missing Codex weekly window");
      }
      if (!lowerText.includes("plan limit is only on the opencode go dashboard") || !lowerText.includes("310.8m tokens")) {
        throw new Error("Missing OpenCode totals-only block");
      }
      if (!lowerText.includes("prime-agent not logged in")) {
        throw new Error("Missing harness error fixture");
      }
      if (!lowerText.includes("build-server") || !lowerText.includes("offline")) {
        throw new Error("Missing offline device fixture");
      }
      if (!lowerText.includes("stale")) {
        throw new Error("Missing stale reading fixture");
      }

      // Check bar elements exist and no full/0% bar on unmeasured
      const bars = await page.locator(".usage-bar-fill").count();
      if (bars < 6) throw new Error(`Expected at least 6 bars, found ${bars}`);

      // Capture screenshot
      const shotPath = `${output}/${theme}-${width}.png`;
      await page.screenshot({ path: shotPath, fullPage: true });

      if (errors.length) throw new Error(errors.join("\n"));
      checks.push({ theme, width, shotPath, overflow: false, fixturesVerified: true, pageErrors: errors });
    } finally {
      await page.close();
      store.db.close();
      rmSync(hub.dataDir, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}

await Bun.write(`${output}/checks.json`, JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks, null, 2));
