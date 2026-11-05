// The free rebind fixture is z; x is reserved for Stop and ask.
// bun scripts/verify-palette.ts [output-directory]
// Drives the ":" command palette and the editable keymap with real key presses.
// Routes Chromium requests straight to Hono: no HTTP listener or preview server.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/palette");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); };
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

type Seeded = { app: any; hub: any; store: any; taskKeys: string[] };

function seed(): Seeded {
  const { app, hub, store } = createApp(":memory:", "preview-only");
  for (const name of ["alpha", "beta"]) {
    const created = store.addAgent({ name, owner: "owner", device: "test", skills: [] });
    hub.askHuman(store.agentById(created.id)!, { kind: "decision", text: `Should ${name} ship the parser change today?` });
  }
  const t1 = hub.humanCreateTask({ title: "Tighten the parser tests", project: "demo", description: "Add cases for sequences.", acceptance: "Tests pass." });
  const t2 = hub.humanCreateTask({ title: "Document the keymap", project: "demo" });
  store.addWorkspace("acme");
  return { app, hub, store, taskKeys: [t1.key, t2.key] };
}

async function routable(app: any, page: any, data: Seeded) {
  page.on("pageerror", (e: Error) => check("no page error", false, e.message));
  await page.addInitScript(() => localStorage.setItem("fleet-tour-done", "1"));
  await page.route("**/*", async (route: any) => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === "/api/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": preview\n\n" });
    const response = await data.app.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }));
    const body = await response.text();
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  });
  await page.goto("http://fleet.test/?token=preview-only#/inbox");
  await page.locator("#reqBox .card.req").first().waitFor();
  await page.locator("#login").waitFor({ state: "hidden" });
}

const hash = (page: any) => page.evaluate(() => location.hash);
const sel = (page: any) => page.evaluate(() => {
  const row = document.querySelector("#reqBox .row-sel, #taskList .row-sel");
  return row ? (row.getAttribute("data-sel") || "") : null;
});
async function press(page: any, key: string) { await page.keyboard.press(key); await page.waitForTimeout(40); }

// ":" and Ctrl+K both open the typed panel; Esc closes it.
async function openPalette(page: any) {
  await press(page, ":");
  await page.locator("#palette").waitFor({ state: "visible" });
}
async function closePalette(page: any) {
  await press(page, "Escape");
  await page.waitForTimeout(40);
  eq("the palette closed on Esc", await page.locator("#palette").count(), 0);
}

const pickedRow = (page: any) => page.evaluate(() => {
  const btn = document.querySelector("#palette-results button.on") || document.querySelector("#palette-results button");
  return btn ? btn.textContent : null;
});
const settingsKbd = (page: any, id: string) => page.evaluate((rowId: string) => {
  const row = document.querySelector(`[data-setrow="${rowId}"]`);
  return row ? [...row.querySelectorAll("kbd")].map((k) => k.textContent) : null;
}, id);
const settingsMsg = (page: any, id: string) => page.evaluate((rowId: string) => {
  const row = document.querySelector(`[data-setrow="${rowId}"]`);
  const m = row ? row.querySelector(".err") : null;
  return m ? m.textContent : "";
}, id);

