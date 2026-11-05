import { test, expect, afterAll, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app";

// Each case gets its own limiter window; authentication assertions remain unchanged.
let authNow = Date.now();
beforeEach(() => { authNow += 60_001; });
const { app, store, hub } = createApp(":memory:", "human-secret", { hubOwner: "alper", security: { now: () => authNow } });
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;
const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };
const call = (path: string, init: RequestInit & { as?: Record<string, string> } = {}) => fetch(`${base}${path}`, { ...init, headers: init.as ?? human });
const post = (path: string, body: unknown, as?: Record<string, string>) => call(path, { method: "POST", body: JSON.stringify(body), as });
const state = async () => (await (await call("/api/state")).json()) as any;

async function newDevice(name = "laptop") {
  const d: any = await (await post("/api/devices", { name })).json();
  const dev = { Authorization: `Bearer ${d.token}`, "content-type": "application/json" };
  return { ...d, dev };
}
const report = (dev: Record<string, string>, over: object = {}) => post("/device/report", {
  hostname: "alpers-laptop", harnesses: [{ id: "claude", label: "Claude Code", path: "/usr/bin/claude" }, { id: "custom", label: "Your own tool", path: null }],
  roots: ["/work"], sessions: [], ...over,
}, dev);

test("adding a device returns its token once; the state lists it, offline, and never shows the token", async () => {
  const d = await newDevice("laptop");
  expect(d.token.length).toBeGreaterThanOrEqual(32);
  const s = await state();
  const row = s.devices.find((x: any) => x.id === d.id);
  expect(row).toMatchObject({ name: "laptop", online: false });
  expect(JSON.stringify(s)).not.toContain(d.token);
  expect((await fetch(`${base}/api/devices`, { method: "POST", body: JSON.stringify({ name: "x" }) })).status).toBe(401);
  expect((await post("/api/devices", { name: "" })).status).toBe(400);
});

test("a device authenticates with its own token, reports what it has, and then shows as online", async () => {
  const d = await newDevice("reporter");
  expect((await post("/device/report", {}, { Authorization: "Bearer nope", "content-type": "application/json" })).status).toBe(401);
  expect((await post("/device/report", {}, { Authorization: `Bearer human-secret`, "content-type": "application/json" })).status).toBe(401);   // the human token is not a device token
  expect((await report(d.dev)).status).toBe(200);
  const row = (await state()).devices.find((x: any) => x.id === d.id);
  expect(row).toMatchObject({ online: true, hostname: "alpers-laptop", roots: ["/work"] });
  expect(row.harnesses.map((h: any) => h.id)).toEqual(["claude", "custom"]);
});

test("a report made before a folder was allowed cannot undo it: an older revision is ignored", async () => {
  const d = await newDevice("slow-reporter");
  await report(d.dev, { rev: 2, roots: ["/work"] });
  expect((await state()).devices.find((x: any) => x.id === d.id).roots).toEqual(["/work"]);
  // The device lists its models for seconds before it sends; a report it started before `fleet device allow` can land after it.
  await report(d.dev, { rev: 1, roots: [] });
  const row = (await state()).devices.find((x: any) => x.id === d.id);
  expect(row.roots).toEqual(["/work"]);
  expect(row.online).toBe(true);                                             // it is still the same, live device
  // A report with no revision (a device running an older fleet) is still applied.
  await report(d.dev, { roots: ["/work", "/tmp/other"] });
  expect((await state()).devices.find((x: any) => x.id === d.id).roots).toEqual(["/work", "/tmp/other"]);
});

test("a device's token is not an agent's token, and an agent's is not a device's", async () => {
  const d = await newDevice("separate");
  expect((await fetch(`${base}/agent/pull`, { method: "POST", headers: d.dev, body: "{}" })).status).toBe(401);
  const a: any = await (await post("/api/agents", { name: "an-agent" })).json();
  expect((await post("/device/report", {}, { Authorization: `Bearer ${a.token}`, "content-type": "application/json" })).status).toBe(401);
});

test("launching an agent from the UI creates the agent, queues the request, and hands the token only to the device", async () => {
  const d = await newDevice("launcher");
  await report(d.dev);
  const res = await post(`/api/devices/${d.id}/launch`, { name: "from-ui", harness: "claude", dir: "/work/han-test", permissions: "safe" });
  expect(res.status).toBe(200);
  const made: any = await res.json();
  expect(made.agent).toBe("from-ui");
  expect(JSON.stringify(made)).not.toMatch(/token/i);                                // the browser never sees the new agent's token
  expect(JSON.stringify(await state())).not.toContain(store.listAgents().find((a) => a.name === "from-ui")!.id + "-token");
  const pulled: any = await (await post("/device/pull", {}, d.dev)).json();
  expect(pulled.requests.length).toBe(1);
  const r = pulled.requests[0];
  expect(r).toMatchObject({ kind: "launch", payload: { agentName: "from-ui", harness: "claude", dir: "/work/han-test", permissions: "safe" } });
  expect(r.payload.token.length).toBeGreaterThanOrEqual(32);
  expect(store.agentByToken(r.payload.token)?.name).toBe("from-ui");                   // it is the real agent's token
  const agent = (await state()).agents.find((a: any) => a.name === "from-ui");
  expect(agent.deviceId).toBe(d.id);
});

