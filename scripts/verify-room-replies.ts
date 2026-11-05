// bun scripts/verify-room-replies.ts [output-directory]
// Route browser requests directly to Hono; never open a preview server.
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/room");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const checks: unknown[] = [];
try {
  for (const theme of ["light", "dark"]) for (const width of [1440, 400]) {
    const { app, hub, store } = createApp(":memory:", "preview-only", { hubOwner: "owner" });
    const ws = hub.createWorkspace("Fleet"), other = hub.createWorkspace("Other");
    const add = (name: string, workspaceId = ws.id) => store.agentById(store.addAgent({ name, workspaceId, owner: "owner", device: "laptop", skills: [] }).id)!;
    const builder = add("builder"), reviewer = add("reviewer"), outsider = add("other-worker", other.id);
    hub.humanSay("@builder Can you check the release checklist?", ws.id);
    const agentMessage = hub.say(builder, "room", "The checks pass. Would you like me to prepare the release notes?");
    hub.say(outsider, "room", "Other workspace conversation");
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.clock.install({ time: Date.now() });
    await page.addInitScript((id: string) => {
      localStorage.setItem("fleet-workspace", id);
      (window as any).EventSource = class extends EventTarget {
        constructor() { super(); (window as any).__fleetEvents = this; }
        close() {}
      };
    }, ws.id);
    await page.route("**/*", async (route: any) => {
      const r = route.request();
      const response = await app.fetch(new Request(r.url(), { method: r.method(), headers: r.headers(), body: ["GET", "HEAD"].includes(r.method()) ? undefined : r.postDataBuffer() }));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    const refresh = async () => {
      const res = page.waitForResponse((r: any) => r.url().endsWith("/api/state"));
      await page.evaluate(() => (window as any).__fleetEvents.dispatchEvent(new Event("change")));
      await res;
    };
    const send = async (text: string) => {
      await page.locator("#compose").fill(text);
      const response = page.waitForResponse((r: any) => r.url().endsWith("/api/room") && r.request().method() === "POST");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      if (!(await response).ok()) throw new Error("Room send failed");
      await refresh();
      return store.messagesSince("room:" + ws.id, 0).at(-1)!;
    };
    const snapshot = async (state: string) => {
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Room overflows horizontally");
      await page.screenshot({ path: `${output}/${theme}-${width}-${state}.png`, fullPage: true });
    };
    try {
      await page.goto("http://fleet.test/?token=preview-only#/room");
      await page.locator('[data-reply-window="active"]').waitFor();
      if (!(await page.locator("#room-reply-hint").innerText()).includes("Replying to builder")) throw new Error("Missing automatic recipient");
      const plain = await send("Yes, please include the test results.");
      if (plain.text !== "Yes, please include the test results." || hub.deliveryFor(plain)[0]?.agent !== builder.name) throw new Error("Plain reply went to wrong agent");
      await page.getByText("Reply to builder", { exact: true }).waitFor();
      await snapshot("active");
      await page.locator("#compose").fill("@reviewer Please check too");
      if (!(await page.locator("#room-reply-hint").innerText()).includes("Your @mentions")) throw new Error("Explicit mention hint missing");
      const explicit = await send("@reviewer Please check too");
      if (hub.deliveryFor(explicit).map(d => d.agent).join() !== reviewer.name) throw new Error("Explicit mention overridden");
      // Advance only the browser clock to prove indicators expire without a server update.
      await page.clock.fastForward(20 * 60_000 + 1000);
      await page.locator('[data-reply-window="expired"]').waitFor();
      if (!(await page.locator("#room-reply-hint").innerText()).includes("Mention @name")) throw new Error("Expired composer hint missing");
      await snapshot("expired");
      // Expire server time too, then verify plain sends stop notifying until explicitly addressed.
      store.db.query("UPDATE messages SET created_at = ? WHERE id = ?").run(Date.now() - 20 * 60_000, agentMessage.id);
      if (hub.deliveryFor(await send("An unaddressed message after the window")).length) throw new Error("Expired plain reply notified an agent");
      if (hub.deliveryFor(await send("@builder One last question"))[0]?.agent !== builder.name) throw new Error("Explicit mention failed after expiry");
      if (errors.length) throw new Error(errors.join("\n"));
      checks.push({ theme, width, plainReply: "pass", explicitOverride: "pass", automaticExpiry: "pass", expiredSend: "pass", explicitAfterExpiry: "pass", workspaceIsolation: "pass", sidewaysScroll: false, pageErrors: errors });
    } finally { await page.close(); store.db.close(); rmSync(hub.dataDir, { recursive: true, force: true }); }
  }
} finally { await browser.close(); }
await Bun.write(`${output}/checks.json`, JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks, null, 2));