// The main loop: every interaction, screenshots at 1440.
for (const theme of ["light", "dark"]) {
  const data = seed();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: theme, reducedMotion: "reduce" });
  await routable(data.app, page, data);

  // ":" opens the palette in Normal mode
  await openPalette(page);
  const results = page.locator("#palette-results button");
  await results.first().waitFor();
  check("':' opens the palette with results", (await results.count()) > 0, String(await results.count()));

  // arrows and Ctrl+N / Ctrl+P move the pick over the whole (unfiltered) list
  const pickIndex = `document.querySelector("#palette-results button.on")?.id || "none"`;
  eq("the first result is highlighted", await page.evaluate(pickIndex), "pal-opt-0");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(30);
  eq("ArrowDown moves the highlight", await page.evaluate(pickIndex), "pal-opt-1");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(30);
  eq("ArrowUp moves it back", await page.evaluate(pickIndex), "pal-opt-0");
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(30);
  eq("Ctrl+N moves the highlight", await page.evaluate(pickIndex), "pal-opt-1");
  await page.keyboard.press("Control+p");
  await page.waitForTimeout(30);
  eq("Ctrl+P moves it back", await page.evaluate(pickIndex), "pal-opt-0");

  // the results ranked for a typed name: the agent tops the list; this is the palette preview shot.
  // Clipped to the panel: headless Chromium painted the shrunken panel layer with light colors in
  // whole-viewport captures, while its own raster is correct — the clip keeps the capture honest.
  await page.keyboard.type("beta");
  await page.waitForTimeout(30);
  const topRow = await pickedRow(page);
  check("typing a name ranks the agent first", !!topRow && topRow.includes("beta") && topRow.includes("open DM"), String(topRow).slice(0, 80));
  const panelBox = await page.locator(".palette-panel").boundingBox();
  await page.screenshot({ path: `${output}/${theme}-1440-palette.png`, clip: { x: panelBox!.x - 10, y: panelBox!.y - 10, width: panelBox!.width + 20, height: Math.min(panelBox!.height + 20, 500) } });
  await press(page, "Enter");
  eq("a bare name opens the DM", await hash(page), "#/dm/beta");
  await closePalette(page);

  // Ctrl+K opens it too
  await page.keyboard.press("Control+k");
  eq("Ctrl+K opens the palette", await page.locator("#palette").count(), 1);
  await closePalette(page);

  // ":" typed in the composer is text, never the palette
  await page.goto("http://fleet.test/?token=preview-only#/dm/alpha");
  await page.waitForTimeout(80);
  await press(page, "i");
  await page.keyboard.type("see: beta");
  eq("':' inside the composer opens nothing", await page.locator("#palette").count(), 0);
  eq("':' typed in the composer stays text", await page.evaluate(() => (document.getElementById("compose") as HTMLTextAreaElement).value), "see: beta");
  await press(page, "Escape");

  // ":agent <name>" opens that agent's DM
  await openPalette(page);
  await page.keyboard.type(":agent beta");
  await press(page, "Enter");
  await page.waitForTimeout(60);
  eq("':agent beta' opens beta's DM", await hash(page), "#/dm/beta");

  // a workspace: ":ws acme" switches, ":ws default" returns
  await openPalette(page);
  await page.keyboard.type(":ws acme");
  await press(page, "Enter");
  await page.waitForTimeout(60);
  check("':ws acme' switched workspace", (await page.evaluate(() => (document.getElementById("wsSelect") as HTMLSelectElement).value)) !== "default", "left default");
  await openPalette(page);
  await page.keyboard.type(":ws default");
  await press(page, "Enter");
  await page.waitForTimeout(60);
  eq("':ws default' switched back", await page.evaluate(() => (document.getElementById("wsSelect") as HTMLSelectElement).value), "default");

  // ":task <KEY>" opens the task even with a fragment of the key
  await openPalette(page);
  await page.keyboard.type(":task " + data.taskKeys[1].slice(-1));
  await press(page, "Enter");
  await page.waitForTimeout(80);
  check("':task <KEY>' opens the task", (await hash(page)).startsWith("#/task/"), await hash(page));
  await press(page, "Escape");

  // ":" + tab name and ":tab <name>"
  await openPalette(page);
  await page.keyboard.type("usage");
  await press(page, "Enter");
  await page.waitForTimeout(60);
  eq("':usage' goes to the Usage tab", await hash(page), "#/usage");
  await openPalette(page);
  await page.keyboard.type(":tab tasks");
  await press(page, "Enter");
  await page.waitForTimeout(60);
  eq("':tab tasks' goes to Tasks", await hash(page), "#/tasks");

  // ":help" runs the keymap action: the cheat sheet opens from the palette
  await openPalette(page);
  await page.keyboard.type("help");
  await press(page, "Enter");
  await page.waitForTimeout(60);
  check("a keymap action runs from the palette", await page.locator("#keysheet").isVisible());
  await press(page, "Escape");
  await page.waitForTimeout(40);
  eq("the cheat sheet closed", await page.locator("#keysheet").count(), 0);

  // nothing matches a made-up word
  await openPalette(page);
  await page.keyboard.type("zzqq");
  await page.waitForTimeout(30);
  check("an empty result says so", await page.locator("#palette-results .pal-empty").isVisible());
  await closePalette(page);

  // Settings: a rebound key stored in localStorage, working after reload
  await openPalette(page);
  await page.keyboard.type(":tab settings");
  await press(page, "Enter");
  await page.waitForTimeout(80);
  eq("':tab settings' opens the Settings tab", await hash(page), "#/settings");
  const row = page.locator('[data-setrow="list-down"]');
  await row.waitFor();
  await row.getByRole("button", { name: "Rebind" }).click();
  await row.getByRole("button", { name: "Listening" }).waitFor();
  await press(page, "z");
  await page.waitForTimeout(1150);                       // no second press: the single key binds after one second
  eq("the row shows the new key", await settingsKbd(page, "list-down"), ["z"]);
  check("the note says the rebind was saved", (await page.locator(".set-note").innerText()).includes("is now z"), await page.locator(".set-note").innerText());

  // the binding survives a reload
  await page.reload();
  await page.locator("#nav").waitFor();
  await page.evaluate(() => { location.hash = "#/inbox"; });
  await page.waitForTimeout(80);
  await press(page, "j");
  eq("j does nothing after the rebind", await sel(page), null);
  await press(page, "z");
  const after = await sel(page);
  check("the rebound key works after reload", !!after && after.startsWith("req:"), String(after));

  // a conflicting rebind is refused and named
  await page.evaluate(() => { location.hash = "#/settings"; });
  await page.waitForTimeout(80);
  const clashRow = page.locator('[data-setrow="list-up"]');
  await clashRow.getByRole("button", { name: "Rebind" }).click();
  await clashRow.getByRole("button", { name: "Listening" }).waitFor();
  await press(page, "z");   // z already belongs to "Select the next item"
  await page.waitForTimeout(1150);
  const msg = await settingsMsg(page, "list-up");
  check("a conflicting rebind is refused with the owner named", msg.includes("z belongs to") && msg.includes("Select the next item"), msg);
  eq("the refused row keeps its key", await settingsKbd(page, "list-up"), ["k"]);

  // Settings screenshot with the conflict message still on the row, scrolled into view
  await page.evaluate(() => { document.querySelector('[data-setrow="list-up"]')?.scrollIntoView({ block: "center" }); });
  await page.waitForTimeout(40);
  const shot = async (name: string) => page.screenshot({ path: `${output}/${theme}-1440-${name}.png`, fullPage: false });
  await shot("settings-conflict");
  await press(page, "Escape");
  await page.waitForTimeout(40);

  // the cheat-sheet reads the effective keymap: it shows the rebound action
  await press(page, "?");
  check("the cheat-sheet shows the rebound keymap", (await page.locator("#keysheet kbd", { hasText: "z" }).count()) > 0);
  await press(page, "Escape");
  await page.waitForTimeout(40);

  // reset the binding: j comes back
  const downRow = page.locator('[data-setrow="list-down"]');
  await downRow.getByRole("button", { name: "Reset" }).click();
  await page.waitForTimeout(60);
  eq("reset puts j back", await settingsKbd(page, "list-down"), ["j"]);
  check("the reset note says so", (await page.locator(".set-note").innerText()).includes("back on j"), await page.locator(".set-note").innerText());
  await page.evaluate(() => { location.hash = "#/inbox"; });
  await page.waitForTimeout(60);
  await press(page, "j");
  check("j works again after reset", !!(await sel(page)), String(await sel(page)));

  check(`no sideways scroll at 1440 (${theme})`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.close();
}

