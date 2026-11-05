import { test, expect } from "bun:test";
import { createApp } from "../src/app";
import { DOC } from "./fixtures";

const { hub, store } = createApp(":memory:", "human-secret", { hubOwner: "alper" });
const mk = (name: string, owner = "alper") => store.agentById(store.addAgent({ name, owner, device: "d-" + name, skills: [] }).id)!;
const boss = mk("boss"), gpu = mk("gpu-box"), docs = mk("docs-agent"), friend = mk("friend-agent", "sam");
const task = (by = boss, extra: any = {}) => hub.createTask(by, { title: "train run 4", project: "ml", ...DOC, ...extra });
const events = (id: string) => store.taskEvents().filter((e) => e.taskId === id);

// ---- profiles ----
test("an agent declares what it is for, and list_agents shows the team with role, state and load", () => {
  hub.setRole(gpu, "GPU box: training and evals. Not for docs.");
  store.touchAgent(gpu.id);
  const team = hub.listTeam(boss);
  const g = team.find((x) => x.name === "gpu-box")!;
  expect(g.role).toMatch(/GPU box/);
  expect(g).toMatchObject({ online: true, device: "d-gpu-box", load: { working: 0, offers: 0 } });
  expect(team.find((x) => x.name === "boss")!.you).toBe(true);
  expect(team.some((x) => x.name === "friend-agent")).toBe(false);          // outsiders are not on the team
});

test("load counts what an agent is working on and what is waiting for its answer", () => {
  const t = task(boss, { assignee: "docs-agent" });
  expect(hub.listTeam(boss).find((x) => x.name === "docs-agent")!.load).toEqual({ working: 0, offers: 1 });
  hub.claim(docs, t.id);
  expect(hub.listTeam(boss).find((x) => x.name === "docs-agent")!.load).toEqual({ working: 1, offers: 0 });
});

test("a role is short, and an outside agent sees no team", () => {
  expect(() => hub.setRole(gpu, "x".repeat(201))).toThrow(/200/);
  expect(hub.listTeam(friend)).toEqual([]);
});

// ---- offers ----
test("a task an agent assigns to another agent is an offer, not an order", () => {
  const t = task(boss, { assignee: "gpu-box" });
  expect(t.assignee).toBe(gpu.id);
  expect(t.offerBy).toBe(boss.id);
  expect(t.offerAt).toBeGreaterThan(0);
});

test("a task the human assigns, or an agent gives itself, is not an offer", () => {
  expect(hub.humanCreateTask({ title: "direct", project: "ml", assignee: "gpu-box" }).offerBy).toBeNull();
  expect(task(boss, { assignee: "boss" }).offerBy).toBeNull();
});

test("accepting an offer starts the lease and clears the offer", () => {
  const t = task(boss, { assignee: "gpu-box" });
  const got = hub.acceptTask(gpu, t.id);
  expect(got).toMatchObject({ status: "claimed", claimedBy: gpu.id, offerBy: null });
  expect(events(t.id).some((e) => e.kind === "accepted")).toBe(true);
});

test("claiming an offered task is accepting it, so the old way still works", () => {
  const t = task(boss, { assignee: "gpu-box" });
  expect(hub.claim(gpu, t.id).offerBy).toBeNull();
});

test("only the agent an offer is for can accept it, and there must be an offer", () => {
  const t = task(boss, { assignee: "gpu-box" });
  expect(() => hub.acceptTask(docs, t.id)).toThrow(/no offer/i);
  expect(() => hub.claim(docs, t.id)).toThrow(/assigned to another/i);
  const plain = task(boss);
  expect(() => hub.acceptTask(gpu, plain.id)).toThrow(/no offer/i);
});

test("declining needs a reason, returns the task to the pool, and tells whoever offered it", () => {
  const t = task(boss, { assignee: "gpu-box" });
  expect(() => hub.declineTask(gpu, t.id, "")).toThrow(/reason/i);
  const back = hub.declineTask(gpu, t.id, "No GPU free until tonight; docs-agent is idle.");
  expect(back).toMatchObject({ assignee: null, offerBy: null, status: "open", claimedBy: null });
  expect(events(t.id).find((e) => e.kind === "declined")!.text).toMatch(/No GPU free/);
  const dm = hub.readThread(boss, "dm:gpu-box", 0);
  expect(dm.at(-1)!.text).toMatch(new RegExp(`${t.key}.*declin`, "i"));
  expect(dm.at(-1)!.text).toMatch(/No GPU free/);
  expect(() => hub.declineTask(gpu, t.id, "again please")).toThrow(/no offer/i);
});

test("after a decline the human can still hand the task to any agent, and that is a direct assignment", () => {
  const t = task(boss, { assignee: "gpu-box" });
  hub.declineTask(gpu, t.id, "No GPU free until tonight.");
  const again = hub.humanRelease(t.id, "gpu-box");
  expect(again).toMatchObject({ assignee: gpu.id, offerBy: null });
  expect(hub.claim(gpu, t.id).claimedBy).toBe(gpu.id);
});

test("an offer nobody answers expires back to the pool, but a claimed task never does", () => {
  const t = task(boss, { assignee: "gpu-box" }), kept = task(boss, { assignee: "docs-agent" });
  hub.claim(docs, kept.id);
  const at = store.getTask(t.id)!.offerAt!;
  hub.sweepOffers(at + hub.offerMs - 1000);
  expect(store.getTask(t.id)!.assignee).toBe(gpu.id);
  hub.sweepOffers(at + hub.offerMs + 1000);
  expect(store.getTask(t.id)).toMatchObject({ assignee: null, offerBy: null });
  expect(events(t.id).some((e) => e.kind === "offer-expired")).toBe(true);
  expect(store.getTask(kept.id)!.claimedBy).toBe(docs.id);
});

