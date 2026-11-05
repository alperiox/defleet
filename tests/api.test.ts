import { DOC } from "./fixtures";
import { test, expect, afterAll } from "bun:test";
import { Hono } from "hono";
import { openStore } from "../src/store";
import { Hub, HUMAN } from "../src/hub";
import { mountApi } from "../src/api";

const store = openStore(":memory:");
const hub = new Hub(store);
const app = new Hono();
mountApi(app, hub, store, "human-secret");
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

const { id: aId } = store.addAgent({ name: "claude-laptop", owner: "alper", device: "laptop", skills: [] });
const agent = store.agentById(aId)!;
const auth = { Authorization: "Bearer human-secret", "content-type": "application/json" };

test("unauthenticated /api/state and query tokens are 401; bearer auth works", async () => {
  expect((await fetch(`${base}/api/state`)).status).toBe(401);
  expect((await fetch(`${base}/api/state`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await fetch(`${base}/api/state?token=human-secret`)).status).toBe(401);
  expect((await fetch(`${base}/api/state`, { headers: auth })).status).toBe(200);
});

test("state lists agents without their tokens", async () => {
  const s = await (await fetch(`${base}/api/state`, { headers: auth })).json();
  expect(s.agents[0].name).toBe("claude-laptop");
  expect(JSON.stringify(s)).not.toContain("token");
});

test("answering a request over REST puts the answer in the asking agent's inbox", async () => {
  const r = hub.askHuman(agent, { kind: "decision", text: "jsonl or parquet?" });
  const res = await fetch(`${base}/api/requests/${r.id}/answer`, { method: "POST", headers: auth, body: JSON.stringify({ answer: "parquet, because columnar" }) });
  expect(res.status).toBe(200);
  expect(hub.inbox(agent).answers.map((a) => a.answer)).toEqual(["parquet, because columnar"]);
});

test("answering an already-answered request is a 409", async () => {
  const r = hub.askHuman(agent, { kind: "decision", text: "again?" });
  hub.humanAnswer(r.id, "yes");
  const res = await fetch(`${base}/api/requests/${r.id}/answer`, { method: "POST", headers: auth, body: JSON.stringify({ answer: "no" }) });
  expect(res.status).toBe(409);
});

test("posting to /api/room stores a message from the human", async () => {
  await fetch(`${base}/api/room`, { method: "POST", headers: auth, body: JSON.stringify({ text: "hello fleet" }) });
  const last = store.messagesSince("room", 0).at(-1)!;
  expect(last.text).toBe("hello fleet");
  expect(last.from).toBe(HUMAN);
});

test("creating a task over REST assigns it by agent name", async () => {
  const res = await fetch(`${base}/api/tasks`, { method: "POST", headers: auth, body: JSON.stringify({ title: "build dashboard", project: "dash", assignee: "claude-laptop" }) });
  expect(res.status).toBe(200);
  const t = await res.json();
  expect(t.assignee).toBe(aId);
  expect(t.aiGenerated).toBe(false);
});

test("the SSE stream emits a change event within 500ms of a task being created", async () => {
  const ticket = await (await fetch(`${base}/api/events/ticket`, { method: "POST", headers: auth })).json();
  const res = await fetch(`${base}/api/events?ticket=${ticket.ticket}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  hub.createTask(agent, { ...DOC, title: "live", project: "dash" });
  let seen = "";
  while (!seen.includes("event: change")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += dec.decode(value);
  }
  expect(seen).toContain("event: change");
  expect(Date.now() - t0).toBeLessThan(500);
  await reader.cancel();
});

test("state includes DMs between agents and the human, and the human can DM an agent", async () => {
  hub.say(agent, "dm:human", "private hello");
  const res = await fetch(`${base}/api/dm/claude-laptop`, { method: "POST", headers: auth, body: JSON.stringify({ text: "got it, thanks" }) });
  expect(res.status).toBe(200);
  const s = await (await fetch(`${base}/api/state`, { headers: auth })).json();
  expect(s.dms.map((m: any) => m.text)).toEqual(["private hello", "got it, thanks"]);
});

test("DM to an unknown agent is a 400", async () => {
  const res = await fetch(`${base}/api/dm/nobody`, { method: "POST", headers: auth, body: JSON.stringify({ text: "hi" }) });
  expect(res.status).toBe(400);
});

test("the human can free a stuck task over REST", async () => {
  const t = hub.createTask(agent, { ...DOC, title: "stuck", project: "dash" });
  hub.claim(agent, t.id);
  const res = await fetch(`${base}/api/tasks/${t.id}/release`, { method: "POST", headers: auth, body: "{}" });
  expect(res.status).toBe(200);
  expect(store.getTask(t.id)!.claimedBy).toBeNull();
});

test("state carries task keys and descriptions, the task history, evidence, and agent-to-agent threads", async () => {
  const other = store.agentById(store.addAgent({ name: "opencode-mac", owner: "alper", device: "mac", skills: [] }).id)!;
  const t = hub.createTask(agent, { ...DOC, title: "visible", project: "vis" });
  hub.claim(agent, t.id);
  hub.postStatus(agent, t.id, "in_progress", "halfway there");
  hub.attachEvidence(agent, t.id, { kind: "test-output", ref: "bun test" });
  hub.say(agent, "dm:opencode-mac", "agent chatter that the human should be able to read");
  hub.say(agent, "dm:human", "private to the human");
  const s = await (await fetch(`${base}/api/state`, { headers: auth })).json();
  const task = s.tasks.find((x: any) => x.id === t.id);
  expect(task.key).toBe("VIS-1");
  expect(task.description).toBe(DOC.description);
  expect(s.taskEvents.filter((e: any) => e.taskId === t.id).map((e: any) => e.kind)).toEqual(["created", "claimed", "status", "evidence"]);
  expect(s.evidence.find((e: any) => e.taskId === t.id).ref).toBe("bun test");
  const texts = s.agentDms.map((m: any) => m.text);
  expect(texts).toContain("agent chatter that the human should be able to read");
  expect(texts).not.toContain("private to the human");
  expect(other.name).toBe("opencode-mac");
});

test("a lost agent token can be replaced: the new one works, the old one stops, the agent keeps its identity and history", async () => {
  const { id, token: oldToken } = store.addAgent({ name: "lost-token", owner: "alper", device: "laptop", skills: [] });
  expect((await fetch(`${base}/api/agents/lost-token/token`, { method: "POST" })).status).toBe(401);          // needs the human token
  const res = await fetch(`${base}/api/agents/lost-token/token`, { method: "POST", headers: auth });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.token).toBeTruthy();
  expect(body.token).not.toBe(oldToken);
  expect(store.agentByToken(body.token)?.id).toBe(id);        // same agent
  expect(store.agentByToken(oldToken)).toBeNull();            // the old token is dead
  expect((await fetch(`${base}/api/agents/nobody/token`, { method: "POST", headers: auth })).status).toBe(404);
  expect(JSON.stringify(await (await fetch(`${base}/api/state`, { headers: auth })).json())).not.toContain(body.token);
});

test("a revoked agent cannot be given a new token", async () => {
  store.addAgent({ name: "gone", owner: "alper", device: "x", skills: [] });
  store.revokeAgent("gone");
  expect((await fetch(`${base}/api/agents/gone/token`, { method: "POST", headers: auth })).status).toBe(404);
});

test("a task created by the human can carry a description and acceptance criteria, which agents then read", async () => {
  const res = await fetch(`${base}/api/tasks`, { method: "POST", headers: auth, body: JSON.stringify({ title: "modernize the pilot ui", project: "kapi", description: "Restyle public/panel.html: cards, status pills, phone layout at 390px.", acceptance: "No sideways scroll at 390px; screenshots attached." }) });
  expect(res.status).toBe(200);
  const task: any = await res.json();
  expect(task.description).toMatch(/phone layout/);
  expect(task.acceptance).toMatch(/390px/);
  const state: any = await (await fetch(`${base}/api/state`, { headers: auth })).json();
  expect(state.tasks.find((t: any) => t.id === task.id).description).toMatch(/phone layout/);
});

test("description and acceptance stay optional for the human, and non-text values are refused", async () => {
  const bare = await fetch(`${base}/api/tasks`, { method: "POST", headers: auth, body: JSON.stringify({ title: "quick one", project: "kapi" }) });
  expect(bare.status).toBe(200);
  const bad = await fetch(`${base}/api/tasks`, { method: "POST", headers: auth, body: JSON.stringify({ title: "x", project: "kapi", description: { a: 1 } }) });
  expect(bad.status).toBe(400);
});


test("JSON null bodies return 400 instead of throwing in required-body routes", async () => {
  for (const path of ["/api/room", "/api/dm/claude-laptop", "/api/tasks", "/api/requests/missing/answer", "/api/agents"]) {
    const res = await fetch(base + path, { method: "POST", headers: auth, body: "null" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  }
});

test("human and you cannot be registered through either agent creation route", async () => {
  for (const name of ["human", "you"]) for (const path of ["/api/agents", "/api/agents/prompt"]) {
    const res = await fetch(base + path, { method: "POST", headers: auth, body: JSON.stringify({ name }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("reserved");
  }
  expect(store.listAgents().some(a => ["human", "you"].includes(a.name))).toBe(false);
});
