// bun scripts/verify-onboarding.ts [output-directory]
// Drives the first-run welcome tour, setup checklist, and view empty states.
// Routes Chromium requests straight to Hono: no HTTP listener or preview server.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/onboarding");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); };
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

async function setupPage(app: any, theme: "light" | "dark", width: number) {
  const page = await browser.newPage({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" });
  page.on("pageerror", (e: Error) => check("no page error", false, e.message));

  await page.addInitScript(() => {
    (window as any).EventSource = class extends EventTarget {
      constructor() { super(); (window as any).__fleetEvents = this; }
      close() {}
    };
  });

  await page.route("**/*", async (route: any) => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === "/api/events") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": preview\n\n" });
    }
    const response = await app.fetch(new Request(req.url(), {
      method: req.method(),
      headers: req.headers(),
      body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer()
    }));
    const body = await response.text();
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  });

  return page;
}

const triggerRefresh = async (page: any) => {
  const response = page.waitForResponse((r: any) => r.url().endsWith("/api/state"));
  await page.evaluate(() => (window as any).__fleetEvents.dispatchEvent(new Event("change")));
  await response;
};

async function press(page: any, key: string) {
  await page.keyboard.press(key);
  await page.waitForTimeout(40);
}

const checkNoScroll = async (page: any, label: string) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`no sideways scroll: ${label}`, overflow <= 1, `${overflow}px`);
};

