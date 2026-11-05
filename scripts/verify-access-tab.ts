// bun scripts/verify-access-tab.ts [output-directory]
// Drives the real Access view in Chromium, routed straight to Hono: no HTTP listener, no preview server.
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/access");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const checks: unknown[] = [];
try {
  for (const theme of ["light", "dark"]) for (const width of [1440, 400]) {
    const { app, hub, store } = createApp(":memory:", "preview-only", { hubOwner: "alper" });
    for (const p of ["kapi", "han-test"]) store.ensureProject(p, "default");
    // One outside agent already exists, so the list is not empty before the form is used.
    const existing = store.addAgent({ name: "bo-laptop", owner: "bo", device: "outside", skills: [], expiresAt: Date.now() + 30 * 86400_000 });
    store.grantProject(existing.id, "kapi");
    const page = await browser.newPage({ viewport: { width, height: 1100 }, colorScheme: theme, reducedMotion: "reduce" });
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
      await page.goto("http://fleet.test/?token=preview-only#/access");
      await page.getByRole("heading", { name: "Access" }).waitFor();
      const list = page.locator("#accList");
      const before = list.locator(".acc", { hasText: "bo-laptop" });
      await before.waitFor();
      await before.locator(".grant", { hasText: "kapi" }).waitFor();                       // its grant is a chip

      // Invite through the real form.
      await page.getByLabel("Agent name").fill("acme-agent");
      await page.getByLabel("Belongs to").fill("acme");
      await page.getByLabel("Token expires").selectOption("7");
      await page.locator('#acc-projects input[value="kapi"]').check();
      await page.getByRole("button", { name: "Create the invite" }).click();

      const panel = page.locator("#acc-out");
      await panel.waitFor();
      if (!(await panel.isVisible())) throw new Error("the one-time token panel did not open");
      const token = await page.locator("#acc-token").innerText();
      if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("no one-time token was shown");
      const prompt = await page.locator("#acc-prompt").innerText();
      if (!prompt.includes("fleet join http://fleet.test") || !prompt.includes(token)) throw new Error("the join prompt is not ready to paste");
      if ((await page.getByLabel("Agent name").inputValue()) !== "") throw new Error("the form kept the previous name");

      const invited = list.locator(".acc", { hasText: "acme-agent" });
      await invited.waitFor();
      await invited.locator(".grant", { hasText: "kapi" }).waitFor();                    // the granted project is on the row
      if (!(await invited.innerText()).includes("in 7 days")) throw new Error("the invite expiry is not shown");
      if (!(await invited.innerText()).includes("owner acme")) throw new Error("the owner label is not shown");

      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Sideways overflow at ${width}px`);
      await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
      // A second frame with the list in view: the token panel and the invited row do not fit one phone screen.
      await page.locator("#accList").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/${theme}-${width}-agents.png`, fullPage: true });
      await page.evaluate(() => { document.getElementById("body")!.scrollTop = 0; });

      // Rotate is two-step and every step says what it breaks; it issues a different token, shown once.
      const rotate = invited.locator(".acc-actions button").nth(0);
      if (!/rotate token/i.test(await rotate.innerText())) throw new Error("the rotate button is missing");
      await rotate.click();
      if (!/sure\?/i.test(await rotate.innerText())) throw new Error("rotate is not two-step");
      await rotate.click();
      await page.waitForFunction((old) => document.getElementById("acc-token")?.textContent && document.getElementById("acc-token")!.textContent !== old, token);
      const token2 = await page.locator("#acc-token").innerText();
      if (token2 === token) throw new Error("rotate did not issue a new token");

      // Copy reports back.
      const copy = page.getByRole("button", { name: "Copy token" });
      await copy.click();
      await page.waitForFunction(() => document.querySelector("#acc-copy-token")!.textContent === "Copied");

      // Revoke is two-step too, and the row goes away.
      const revoke = before.locator(".acc-actions button").nth(1);
      if (!/revoke agent/i.test(await revoke.innerText())) throw new Error("the revoke button is missing");
      await revoke.click();
      if (!/sure\?/i.test(await revoke.innerText())) throw new Error("revoke is not two-step");
      await revoke.click();
      await list.locator(".acc", { hasText: "bo-laptop" }).waitFor({ state: "detached" });

      // The token is never shown again: a reload goes back to the list only.
      await page.reload();
      await page.getByRole("heading", { name: "Access" }).waitFor();
      if (await page.locator("#acc-out").isVisible()) throw new Error("the token panel survived a reload");
      if (await page.locator("#accList").getByText(token).count()) throw new Error("the token is in the page after a reload");

      if (errors.length) throw new Error(errors.join("\n"));
      checks.push({ theme, width, invite: "pass", tokenShownOnce: "pass", prompt: "pass", rotateTwoStep: "pass", revokeTwoStep: "pass", copy: "pass", expiry: "7 days", sidewaysScroll: false, pageErrors: errors });
    } finally { await page.close(); store.db.close(); rmSync(hub.dataDir, { recursive: true, force: true }); }
  }
} finally { await browser.close(); }
await Bun.write(`${output}/checks.json`, JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks, null, 2));
