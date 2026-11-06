// bun scripts/verify-onboarding.ts [output-directory]
// Drives the 3-step first-run guided setup, live ticking, dismiss/restore, and optional concept tour.
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

      // 1. Fresh hub: no overlay by default, 3-step setup card is immediately visible on Needs you
      await page.goto("http://fleet.test/?token=preview-only#/inbox");
      await page.locator("#setup-checklist").waitFor({ state: "visible" });
      check(`[${theme}-${width}] no automatic overlay on fresh hub`, !(await page.locator("#tour").isVisible()));
      check(`[${theme}-${width}] 3-step checklist visible on fresh hub`, await page.locator("#setup-checklist").isVisible());

      // Progress initially 0 of 3
      const initialProgress = await page.locator(".checklist-progress").innerText();
      check(`[${theme}-${width}] initial progress 0 of 3`, initialProgress.toLowerCase().includes("0 of 3"), `got: "${initialProgress}"`);

      // Step 1 highlighted
      const step1Active = await page.locator('.checklist-item[data-checklist-id="device"]').getAttribute("class");
      check(`[${theme}-${width}] step 1 highlighted`, step1Active?.includes("active") ?? false);

      // Inline curl command with copy button
      const hasCurlCmd = await page.locator('.checklist-item[data-checklist-id="device"] code').innerText();
      check(`[${theme}-${width}] inline install command`, hasCurlCmd.includes("install.sh | sh"), `got: "${hasCurlCmd}"`);

      // Screenshot 1: the fresh hub with the 3-step card
      await checkNoScroll(page, `${theme}-${width}-fresh-hub`);
      await page.screenshot({ path: `${output}/${theme}-${width}-fresh-hub-3steps.png` });

      // 2. Step 1 done (device added) and Step 2 highlighted
      store.addDevice("macbook");
      await triggerRefresh(page);
      await page.waitForTimeout(60);

      const prog1 = await page.locator(".checklist-progress").innerText();
      check(`[${theme}-${width}] progress 1 of 3 after device`, prog1.toLowerCase().includes("1 of 3"), `got: "${prog1}"`);

      const step1Done = await page.locator('.checklist-item[data-checklist-id="device"]').getAttribute("class");
      check(`[${theme}-${width}] step 1 marked done`, step1Done?.includes("done") ?? false);

      const step2Active = await page.locator('.checklist-item[data-checklist-id="agent"]').getAttribute("class");
      check(`[${theme}-${width}] step 2 highlighted after device`, step2Active?.includes("active") ?? false);

      // Screenshot 2: step 1 done and step 2 highlighted
      await checkNoScroll(page, `${theme}-${width}-step1done`);
      await page.screenshot({ path: `${output}/${theme}-${width}-step1done-step2highlighted.png` });

      // 3. Step 2 done (agent started) and Step 3 highlighted
      store.addAgent({ name: "claude-1", owner: "owner", device: "macbook", skills: [] });
      await triggerRefresh(page);
      await page.waitForTimeout(60);

      const prog2 = await page.locator(".checklist-progress").innerText();
      check(`[${theme}-${width}] progress 2 of 3 after agent`, prog2.toLowerCase().includes("2 of 3"), `got: "${prog2}"`);

      const step2Done = await page.locator('.checklist-item[data-checklist-id="agent"]').getAttribute("class");
      check(`[${theme}-${width}] step 2 marked done`, step2Done?.includes("done") ?? false);

      const step3Active = await page.locator('.checklist-item[data-checklist-id="task"]').getAttribute("class");
      check(`[${theme}-${width}] step 3 highlighted after agent`, step3Active?.includes("active") ?? false);

      // 4. Step 3 done (task created) -> all done, card disappears, NO automatic overlay
      hub.humanCreateTask({ title: "Add health check endpoint", project: "default" });
      await triggerRefresh(page);
      await page.waitForTimeout(60);

      check(`[${theme}-${width}] checklist card gone after completion`, !(await page.locator("#setup-checklist").isVisible()));
      check(`[${theme}-${width}] no automatic overlay after completion`, !(await page.locator("#tour").isVisible()));

      // Screenshot 3: all done (card gone)
      await checkNoScroll(page, `${theme}-${width}-all-done`);
      await page.screenshot({ path: `${output}/${theme}-${width}-all-done-card-gone.png` });

      // 5. Reopen optional concept tour: Settings -> "How does this work?"
      await page.goto("http://fleet.test/?token=preview-only#/settings");
      await page.locator("#reopen-tour-btn").waitFor({ state: "visible" });
      await page.locator("#reopen-tour-btn").click();
      await page.locator("#tour").waitFor({ state: "visible" });
      check(`[${theme}-${width}] optional concept tour opened from Settings`, await page.locator("#tour").isVisible());
      eq(`[${theme}-${width}] tour slide 1 title`, await page.locator("#tour-title").innerText(), "The Hub & Workspaces");

      // Screenshot 4: the optional 'How does this work?' view
      await checkNoScroll(page, `${theme}-${width}-how-it-works`);
      await page.screenshot({ path: `${output}/${theme}-${width}-how-it-works-tour.png` });

      // Advance slides using ArrowRight and test last slide button
      await press(page, "ArrowRight"); // Slide 2
      eq(`[${theme}-${width}] tour slide 2 title`, await page.locator("#tour-title").innerText(), "Devices & Local Code");

      await press(page, "ArrowRight"); // Slide 3
      eq(`[${theme}-${width}] tour slide 3 title`, await page.locator("#tour-title").innerText(), "Agents, Tasks & Needs You");

      // Close tour via checklist button on last slide
      await page.locator("#tour-checklist-btn").click();
      await page.locator("#tour").waitFor({ state: "hidden" });
      check(`[${theme}-${width}] tour closed via action button`, !(await page.locator("#tour").isVisible()));

      // 6. Test reopening via ':' command palette (:tour)
      await press(page, ":");
      await page.locator("#palette").waitFor({ state: "visible" });
      await page.keyboard.type("tour");
      await page.waitForTimeout(60);
      await press(page, "Enter");
      await page.locator("#tour").waitFor({ state: "visible" });
      check(`[${theme}-${width}] tour reopened via :tour palette command`, await page.locator("#tour").isVisible());
      await press(page, "Escape");
      await page.locator("#tour").waitFor({ state: "hidden" });

      // 7. Test Dismiss & Restore on a fresh hub
      const { app: freshApp, store: freshStore } = createApp(":memory:", "preview-only");
      const testPage = await setupPage(freshApp, theme, width);
      await testPage.goto("http://fleet.test/?token=preview-only#/inbox");
      await testPage.locator("#setup-checklist").waitFor({ state: "visible" });

      // Click "How does this work?" on the card
      await testPage.locator("#checklist-tour-btn").click();
      await testPage.locator("#tour").waitFor({ state: "visible" });
      check(`[${theme}-${width}] tour opened via card 'How does this work?' button`, await testPage.locator("#tour").isVisible());
      await press(testPage, "Escape");
      await testPage.locator("#tour").waitFor({ state: "hidden" });

      // Dismiss checklist
      await testPage.locator("#checklist-dismiss-btn").click();
      check(`[${theme}-${width}] checklist hidden on dismiss`, !(await testPage.locator("#setup-checklist").isVisible()));

      // Restore checklist from Settings
      await testPage.goto("http://fleet.test/?token=preview-only#/settings");
      await testPage.locator("#reset-checklist-btn").waitFor({ state: "visible" });
      await testPage.locator("#reset-checklist-btn").click();

      // Back to inbox -> checklist is visible again
      await testPage.goto("http://fleet.test/?token=preview-only#/inbox");
      await testPage.locator("#setup-checklist").waitFor({ state: "visible" });
      check(`[${theme}-${width}] checklist restored from settings`, await testPage.locator("#setup-checklist").isVisible());

      // 8. Empty states across tabs point at 3-step setup when fresh
      // (a) Needs you empty state
      const noreq = testPage.locator("#noreq");
      check(`[${theme}-${width}] Needs you empty state visible`, await noreq.isVisible());
      check(`[${theme}-${width}] Needs you empty title`, (await noreq.locator(".empty-title").innerText()).includes("Nothing is waiting"));

      // (b) Room empty state
      await testPage.goto("http://fleet.test/?token=preview-only#/room");
      const roomEmpty = testPage.locator("#thread-msgs .empty");
      await roomEmpty.waitFor({ state: "visible" });
      check(`[${theme}-${width}] Room empty title`, (await roomEmpty.locator(".empty-title").innerText()).includes("No messages in the room"));
      check(`[${theme}-${width}] Room empty desc points at setup`, (await roomEmpty.locator(".empty-desc").innerText()).includes("3-step setup"));

      // (c) Tasks empty state
      await testPage.goto("http://fleet.test/?token=preview-only#/tasks");
      const tasksEmpty = testPage.locator("#taskList .empty");
      await tasksEmpty.waitFor({ state: "visible" });
      check(`[${theme}-${width}] Tasks empty title`, (await tasksEmpty.locator(".empty-title").innerText()).includes("No tasks here"));
      check(`[${theme}-${width}] Tasks empty desc points at setup`, (await tasksEmpty.locator(".empty-desc").innerText()).includes("3-step setup"));

      await testPage.close();
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