try {
  // Matrix: light & dark at 1440 and 400
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 400] as const) {
      const { app, hub, store } = createApp(":memory:", "preview-only");
      const page = await setupPage(app, theme, width);

      // 1. First visit on a fresh empty hub: tour opens automatically
      await page.goto("http://fleet.test/?token=preview-only#/inbox");
      await page.locator("#tour").waitFor({ state: "visible" });
      check(`[${theme}-${width}] tour opens automatically on empty hub`, await page.locator("#tour").isVisible());

      // Tour Step 1 check & screenshot
      const step1Title = await page.locator("#tour-title").innerText();
      eq(`[${theme}-${width}] tour step 1 title`, step1Title, "The Hub & Workspaces");
      await checkNoScroll(page, `${theme}-${width}-tour-step1`);
      await page.screenshot({ path: `${output}/${theme}-${width}-tour-step1.png` });

      // ArrowRight to Step 2
      await press(page, "ArrowRight");
      const step2Title = await page.locator("#tour-title").innerText();
      eq(`[${theme}-${width}] tour step 2 title`, step2Title, "Autonomous Agents");

      // ArrowRight to Step 3 (middle step) & screenshot
      await press(page, "ArrowRight");
      const step3Title = await page.locator("#tour-title").innerText();
      eq(`[${theme}-${width}] tour step 3 title`, step3Title, "Devices & Local Code");
      await checkNoScroll(page, `${theme}-${width}-tour-middle`);
      await page.screenshot({ path: `${output}/${theme}-${width}-tour-middle.png` });

      // ArrowLeft goes back to Step 2
      await press(page, "ArrowLeft");
      eq(`[${theme}-${width}] tour arrow left returns to step 2`, await page.locator("#tour-title").innerText(), "Autonomous Agents");

      // Advance to step 5
      await press(page, "ArrowRight"); // step 3
      await press(page, "ArrowRight"); // step 4
      await press(page, "ArrowRight"); // step 5
      const step5Title = await page.locator("#tour-title").innerText();
      eq(`[${theme}-${width}] tour step 5 title`, step5Title, "Setup Checklist");

      // Click "Open setup checklist" on step 5
      await page.locator("#tour-checklist-btn").click();
      await page.locator("#tour").waitFor({ state: "hidden" });
      check(`[${theme}-${width}] tour closed via checklist button`, !(await page.locator("#tour").isVisible()));

      // 2. Setup checklist is now visible on Needs you
      await page.locator("#setup-checklist").waitFor({ state: "visible" });
      check(`[${theme}-${width}] checklist visible on Needs you`, await page.locator("#setup-checklist").isVisible());

      // Check checklist state: initially 1 of 4 (hub reachable)
      const initialProgress = await page.locator(".checklist-progress").innerText();
      check(`[${theme}-${width}] initial checklist progress 1 of 4`, initialProgress.toLowerCase().includes("1 of 4"), `got: "${initialProgress}"`);

      // Enroll a device and simulate state update
      store.addDevice("macbook");
      await triggerRefresh(page);
      await page.waitForTimeout(60);

      // Now 2 of 4 complete
      const prog2 = await page.locator(".checklist-progress").innerText();
      check(`[${theme}-${width}] checklist progress 2 of 4 after device`, prog2.toLowerCase().includes("2 of 4"), `got: "${prog2}"`);
      await checkNoScroll(page, `${theme}-${width}-checklist`);
      await page.screenshot({ path: `${output}/${theme}-${width}-checklist.png` });

      // 3. Three empty states: Needs you, Room, Tasks
      // (a) Needs you empty state
      const noreq = page.locator("#noreq");
      check(`[${theme}-${width}] Needs you empty state visible`, await noreq.isVisible());
      check(`[${theme}-${width}] Needs you empty title`, (await noreq.locator(".empty-title").innerText()).includes("Nothing is waiting"));
      await checkNoScroll(page, `${theme}-${width}-empty-needsyou`);
      await page.screenshot({ path: `${output}/${theme}-${width}-empty-needsyou.png` });

      // (b) Room empty state
      await page.goto("http://fleet.test/?token=preview-only#/room");
      const roomEmpty = page.locator("#thread-msgs .empty");
      await roomEmpty.waitFor({ state: "visible" });
      check(`[${theme}-${width}] Room empty title`, (await roomEmpty.locator(".empty-title").innerText()).includes("No messages in the room"));
      await checkNoScroll(page, `${theme}-${width}-empty-room`);
      await page.screenshot({ path: `${output}/${theme}-${width}-empty-room.png` });

      // (c) Tasks empty state
      await page.goto("http://fleet.test/?token=preview-only#/tasks");
      const tasksEmpty = page.locator("#taskList .empty");
      await tasksEmpty.waitFor({ state: "visible" });
      check(`[${theme}-${width}] Tasks empty title`, (await tasksEmpty.locator(".empty-title").innerText()).includes("No tasks here"));
      await checkNoScroll(page, `${theme}-${width}-empty-tasks`);
      await page.screenshot({ path: `${output}/${theme}-${width}-empty-tasks.png` });

      // 4. Test reopening the tour
      // Reopen via Settings
      await page.goto("http://fleet.test/?token=preview-only#/settings");
      await page.locator("#reopen-tour-btn").waitFor({ state: "visible" });
      await page.locator("#reopen-tour-btn").click();
      await page.locator("#tour").waitFor({ state: "visible" });
      check(`[${theme}-${width}] tour reopened from Settings`, await page.locator("#tour").isVisible());
      await press(page, "Escape");
      await page.locator("#tour").waitFor({ state: "hidden" });

      // Reopen via '?' cheat-sheet
      await press(page, "?");
      await page.locator("#keysheet").waitFor({ state: "visible" });
      await page.locator("#keysheet-tour").click();
      await page.locator("#tour").waitFor({ state: "visible" });
      check(`[${theme}-${width}] tour reopened from keysheet`, await page.locator("#tour").isVisible());
      await press(page, "Escape");
      await page.locator("#tour").waitFor({ state: "hidden" });

      // Reopen via ':' command palette
      await press(page, ":");
      await page.locator("#palette").waitFor({ state: "visible" });
      await page.keyboard.type("tour");
      await page.waitForTimeout(60);
      await press(page, "Enter");
      await page.locator("#tour").waitFor({ state: "visible" });
      check(`[${theme}-${width}] tour reopened via :tour palette command`, await page.locator("#tour").isVisible());
      await press(page, "Escape");
      await page.locator("#tour").waitFor({ state: "hidden" });

      await page.close();
    }
  }
} finally {
  await browser.close();
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? "  — " + c.detail : ""}`);
}
console.log(`\n${checks.length} checks, ${failed} failed. Screenshots in ${output}`);
process.exit(failed ? 1 : 0);