test("the launch is refused, with the reason, for a harness the device lacks, a folder it does not allow, or a bad combination, and nothing is created", async () => {
  const d = await newDevice("strict");
  expect((await post(`/api/devices/${d.id}/launch`, { name: "too-early", harness: "claude", dir: "/work/x" })).status).toBe(409);     // never reported
  await report(d.dev);
  const before = store.listAgents().length;
  const refused = async (body: object, status: number, why: RegExp) => {
    const r = await post(`/api/devices/${d.id}/launch`, body);
    expect(r.status).toBe(status);
    expect(((await r.json()) as any).error).toMatch(why);
  };
  await refused({ name: "no-codex", harness: "codex", dir: "/work/x" }, 400, /does not have codex|not installed/i);
  await refused({ name: "outside", harness: "claude", dir: "/etc" }, 400, /allow/i);
  await refused({ name: "dots", harness: "claude", dir: "/work/../etc" }, 400, /allow/i);
  await refused({ name: "prefix", harness: "claude", dir: "/work-evil/x" }, 400, /allow/i);        // /work-evil is not inside /work
  await refused({ name: "relative", harness: "claude", dir: "work/x" }, 400, /absolute/i);
  await refused({ name: "custom-safe", harness: "custom", dir: "/work/x", permissions: "safe", runCmd: "x {prompt}" }, 400, /open/i);
  await refused({ name: "custom-nocmd", harness: "custom", dir: "/work/x", permissions: "open" }, 400, /run/i);
  await refused({ name: "bad-session", harness: "claude", dir: "/work/x", session: "nope" }, 400, /uuid/i);
  await refused({ name: "all", harness: "claude", dir: "/work/x" }, 400, /reserved/i);
  await refused({ name: "nowhere", harness: "claude", dir: "/work/x", workspace: "missing" }, 400, /no workspace/i);
  expect(store.listAgents().length).toBe(before);
  await post(`/api/devices/${d.id}/launch`, { name: "dupe", harness: "claude", dir: "/work/x" });
  await refused({ name: "dupe", harness: "claude", dir: "/work/x" }, 409, /already exists/i);
});

test("the device reports the outcome: done wipes the token from the stored request, failed revokes the agent that was created for it", async () => {
  const d = await newDevice("outcomes");
  await report(d.dev);
  const ok: any = await (await post(`/api/devices/${d.id}/launch`, { name: "will-work", harness: "claude", dir: "/work/a" })).json();
  const bad: any = await (await post(`/api/devices/${d.id}/launch`, { name: "will-fail", harness: "claude", dir: "/work/b" })).json();
  const pulled: any = await (await post("/device/pull", {}, d.dev)).json();
  const tokenOf = (name: string) => pulled.requests.find((r: any) => r.payload.agentName === name).payload.token;
  expect((await post(`/device/requests/${ok.request.id}/result`, { status: "done", message: "online" }, d.dev)).status).toBe(200);
  expect((await post(`/device/requests/${bad.request.id}/result`, { status: "failed", message: "claude is not logged in" }, d.dev)).status).toBe(200);
  expect(store.agentByToken(tokenOf("will-work"))?.name).toBe("will-work");
  expect(store.agentByToken(tokenOf("will-fail"))).toBeNull();                      // nobody is left holding a token for an agent that never started
  const s = await state();
  expect(s.deviceRequests.find((r: any) => r.id === ok.request.id)).toMatchObject({ status: "done", message: "online" });
  expect(s.deviceRequests.find((r: any) => r.id === bad.request.id)).toMatchObject({ status: "failed", message: "claude is not logged in" });
  expect(JSON.stringify(s)).not.toContain(tokenOf("will-work"));
  const again: any = await (await post("/device/pull", {}, d.dev)).json();
  expect(again.requests).toEqual([]);                                                // finished requests are not offered again
});