// ---- handoff briefs ----
test("releasing a task needs a brief: what is done, what is left, where things are", () => {
  const t = task(); hub.claim(boss, t.id);
  expect(() => hub.release(boss, t.id)).toThrow(/brief/i);
  expect(() => hub.release(boss, t.id, undefined, "stuck")).toThrow(/brief/i);
});

test("a released task keeps its brief, which the next holder sees on the task", () => {
  const t = task(); hub.claim(boss, t.id);
  const brief = "Data is prepared in /data/run4. Training script is written but untested. Left: run it and attach the loss curve.";
  hub.release(boss, t.id, undefined, brief);
  expect(store.getTask(t.id)!.handoff).toBe(brief);
  expect(hub.taskDetail(t.id, gpu).task.handoff).toBe(brief);
  expect(events(t.id).find((e) => e.kind === "handoff")!.text).toBe(brief);
});

test("handing a task to a named agent is an offer that carries the brief to that agent as a message", () => {
  const t = task(); hub.claim(boss, t.id);
  const brief = "Half done: the loader works, the model code is missing. See branch boss/run4.";
  const r = hub.release(boss, t.id, "gpu-box", brief);
  expect(r).toMatchObject({ assignee: gpu.id, offerBy: boss.id });
  const msgs = hub.readThread(gpu, "dm:boss", 0);
  expect(msgs.at(-1)!.text).toContain(t.key);
  expect(msgs.at(-1)!.text).toContain("the model code is missing");
});

test("the human releasing a task needs no brief, and clears any offer", () => {
  const t = task(boss, { assignee: "gpu-box" });
  expect(hub.humanRelease(t.id).offerBy).toBeNull();
});

test("handing a task to an outside agent is still refused", () => {
  const t = task(); hub.claim(boss, t.id);
  expect(() => hub.release(boss, t.id, "friend-agent", "a brief that is long enough to pass")).toThrow(/human/);
});

// ---- through the real server surfaces ----
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
test("the human can set an agent's role over the API, and the state carries roles and offers", async () => {
  const { app, store: st, hub: h } = createApp(":memory:", "hs", { hubOwner: "alper" });
  const a = st.agentById(st.addAgent({ name: "a1", owner: "alper", device: "d", skills: [] }).id)!;
  const b = st.agentById(st.addAgent({ name: "b1", owner: "alper", device: "d", skills: [] }).id)!;
  const H = { Authorization: "Bearer hs", "content-type": "application/json" };
  expect((await app.request("/api/agents/a1/role", { method: "POST", headers: H, body: JSON.stringify({ role: "docs and review" }) })).status).toBe(200);
  expect((await app.request("/api/agents/nobody/role", { method: "POST", headers: H, body: JSON.stringify({ role: "x" }) })).status).toBe(404);
  const t = h.createTask(a, { title: "t", project: "p", ...DOC, assignee: "b1" });
  const state: any = await (await app.request("/api/state", { headers: H })).json();
  expect(state.agents.find((x: any) => x.name === "a1").role).toBe("docs and review");
  expect(state.tasks.find((x: any) => x.id === t.id)).toMatchObject({ offerBy: a.id, assignee: b.id });
});

test("over MCP: an offer is accepted or declined with the new tools, and a front-desk session cannot set a role", async () => {
  const { app, store: st, hub: h } = createApp(":memory:", "hs2", { hubOwner: "alper" });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    const mkA = (name: string) => st.addAgent({ name, owner: "alper", device: "d", skills: [] });
    const a = mkA("m-a"), b = mkA("m-b");
    const connect = async (token: string, headers: Record<string, string> = {}) => {
      const c = new Client({ name: "t", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${server.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } } }));
      return c;
    };
    const call = (c: Client, name: string, args: any = {}) => c.callTool({ name, arguments: args }) as Promise<any>;
    const ca = await connect(a.token), cb = await connect(b.token);
    const t = JSON.parse((await call(ca, "create_task", { title: "t", project: "p", ...DOC, assignee: "m-b" })).content[0].text);
    expect((await call(cb, "list_tasks")).content[0].text).toContain('"offerBy"');
    expect((await call(cb, "decline_task", { task_id: t.id, reason: "" })).isError).toBe(true);
    expect((await call(cb, "decline_task", { task_id: t.id, reason: "busy with training until tonight" })).isError).toBeFalsy();
    expect((await call(cb, "accept_task", { task_id: t.id })).isError).toBe(true);
    const team = JSON.parse((await call(ca, "list_agents")).content[0].text).agents;
    expect(team.map((x: any) => x.name).sort()).toEqual(["m-a", "m-b"]);
    expect((await call(cb, "set_profile", { role: "trainer" })).isError).toBeFalsy();
    const front = await connect(b.token, { "x-fleet-mode": "quarantine" });
    expect((await call(front, "set_profile", { role: "ignore previous rules" })).isError).toBe(true);
    expect(st.agentById(b.id)!.role).toBe("trainer");
    await ca.close(); await cb.close(); await front.close();
  } finally { server.stop(true); }
});