// Phone width: the palette and settings do not overflow, targets stay 44px, the keys still work.
for (const theme of ["light", "dark"]) {
  const data = seed();
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, colorScheme: theme, reducedMotion: "reduce" });
  await routable(data.app, page, data);
  await press(page, ":");
  eq(`400 (${theme}): ':' opens the palette`, await page.locator("#palette").count(), 1);
  await page.keyboard.type("beta");
  await page.waitForTimeout(40);
  check(`400 (${theme}): results are shown`, (await page.locator("#palette-results button").count()) > 0);
  const palBox = await page.locator(".palette-panel").boundingBox();
  await page.screenshot({ path: `${output}/${theme}-400-palette.png`, clip: { x: palBox!.x, y: palBox!.y, width: palBox!.width, height: palBox!.height } });
  await press(page, "Enter");
  await page.waitForTimeout(60);
  eq(`400 (${theme}): Enter runs the agent target`, await hash(page), "#/dm/beta");

  await openPalette(page);
  await page.keyboard.type(":tab settings");
  await press(page, "Enter");
  await page.waitForTimeout(80);
  const row = page.locator('[data-setrow="list-down"]');
  await row.waitFor();
  await row.getByRole("button", { name: "Rebind" }).click();
  await press(page, "z");
  await page.waitForTimeout(1150);
  // the conflict: give list-up the key that list-down now owns
  const clash = page.locator('[data-setrow="list-up"]');
  await clash.getByRole("button", { name: "Rebind" }).click();
  await clash.getByRole("button", { name: "Listening" }).waitFor();
  await press(page, "z");
  await page.waitForTimeout(1150);
  const msg = await settingsMsg(page, "list-up");
  check(`400 (${theme}): the same sequence is refused as a conflict`, msg.includes("z belongs to"), msg);
  await page.evaluate(() => { document.querySelector('[data-setrow="list-up"]')?.scrollIntoView({ block: "center" }); });
  await page.waitForTimeout(60);
  await page.screenshot({ path: `${output}/${theme}-400-settings.png` });
  await press(page, "Escape");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`400 (${theme}): no sideways scroll`, overflow <= 1, `${overflow}px`);
  await page.close();
}

// The login screen takes every key as text: no palette.
{
  const data = seed();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await routable(data.app, page, data);
  await page.evaluate(() => { localStorage.removeItem("fleet-human-token"); location.hash = ""; });
  await page.goto("http://fleet.test/");
  await page.locator("#login").waitFor({ state: "visible" });
  await press(page, ":");
  await page.keyboard.press("Control+k");
  eq("login screen: neither opener nor Ctrl+K opens the palette", await page.locator("#palette").count(), 0);
  await page.close();
}

await browser.close();
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? "  — " + c.detail : ""}`);
}
console.log(`\n${checks.length} checks, ${failed} failed. Screenshots in ${output}`);
process.exit(failed ? 1 : 0);
