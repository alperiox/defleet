// bun scripts/verify-discuss-request.ts [output-directory]
// Routes Chromium requests straight to Hono: no HTTP listener or preview server.
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/discuss");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const checks: unknown[] = [];
try {
  for (const theme of ["light", "dark"]) for (const width of [1440, 400]) {
    const { app, hub, store } = createApp(":memory:", "preview-only");
    const created = store.addAgent({ name: "worker", owner: "owner", device: "test", skills: [] });
    const agent = store.agentById(created.id)!;
    const task = hub.humanCreateTask({ title: "Implement profile caching layer", project: "demo", description: "Add Redis profile caching for quick lookups.", acceptance: "Profile requests hit cache and latency < 10ms." });
    hub.claim(agent, task.id);
    const req = hub.askHuman(agent, { kind: "decision", text: "Should we use Redis or memcached for profile caching?", taskId: task.id, link: "https://redis.io" });

    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
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
      // 1. Visit inbox: Needs-you card
      await page.goto("http://fleet.test/?token=preview-only#/inbox");
      const card = page.locator(".card.req").first();
      await card.waitFor();

      // Check overflow on inbox
      let overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error(`Sideways overflow on inbox card at ${width}px (${theme})`);

      // Screenshot 1: Needs-you card
      await page.screenshot({ path: `${output}/${theme}-${width}-1-needs-you-card.png`, fullPage: true });

      // Click Discuss button
      const discussBtn = card.getByRole("button", { name: "Discuss", exact: true });
      await discussBtn.waitFor();
      await discussBtn.click();

      // 2. Discuss thread opened with quoted request
      const quoteCard = page.locator("#thread-discuss .card.req");
      await quoteCard.waitFor();
      const quoteText = await quoteCard.innerText();
      if (!quoteText.includes("Should we use Redis or memcached")) throw new Error("Missing quoted request text in thread");
      if (!quoteText.includes(task.key)) throw new Error("Missing task key in discuss header");

      // Check composer focused
      const isFocused = await page.evaluate(() => document.activeElement?.id === "compose");
      if (!isFocused) throw new Error("Composer was not focused");

      // Check overflow on discuss thread
      overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error(`Sideways overflow on discuss thread at ${width}px (${theme})`);

      // Screenshot 2: Discuss thread opened with quoted request
      await page.screenshot({ path: `${output}/${theme}-${width}-2-discuss-thread.png`, fullPage: true });

      // 3. Send a thread message
      await page.locator("#compose").fill("Let's go with Redis because we need persistence across restarts.");
      await page.locator("#sendBtn").click();

      // Wait for message to appear in thread
      await page.locator("#thread-msgs .msg").waitFor();
      const msgText = await page.locator("#thread-msgs .msg .bubble").innerText();
      if (!msgText.includes(`Discussing request ${req.id}`)) throw new Error("Thread message missing request id line");
      if (!msgText.includes("Let's go with Redis")) throw new Error("Thread message missing human text");

      // Verify request is still open in store
      if (store.getRequest(req.id)?.answer !== null) throw new Error("Request was answered by thread message");
      if (!store.openRequests().some((r) => r.id === req.id)) throw new Error("Request is no longer open in store");

      // Navigate back to inbox
      await page.goto("http://fleet.test/?token=preview-only#/inbox");
      await page.locator(".card.req").waitFor();

      // Check overflow on inbox after thread message
      overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error(`Sideways overflow on inbox after message at ${width}px (${theme})`);

      // Screenshot 3: Request still open after thread message
      await page.screenshot({ path: `${output}/${theme}-${width}-3-request-still-open.png`, fullPage: true });

      // 4. Now answer request with normal answer box
      await page.locator(".card.req textarea").fill("Redis is approved.");
      await page.getByRole("button", { name: "Send reply", exact: true }).click();
      await page.locator(".card.req").waitFor({ state: "detached" });

      // Return to discuss thread and verify thread shows when request was answered
      await page.goto(`http://fleet.test/?token=preview-only#/dm/${encodeURIComponent(agent.name)}?discuss=${encodeURIComponent(req.id)}`);
      const answeredPill = page.locator("#thread-discuss .pill.done");
      await answeredPill.waitFor();
      const answeredHeader = await page.locator("#thread-discuss").innerText();
      if (!answeredHeader.toUpperCase().includes("ANSWERED: REDIS IS APPROVED.")) throw new Error("Discuss thread did not show request was answered: " + answeredHeader);

      // Screenshot 4: Discuss thread shows answered
      await page.screenshot({ path: `${output}/${theme}-${width}-4-thread-answered.png`, fullPage: true });

      if (errors.length) throw new Error(errors.join("\n"));
      checks.push({ theme, width, sidewaysScroll: false, discussOpened: "pass", composerFocused: "pass", threadMessage: "pass", requestKeptOpen: "pass", threadShowsAnswered: "pass", pageErrors: errors });
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
