// bun scripts/verify-keyboard.ts [output-directory]
// Drives the real page with real key presses. Routes Chromium requests straight to Hono: no HTTP listener or preview server.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/keyboard");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); };
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

type Seeded = { app: any; hub: any; store: any; agentNames: string[] };

function seed() {
  const { app, hub, store } = createApp(":memory:", "preview-only");
  const names: string[] = [];
  for (const name of ["alpha", "beta"]) {
    const created = store.addAgent({ name, owner: "owner", device: "test", skills: [] });
    const agent = store.agentById(created.id)!;
    names.push(name);
    hub.askHuman(agent, { kind: "decision", text: `Should ${name} ship the parser change today?` });
  }
  const a = store.agentById(store.listAgents().find((x: any) => x.name === "alpha")!.id)!;
  hub.humanCreateTask({ title: "Tighten the parser tests", project: "demo", description: "Add cases for sequences.", acceptance: "Tests pass." });
  hub.humanCreateTask({ title: "Document the keymap", project: "demo" });
  store.addWorkspace("acme");
  return { app, hub, store, agentNames: names } as Seeded;
}

async function routable(app: any, page: any, seedData: Seeded) {
  page.on("pageerror", (e: Error) => check("no page error", false, e.message));
  await page.addInitScript(() => localStorage.setItem("fleet-tour-done", "1"));
  await page.route("**/*", async (route: any) => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === "/api/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": preview\n\n" });
    const response = await seedData.app.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }));
    const body = await response.text();
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  });
  await page.goto("http://fleet.test/?token=preview-only#/inbox");
  await page.locator("#reqBox .card.req").first().waitFor();
  await page.locator("#login").waitFor({ state: "hidden" });
}

const sel = (page: any) => page.evaluate(() => {
  const row = document.querySelector("#reqBox .row-sel, #taskList .row-sel, #devList .row-sel");
  return row ? row.getAttribute("data-sel") : null;
});
const hash = (page: any) => page.evaluate(() => location.hash);
const activeTag = (page: any) => page.evaluate(() => (document.activeElement && document.activeElement.tagName) || "");
const selectedCount = (page: any) => page.locator(".row-sel").count();

async function press(page: any, key: string) { await page.keyboard.press(key); await page.waitForTimeout(40); }

