// bun scripts/verify-knowledge.ts [output-directory] — Chromium requests -> Hono, no listener.
import { createRequire } from "node:module";
import { mkdirSync, rmSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/knowledge"); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const checks: unknown[] = [];
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
try {
 for (const theme of ["light", "dark"]) for (const width of [1440, 400]) {
  const { app, hub, store } = createApp(":memory:", "preview-only", { hubOwner: "owner" });
  const added = store.addAgent({ name: "worker", owner: "owner", device: "fixture", skills: [] }); const agent = store.agentById(added.id)!;
  const task = hub.humanCreateTask({ title: "Document staging recovery", project: "demo" });
  hub.humanKnowledge("default", "create", undefined, { kind: "fact", title: "Release ownership", body: "The release coordinator owns the checklist.", verify: "Check the current release checklist", sources: [] });
  const proposed = hub.proposeKnowledge(agent, { kind: "how-to", title: "Restart the staging service", body: "Use the team's documented restart procedure, then check the health endpoint.", verify: "Run the staging health check", project: "demo", sources: [{ kind: "task", ref: task.key }] });
  const other = hub.createWorkspace("Other workspace");
  hub.humanKnowledge(other.id, "create", undefined, { kind: "fact", title: "Foreign private workspace note", body: "This must never appear in the selected workspace.", verify: "Check locally", sources: [] });
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce", ...(theme === "light" && width === 1440 ? { recordVideo: { dir: output, size: { width: 1440, height: 1000 } } } : {}) });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.route("**/*", async (route: any) => {
   const req = route.request(), path = new URL(req.url()).pathname;
   if (path === "/api/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture\n\n" });
   const res = await app.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }));
   await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  const filter = async (status: string) => { await page.locator(`[data-kb-filter="${status}"]`).click(); };
  const shot = async (name: string) => { check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), "sideways scroll"); await page.screenshot({ path: `${output}/${theme}-${width}-${name}.png`, fullPage: true }); };
  const expectStatus = async (text: string) => page.waitForFunction((wanted: string) => document.getElementById("kb-editor-status")?.textContent?.includes(wanted), text);
  try {
   await page.goto("http://fleet.test/?token=preview-only#/knowledge"); await page.locator(`[data-kb-id="${proposed.id}"]`).waitFor();
   check(!hub.searchKnowledge(agent, { query: "staging" }).entries.length, "proposal leaked before approval");
   check(!(await page.locator("#v-knowledge").innerText()).includes("Foreign private workspace note"), "workspace note leaked");
   check((await page.locator("#kb-framing").innerText()).includes("not instructions"), "missing fixed notes framing");
   await shot("proposed");
   await page.locator(`[data-kb-id="${proposed.id}"]`).click(); await page.locator("#kb-body").waitFor();
   check(await page.locator("#kb-sources").inputValue() === task.key, "approval did not show source");
   await page.locator("#kb-editor").scrollIntoViewIfNeeded(); await shot("review");
   const oldVersion = hub.knowledgeIndex(agent).version;
   await page.locator("#kb-approve").click(); await expectStatus("Approved");
   check(hub.knowledgeIndex(agent).version !== oldVersion, "approval did not refresh index hash");
   check(hub.knowledgeIndex(agent).block.includes("Restart the staging service"), "approved note missing from prompt index");
   await filter("approved"); check(await page.locator("#kb-list .kb-entry").count() === 2, "approved entries missing"); await shot("approved");
   await page.locator("#kb-body").fill("Use the updated staging restart procedure, then check the health endpoint twice.");
   await page.locator("#kb-body").focus(); await page.evaluate(() => { const n = document.getElementById("kb-body") as HTMLTextAreaElement; n.setSelectionRange(4, 12); document.dispatchEvent(new Event("visibilitychange")); });
   check(await page.locator("#kb-body").inputValue().then((s: string) => s.includes("updated staging")), "live render lost edit");
   check(await page.locator("#kb-body").evaluate((n: HTMLTextAreaElement) => document.activeElement === n && n.selectionStart === 4 && n.selectionEnd === 12), "live render lost focus/caret");
   await page.locator("#kb-editor").scrollIntoViewIfNeeded(); await shot("edit");
   const approvedVersion = hub.knowledgeIndex(agent).version; await page.locator("#kb-save").click(); await expectStatus("Saved"); check(hub.knowledgeIndex(agent).version !== approvedVersion, "edit did not refresh version");
   await page.locator("#kb-promote").click(); await expectStatus("Copied to global");
   const global = store.knowledgeList({ workspaceId: "default", actor: "human", human: true, allowed: true }).entries.find((e: any) => e.scope === "global"); check(global && global.id !== proposed.id, "promotion did not copy");
   const foreignAgent = store.agentById(store.addAgent({ name: "foreign", owner: "owner", device: "fixture", skills: [], workspaceId: other.id }).id)!;
   check(hub.getKnowledge(foreignAgent, global.id).scope === "global", "global note not visible across team workspaces");
   await page.locator("#kb-archive").click(); await expectStatus("Archived");
   let denied = false; try { hub.getKnowledge(agent, proposed.id); } catch { denied = true; } check(denied, "archive still readable by agent");
   await filter("archived"); check(await page.locator(`[data-kb-id="${proposed.id}"]`).count() === 1, "archived body/history disappeared");
   // Human-authored writes publish immediately; unsafe edits are refused and drafts remain.
   await page.locator("#kb-new").click(); await page.locator("#kb-title").fill("Human workflow note"); await page.locator("#kb-body").fill("Review the release notes before scheduling a deployment."); await page.locator("#kb-verify").fill("Read the release checklist");
   await page.locator("#kb-save").click(); await expectStatus("Saved");
   await page.locator("#kb-body").fill("password = this-is-a-test-secret"); await page.locator("#kb-save").click(); await expectStatus("secret");
   check(await page.locator("#kb-body").inputValue() === "password = this-is-a-test-secret", "refusal erased draft");
   await page.getByRole("button", { name: "Dismiss error" }).click();
   await page.getByRole("button", { name: "Close note", exact: true }).click();
   // Real keyboard and palette route reach the new tab from an unrelated view.
   await page.evaluate(() => { location.hash = "#/room"; }); await page.waitForTimeout(50); await page.locator("#title").click(); await page.keyboard.press("g"); await page.keyboard.press("k"); await page.waitForURL("**/#/knowledge");
   await page.keyboard.press(":"); await page.locator("#palette-input").fill(":knowledge"); await page.keyboard.press("Enter"); await page.waitForURL("**/#/knowledge");
   check(errors.length === 0, errors.join("\n"));
   checks.push({ theme, width, proposedPrivate: "pass", scopeIsolation: "pass", sourceReview: "pass", approveToIndex: "pass", editHashRefresh: "pass", editFocusCaretPersistence: "pass", globalCopy: "pass", archiveRetainsBody: "pass", humanApproved: "pass", secretRefusalKeepsDraft: "pass", keyboardAndPalette: "pass", sidewaysScroll: false, pageErrors: errors });
  } finally { const video = page.video(); await page.close(); if (video) renameSync(await video.path(), `${output}/knowledge-demo.webm`); store.db.close(); rmSync(hub.dataDir, { recursive: true, force: true }); }
 }
} finally { await browser.close(); }
await Bun.write(`${output}/checks.json`, JSON.stringify(checks, null, 2)); console.log(JSON.stringify(checks, null, 2));
