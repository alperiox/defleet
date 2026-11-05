import { test, expect, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { DOC } from "./fixtures";

const { app, hub, store } = createApp(":memory:", "human-secret", { hubOwner: "alper" });
const server = Bun.serve({ port: 0, fetch: app.fetch });
afterAll(() => server.stop(true));
const base = `http://localhost:${server.port}`;
const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };
const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: "POST", headers: human, body: JSON.stringify(body ?? {}) });

const han = hub.createWorkspace("han-test");
const shop = hub.createWorkspace("shop");
const mk = (name: string, workspaceId?: string) => { const r = store.addAgent({ name, owner: "alper", device: "d", skills: [], workspaceId }); return store.agentById(r.id)!; };
const claude = mk("claude-laptop", han.id), opencode = mk("opencode-mac", han.id), shopper = mk("shop-agent", shop.id);

test("there is always a default workspace, and an agent made without one belongs to it", () => {
  const names = store.listWorkspaces().map((w) => w.name);
  expect(names).toContain("Default");
  const legacy = mk("legacy-agent");
  expect(legacy.workspaceId).toBe(store.defaultWorkspace().id);
});

test("workspace names are unique regardless of case, must have text, and can be renamed", () => {
  expect(() => hub.createWorkspace("HAN-TEST")).toThrow(/already exists/i);
  expect(() => hub.createWorkspace("   ")).toThrow(/name/i);
  expect(() => hub.createWorkspace("x".repeat(61))).toThrow(/name/i);
  const w = hub.createWorkspace("scratch");
  expect(hub.renameWorkspace(w.id, "sandbox").name).toBe("sandbox");
  expect(() => hub.renameWorkspace(w.id, "shop")).toThrow(/already exists/i);
});

test("a project belongs to the workspace of whoever creates it first, and its name is unique across all workspaces", () => {
  const t = hub.createTask(claude, { title: "panel", project: "kapi", ...DOC });
  expect(store.projectWorkspace("kapi")).toBe(han.id);
  expect(hub.taskDetail(t.id, claude).task.project).toBe("kapi");
  expect(() => hub.createTask(shopper, { title: "x", project: "kapi", ...DOC })).toThrow(/no access/i);
});

test("an agent sees and claims only the tasks of its own workspace", () => {
  const mine = hub.createTask(claude, { title: "in han-test", project: "kapi", ...DOC });
  const theirs = hub.createTask(shopper, { title: "in shop", project: "checkout", ...DOC });
  expect(hub.listTasksFor(opencode).map((t) => t.id)).toContain(mine.id);
  expect(hub.listTasksFor(opencode).map((t) => t.id)).not.toContain(theirs.id);
  expect(hub.listTasksFor(shopper).map((t) => t.id)).not.toContain(mine.id);
  expect(() => hub.claim(opencode, theirs.id)).toThrow(/no such task/i);
  // work is delivered only inside the workspace
  const delivered = hub.pull(opencode).items.filter((i: any) => i.type === "task").map((i: any) => i.task.id);
  expect(delivered).toContain(mine.id);
  expect(delivered).not.toContain(theirs.id);
  expect(hub.claim(opencode, mine.id).claimedBy).toBe(opencode.id);
});

test("the human creates a task in a workspace: a new project lands there, an existing one keeps its workspace, and a clash is explained", () => {
  const fresh = hub.humanCreateTask({ title: "new thing", project: "brand-new", workspaceId: shop.id });
  expect(store.projectWorkspace("brand-new")).toBe(shop.id);
  expect(fresh.project).toBe("brand-new");
  expect(() => hub.humanCreateTask({ title: "clash", project: "kapi", workspaceId: shop.id })).toThrow(/belongs to workspace han-test/);
  expect(hub.humanCreateTask({ title: "no workspace given", project: "kapi" }).project).toBe("kapi");   // the project decides
  expect(() => hub.humanCreateTask({ title: "wrong agent", project: "kapi", assignee: "shop-agent" })).toThrow(/works in workspace shop/);
});

