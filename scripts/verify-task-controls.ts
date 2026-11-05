// bun scripts/verify-task-controls.ts [output-directory]
// All browser HTTP requests are routed into Hono in-process. No listener or preview server.
import { createRequire } from "node:module";
import { mkdirSync, rmSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/task-controls"); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const checks: unknown[] = [];
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
try {
 for (const theme of ["light", "dark"]) for (const width of [1440, 400]) {
  const { app, hub, store } = createApp(":memory:", "preview-only", { hubOwner: "owner" });
  const mk = (name: string) => store.agentById(store.addAgent({ name, owner: "owner", device: "fixture", skills: [] }).id)!;
  const a = mk("worker"), b = mk("other");
  const t = hub.humanCreateTask({ title: "Prepare the release checklist", project: "demo", description: "Review the requirements and collect the release evidence.", acceptance: "The checklist is reviewed and the release is ready." });
  const ws = hub.createWorkspace("Private workspace");
  const foreign = hub.humanCreateTask({ title: "Foreign backlog task", project: "foreign", workspaceId: ws.id }); hub.humanStatus(foreign.id, "backlog");
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce", ...(theme === "light" && width === 1440 ? { recordVideo: { dir: output, size: { width: 1440, height: 1000 } } } : {}) });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  let refuseStatus = false, refuseDelete = false;
  await page.route("**/*", async (route: any) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === "/api/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": preview\n\n" });
    if ((path.endsWith("/status") && refuseStatus) || (req.method() === "DELETE" && refuseDelete)) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Fixture refusal: task changed; retry" }) });
    const res = await app.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }));
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  const overflow = async () => check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), `sideways scroll at ${theme}/${width}`);
  const save = async (status: string, note: string) => {
    await page.locator("#task-status").selectOption(status); await page.locator("#task-status-note").fill(note); await page.locator("#task-status-save").click();
    await page.waitForFunction(({ id, status }: { id: string; status: string }) => [...document.querySelectorAll("#v-task .facts .pill")].some((x) => x.textContent === status.replace("_", " ")), { id: t.id, status });
    check(store.getTask(t.id)?.status === status, "server status did not change");
  };
  try {
    // Create directly in Backlog: the checkbox is the only extra step, the row is never open, and the filter lands on it.
    await page.goto("http://fleet.test/?token=preview-only#/tasks"); await page.locator("#nt-title").waitFor();
    await page.locator("#nt-title").fill("Private pricing draft");
    await page.locator("#nt-backlog").check();
    check(await page.locator("#nt-assignee").isDisabled(), "assignee is not disabled for a backlog task");
    await overflow(); await page.screenshot({ path: `${output}/${theme}-${width}-backlog-form.png`, fullPage: true });
    await page.locator("#nt-add").click();
    await page.waitForFunction(() => document.querySelector("#chips button.active")?.textContent?.trim() === "backlog");
    await page.waitForFunction(() => document.querySelector("#taskList")?.textContent?.includes("Private pricing draft"));
    const made = store.listTasks("demo").find((x) => x.title === "Private pricing draft")!;
    check(!!made && made.status === "backlog" && made.seq === null, "created task was not backlog from the first write");
    check(hub.listTasksFor(a).every((x) => x.id !== made.id), "the new backlog task is visible to an agent");
    check(hub.pull(a).items.every((i: any) => i.type !== "task" || i.task.id !== made.id), "the new backlog task woke an agent");
    await overflow(); await page.screenshot({ path: `${output}/${theme}-${width}-backlog-created.png`, fullPage: true });

    await page.goto("http://fleet.test/?token=preview-only#/task/" + t.key); await page.locator("#task-status").waitFor();
    // Every status is available; blank optional note and human override of completion are valid.
    for (const status of ["claimed", "in_progress", "blocked", "done", "open"]) await save(status, "Reviewing " + status);
    await page.locator("#task-status").selectOption("blocked"); await page.locator("#task-status-note").fill("Waiting for the release window.");
    // Simulate the page's live re-render path while note is being edited.
    await page.locator("#task-status-note").focus(); await page.evaluate(() => { const n = document.getElementById("task-status-note") as HTMLTextAreaElement; n.setSelectionRange(4, 11); document.dispatchEvent(new Event("visibilitychange")); });
    check(await page.locator("#task-status-note").inputValue() === "Waiting for the release window.", "live update erased status note");
    check(await page.locator("#task-status").inputValue() === "blocked", "live update erased status selection");
    check(await page.locator("#task-status-note").evaluate((n: HTMLTextAreaElement) => document.activeElement === n && n.selectionStart === 4 && n.selectionEnd === 11), "live update lost focus/caret");
    await overflow(); await page.screenshot({ path: `${output}/${theme}-${width}-status.png`, fullPage: true });
    refuseStatus = true; await page.locator("#task-status-save").click(); await page.locator("#error-toast:not([hidden])").waitFor();
    check(await page.locator("#task-status-note").inputValue() === "Waiting for the release window.", "refusal erased draft");
    refuseStatus = false; await page.getByRole("button", { name: "Dismiss error" }).click();
    await save("backlog", "Keep this idea private until it is scheduled.");
    check(hub.listTasksFor(a).every((x) => x.id !== t.id) && hub.pull(a).items.every((x: any) => x.type !== "task" || x.task.id !== t.id), "backlog leaked to agent");
    await page.getByRole("button", { name: "← Tasks", exact: true }).click(); await page.locator("#chips").getByRole("button", { name: "backlog", exact: true }).click();
    check(await page.locator("#taskList").innerText().then((s: string) => s.includes(t.title) && !s.includes(foreign.title) && !s.includes(foreign.key)), "Backlog list leaks workspace data");
    await overflow(); await page.screenshot({ path: `${output}/${theme}-${width}-backlog.png`, fullPage: true });
    await page.locator(`[data-sel="task:${t.id}"]`).click(); await page.locator("#v-task").getByLabel("Assign to", { exact: true }).selectOption("worker");
    await page.waitForFunction(() => document.querySelector("#task-status")?.getAttribute("disabled") === null && [...document.querySelectorAll("#v-task .facts .pill")].some((n) => n.textContent === "open"));
    check(store.getTask(t.id)?.status === "open", "assignment did not explicitly open backlog");
    check(hub.listTasksFor(a).some((x) => x.id === t.id) && !hub.listTasksFor(b).some((x) => x.id === t.id), "assignment privacy wrong");
    await page.locator("#task-delete").click();
    check(await page.locator("#task-delete-confirm").isDisabled(), "delete is not two-step");
    await page.locator("#task-delete-key").fill("WRONG"); check(await page.locator("#task-delete-confirm").isDisabled(), "wrong key allows delete");
    await page.getByRole("button", { name: "Cancel deletion" }).click(); check(await page.locator("#task-delete-panel").isHidden() && !!store.getTask(t.id), "cancel deleted task");
    await page.locator("#task-delete").click(); await page.locator("#task-delete-key").fill(t.key);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    check(await page.locator("#task-delete-key").inputValue() === t.key && await page.locator("#task-delete-panel").isVisible(), "delete confirmation lost on render");
    await page.locator("#task-delete-panel").scrollIntoViewIfNeeded(); await overflow();
    await page.screenshot({ path: `${output}/${theme}-${width}-delete.png`, fullPage: true });
    refuseDelete = true; await page.locator("#task-delete-confirm").click(); await page.locator("#error-toast:not([hidden])").waitFor(); check(!!store.getTask(t.id), "refused delete removed task");
    refuseDelete = false; await page.getByRole("button", { name: "Dismiss error" }).click(); await page.locator("#task-delete-confirm").click(); await page.waitForURL("**/#/tasks");
    check(!store.getTask(t.id) && store.deletedTasks().some((x) => x.taskId === t.id && x.actor === "human"), "task/audit deletion wrong");
    check(!await page.locator("#taskList").innerText().then((s: string) => s.includes(foreign.title)), "deleted audit leaked another workspace");
    check(errors.length === 0, errors.join("\n"));
    checks.push({ theme, width, allStatuses: "pass", optionalNote: "pass", humanCompletionOverride: "pass", draftFocusCaretAcrossRender: "pass", statusRefusalRetry: "pass", backlogInvisibleToAgents: "pass", workspaceScoping: "pass", privateAssignment: "pass", deleteTwoStepCancelWrongKey: "pass", confirmSurvivesRender: "pass", deleteRefusalRetry: "pass", deletedAudit: "pass", backlogCreate: "pass", sidewaysScroll: false, pageErrors: errors });
  } finally { const video = page.video(); await page.close(); if (video) renameSync(await video.path(), `${output}/task-controls-demo.webm`); store.db.close(); rmSync(hub.dataDir, { recursive: true, force: true }); }
 }
} finally { await browser.close(); }
await Bun.write(`${output}/checks.json`, JSON.stringify(checks, null, 2)); console.log(JSON.stringify(checks, null, 2));
