// bun scripts/verify-team-workspace.ts [output-directory]
// Chromium requests go directly to the in-memory Hono app; no server is opened.
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core");
const output = resolve(process.argv[2] ?? "artifacts/team");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const checks: unknown[] = [];
try {
  for (const theme of ["light", "dark"]) for (const width of [1440, 400]) {
    const { app, hub, store } = createApp(":memory:", "preview-only", { hubOwner: "owner" });
    const alpha = hub.createWorkspace("Alpha"), beta = hub.createWorkspace("Beta");
    const emptyA = hub.createWorkspace("Empty A"), emptyB = hub.createWorkspace("Empty B");
    const add = (name: string, workspaceId: string, owner = "owner") => store.agentById(store.addAgent({ name, owner, workspaceId, device: "laptop", skills: [] }).id)!;
    const a = add("alpha-builder", alpha.id), b = add("beta-researcher", beta.id);
    add("default-worker", "default");
    add("shared-reviewer", "default", "partner");
    add("beta-partner", "default", "partner");
    add("ungranted-partner", "default", "partner");
    hub.humanCreateTask({ title: "Alpha work", project: "alpha-project", workspaceId: alpha.id });
    hub.humanCreateTask({ title: "Beta work", project: "beta-project", workspaceId: beta.id });
    hub.grant("shared-reviewer", "alpha-project"); hub.grant("shared-reviewer", "beta-project"); hub.grant("beta-partner", "beta-project");
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.addInitScript((id: string) => {
      localStorage.setItem("fleet-workspace", id);
      (window as any).EventSource = class extends EventTarget {
        constructor() { super(); (window as any).__fleetEvents = this; }
        close() {}
      };
    }, alpha.id);
    await page.route("**/*", async (route: any) => {
      const r = route.request();
      const response = await app.fetch(new Request(r.url(), { method: r.method(), headers: r.headers(), body: ["GET", "HEAD"].includes(r.method()) ? undefined : r.postDataBuffer() }));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    const team = page.locator("#v-team");
    const assertNames = async (expected: string[]) => {
      const actual = await team.locator(".team strong").allTextContents();
      const names = actual.filter((s: string) => s !== "Workspace");
      if (JSON.stringify(names.sort()) !== JSON.stringify([...expected].sort())) throw new Error(`Expected agents ${expected}; saw ${names}`);
    };
    const assertWorkspace = async (name: string) => {
      const inputs = team.getByRole("textbox", { name: "Workspace name", exact: true });
      if (await inputs.count() !== 1 || await inputs.inputValue() !== name) throw new Error("Team exposes other workspace settings");
    };
    const switchTo = async (id: string) => {
      if (width === 400) await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page.locator("#wsSelect").selectOption(id);
      if (width === 400) await page.keyboard.press("Escape");
    };
    const refresh = async () => {
      const response = page.waitForResponse((r: any) => r.url().endsWith("/api/state"));
      await page.evaluate(() => (window as any).__fleetEvents.dispatchEvent(new Event("change")));
      await response;
    };
    try {
      await page.goto("http://fleet.test/?token=preview-only#/team");
      await team.waitFor();
      await assertNames(["alpha-builder", "shared-reviewer"]); await assertWorkspace("Alpha");
      if ((await team.innerText()).includes("beta-project")) throw new Error("Other workspace project grant leaked");
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Populated Team overflows horizontally");
      await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
      await switchTo(beta.id);
      await assertNames(["beta-researcher", "shared-reviewer", "beta-partner"]); await assertWorkspace("Beta");
      if ((await team.innerText()).includes("alpha-project")) throw new Error("Previous workspace grants remain");
      await switchTo(alpha.id);
      await assertNames(["alpha-builder", "shared-reviewer"]);
      // Background updates in another workspace must not replace active drafts.
      const role = team.getByRole("textbox", { name: "Role of alpha-builder", exact: true });
      await role.fill("Draft role");
      hub.setRole(b, "Updated elsewhere"); await refresh();
      if (await role.inputValue() !== "Draft role") throw new Error("Unrelated update destroyed active draft");
      // Moving an agent out and revoking the last grant must remove both cards on refresh.
      hub.moveAgent(a.name, beta.id); hub.revokeGrant("shared-reviewer", "alpha-project"); await refresh();
      await page.waitForFunction(() => document.querySelectorAll("#v-team .team strong").length === 1);
      await assertNames([]);
      if (!(await team.innerText()).includes("No agents in this workspace")) throw new Error("Missing empty workspace message");
      await switchTo(emptyA.id); await assertWorkspace("Empty A"); await assertNames([]);
      await switchTo(emptyB.id); await assertWorkspace("Empty B"); await assertNames([]);
      await switchTo("default"); await assertNames(["default-worker"]); await assertWorkspace("Default");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error(`Horizontal overflow at ${width}`);
      if (errors.length) throw new Error(errors.join("\n"));
      checks.push({ theme, width, workspaceFiltering: "pass", externalGrants: "pass", switching: "pass", emptyWorkspaces: "pass", liveMoveAndRevoke: "pass", draftsPreserved: "pass", defaultWorkspace: "pass", sidewaysScroll: false, pageErrors: errors });
    } finally { await page.close(); store.db.close(); rmSync(hub.dataDir, { recursive: true, force: true }); }
  }
} finally { await browser.close(); }
await Bun.write(`${output}/checks.json`, JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks, null, 2));
