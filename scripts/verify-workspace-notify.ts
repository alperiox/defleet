// bun scripts/verify-workspace-notify.ts [output-directory]
// Two workspaces, real key presses and clicks, in-process Hono (no listener). The event stream is a stub, so the page
// refreshes through its normal reconnect cycle (3 s) after a fixture writes new state.
import { createRequire } from "node:module";
import { mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import { DOC } from "../tests/fixtures";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/workspace-notify");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const checks: unknown[] = [];
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

try {
  for (const theme of ["light", "dark"]) for (const width of [1440, 400]) {
    const { app, hub, store } = createApp(":memory:", "preview-only", { hubOwner: "owner" });
    const acme = hub.createWorkspace("acme");
    const claude = store.agentById(store.addAgent({ name: "claude-1", owner: "owner", device: "test", skills: [] }).id)!;
    const codex = store.agentById(store.addAgent({ name: "codex-2", owner: "owner", device: "test", skills: [], workspaceId: acme.id }).id)!;
    hub.humanCreateTask({ title: "Fleet release checklist", project: "demo", ...DOC });
    hub.humanCreateTask({ title: "Acme launch plan", project: "acme-project", workspaceId: acme.id, ...DOC });

    // A fresh context per viewport: localStorage (the remembered workspace) must not leak between iterations.
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce", ...(theme === "light" && width === 1440 ? { recordVideo: { dir: output, size: { width: 1440, height: 1000 } } } : {}) });
    const page = await context.newPage();
    // Sound and pop-ups are captured instead of played: no audio device in CI, and a stub is the only way to click one.
    await page.addInitScript(() => {
      const w = window as any;
      w.__beeps = 0;
      class FakeAudioContext {
        constructor() { w.__beeps++; }
        createOscillator() { return { type: "", frequency: { value: 0 }, connect() {}, start() {}, stop() {}, onended: null }; }
        createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        get destination() { return {}; }
        get currentTime() { return 0; }
        close() {}
      }
      w.AudioContext = FakeAudioContext;
      w.__notes = [];
      class FakeNotification {
        static permission = "granted";
        title: string; body: unknown; onclick: (() => void) | null = null;
        constructor(title: string, opts: any) { this.title = title; this.body = opts?.body; w.__notes.push(this); }
        close() {}
      }
      w.Notification = FakeNotification;
    });
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.route("**/*", async (route: any) => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (path === "/api/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: hello\ndata: 1\n\n" });
      const res = await app.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }));
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
    const overflow = async () => check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `sideways scroll at ${theme}/${width}`);

    try {
      await page.goto("http://fleet.test/?token=preview-only#/dm/claude-1");
      await page.locator("#compose").waitFor();
      check(await page.locator("#v-thread").isVisible(), "the DM did not open");

      // Bug 1: a DM from another workspace must not survive the switch.
      await page.locator("#wsSelect").selectOption(acme.id);
      await page.waitForFunction(() => location.hash === "#/inbox");
      check(await page.locator("#v-thread").isHidden(), "the old agent chat is still rendered after the switch");
      check(await page.locator("#v-inbox").isVisible(), "the default view is not Needs you");
      check(await page.locator("#title").textContent() === "Needs you", "the title still names the old agent");
      await overflow(); await page.screenshot({ path: `${output}/${theme}-${width}-switched.png`, fullPage: true });

      // A draft belongs to its conversation: switching away must not send it anywhere, and coming back must show it.
      await page.locator("#wsSelect").selectOption("default");
      await page.goto("http://fleet.test/?token=preview-only#/dm/claude-1"); await page.locator("#compose").waitFor();
      await page.locator("#compose").fill("half a thought for claude");
      await page.locator("#wsSelect").selectOption(acme.id);
      await page.waitForFunction(() => location.hash === "#/inbox");
      check((await page.locator("#compose").inputValue()) === "", "the composer kept text after leaving the conversation");
      await page.locator("#wsSelect").selectOption("default");
      await page.evaluate(() => { location.hash = "#/dm/claude-1"; }); await page.locator("#compose").waitFor();
      check((await page.locator("#compose").inputValue()) === "half a thought for claude", "the draft was lost");
      await page.locator("#compose").fill("");

      // Bug 2: an update in another workspace while this tab is visible.
      hub.say(codex, "dm:human", "hello from acme");
      await page.waitForFunction(() => !(document.getElementById("ws-toast") as HTMLElement).hidden, undefined, { timeout: 20000 });
      const toastTitle = (await page.locator("#ws-toast-title").textContent()) ?? "";
      check(toastTitle.startsWith("acme: ") && toastTitle.includes("codex-2 replied"), `toast reads: ${toastTitle}`);
      const option = await page.locator("#wsSelect option[value='" + acme.id + "']").textContent();
      check(/acme \(1 new\)/.test(option ?? ""), `selector reads: ${option}`);
      const fresh = await page.locator("#wsFresh").innerText();
      check(/acme \(1 new\)/.test(fresh), `the visible unread button reads: ${fresh}`);
      check((await page.title()).startsWith("(1)"), `title reads: ${await page.title()}`);
      check((await page.evaluate(() => (window as any).__beeps)) >= 1, "no sound was made for a visible tab");
      await overflow(); await page.screenshot({ path: `${output}/${theme}-${width}-toast.png`, fullPage: true });
      await page.locator("#ws-toast").screenshot({ path: `${output}/${theme}-${width}-toast-closeup.png` });
      if (width <= 820) await page.locator("#burger").click();   // the switcher lives in the drawer on a phone
      await page.screenshot({ path: `${output}/${theme}-${width}-selector.png`, fullPage: true });
      if (width <= 820) await page.locator("#burger").click();

      // Clicking the toast must switch workspace first, then open the conversation.
      await page.locator("#ws-toast-open").click();
      await page.waitForFunction(() => location.hash.startsWith("#/dm/codex-2"));
      const dbg = await page.evaluate(() => ({ hash: location.hash, sel: (document.getElementById("wsSelect") as HTMLSelectElement).value }));
      check(await page.locator("#wsSelect").inputValue() === acme.id, `the toast did not switch workspace (${JSON.stringify(dbg)}, wanted ${acme.id})`);
      check((await page.locator("#wsSelect option[value='" + acme.id + "']").textContent()) === "acme", "the unread count was not cleared");
      check(await page.locator("#ws-toast").isHidden(), "the toast stayed after opening it");

      // A burst is one beep, and a browser notification opens the right workspace and route.
      await page.locator("#wsSelect").selectOption("default");
      await page.waitForFunction(() => location.hash === "#/inbox");
      const beepsBefore = await page.evaluate(() => (window as any).__beeps);
      hub.say(codex, "dm:human", "second from acme"); hub.say(codex, "dm:human", "third from acme");
      await page.waitForFunction(() => !(document.getElementById("ws-toast") as HTMLElement).hidden, undefined, { timeout: 20000 });
      check((await page.evaluate(() => (window as any).__beeps)) === beepsBefore + 1, "a burst should make exactly one beep");
      const notes = await page.evaluate(() => (window as any).__notes.map((n: any) => n.title));
      check(notes.some((t: string) => t.startsWith("acme: ")), `browser notifications: ${JSON.stringify(notes)}`);
      await page.evaluate(() => { const n = (window as any).__notes.at(-1); n.onclick && n.onclick(); });
      await page.waitForFunction(() => location.hash.startsWith("#/dm/codex-2"));
      check(await page.locator("#wsSelect").inputValue() === acme.id, "the notification click did not switch workspace");
      check(errors.length === 0, errors.join("\n"));
      checks.push({ theme, width, chatHiddenAfterSwitch: "pass", defaultView: "pass", draftKept: "pass", toast: "pass", counter: "pass", freshButton: "pass", title: "pass", beepVisibleTab: "pass", toastOpens: "pass", burstOneBeep: "pass", notificationClick: "pass", sidewaysScroll: false, pageErrors: errors });
    } finally {
      const video = page.video(); await page.close(); await context.close(); if (video) renameSync(await video.path(), `${output}/workspace-notify-demo.webm`);
      store.db.close();
    }
  }
} finally { await browser.close(); }
await Bun.write(`${output}/checks.json`, JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks, null, 2));