for (const theme of ["light", "dark"]) {
  const data = seed();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: theme, reducedMotion: "reduce" });
  await routable(data.app, page, data);

  // j / k / G / gg and the visible highlight
  await press(page, "j");
  const first = await sel(page);
  check("j selects the first Needs-you card", !!first && first.startsWith("req:"), String(first));
  eq("one row is highlighted", await selectedCount(page), 1);
  await press(page, "j");
  const second = await sel(page);
  check("a second j moves to the next card", second !== first, `${first} -> ${second}`);
  await press(page, "k");
  eq("k moves back", await sel(page), first);
  await press(page, "G");
  check("G selects the last card", (await sel(page)) !== first, String(await sel(page)));
  await press(page, "g"); await press(page, "g");
  eq("gg returns to the first card", await sel(page), first);

  // Enter opens the selected card at its answer box; Esc returns to Normal
  await press(page, "Enter");
  eq("Enter focuses the answer box", await activeTag(page), "TEXTAREA");
  await press(page, "Escape");
  check("Esc leaves the field", (await activeTag(page)) !== "TEXTAREA", await activeTag(page));
  eq("the selection survives Esc", await sel(page), first);
  await press(page, "a");
  eq("a focuses the selected card's answer box", await activeTag(page), "TEXTAREA");
  await press(page, "Escape");

  // ? opens the cheat-sheet, listing every binding; Esc closes it
  await press(page, "?");
  check("? opens the key list", await page.locator("#keysheet").isVisible());
  const kbds = await page.locator("#keysheet kbd").count();
  check("the key list shows the whole keymap", kbds >= 25, `${kbds} keys`);
  await press(page, "Escape");
  eq("Esc closes the key list", await page.locator("#keysheet").count(), 0);

  // the pending-sequence hint appears, then times out
  await press(page, "g");
  check("the hint footer shows the pending sequence", await page.locator("#keyhint").isVisible());
  eq("the hint reads g …", (await page.locator("#keyhint").textContent())?.trim(), "g …");
  await page.waitForTimeout(1150);
  eq("the hint clears after one second", await page.locator("#keyhint").isVisible(), false);

  // a stale g does not swallow the next key: g, wait, n does nothing
  const before = await hash(page);
  await press(page, "g");
  await page.waitForTimeout(1150);
  await press(page, "n");
  eq("a timed-out g sequence runs nothing", await hash(page), before);

  // tabs
  for (const [key, want] of [["g r", "#/room"], ["g t", "#/tasks"], ["g m", "#/team"], ["g d", "#/devices"], ["g u", "#/usage"], ["g a", "#/access"], ["g c", "#/code"], ["g n", "#/inbox"]]) {
    for (const part of key.split(" ")) await press(page, part);
    eq(`"${key}" goes to ${want}`, await hash(page), want);
  }

  // workspaces
  await press(page, "]");
  const afterRight = await page.evaluate(() => (document.getElementById("wsSelect") as HTMLSelectElement).value);
  check("] switches workspace", afterRight !== "default", afterRight);
  await press(page, "[");
  eq("[ switches back", await page.evaluate(() => (document.getElementById("wsSelect") as HTMLSelectElement).value), "default");

  // J / K move through agent conversations
  await press(page, "J");
  eq("J opens the first agent's DM", await hash(page), "#/dm/alpha");
  await press(page, "J");
  eq("J moves to the next agent", await hash(page), "#/dm/beta");
  await press(page, "K");
  eq("K moves back", await hash(page), "#/dm/alpha");

  // i focuses the composer in a conversation; typing there is text, not navigation
  await press(page, "i");
  eq("i focuses the composer", await activeTag(page), "TEXTAREA");
  await page.keyboard.type("jkg");
  eq("typing j/k/g in the composer types them", await page.evaluate(() => (document.getElementById("compose") as HTMLTextAreaElement).value), "jkg");
  await press(page, "Escape");
  check("Esc leaves the composer", (await activeTag(page)) !== "TEXTAREA", await activeTag(page));

  // Ctrl+J is the browser's, not ours
  await page.keyboard.press("Control+j");
  eq("Ctrl+J is ignored", await hash(page), "#/dm/alpha");

  // Enter on a task row opens the task; Esc goes back
  await press(page, "g"); await press(page, "t");
  await press(page, "j");
  const task = await sel(page);
  check("j selects a task row", !!task && task.startsWith("task:"), String(task));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(60);
  check("Enter opens the selected task", (await hash(page)).startsWith("#/task/"), await hash(page));
  await press(page, "Escape");
  await page.waitForTimeout(60);
  eq("Esc returns to the task list", await hash(page), "#/tasks");

  // selection survives a live re-render
  await press(page, "j");
  const kept = await sel(page);
  await page.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
  await page.waitForTimeout(60);
  eq("the selection survives a re-render", await sel(page), kept);

  // typing in a form field never navigates
  await page.locator("#nt-title").click();
  await page.keyboard.type("jjj");
  eq("typing j in the new-task title is text", await page.evaluate(() => (document.getElementById("nt-title") as HTMLInputElement).value), "jjj");
  eq("and the list selection did not move", await sel(page), kept);
  await press(page, "Escape");

  // d runs Discuss on the selected Needs-you card (AGEN-18): it opens that agent's DM thread.
  await press(page, "g"); await press(page, "n");
  await press(page, "j");
  await press(page, "d");
  check("d opens the Discuss thread for the selected request", (await hash(page)).startsWith("#/dm/"), await hash(page));
  await press(page, "Escape"); // Discuss focuses the composer (Insert mode); Esc returns to Normal
  await press(page, "?");
  eq("the cheat-sheet has the Discuss row", await page.locator("#keysheet", { hasText: "Discuss this request" }).count(), 1);
  await press(page, "Escape");
  await press(page, "g"); await press(page, "n");

  // screenshots: highlight, hint mid-sequence, key list
  const shot = async (name: string) => page.screenshot({ path: `${output}/${theme}-1440-${name}.png`, fullPage: false });
  await press(page, "g"); await press(page, "n"); await press(page, "j");
  await shot("select");
  await press(page, "g");
  await shot("hint");
  await page.waitForTimeout(1100);
  await press(page, "?");
  await shot("keysheet");
  await press(page, "Escape");

  check("no sideways scroll at 1440", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), String(await page.evaluate(() => document.documentElement.scrollWidth)));
  await page.close();
}

// Phone width: the same keys must work, nothing may scroll sideways, and the three previews are captured.
for (const theme of ["light", "dark"]) {
  const data = seed();
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, colorScheme: theme, reducedMotion: "reduce" });
  await routable(data.app, page, data);
  await press(page, "j");
  check(`${theme} 400: j selects a card`, !!(await sel(page)));
  await press(page, "g"); await press(page, "g");
  check(`${theme} 400: gg keeps the first card`, !!(await sel(page)));
  await press(page, "g"); await press(page, "n");
  await press(page, "g"); await press(page, "t");
  eq(`${theme} 400: g t reaches Tasks`, await hash(page), "#/tasks");
  await press(page, "g"); await press(page, "n");
  await press(page, "j");
  await page.screenshot({ path: `${output}/${theme}-400-select.png` });
  await press(page, "g");
  await page.screenshot({ path: `${output}/${theme}-400-hint.png` });
  await page.waitForTimeout(1100);
  await press(page, "?");
  await page.screenshot({ path: `${output}/${theme}-400-keysheet.png` });
  await press(page, "Escape");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${theme} 400: no sideways scroll`, overflow <= 1, `${overflow}px`);
  await page.close();
}

// The login screen takes every key as text: no selection, no hint, no navigation.
{
  const data = seed();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await routable(data.app, page, data);
  await page.evaluate(() => { localStorage.clear(); location.hash = ""; });
  await page.goto("http://fleet.test/");
  await page.locator("#login").waitFor({ state: "visible" });
  await press(page, "j");
  await press(page, "g");
  eq("login screen: j changes nothing", await page.evaluate(() => document.querySelectorAll(".row-sel").length), 0);
  eq("login screen: no hint footer", await page.evaluate(() => (document.getElementById("keyhint") as HTMLElement).hidden), true);
  eq("login screen: g does not navigate", await page.evaluate(() => location.hash), "");
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
