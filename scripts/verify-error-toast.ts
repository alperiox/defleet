// bun scripts/verify-error-toast.ts [output-directory]
// Routes Chromium requests straight to Hono: no HTTP listener or preview server.
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/toast");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const checks: unknown[] = [];
try {
  for (const theme of ["light", "dark"]) for (const width of [1440, 400]) {
    const { app, hub, store } = createApp(":memory:", "preview-only");
    const created = store.addAgent({ name: "worker", owner: "owner", device: "test", skills: [] });
    const agent = store.agentById(created.id)!;
    const task = hub.humanCreateTask({ title: "Review the deployment checklist", project: "demo", description: "Verify the release is ready before deploying.", acceptance: "Checks pass and evidence is attached." });
    hub.claim(agent, task.id);
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    let mode = "app", reason = "";
    await page.route("**/*", async (route: any) => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === "/api/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": preview\n\n" });
      if (url.pathname.endsWith("/request-outcome") && mode === "network") return route.abort("failed");
      if (url.pathname.endsWith("/request-outcome") && mode === "html") return route.fulfill({ status: 502, contentType: "text/html", body: "Bad gateway" });
      if (url.pathname.endsWith("/request-outcome") && mode === "untrusted") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "<img src=x onerror=alert(1)> " + "long-reason-".repeat(70) }) });
      const response = await app.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }));
      const body = await response.text();
      if (!response.ok && url.pathname.endsWith("/release")) reason = JSON.parse(body).error;
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
    });
    try {
      await page.goto("http://fleet.test/?token=preview-only#/task/" + task.key);
      const release = page.getByRole("button", { name: "Release to the pool", exact: true });
      await release.waitFor();
      // The rendered task became stale: the hub must refuse this real button action.
      store.db.query("DELETE FROM tasks WHERE id = ?").run(task.id);
      await release.click();
      await page.locator("#error-toast:not([hidden])").waitFor();
      const shown = await page.locator("#error-toast-text").innerText();
      if (!reason || shown !== reason) throw new Error("Toast did not display hub refusal verbatim");
      if (await release.isDisabled()) throw new Error("Release remained disabled");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error(`Sideways overflow at ${width}px`);
      await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "Dismiss error" }).click();
      if (await page.locator("#error-toast").isVisible()) throw new Error("Dismiss failed");
      const ask = page.getByRole("button", { name: "Request outcome report", exact: true });
      for (mode of ["network", "html", "untrusted"]) {
        await ask.click();
        await page.locator("#error-toast:not([hidden])").waitFor();
        if (await ask.isDisabled()) throw new Error("Refused request cannot be retried");
        const text = await page.locator("#error-toast-text").innerText();
        if (mode === "network" && !text.includes("Could not reach")) throw new Error("Missing network error");
        if (mode === "html" && !text.includes("502")) throw new Error("Missing HTTP fallback");
        if (mode === "untrusted" && await page.locator("#error-toast img").count()) throw new Error("Error injected markup");
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Long error overflow");
        await page.getByRole("button", { name: "Dismiss error" }).click();
      }
      if (errors.length) throw new Error(errors.join("\n"));
      checks.push({ theme, width, reason, sidewaysScroll: false, dismiss: "pass", retry: "pass", network: "pass", nonJson: "pass", safeText: "pass", reducedMotion: "reduce", pageErrors: errors });
    } finally { await page.close(); store.db.close(); rmSync(hub.dataDir, { recursive: true, force: true }); }
  }
} finally { await browser.close(); }
await Bun.write(`${output}/checks.json`, JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks, null, 2));
