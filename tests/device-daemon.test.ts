import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createApp } from "../src/app";
import { collectSessions, claudeProjectDir } from "../cli/fleet";

// This file drives the real device daemon and report path. Usage measurement shells out to the installed harnesses
// (claude, agy, opencode), so it is switched off here: the Usage tab's own tests inject a runner instead.
process.env.FLEET_USAGE = "off";

const { app, store, hub } = createApp(":memory:", "human-secret", { hubOwner: "alper" });
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
const url = `http://127.0.0.1:${server.port}`;
const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };
const home = mkdtempSync(`${tmpdir()}/fleet-dev-home-`);
const root = realpathSync(mkdtempSync(`${tmpdir()}/fleet-dev-root-`));
const claudeHome = mkdtempSync(`${tmpdir()}/fleet-dev-claude-`);
const work = `${root}/project-a`;
mkdirSync(work, { recursive: true });

// A stand-in agent tool: remembers each session's prompt in a file and prints it back when resumed.
const botDir = mkdtempSync(`${tmpdir()}/fleet-dev-bot-`);
writeFileSync(`${botDir}/bot.ts`, `import { writeFileSync, readFileSync, existsSync } from "node:fs";
const [mode, session, prompt] = process.argv.slice(2);
const f = "${botDir}/" + session;
if (mode === "new") { writeFileSync(f, prompt); console.log("OK"); }
else if (mode === "resume") console.log(existsSync(f) ? readFileSync(f, "utf8") : "no such session");
else process.exit(3);
`);
const bot = (mode: string) => `${process.execPath} ${botDir}/bot.ts ${mode} {session} {prompt}`;

async function fleet(...args: string[]) {
  const p = Bun.spawn([process.execPath, "run", "cli/fleet.ts", ...args], { env: { ...process.env, FLEET_HOME: home, FLEET_CLAUDE_HOME: claudeHome }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  return { out: out + err, code };
}
const state = async () => (await (await fetch(`${url}/api/state`, { headers: human })).json()) as any;
const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(250); }
  throw new Error(`timed out waiting for: ${what}`);
};
afterAll(async () => {
  await fleet("device", "stop");
  // Every agent configured on this device, not only the ones the hub still lists: a revoked agent's helper must be stopped too.
  const configured = existsSync(`${home}/agents`) ? readdirSync(`${home}/agents`).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
  for (const name of configured) await fleet("stop", name);
  server.stop(true);
});

let device: { id: string; token: string };