test("each workspace has its own room: messages and @all stay inside it", () => {
  hub.say(claude, "room", "@opencode-mac the panel is in kapi-demo");
  expect(hub.readThread(opencode, "room", 0).some((m) => /kapi-demo/.test(m.text))).toBe(true);
  expect(hub.readThread(shopper, "room", 0).some((m) => /kapi-demo/.test(m.text))).toBe(false);
  const m = hub.humanSay("@all status please", shop.id);
  expect(hub.deliveryFor(m).map((d) => d.agent)).toEqual(["shop-agent"]);
  expect(hub.pull(shopper).items.some((i: any) => i.type === "message" && i.message.id === m.id)).toBe(true);
  expect(hub.pull(claude).items.some((i: any) => i.type === "message" && i.message.id === m.id)).toBe(false);
});

test("the original room is the default workspace's room, so old messages stay where they were", () => {
  const legacy = store.agentById(store.addAgent({ name: "old-timer", owner: "alper", device: "d", skills: [] }).id)!;
  const m = hub.humanSay("hello default room");
  expect(m.thread).toBe("room");
  expect(hub.readThread(legacy, "room", 0).some((x) => x.id === m.id)).toBe(true);
});

test("agents cannot message agents in another workspace, but the human can message anyone", () => {
  expect(() => hub.say(claude, "dm:shop-agent", "hi")).toThrow(/other workspace/i);
  expect(hub.humanDm("shop-agent", "hello").thread).toContain("dm:");
  expect(hub.say(claude, "dm:opencode-mac", "same workspace is fine").thread).toContain("dm:");
});

test("an agent can move to another workspace only when it holds nothing", () => {
  const busy = mk("busy-agent", han.id);
  const t = hub.createTask(claude, { title: "held work", project: "kapi", ...DOC });
  hub.claim(busy, t.id);
  expect(() => hub.moveAgent("busy-agent", "shop")).toThrow(/holds/i);
  hub.humanRelease(t.id);
  expect(hub.moveAgent("busy-agent", "shop").workspaceId).toBe(shop.id);
  expect(() => hub.moveAgent("busy-agent", "nowhere")).toThrow(/no workspace/i);
});

test("over HTTP: create a workspace, add an agent to it, post to its room, and read all of it back", async () => {
  expect((await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "api-ws" }) })).status).toBe(401);
  const ws: any = await (await post("/api/workspaces", { name: "api-ws" })).json();
  expect(ws.name).toBe("api-ws");
  expect((await post("/api/workspaces", { name: "api-ws" })).status).toBe(409);
  const added: any = await (await post("/api/agents", { name: "ws-agent", workspace: "api-ws" })).json();
  expect(added.workspace).toBe("api-ws");
  expect((await post("/api/agents", { name: "bad-ws-agent", workspace: "missing" })).status).toBe(400);
  await post("/api/room", { text: "@ws-agent hello", workspace: ws.id });
  const state: any = await (await fetch(`${base}/api/state`, { headers: human })).json();
  expect(state.workspaces.map((w: any) => w.name)).toContain("api-ws");
  expect(state.agents.find((a: any) => a.name === "ws-agent").workspaceId).toBe(ws.id);
  expect(state.room.find((m: any) => /@ws-agent hello/.test(m.text)).workspace).toBe(ws.id);
  await post("/api/tasks", { title: "api task", project: "api-proj", workspace: ws.id });
  const s2: any = await (await fetch(`${base}/api/state`, { headers: human })).json();
  expect(s2.tasks.find((t: any) => t.project === "api-proj").workspaceId).toBe(ws.id);
  expect((await post("/api/agents/ws-agent/workspace", { workspace: "shop" })).status).toBe(200);
  expect((await post("/api/workspaces/" + ws.id + "/rename", { name: "renamed-ws" })).status).toBe(200);
});
