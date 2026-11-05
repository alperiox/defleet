// bun scripts/verify-attachments.ts [output-directory]
// Chromium -> Hono in-process; no server, port or listener.
import { createRequire } from "node:module";
import { mkdirSync, rmSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import { downloadArtifact, buildPrompt, type HelperConfig } from "../helper/fleet-helper";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/attachments"); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const pdf = Buffer.from("%PDF-1.4\nAttachment verification fixture\n%%EOF\n");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCVEAAAAASUVORK5CYII=", "base64");
const checks: unknown[] = [];
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
try {
 for (const theme of ["light", "dark"]) for (const width of [1440, 400]) {
  const { app, hub, store } = createApp(":memory:", "preview-only", { hubOwner: "owner", humanAttachmentMaxBytes: 1024 });
  const a = store.addAgent({ name: "worker", owner: "owner", device: "agent's own machine", skills: [] });
  const b = store.addAgent({ name: "other", owner: "owner", device: "other machine", skills: [] });
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce", ...(theme === "light" && width === 1440 ? { recordVideo: { dir: output, size: { width: 1440, height: 1000 } } } : {}) });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  let refuseSend = false, failUpload = false, holdUpload = false, releaseUpload: (() => void) | undefined;
  await page.route("**/*", async (route: any) => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === "/api/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": preview\n\n" });
    if (url.pathname === "/api/artifacts" && req.method() === "POST") {
      if (failUpload) return route.abort("failed");
      if (holdUpload) await new Promise<void>((resolve) => { releaseUpload = resolve; });
    }
    if (url.pathname === "/api/dm/worker" && refuseSend) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Fixture refusal: try again" }) });
    const response = await app.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() }));
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const ready = async (count: number) => {
    await page.waitForFunction((n: number) => document.querySelectorAll('#attachmentList [data-status="ready"]').length === n, count);
    check(!await page.locator("#sendBtn").isDisabled(), "send remains disabled after uploads");
  };
  try {
    await page.goto("http://fleet.test/?token=preview-only#/dm/worker"); await page.locator("#attachBtn").waitFor();
    // Real file input upload, including simultaneous PDF and PNG.
    holdUpload = true;
    await page.locator("#attachmentInput").setInputFiles({ name: "brief.pdf", mimeType: "application/pdf", buffer: pdf });
    await page.waitForFunction(() => document.querySelector('[data-status="uploading"]'));
    check(await page.locator("#sendBtn").isDisabled(), "send allowed during upload");
    // Unrelated state refresh must preserve pending file selection/upload.
    await page.evaluate(async () => { const t = localStorage.getItem("fleet-human-token"); await fetch("/api/agents/worker/role", { method: "POST", headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: JSON.stringify({ role: "Review attached material" }) }); });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    check(await page.locator('#attachmentList [data-status="uploading"]').count() === 1, "pending upload lost during re-render");
    holdUpload = false; while (!releaseUpload) await new Promise((r) => setTimeout(r, 10)); releaseUpload(); await ready(1);
    await page.locator("#attachmentInput").setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: png }); await ready(2);
    // Drag-and-drop and clipboard file paste use the same real upload endpoint.
    await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["Notes from the human"], "notes.txt", { type: "text/plain" })); document.getElementById("composer")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt })); }); await ready(3);
    await page.evaluate((bytes: number[]) => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" })); document.getElementById("compose")!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })); }, [...png]); await ready(4);
    // Remove deletes the unused upload, then re-add via the file picker.
    const notesId = store.artifactsFor().find((x) => x.name === "notes.txt")!.id;
    await page.getByRole("button", { name: "Remove notes.txt", exact: true }).click(); await ready(3);
    await page.waitForTimeout(60); check(!store.getArtifact(notesId), "removed chip leaked its upload");
    await page.locator("#attachmentInput").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Notes from the human") }); await ready(4);
    await page.locator("#compose").fill("Please read the attached brief and reference image. Tell me plainly if a format is unsupported.");
    // Switching threads cannot accidentally send worker's files to another agent.
    await page.evaluate(() => { location.hash = "#/dm/other"; }); await page.waitForTimeout(60);
    check(await page.locator("#attachmentList .attachment-chip").count() === 0, "files crossed thread boundary");
    await page.evaluate(() => { location.hash = "#/dm/worker"; }); await ready(4);
    check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), "composer sideways scroll");
    await page.screenshot({ path: `${output}/${theme}-${width}-composer.png`, fullPage: true });
    // A server refusal must keep draft files and allow retry.
    refuseSend = true; await page.locator("#sendBtn").click(); await page.locator("#error-toast:not([hidden])").waitFor(); await ready(4);
    refuseSend = false; await page.getByRole("button", { name: "Dismiss error" }).click(); await page.locator("#sendBtn").click();
    await page.waitForFunction(() => document.querySelectorAll("#v-thread .atts a").length === 4);
    check(await page.locator("#attachmentList .attachment-chip").count() === 0, "sent files left in composer");
    const pulled = hub.pull(store.agentById(a.id)!);
    const message = pulled.items.find((i: any) => i.type === "message") as any;
    check(message.message.attachments.length === 4, "agent wake is missing attachment metadata");
    const prompt = buildPrompt([message], { harness: "claude", workdir: output } as HelperConfig, null);
    check(prompt.includes("brief.pdf") && prompt.includes("application/pdf") && prompt.includes("download '") && prompt.includes("cannot read this format"), "missing helper guidance");
    const art = message.message.attachments.find((x: any) => x.name === "brief.pdf");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => app.fetch(new Request(url, init))) as typeof fetch;
      const path = await downloadArtifact({ hubUrl: "http://fleet.test", token: a.token }, art.id, `${output}/${theme}-${width}-download.pdf`);
      check(readFileSync(path).equals(pdf), "helper-side download bytes differ");
      let denied = false;
      try { await downloadArtifact({ hubUrl: "http://fleet.test", token: b.token }, art.id, `${output}/denied.pdf`); } catch { denied = true; }
      check(denied, "other agent downloaded private human file");
    } finally { globalThis.fetch = originalFetch; }
    check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), "message sideways scroll");
    check(await page.locator("#v-thread .atts a").first().evaluate((a: Element) => getComputedStyle(a).color === getComputedStyle(a.closest(".bubble")!).color), "attachment link is not readable against human bubble");
    await page.screenshot({ path: `${output}/${theme}-${width}-sent.png`, fullPage: true });
    // Client cap refusal and network failure are visible, removable and recoverable.
    await page.locator("#attachmentInput").setInputFiles({ name: "too-big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(1025) });
    await page.locator("#error-toast:not([hidden])").waitFor(); check((await page.locator("#error-toast-text").innerText()).includes("limit"), "size refusal not clear");
    await page.getByRole("button", { name: "Dismiss error" }).click();
    failUpload = true; await page.locator("#attachmentInput").setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry") });
    await page.locator('#attachmentList [data-status="failed"]').waitFor(); check(await page.locator("#sendBtn").isDisabled(), "failed upload can be sent");
    await page.getByRole("button", { name: "Remove retry.txt" }).click(); failUpload = false;
    await page.locator("#attachmentInput").setInputFiles(Array.from({ length: 11 }, (_, i) => ({ name: `small-${i}.txt`, mimeType: "text/plain", buffer: Buffer.from("x") }))); await ready(10);
    check((await page.locator("#error-toast-text").innerText()).includes("At most 10"), "count refusal missing");
    await page.getByRole("button", { name: "Dismiss error" }).click();
    // Attachment-only Room message uses the same flow.
    for (let i = 0; i < 10; i++) await page.getByRole("button", { name: `Remove small-${i}.txt`, exact: true }).click();
    await page.evaluate(() => { location.hash = "#/room"; }); await page.waitForTimeout(60);
    await page.locator("#attachmentInput").setInputFiles({ name: "room.pdf", mimeType: "application/pdf", buffer: pdf }); await ready(1);
    await page.locator("#compose").fill(""); await page.locator("#sendBtn").click();
    await page.waitForFunction(() => [...document.querySelectorAll("#v-thread .atts a")].some((a) => a.textContent === "room.pdf"));
    check(errors.length === 0, errors.join("\n"));
    checks.push({ theme, width, input: "PDF + PNG", drop: "pass", paste: "pass", progressDisablesSend: true, remove: "pass", recipientDrafts: "pass", refusalRetry: "pass", countAndSizeCaps: "pass", uploadFailure: "pass", roomAttachmentOnly: "pass", helperDownload: "byte-for-byte equal", otherDmDenied: true, sidewaysScroll: false, pageErrors: errors });
  } finally { const video = page.video(); await page.close(); if (video) renameSync(await video.path(), `${output}/attachments-demo.webm`); store.db.close(); rmSync(hub.dataDir, { recursive: true, force: true }); }
 }
} finally { await browser.close(); }
await Bun.write(`${output}/checks.json`, JSON.stringify(checks, null, 2)); console.log(JSON.stringify(checks, null, 2));