test("the sessions a device offers are found in its allowed folders and their subfolders, newest first", () => {
  const dir = claudeProjectDir(`${root}/project-a`, claudeHome);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/11111111-1111-4111-8111-111111111111.jsonl`, JSON.stringify({ type: "user", message: { role: "user", content: "Fix the booking date bug" } }) + "\n");
  const found = collectSessions([root], claudeHome, claudeHome);
  expect(found.length).toBe(1);
  expect(found[0]).toMatchObject({ harness: "claude", id: "11111111-1111-4111-8111-111111111111", dir: `${root}/project-a`, preview: "Fix the booking date bug" });
  expect(collectSessions(["/nowhere"], claudeHome, claudeHome)).toEqual([]);
});

test("enroll saves the device privately, starts it, and the hub sees it online with what it has and no folders allowed", async () => {
  device = await (await fetch(`${url}/api/devices`, { method: "POST", headers: human, body: JSON.stringify({ name: "test-device" }) })).json() as any;
  const bad = await fleet("device", "enroll", url, "not-a-token");
  expect(bad.code).not.toBe(0);
  const r = await fleet("device", "enroll", url, device.token);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/fleet device allow/);
  expect(statSync(`${home}/device.json`).mode & 0o077).toBe(0);
  await until("device online", async () => (await state()).devices.find((d: any) => d.id === device.id)?.online === true);
  const row = (await state()).devices.find((d: any) => d.id === device.id);
  expect(row.roots).toEqual([]);
  expect(row.harnesses.some((h: any) => h.id === "custom")).toBe(true);
}, 30000);

test("nothing can be launched until a folder is allowed; allowing one reaches the hub, and / or the home folder are refused", async () => {
  const early = await fetch(`${url}/api/devices/${device.id}/launch`, { method: "POST", headers: human, body: JSON.stringify({ name: "early", harness: "custom", dir: work, permissions: "open", runCmd: bot("new") }) });
  expect(early.status).toBe(400);
  expect(((await early.json()) as any).error).toMatch(/allow/i);
  expect((await fleet("device", "allow", "/")).code).not.toBe(0);
  expect((await fleet("device", "allow", process.env.HOME!)).out).toMatch(/too broad|subfolder/i);
  expect((await fleet("device", "allow", `${root}/missing`)).code).not.toBe(0);
  const ok = await fleet("device", "allow", root);
  expect(ok.code).toBe(0);
  await until("hub learns the folder", async () => (await state()).devices.find((d: any) => d.id === device.id)?.roots.includes(root));
  expect((await fleet("device", "roots")).out).toContain(root);
}, 30000);

test("an open-permission launch waits for a person at the device; confirming it starts the agent, which comes online", async () => {
  const res = await fetch(`${url}/api/devices/${device.id}/launch`, { method: "POST", headers: human, body: JSON.stringify({ name: "from-the-ui", harness: "custom", dir: work, permissions: "open", runCmd: bot("new"), resumeCmd: bot("resume") }) });
  expect(res.status).toBe(200);
  const made: any = await res.json();
  await until("awaiting confirmation", async () => (await state()).deviceRequests.find((r: any) => r.id === made.request.id)?.status === "awaiting-confirmation");
  expect(store.listAgents().find((a) => a.name === "from-the-ui")).toBeTruthy();
  expect(existsSync(`${home}/agents/from-the-ui.json`)).toBe(false);          // nothing has started on the machine
  const pending = await fleet("device", "confirm");
  expect(pending.out).toContain("from-the-ui");
  expect(pending.out).toContain(made.request.id.slice(0, 8));
  expect((await fleet("device", "confirm", "zzzzzzzz")).code).not.toBe(0);
  const go = await fleet("device", "confirm", made.request.id.slice(0, 8));
  expect(go.code).toBe(0);
  await until("launch done", async () => ["done", "failed"].includes((await state()).deviceRequests.find((r: any) => r.id === made.request.id)?.status), 40000);
  const final = (await state()).deviceRequests.find((r: any) => r.id === made.request.id);
  expect(final).toMatchObject({ status: "done" });
  expect(JSON.parse(readFileSync(`${home}/agents/from-the-ui.json`, "utf8"))).toMatchObject({ harness: "custom", workdir: work, permissions: "open" });
  await until("agent online", async () => { const a = (await state()).agents.find((x: any) => x.name === "from-the-ui"); return !!a && Date.now() - a.lastSeen < 40000; }, 30000);
}, 90000);

test("the device checks every request itself: a folder outside what it allows is refused even if the hub asked", async () => {
  const sneaky = store.addAgent({ name: "sneaky", owner: "alper", device: "test-device", skills: [], deviceId: device.id });
  const req = store.addDeviceRequest({ deviceId: device.id, kind: "launch", agentId: sneaky.id, payload: { agentName: "sneaky", token: sneaky.token, harness: "custom", dir: "/etc", permissions: "open", runCmd: bot("new") } });
  hub.notify();                                                                   // what the hub does itself when it queues one
  await until("request failed", async () => (await state()).deviceRequests.find((r: any) => r.id === req.id)?.status === "failed");
  expect((await state()).deviceRequests.find((r: any) => r.id === req.id).message).toMatch(/outside/i);
  expect(existsSync(`${home}/agents/sneaky.json`)).toBe(false);
  expect(store.agentByToken(sneaky.token)).toBeNull();                         // and the agent made for it lost its token
}, 30000);

test("removing the device stops its daemon, and the agents it launched lose their tokens", async () => {
  const res = await fetch(`${url}/api/devices/${device.id}`, { method: "DELETE", headers: human });
  expect(((await res.json()) as any).revokedAgents).toContain("from-the-ui");
  await until("daemon exits", async () => !(await fleet("device", "status")).out.includes("running"), 30000);
  expect((await fleet("device", "status")).out).toMatch(/stopped|removed/i);
}, 60000);