test("only the device a request belongs to can report on it", async () => {
  const a = await newDevice("owner-device"), b = await newDevice("other-device");
  await report(a.dev);
  const made: any = await (await post(`/api/devices/${a.id}/launch`, { name: "mine-only", harness: "claude", dir: "/work/a" })).json();
  expect((await post(`/device/requests/${made.request.id}/result`, { status: "done" }, b.dev)).status).toBe(404);
  expect((await post(`/device/requests/${made.request.id}/result`, { status: "bogus" }, a.dev)).status).toBe(400);
});

test("a request that needs a person at the device says so, and stays visible until it is answered", async () => {
  const d = await newDevice("confirm");
  await report(d.dev);
  const made: any = await (await post(`/api/devices/${d.id}/launch`, { name: "open-agent", harness: "custom", dir: "/work/o", permissions: "open", runCmd: "bot {prompt}" })).json();
  expect(made.request.needsConfirmation).toBe(true);
  expect((await post(`/device/requests/${made.request.id}/result`, { status: "awaiting-confirmation", message: "run: fleet device confirm" }, d.dev)).status).toBe(200);
  expect((await state()).deviceRequests.find((r: any) => r.id === made.request.id)).toMatchObject({ status: "awaiting-confirmation", needsConfirmation: true });
  // still pending on the hub side: a restarted device can pick it up again
  expect(((await (await post("/device/pull", {}, d.dev)).json()) as any).requests.map((r: any) => r.id)).toContain(made.request.id);
});

