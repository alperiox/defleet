// bun scripts/verify-stop-agent.ts [output-directory] — Chromium -> Hono, no listener.
import { createRequire } from "node:module";
import { mkdirSync, rmSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/stop-agent"); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const checks: unknown[] = []; const pdf = Buffer.from("%PDF-1.4\nquestion\n%%EOF");
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
try {
 for (const theme of ["light", "dark"]) for (const width of [1440, 400]) {
  const { app, hub, store } = createApp(":memory:", "preview-only", { hubOwner: "owner" });
  const made = store.addAgent({ name: "worker", owner: "owner", device: "fixture", skills: [] }); const agent = store.agentById(made.id)!;
  const other = store.agentById(store.addAgent({ name: "other", owner: "owner", device: "fixture", skills: [] }).id)!;
  const task = hub.humanCreateTask({ title: "Inspect the migration", project: "demo" }); hub.claim(agent, task.id); hub.humanDm("worker", "Please inspect the migration.");
  let signals = 0; const off = hub.onAgentStop(agent.id, (e) => { signals++; hub.setActivity(agent, "idle", undefined, e.turn); });
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce", ...(theme === "light" && width === 1440 ? { recordVideo: { dir: output, size: { width: 1440, height: 1000 } } } : {}) });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.route("**/*", async (route: any) => {
   const req = route.request(), path = new URL(req.url()).pathname;
   if (path === "/api/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture\n\n" });
   const res = await app.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }));
   await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  const refresh = async (hash = "#/dm/worker") => { await page.goto("http://fleet.test/?token=preview-only" + hash); await page.locator("#title").waitFor(); await page.waitForFunction(() => document.getElementById("login")!.hidden); };
  const working = (turn: string) => hub.setActivity(agent, "working", "Inspecting the migration", turn);
  const overflow = async () => check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), "sideways scroll");
  try {
   await refresh(); check(await page.locator("#stop-header").isHidden(), "idle agent has Stop");
   working("first"); await refresh(); await page.locator("#stop-header:not([hidden])").waitFor(); await overflow();
   await page.screenshot({ path: `${output}/${theme}-${width}-control.png`, fullPage: true });
   await page.locator("#stop-header").click(); await page.locator("#stop-question").fill("What have you found so far?");
   await page.evaluate(() => { const n = document.getElementById("stop-question") as HTMLTextAreaElement; n.setSelectionRange(3, 8); document.dispatchEvent(new Event("visibilitychange")); });
   check(await page.locator("#stop-question").inputValue() === "What have you found so far?", "stop draft lost on update");
   await page.screenshot({ path: `${output}/${theme}-${width}-ask.png`, fullPage: true });
   const before = store.dmsWithHuman().length; await page.locator("#stop-only").click();
   await page.waitForFunction(() => document.getElementById("stop-result")!.textContent!.includes("stopped"));
   check(signals === 1 && store.dmsWithHuman().length === before, "Stop only sent text or wrong signal count");
   check(await page.locator("#stop-header").isHidden(), "Stop remains visible after idle");
   check(await page.locator("#stop-question").inputValue() === "What have you found so far?", "Stop only discarded draft");
   // Idle race: the already-open box still sends a question, without another stop.
   await page.locator("#stop-send").click(); await page.waitForFunction(() => document.getElementById("stop-result")!.textContent!.includes("already idle"));
   check(signals === 1 && store.dmsWithHuman().at(-1)?.text === "What have you found so far?", "idle question lost");
   working("second"); await refresh(); await page.locator("#compose").focus(); await page.keyboard.type("x"); check(await page.locator("#stop-ask").count() === 0, "Insert x opened Stop");
   await page.keyboard.press("Escape"); await page.keyboard.press("x"); await page.locator("#stop-question").waitFor();
   await page.locator("#stop-question").fill("Check the attached PDF before continuing.");
   await page.locator("#attachmentInput").setInputFiles({ name: "question.pdf", mimeType: "application/pdf", buffer: pdf });
   await page.waitForFunction(() => document.querySelector('#attachmentList [data-status="ready"]'));
   await page.locator("#stop-send").click(); await page.waitForFunction(() => document.querySelectorAll("#thread-msgs .atts a").length > 0);
   check(signals === 2 && store.getTask(task.id)?.claimedBy === agent.id, "stop changed task claim");
   await overflow(); await page.screenshot({ path: `${output}/${theme}-${width}-thread.png`, fullPage: true });
   working("palette"); await refresh(); await page.keyboard.press(":"); await page.locator("#palette-input").fill(":stop");
   check(await page.locator("#palette-results").innerText().then((s: string) => s.includes("Stop and ask")), "palette :stop missing");
   await page.keyboard.press("Enter"); await page.locator("#stop-question").waitFor();
   await page.getByRole("button", { name: "Close" }).click(); check(await page.locator("#stop-ask").count() === 0, "cancel failed");
   // Team controls and live state refresh retain Stop's accurate visibility.
   await refresh("#/team"); const teamStop = page.locator(`[data-stop-agent="${agent.id}"]`); await teamStop.waitFor(); check(await teamStop.isVisible(), "Team Stop missing");
   check(await page.locator(`[data-stop-agent="${other.id}"]`).isHidden(), "idle Team agent has Stop"); await teamStop.click(); await page.locator("#stop-question").waitFor();
   // An offline helper is reported explicitly, never a stale queued stop.
   off(); await page.locator("#stop-question").fill("Question for when you return"); await page.locator("#stop-send").click();
   await page.waitForFunction(() => document.getElementById("stop-result")!.textContent!.includes("offline"));
   check(store.dmsWithHuman().at(-1)?.text === "Question for when you return", "offline question was not delivered");
   check(signals === 2 && errors.length === 0, errors.join("\n"));
   checks.push({ theme, width, workingOnly: "pass", stopOnly: "pass", stopAndSendWithFile: "pass", idleQuestion: "pass", offlineQuestion: "pass", teamControl: "pass", keyboardNormalInsert: "pass", paletteStop: "pass", draftsSurviveRender: "pass", tasksStayClaimed: true, sidewaysScroll: false, pageErrors: errors });
  } finally { off(); const video = page.video(); await page.close(); if (video) renameSync(await video.path(), `${output}/stop-agent-demo.webm`); store.db.close(); rmSync(hub.dataDir, { recursive: true, force: true }); }
 }
} finally { await browser.close(); }
await Bun.write(`${output}/checks.json`, JSON.stringify(checks, null, 2)); console.log(JSON.stringify(checks, null, 2));
