// bun scripts/verify-stream-tickets.ts [output-directory]
// Actual browser EventSource + Hono SSE, connected through Playwright routing. No listener is opened.
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/streams");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const results: unknown[] = [];
try {
  for (const width of [1440, 400]) {
    const { app, hub, store } = createApp(":memory:", "browser-human");
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = [], violations: string[] = [], tickets: string[] = [];
    let minted = 0;
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: any) => { if (/content security policy|violates.*directive/i.test(message.text())) violations.push(message.text()); });
    await page.addInitScript(() => localStorage.setItem("fleet-human-token", "browser-human"));
    await page.route("**/*", async (route: any) => {
      const request = route.request(), url = new URL(request.url());
      if (url.searchParams.has("token")) throw new Error("Human token in request URL");
      if (url.pathname === "/api/events/ticket") {
        if (request.method() !== "POST" || request.headers().authorization !== "Bearer browser-human") throw new Error("Ticket mint not authenticated");
        minted++;
      }
      const response = await app.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(), body: ["GET", "HEAD"].includes(request.method()) ? undefined : request.postDataBuffer() }), { remoteAddress: "127.0.0.1" });
      if (url.pathname === "/api/events") {
        const ticket = url.searchParams.get("ticket");
        if (!ticket || tickets.includes(ticket)) throw new Error("Missing/reused stream ticket");
        tickets.push(ticket);
        if (response.status !== 200) throw new Error(`Stream rejected: ${response.status}`);
        const reader = response.body!.getReader(), decoder = new TextDecoder();
        let body = decoder.decode((await reader.read()).value);
        if (!body.includes("event: hello")) throw new Error("No real SSE hello");
        if (tickets.length === 2) {
          // The first connection closes intentionally; on its replacement generate a real Hub change.
          hub.humanCreateTask({ title: "Ticket stream update", project: "stream-check" });
          while (!body.includes("event: change")) {
            const next = await reader.read();
            if (next.done) throw new Error("No real SSE change");
            body += decoder.decode(next.value);
          }
        }
        await reader.cancel();
        await route.fulfill({ status: 200, contentType: "text/event-stream", body });
      } else await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    try {
      await page.goto("http://fleet.test/#/tasks");
      await page.locator("#taskList").getByText("Ticket stream update", { exact: true }).waitFor({ timeout: 15_000 });
      if (tickets.length < 2 || minted < 2) throw new Error("UI did not reconnect with a new ticket");
      if (errors.length || violations.length) throw new Error(JSON.stringify({ errors, violations }));
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Horizontal overflow");
      const replay = await app.request(`/api/events?ticket=${encodeURIComponent(tickets[0])}`);
      if (replay.status !== 401) throw new Error("Used browser ticket replayed");
      await page.screenshot({ path: `${output}/live-${width}.png`, fullPage: true });
      results.push({ width, authenticatedTicketPosts: minted, distinctStreamTickets: tickets.length, realHelloAndChange: "pass", reconnect: "pass", liveTaskVisible: true, replayStatus: replay.status, cspViolations: violations, pageErrors: errors });
    } finally { await page.close(); store.db.close(); rmSync(hub.dataDir, { recursive: true, force: true }); }
  }
} finally { await browser.close(); }
await Bun.write(`${output}/checks.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