test("removing a device cuts it off at once and revokes the agents launched through it, but not agents it never launched", async () => {
  const d = await newDevice("to-remove");
  await report(d.dev);
  await post(`/api/devices/${d.id}/launch`, { name: "launched-1", harness: "claude", dir: "/work/1" });
  await post(`/api/devices/${d.id}/launch`, { name: "launched-2", harness: "claude", dir: "/work/2" });
  store.addAgent({ name: "unrelated", owner: "alper", device: "to-remove", skills: [] });          // same device name, not launched through it
  const pending: any = await (await post("/device/pull", {}, d.dev)).json();
  const token = pending.requests[0].payload.token;
  const res = await call(`/api/devices/${d.id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).revokedAgents.sort()).toEqual(["launched-1", "launched-2"]);
  expect((await report(d.dev)).status).toBe(401);                                    // the device can no longer report
  expect((await post("/device/pull", {}, d.dev)).status).toBe(401);
  expect(store.agentByToken(token)).toBeNull();
  expect(store.listAgents().some((a) => a.name === "unrelated")).toBe(true);
  expect((await state()).devices.some((x: any) => x.id === d.id)).toBe(false);
  expect((await call(`/api/devices/${d.id}`, { method: "DELETE" })).status).toBe(404);
});

test("a device is woken when there is something to do", async () => {
  const d = await newDevice("waker");
  await report(d.dev);
  const res = await fetch(`${base}/device/events`, { headers: d.dev });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  let text = "";
  const readUntil = async (needle: string) => { const end = Date.now() + 4000; while (Date.now() < end && !text.includes(needle)) { const r = await reader.read(); if (!r.done) text += new TextDecoder().decode(r.value); } };
  await readUntil("event: hello");
  await post(`/api/devices/${d.id}/launch`, { name: "wake-me", harness: "claude", dir: "/work/w" });
  await readUntil("event: wake");
  await reader.cancel();
  expect(text).toContain("event: wake");
  expect((await fetch(`${base}/device/events`)).status).toBe(401);
});

test("the UI can create an agent for a tool the fleet does not know, and gets the setup prompt with its token to paste into that tool", async () => {
  const res = await post("/api/agents/prompt", { name: "my-own-tool" });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.name).toBe("my-own-tool");
  expect(body.prompt).toContain(`fleet join ${base} `);
  const token = /fleet join \S+ (\S+) --name my-own-tool/.exec(body.prompt)?.[1];
  expect(store.agentByToken(token!)?.name).toBe("my-own-tool");
  expect(body.prompt).toMatch(/--harness custom/);
  expect((await post("/api/agents/prompt", { name: "my-own-tool" })).status).toBe(409);
  expect((await post("/api/agents/prompt", { name: "Bad Name" })).status).toBe(400);
  expect((await fetch(`${base}/api/agents/prompt`, { method: "POST", body: JSON.stringify({ name: "x" }) })).status).toBe(401);
});

test("the harness table is served to the browser as plain JavaScript", async () => {
  const text = await (await call("/harnesses.js")).text();
  expect(text).toContain("export const HARNESSES");
  expect(text).not.toMatch(/:\s*HarnessInfo\[\]/);                 // types are stripped
});

// ---- continuing as an agent that already exists ----

test("a launch can continue as an existing agent: same identity, workspace and tasks, a new token, and the old token stops working", async () => {
  const d = await newDevice("continuer");
  await report(d.dev);
  const ws: any = await (await post("/api/workspaces", { name: "han-continue" })).json();
  const existing = store.addAgent({ name: "old-claude", owner: "alper", device: "laptop", skills: [], workspaceId: ws.id });
  const res = await post(`/api/devices/${d.id}/launch`, { asAgent: "old-claude", harness: "claude", dir: "/work/han-test", permissions: "safe" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).agent).toBe("old-claude");
  const pulled: any = await (await post("/device/pull", {}, d.dev)).json();
  const r = pulled.requests.find((x: any) => x.payload.agentName === "old-claude");
  expect(store.agentByToken(existing.token)).toBeNull();                          // whatever was running as it before is cut off
  expect(store.agentByToken(r.payload.token)?.id).toBe(existing.id);               // the same agent, with a new token
  expect(r.payload.reuse).toBe(true);
  expect(store.agentById(existing.id)).toMatchObject({ deviceId: d.id, workspaceId: ws.id });
  expect(store.listAgents().filter((a) => a.name === "old-claude").length).toBe(1);
});

test("if starting the continued agent fails, the agent is kept (it was never new), and the failure is shown", async () => {
  const d = await newDevice("continuer-fail");
  await report(d.dev);
  const existing = store.addAgent({ name: "keeper", owner: "alper", device: "laptop", skills: [] });
  const made: any = await (await post(`/api/devices/${d.id}/launch`, { asAgent: "keeper", harness: "claude", dir: "/work/k" })).json();
  const pulled: any = await (await post("/device/pull", {}, d.dev)).json();
  const token = pulled.requests.find((x: any) => x.payload.agentName === "keeper").payload.token;
  await post(`/device/requests/${made.request.id}/result`, { status: "failed", message: "claude is not logged in" }, d.dev);
  expect(store.agentById(existing.id)).toBeTruthy();
  expect(store.listAgents().some((a) => a.name === "keeper")).toBe(true);          // not revoked: only brand-new agents are cleaned up
  expect(store.agentByToken(token)?.name).toBe("keeper");                           // it can be started again with the token it has now
});

test("only a team agent that exists can be continued", async () => {
  const d = await newDevice("continuer-strict");
  await report(d.dev);
  const friend = store.addAgent({ name: "friends-agent", owner: "sam", device: "x", skills: [] });
  void friend;
  const refused = async (body: object, status: number, why: RegExp) => { const r = await post(`/api/devices/${d.id}/launch`, { harness: "claude", dir: "/work/x", ...body }); expect(r.status).toBe(status); expect(((await r.json()) as any).error).toMatch(why); };
  await refused({ asAgent: "nobody-here" }, 400, /no agent/i);
  await refused({ asAgent: "friends-agent" }, 400, /outside|team/i);
});

test("an agent's wake carries who it is, so an agent that resumed an old conversation is not confused about its identity", async () => {
  const a = store.addAgent({ name: "who-am-i", owner: "alper", device: "d", skills: [] });
  const res = await fetch(`${base}/agent/pull`, { method: "POST", headers: { Authorization: `Bearer ${a.token}`, "content-type": "application/json" }, body: "{}" });
  const body: any = await res.json();
  expect(body.self).toEqual({ name: "who-am-i", workspace: "Default", instructions: "" });
});

test("refusing an agent that does not hold a task says who it is, who holds it, and how to get it", () => {
  const holder = store.agentById(store.addAgent({ name: "holder-a", owner: "alper", device: "d", skills: [] }).id)!;
  const other = store.agentById(store.addAgent({ name: "other-b", owner: "alper", device: "d", skills: [] }).id)!;
  const t = hub.createTask(holder, { title: "t", project: "idproj", description: "a description that is long enough", acceptance: "it is done" });
  hub.claim(holder, t.id);
  let msg = "";
  try { hub.attachEvidence(other, t.id, { kind: "note", ref: "x" }); } catch (e) { msg = (e as Error).message; }
  expect(msg).toMatch(/not your task/);
  expect(msg).toContain("holder-a");
  expect(msg).toContain("other-b");
  expect(msg).toMatch(/reassign/i);
});

test("a device's report can carry the models each tool offers, which the UI then lists", async () => {
  const d = await newDevice("models");
  await report(d.dev, { models: { opencode: ["openai/gpt-5.5", "opencode-go/glm-5.2"], claude: ["opus", "sonnet"], junk: "nope", prime: [42, "ok"] } });
  const row = (await state()).devices.find((x: any) => x.id === d.id);
  expect(row.models.opencode).toEqual(["openai/gpt-5.5", "opencode-go/glm-5.2"]);
  expect(row.models.claude).toEqual(["opus", "sonnet"]);
  expect(row.models.prime).toEqual(["ok"]);                // only text survives
  expect(row.models.junk).toBeUndefined();
});

test("a device's report can explain where each model list came from, or why it is empty, and only for tools it reported", async () => {
  const d = await newDevice("model-notes");
  const long = "x".repeat(400);
  await report(d.dev, {
    harnesses: [{ id: "opencode", label: "opencode", path: "/usr/local/bin/opencode" }, { id: "claude", label: "Claude Code", path: "/usr/bin/claude" }, { id: "custom", label: "Your own tool", path: null }],
    models: { opencode: [], claude: ["opus"], custom: ["anything"] },
    modelInfo: {
      opencode: { source: "opencode models", found: 0, at: 1760000000000, error: "opencode models exited 1: not signed in" },
      claude: { source: long, found: 1, at: 1760000000001 },
      custom: "not an object",
      codex: { source: "codex debug models", found: 3 },        // not installed there: dropped
      nope: { source: "made up" },
    },
  });
  const row = (await state()).devices.find((x: any) => x.id === d.id);
  expect(row.modelInfo.opencode).toEqual({ source: "opencode models", found: 0, at: 1760000000000, error: "opencode models exited 1: not signed in" });
  expect(row.modelInfo.claude.source.length).toBe(200);        // capped, never an unbounded string from a device
  expect(row.modelInfo.claude.error).toBeUndefined();
  expect(row.modelInfo.custom).toBeUndefined();
  expect(row.modelInfo.codex).toBeUndefined();
  expect(row.modelInfo.nope).toBeUndefined();
  expect(JSON.stringify(await state())).not.toContain(d.token);
});

test("the Devices page refreshes a model list whose values changed at the same length, clears a stale pick, and explains an empty list", () => {
  // The UI is one HTML file with no build step, so the behaviour that matters is pinned by reading its source.
  const ui = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  expect(ui).toContain("Object.entries(d.models || {}), d.modelInfo || {}");   // the whole list is part of the rebuild key, not just its length
  expect(ui).not.toContain("k + v.length");
  expect(ui).toContain('f.harness.addEventListener("change", () => refreshHarness(true))');   // switching tool clears the old tool's model
  expect(ui).toContain('const kept = harnessChanged ? ""');
  expect(ui).toContain("is no longer listed; it was cleared.");
  expect(ui).toContain("No model list from ");
  expect(ui).toContain("This device has not listed models for ");
});

// ---- removing an agent from the UI ----

test("removing an agent returns what it held to the pool, frees its name, cuts off its token, and fails anything still waiting for it", async () => {
  const d = await newDevice("remover");
  await report(d.dev);
  const doomed = store.addAgent({ name: "doomed", owner: "alper", device: "d", skills: [] });
  const agent = store.agentById(doomed.id)!;
  const t1 = hub.createTask(agent, { title: "held one", project: "rmproj", description: "a description that is long enough", acceptance: "it is done" });
  const t2 = hub.createTask(agent, { title: "held two", project: "rmproj", description: "a description that is long enough", acceptance: "it is done" });
  hub.claim(agent, t1.id); hub.claim(agent, t2.id);
  const pendingLaunch: any = await (await post(`/api/devices/${d.id}/launch`, { asAgent: "doomed", harness: "claude", dir: "/work/x" })).json();
  const res = await call("/api/agents/doomed", { method: "DELETE" });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.released.sort()).toEqual([t1.key, t2.key].sort());
  for (const t of [t1, t2]) expect(store.getTask(t.id)).toMatchObject({ status: "open", claimedBy: null });
  expect(store.agentByToken(doomed.token)).toBeNull();
  expect(store.listAgents().some((a) => a.name === "doomed")).toBe(false);
  expect((await post("/api/agents", { name: "doomed" })).status).toBe(200);                      // the name can be used again
  expect(store.getDeviceRequest(pendingLaunch.request.id)).toMatchObject({ status: "failed" });  // nothing is left waiting to start it
  expect((await call("/api/agents/nobody-at-all", { method: "DELETE" })).status).toBe(404);
  expect((await fetch(`${base}/api/agents/doomed`, { method: "DELETE" })).status).toBe(401);
  const history = JSON.stringify(hub.taskDetail(t1.id).events);
  expect(history).toMatch(/removed/i);                                                            // the task's history says why it came back
});

test("a task whose holder was removed is claimable by anyone straight away, not after a lease runs out", async () => {
  const a = store.agentById(store.addAgent({ name: "leaver", owner: "alper", device: "d", skills: [] }).id)!;
  const b = store.agentById(store.addAgent({ name: "stayer", owner: "alper", device: "d", skills: [] }).id)!;
  const t = hub.createTask(a, { title: "was theirs", project: "rmproj2", description: "a description that is long enough", acceptance: "it is done" });
  hub.claim(a, t.id);
  await call("/api/agents/leaver", { method: "DELETE" });
  expect(hub.claim(b, t.id).claimedBy).toBe(b.id);
});

test("a removed agent is not listed, not counted by @all, and its old messages still say who wrote them", async () => {
  const gone = store.agentById(store.addAgent({ name: "ghost", owner: "alper", device: "d", skills: [] }).id)!;
  hub.say(gone, "room", "I was here");
  await call("/api/agents/ghost", { method: "DELETE" });
  const s = await state();
  expect(s.agents.some((a: any) => a.id === gone.id)).toBe(false);
  expect(s.retired.find((a: any) => a.id === gone.id)).toEqual({ id: gone.id, name: "ghost" });      // the name, without the internal suffix
  const all = hub.humanSay("@all roll call");
  expect(hub.deliveryFor(all).map((d) => d.agent)).not.toContain("ghost");
});

test("a launch whose agent was removed is marked as such, so the Devices page can stop showing it as running", async () => {
  const d = await newDevice("stale-line");
  await report(d.dev);
  const made: any = await (await post(`/api/devices/${d.id}/launch`, { name: "short-lived", harness: "claude", dir: "/work/s" })).json();
  await post("/device/pull", {}, d.dev);
  await post(`/device/requests/${made.request.id}/result`, { status: "done", message: "short-lived is running here" }, d.dev);
  let row = (await state()).deviceRequests.find((r: any) => r.id === made.request.id);
  expect(row.agentRemoved).toBe(false);
  await call("/api/agents/short-lived", { method: "DELETE" });
  row = (await state()).deviceRequests.find((r: any) => r.id === made.request.id);
  expect(row.agentRemoved).toBe(true);
});

// ---- the Devices form itself: a small DOM stand-in runs the real code from ui/index.html ----
// The page is one HTML file with no build step, so the form's refresh behaviour is exercised here by evaluating the
// actual functions from the file against a minimal element stub. It is enough to catch the bugs that matter:
// a list that changed without changing length, a model carried across a tool switch, and an unexplained empty list.

function fakeElement(tag: string): any {
  const node: any = {
    tag, attrs: {} as Record<string, string>, children: [] as any[], listeners: {} as Record<string, Function[]>,
    className: "", hidden: false, textContent: "", value: "", dataset: {}, disabled: false, title: "", placeholder: "",
    setAttribute(k: string, v: unknown) { node.attrs[k] = String(v); if (k === "value") node.value = String(v); },
    append(...kids: any[]) { node.children.push(...kids.filter((k) => k != null)); },
    // A real <select> takes its first option's value when its options are replaced; the form relies on that.
    replaceChildren(...kids: any[]) { node.children = kids.filter((k) => k != null); if (tag === "select") node.value = node.children.length ? (node.children[0].attrs?.value ?? "") : ""; },
    addEventListener(type: string, fn: Function) { (node.listeners[type] ||= []).push(fn); },
    dispatchEvent(e: any) { for (const fn of node.listeners[e.type] || []) fn(e); return true; },
    focus() {}, remove() {}, select() {},
  };
  return node;
}
const fakeDocument = { createElement: (tag: string) => fakeElement(tag), createTextNode: (t: string) => t };

function devicesForm() {
  const ui = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  const from = ui.indexOf("// ---- Devices: start agents on a machine from here ----");
  const to = ui.indexOf("function renderDevices");
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const code = ui.slice(from, to) + "\nreturn { buildDeviceCard, updateDeviceCard };";
  const el = (tag: string, props: Record<string, unknown> = {}, ...kids: any[]) => {
    const n = fakeDocument.createElement(tag);
    for (const [k, v] of Object.entries(props)) n.setAttribute(k, v);
    n.append(...kids);
    return n;
  };
  const HARNESSES = [
    { id: "claude", label: "Claude Code", model: "optional", modelExample: "opus", permissions: ["safe", "edits", "open"] },
    { id: "codex", label: "Codex", model: "optional", modelExample: "gpt-5", permissions: ["safe", "edits", "open"] },
    { id: "opencode", label: "opencode", model: "required", modelExample: "opencode-go/glm-5.2", permissions: ["safe", "open"] },
    { id: "custom", label: "Your own tool", model: "optional", permissions: ["open"] },
  ];
  const raw = { agents: [], workspaces: [{ id: "default", name: "Default" }], deviceRequests: [] };
  const wsName = (id: string) => (raw.workspaces.find((w) => w.id === id) || { name: "Default" }).name;
  const online = () => false;
  const api = async () => ({ ok: false, json: async () => ({}) });
  const cmdLine = (text: string) => el("code", {}, text);
  const build = new Function("HARNESSES", "raw", "wsId", "wsName", "online", "api", "cmdLine", "el", code);
  return build(HARNESSES, raw, "default", wsName, online, api, cmdLine, el) as { buildDeviceCard: Function; updateDeviceCard: Function };
}

const device = (over: any = {}) => ({
  id: "dev-1", name: "laptop", online: true, lastSeen: Date.now(), hostname: "mac", harnesses: [{ id: "claude", label: "Claude Code", path: "/usr/bin/claude" }, { id: "codex", label: "Codex", path: "/usr/bin/codex" }],
  roots: ["/work"], models: {}, modelInfo: {}, sessions: [], reported: true, launched: 0, ...over,
});
const optionValues = (select: any) => select.children.map((o: any) => o.attrs.value);

test("the Devices form rebuilds the model list when its values change but its length does not", () => {
  const { buildDeviceCard, updateDeviceCard } = devicesForm();
  const card = buildDeviceCard(device({ models: { claude: ["opus", "sonnet"] }, modelInfo: { claude: { source: "claude --help", found: 2, at: 1 } } }));
  updateDeviceCard(card, device({ models: { claude: ["opus", "sonnet"] }, modelInfo: { claude: { source: "claude --help", found: 2, at: 1 } } }));
  expect(card.f.harness.value).toBe("claude");
  expect(optionValues(card.f.modelSel)).toEqual(["", "opus", "sonnet", "__other"]);
  expect(card.f.modelSel.value).toBe("");
  // Same length, different models: a key built from lengths would keep the old options.
  updateDeviceCard(card, device({ models: { claude: ["opus", "haiku"] }, modelInfo: { claude: { source: "claude --help", found: 2, at: 2 } } }));
  expect(optionValues(card.f.modelSel)).toEqual(["", "opus", "haiku", "__other"]);
});

test("a model that is no longer listed is cleared and said so; a typed custom name survives a refresh", () => {
  const { buildDeviceCard, updateDeviceCard } = devicesForm();
  const first = device({ models: { claude: ["opus", "sonnet"] }, modelInfo: { claude: { source: "claude --help", found: 2, at: 1 } } });
  const card = buildDeviceCard(first);
  updateDeviceCard(card, first);
  card.f.modelSel.value = "sonnet";
  updateDeviceCard(card, device({ models: { claude: ["opus", "haiku"] }, modelInfo: { claude: { source: "claude --help", found: 2, at: 2 } } }));
  expect(card.f.modelSel.value).toBe("");                       // gone from the list: never start an agent on a model the tool may not have
  expect(card.modelNote.textContent).toMatch(/no longer listed/);
  // A name typed under "Other…" is the person's own: a device report must not wipe it.
  card.f.modelSel.value = "__other"; card.f.model.value = "my-private-model";
  updateDeviceCard(card, device({ models: { claude: ["opus"] }, modelInfo: { claude: { source: "claude --help", found: 1, at: 3 } } }));
  expect(card.f.modelSel.value).toBe("__other");
  expect(card.f.model.value).toBe("my-private-model");
});

test("switching tool never keeps the previous tool's model, even when both list the same name", () => {
  const { buildDeviceCard, updateDeviceCard } = devicesForm();
  const d = device({ models: { claude: ["gpt-5.5"], codex: ["gpt-5.5"] }, modelInfo: { claude: { source: "claude --help" }, codex: { source: "codex debug models" } } });
  const card = buildDeviceCard(d);
  updateDeviceCard(card, d);
  card.f.modelSel.value = "gpt-5.5";
  card.f.harness.value = "codex";
  card.f.harness.dispatchEvent({ type: "change" });
  expect(card.f.modelSel.value).toBe("");
  card.f.modelSel.value = "__other"; card.f.model.value = "typed-for-claude";
  card.f.harness.value = "claude";
  card.f.harness.dispatchEvent({ type: "change" });
  expect(card.f.modelSel.value).toBe("");
  expect(card.f.model.value).toBe("");
});

test("an empty or failed model list is explained in the form, and a required model goes to the name field", () => {
  const { buildDeviceCard, updateDeviceCard } = devicesForm();
  const d = device({
    harnesses: [{ id: "opencode", label: "opencode", path: "/usr/local/bin/opencode" }],
    models: { opencode: [] },
    modelInfo: { opencode: { source: "opencode models", found: 0, at: 1, error: "opencode models exited 1: not signed in" } },
  });
  const card = buildDeviceCard(d);
  updateDeviceCard(card, d);
  expect(card.f.modelSel.value).toBe("__other");
  expect(card.f.model.value).toBe("");
  expect(card.f.model.hidden).toBe(false);
  expect(card.modelNote.textContent).toContain("No model list from opencode models");
  expect(card.modelNote.textContent).toContain("not signed in");
  expect(card.modelNote.textContent).toMatch(/Type a model name/);
  // A device that has not reported any lists yet says that, instead of leaving a blank select unexplained.
  const old = device({ models: {}, modelInfo: {} });
  const card2 = buildDeviceCard(old);
  updateDeviceCard(card2, old);
  expect(card2.modelNote.textContent).toMatch(/No model list from this device for Claude Code/);
});

test("a custom connector that runs Hermes gets Hermes's model list, with a manual fallback", () => {
  const { buildDeviceCard, updateDeviceCard } = devicesForm();
  const d = device({
    harnesses: [{ id: "custom", label: "Your own tool", path: null }],
    models: { hermes: ["anthropic/claude-opus-4.6", "openai/gpt-5.5"] },
    modelInfo: { hermes: { source: "Hermes's own static provider catalog (read offline with its Python, no model call)", found: 2, at: 1 } },
  });
  const card = buildDeviceCard(d);
  updateDeviceCard(card, d);
  expect(card.modelL.hidden).toBe(false);                        // a custom tool may take a model; until Hermes is named there is no list
  expect(card.f.modelSel.children.map((o: any) => o.attrs.value)).toEqual(["", "__other"]);
  card.f.run.value = "hermes chat -q {prompt} -m {model}";
  card.f.run.dispatchEvent({ type: "input" });
  expect(card.modelL.hidden).toBe(false);
  expect(card.f.modelSel.children.map((o: any) => o.attrs.value)).toEqual(["", "anthropic/claude-opus-4.6", "openai/gpt-5.5", "__other"]);
  expect(card.modelNote.textContent).toContain("static provider catalog");
  expect(card.modelNote.textContent).toContain("{model}");
});

test("the Devices page keeps Hermes catalog-only: no Hermes option in the launch tool list", () => {
  const ui = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  expect(ui).toContain('h.id === "custom" && /\\bhermes\\b/i.test(f.run.value');
  expect(ui).toContain('const sourceId = hermes ? "hermes" : h.id');
  expect(ui).toContain("The command uses {model}: choose a model");
  expect(ui).toContain('"safe: read-only sandbox + fleet tools"');   // Codex safe is a sandbox, not a blank "fleet tools only"
});

test("a custom launch whose command uses {model} is refused without a model before any agent is created or rotated", async () => {
  const d = await newDevice("model-required");
  await report(d.dev);
  const before = store.listAgents().length;
  const refused = async (body: object) => {
    const r = await post(`/api/devices/${d.id}/launch`, body);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toMatch(/\{model\}/);
  };
  await refused({ name: "no-model-new", harness: "custom", dir: "/work/x", permissions: "open", runCmd: "bot {prompt} -m {model}" });
  expect(store.listAgents().length).toBe(before);                      // nothing was created
  expect(store.listAgents().some((a) => a.name === "no-model-new")).toBe(false);
  const existing = store.addAgent({ name: "no-model-existing", owner: "alper", device: "d", skills: [] });
  const requests = store.listDeviceRequests().length;
  await refused({ asAgent: "no-model-existing", harness: "custom", dir: "/work/x", permissions: "open", resumeCmd: "bot --resume {session} -m {model}" });
  expect(store.agentByToken(existing.token)?.id).toBe(existing.id);    // its token was not rotated
  expect(store.listDeviceRequests().length).toBe(requests);            // and no launch was queued
});

test("the state ties each device and each launch request to the agent it started, so the UI can show only the workspace being looked at", async () => {
  const d = await newDevice("scoped");
  await report(d.dev);
  await post("/api/workspaces", { name: "other-ws" });
  await post(`/api/devices/${d.id}/launch`, { name: "scope-a", harness: "claude", dir: "/work/a", permissions: "safe" });
  await post(`/api/devices/${d.id}/launch`, { name: "scope-b", harness: "claude", dir: "/work/b", permissions: "safe", workspace: "other-ws" });
  const s = await state();
  const wsOf = (name: string) => s.agents.find((a: any) => a.name === name).workspaceId;
  const ids = (name: string) => s.agents.find((a: any) => a.name === name).id;
  expect(wsOf("scope-a")).not.toBe(wsOf("scope-b"));
  expect(s.devices.find((x: any) => x.id === d.id).agentIds.sort()).toEqual([ids("scope-a"), ids("scope-b")].sort());
  const byAgent = s.deviceRequests.filter((r: any) => r.deviceId === d.id).map((r: any) => r.agentId).sort();
  expect(byAgent).toEqual([ids("scope-a"), ids("scope-b")].sort());
});
