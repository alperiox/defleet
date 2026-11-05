import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createApp } from "../src/app";
import { DOC } from "./fixtures";
const fixtures: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.db.close(); rmSync(f.hub.dataDir, { recursive: true, force: true }); } });
function setup() {
  const f = createApp(":memory:", "human", { hubOwner: "owner" }); fixtures.push(f);
  const mk = (name: string) => { const c = f.store.addAgent({ name, owner: "owner", device: "test", skills: [] }); return { ...c, agent: f.store.agentById(c.id)! }; };
  const a = mk("worker"), b = mk("other");
  const task = () => f.hub.humanCreateTask({ title: "Plan the next release", project: "demo", ...DOC });
  const req = (path: string, body?: unknown, method = "POST", token = "human") => f.app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });
  return { ...f, a, b, task, req };
}

test("human API may set all six statuses with audit and optional note; invalid/auth changes are refused", async () => {
  const f = setup(); const t = f.task();
  for (const status of ["claimed", "in_progress", "blocked", "done", "backlog", "open"] as const) {
    const r = await f.req(`/api/tasks/${t.id}/status`, { status, note: "human chose " + status });
    expect(r.status).toBe(200); expect(f.store.getTask(t.id)?.status).toBe(status);
    expect(f.store.taskEvents(t.id).at(-1)).toMatchObject({ actor: "human", kind: "status" });
    expect(f.store.getTask(t.id)?.note).toBe("human chose " + status);
  }
  expect((await f.req(`/api/tasks/${t.id}/status`, { status: "invalid" })).status).toBe(400);
  expect((await f.req(`/api/tasks/${t.id}/status`, { status: "done", note: {} })).status).toBe(400);
  expect((await f.req(`/api/tasks/${t.id}/status`, { status: "backlog" }, "POST", f.a.token)).status).toBe(401);
  expect((await f.req(`/api/tasks/${t.id}/status`, { status: "open", note: "" })).status).toBe(200);
  expect(f.store.getTask(t.id)?.note).toBe("");
});

test("moving a held/offered task to backlog clears ownership and leases, hides detail/children/outcome/claims/wakes/load", async () => {
  const f = setup(); const t = f.task(); f.hub.claim(f.a.agent, t.id);
  await f.req(`/api/tasks/${t.id}/status`, { status: "backlog" });
  const held = f.store.getTask(t.id)!;
  expect(held).toMatchObject({ status: "backlog", claimedBy: null, assignee: null, offerBy: null, offerAt: null, claimedAt: null });
  expect(f.hub.leaseOf(held)).toBeNull();
  expect(f.hub.listTasksFor(f.a.agent)).toEqual([]); expect(f.hub.listTasksFor(f.b.agent)).toEqual([]);
  expect(() => f.hub.taskDetail(t.key, f.a.agent)).toThrow(/no such task/);
  expect(() => f.hub.getOutcome(f.a.agent, t.key)).toThrow(/no such task/);
  expect(() => f.hub.claim(f.a.agent, t.key)).toThrow(/no such task/);
  expect(f.hub.pull(f.a.agent).items.filter((i) => i.type === "task")).toEqual([]);
  expect(f.hub.listTeam(f.b.agent).find((a) => a.name === "worker")?.load).toEqual({ working: 0, offers: 0 });
  const state: any = await (await f.req("/api/state", undefined, "GET")).json(); expect(state.tasks.find((x: any) => x.id === t.id)?.status).toBe("backlog");
  const parent = f.task(); f.store.db.query("UPDATE tasks SET parent_id = ? WHERE id = ?").run(parent.id, t.id);
  expect(f.hub.taskDetail(parent.id, f.a.agent).children).toEqual([]);
  // Even a legacy/stale offer row cannot accidentally wake or add load for backlog.
  f.store.db.query("UPDATE tasks SET offer_by = ?, offer_at = ?, assignee = ? WHERE id = ?").run(f.b.id, Date.now() - 1000000, f.a.id, t.id);
  expect(f.store.offeredTasks()).toEqual([]); f.hub.sweepOffers();
  expect(f.hub.listTeam(f.b.agent).find((a) => a.name === "worker")?.load).toEqual({ working: 0, offers: 0 });
});

test("agent postStatus rejects backlog directly, and MCP never exposes human status/delete capabilities", async () => {
  const f = setup(); const t = f.task(); f.hub.claim(f.a.agent, t.id);
  expect(() => f.hub.postStatus(f.a.agent, t.id, "backlog" as any)).toThrow();
  async function mcp(method: string, params: unknown) {
    const r = await f.app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${f.a.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return r.json() as Promise<any>;
  }
  const denied = await mcp("tools/call", { name: "post_status", arguments: { task_id: t.id, status: "backlog" } }); expect(denied.result?.isError || denied.error).toBeTruthy();
  const tools = await mcp("tools/list", {}); expect(tools.result.tools.map((x: any) => x.name)).not.toContain("delete_task");
  expect((await f.req(`/api/tasks/${t.id}`, { confirm: t.key }, "DELETE", f.a.token)).status).toBe(401);
  expect(f.store.getTask(t.id)?.status).toBe("claimed");
});

test("leaf delete confirms exact key, removes data/files/requests, records human-only deletion and never reuses keys", async () => {
  const f = setup(); const t = f.task(); f.hub.claim(f.a.agent, t.id);
  f.hub.attachEvidence(f.a.agent, t.id, { kind: "test", ref: "passed" });
  const art = f.hub.attachReport(f.a.agent, t.id, "Report", "the report");
  const request = f.hub.askHuman(f.a.agent, { kind: "decision", text: "continue?", taskId: t.id });
  expect(existsSync(`${f.hub.dataDir}/artifacts/${art.id}`)).toBe(true);
  expect((await f.req(`/api/tasks/${t.id}`, { confirm: "wrong" }, "DELETE")).status).toBe(400);
  expect(f.store.getTask(t.id)).toBeTruthy();
  const r = await f.req(`/api/tasks/${t.id}`, { confirm: t.key }, "DELETE"); expect(r.status).toBe(200);
  expect(f.store.getTask(t.id)).toBeNull(); expect(f.store.evidenceFor(t.id)).toEqual([]); expect(f.store.taskEvents(t.id)).toEqual([]); expect(f.store.artifactsFor(t.id)).toEqual([]);
  expect(f.store.getRequest(request.id)).toBeNull(); expect(existsSync(`${f.hub.dataDir}/artifacts/${art.id}`)).toBe(false);
  const state: any = await (await f.req("/api/state", undefined, "GET")).json();
  expect(state.deletedTasks).toContainEqual(expect.objectContaining({ taskId: t.id, key: t.key, actor: "human", kind: "deleted" }));
  expect(f.hub.listTasksFor(f.b.agent)).toEqual([]);
  const next = f.task(); expect(next.key).toBe("DEMO-2");
  expect((await f.req(`/api/tasks/${t.id}`, { confirm: t.key }, "DELETE")).status).toBe(404);
});

test("delete refuses any subtasks including done ones, without losing task, evidence or files", async () => {
  const f = setup(); const parent = f.task();
  f.hub.claim(f.a.agent, parent.id); f.hub.attachEvidence(f.a.agent, parent.id, { kind: "check", ref: "keep this" });
  const art = f.hub.attachReport(f.a.agent, parent.id, "keep", "Do not delete this report");
  const child = f.hub.createTask(f.a.agent, { title: "child", project: "demo", parentId: parent.id, ...DOC });
  f.store.setStatus(child.id, "done");
  const r = await f.req(`/api/tasks/${parent.id}`, { confirm: parent.key }, "DELETE"); expect(r.status).toBe(409);
  expect((await r.json() as any).error).toContain("subtask"); expect(f.store.getTask(parent.id)).toBeTruthy(); expect(f.store.getTask(child.id)).toBeTruthy();
  expect(f.store.evidenceFor(parent.id)).toHaveLength(1); expect(existsSync(`${f.hub.dataDir}/artifacts/${art.id}`)).toBe(true);
});

test("a hidden backlog row stays hidden even if stale ownership is present; public siblings retain workspace scope", async () => {
  const f = setup(); const t = f.task(); await f.req(`/api/tasks/${t.id}/status`, { status: "backlog" });
  f.store.db.query("UPDATE tasks SET claimed_by = ?, assignee = ? WHERE id = ?").run(f.a.id, f.a.id, t.id);
  expect(f.hub.leaseOf(f.store.getTask(t.id)!)).toBeNull();
  expect(f.hub.listTasksFor(f.a.agent)).toEqual([]);
  expect(f.hub.listTeam(f.b.agent).find((x) => x.name === "worker")?.load.working).toBe(0);
  const ws = f.hub.createWorkspace("elsewhere"); f.hub.moveAgent("other", ws.id);
  expect(f.hub.listTasksFor(f.b.agent)).toEqual([]);
});

test("explicit human assignment opens backlog only for that agent, including after its cursor passed the row", async () => {
  const f = setup(); const t = f.task(); await f.req(`/api/tasks/${t.id}/status`, { status: "backlog" });
  f.hub.pull(f.a.agent); f.hub.pull(f.b.agent); // both skipped the hidden row
  const r = await f.req(`/api/tasks/${t.id}/release`, { to: "worker" }); expect(r.status).toBe(200);
  expect(f.store.getTask(t.id)).toMatchObject({ status: "open", assignee: f.a.id });
  expect(f.store.taskEvents(t.id)).toContainEqual(expect.objectContaining({ actor: "human", kind: "status" }));
  expect(f.hub.listTasksFor(f.a.agent).map((x) => x.id)).toEqual([t.id]);
  expect(f.hub.listTasksFor(f.b.agent)).toEqual([]);
  expect(() => f.hub.taskDetail(t.key, f.b.agent)).toThrow(/no such task/);
  expect(() => f.hub.claim(f.b.agent, t.id)).toThrow(/no such task/);
  expect(f.hub.pull(f.a.agent).items.filter((x) => x.type === "task").map((x: any) => x.task.id)).toEqual([t.id]);
  expect(f.hub.pull(f.b.agent).items.filter((x) => x.type === "task")).toEqual([]);
  f.hub.claim(f.a.agent, t.id);
  expect(() => f.hub.release(f.a.agent, t.id, "other", "Hand over this private task to another agent.")).toThrow(/human|private/i);
  await f.req(`/api/tasks/${t.id}/status`, { status: "backlog" });
  expect(f.hub.listTasksFor(f.a.agent)).toEqual([]);
});

test("reopening a task after an acknowledged wake delivers it again and deleting the last row never reuses a wake sequence", async () => {
  const f = setup(); const t = f.task();
  const first = f.hub.pull(f.a.agent); f.hub.pull(f.a.agent, first.ack);
  await f.req(`/api/tasks/${t.id}/status`, { status: "done" });
  await f.req(`/api/tasks/${t.id}/status`, { status: "open" });
  const again = f.hub.pull(f.a.agent); expect(again.items.filter((i) => i.type === "task")).toHaveLength(1);
  f.hub.pull(f.a.agent, again.ack);
  await f.req(`/api/tasks/${t.id}`, { confirm: t.key }, "DELETE");
  const next = f.task(); expect(next.seq).toBeGreaterThan(again.ack.task);
  expect(f.hub.pull(f.a.agent).items.filter((i) => i.type === "task")).toHaveLength(1);
});


test("backlog/private task artifacts stay hidden; private child work and parent references do not leak", async () => {
  const f = setup(); const parent = f.task(); f.hub.claim(f.a.agent, parent.id);
  const report = f.hub.attachReport(f.a.agent, parent.id, "secret", "private draft");
  await f.req(`/api/tasks/${parent.id}/status`, { status: "backlog" });
  expect((await f.req(`/agent/artifacts/${report.id}`, undefined, "GET", f.a.token)).status).toBe(404);
  await f.req(`/api/tasks/${parent.id}/release`, { to: "worker" });
  expect((await f.req(`/agent/artifacts/${report.id}`, undefined, "GET", f.b.token)).status).toBe(404);
  expect((await f.req(`/agent/artifacts/${report.id}`, undefined, "GET", f.a.token)).status).toBe(200);
  const child = f.hub.createTask(f.a.agent, { title: "private subtask", parentId: parent.id, project: "demo", ...DOC });
  expect(f.hub.listTasksFor(f.b.agent)).toEqual([]);
  expect(f.hub.taskDetail(child.id, f.a.agent).task.visibleToAgent).toBe(f.a.id);
  const publicChild = f.task(); f.store.db.query("UPDATE tasks SET parent_id = ? WHERE id = ?").run(parent.id, publicChild.id);
  expect(f.hub.taskDetail(publicChild.id, f.b.agent).task.parentId).toBeNull();
});

test("failed file unlink is durably recorded and later cleanup removes the pending bytes", async () => {
  const f = setup(); const t = f.task(); f.hub.claim(f.a.agent, t.id);
  const art = f.hub.attachReport(f.a.agent, t.id, "report", "content");
  const path = `${f.hub.dataDir}/artifacts/${art.id}`;
  rmSync(path); mkdirSync(path); // cannot unlink a directory as a regular file
  const res = await f.req(`/api/tasks/${t.id}`, { confirm: t.key }, "DELETE");
  expect((await res.json() as any).cleanupPending).toBe(true);
  expect(f.store.getTask(t.id)).toBeNull(); expect(f.store.getArtifact(art.id)).toBeNull();
  expect(f.store.deletedTasks()[0].pendingFiles).toEqual([art.id]);
  rmSync(path, { recursive: true }); await Bun.write(path, "leftover");
  f.hub.cleanupTaskFiles(); expect(existsSync(path)).toBe(false); expect(f.store.deletedTasks()[0].pendingFiles).toEqual([]);
});


test("legacy rowid task cursors migrate idempotently and durable activation survives reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-task-migration-")); const path = join(dir, "fleet.db");
  const old = new Database(path);
  old.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL, parent_id TEXT, created_by TEXT NOT NULL, ai_generated INTEGER NOT NULL, status TEXT NOT NULL, claimed_by TEXT, assignee TEXT, note TEXT, created_at INTEGER NOT NULL)");
  old.run("INSERT INTO tasks (id,title,project,created_by,ai_generated,status,created_at) VALUES ('old-task','Legacy task','demo','human',0,'open',0)"); old.close();
  let current = createApp(path, "human");
  try {
    const legacy = current.store.getTask("old-task")!; expect(legacy.key).toBe("DEMO-1"); expect(legacy.seq).toBe(1);
    const a = current.store.addAgent({ name: "worker", owner: "owner", device: "d", skills: [] }); current.store.setCursors(a.id, { task: 100, msg: 0 });
    current.store.db.close(); current = createApp(path, "human");
    current.hub.humanStatus(legacy.id, "backlog"); current.hub.humanRelease(legacy.id, "worker");
    expect(current.store.getTask(legacy.id)!.seq).toBeGreaterThan(100);
    const sequence = current.store.getTask(legacy.id)!.seq; current.store.db.close(); current = createApp(path, "human");
    expect(current.store.getTask(legacy.id)).toMatchObject({ status: "open", visibleToAgent: a.id, seq: sequence, key: "DEMO-1" });
    expect(current.hub.pull(current.store.agentById(a.id)!).items.filter((i) => i.type === "task")).toHaveLength(1);
    // A backlog row stays unwoken across a restart: the startup migration must not hand it a sequence.
    const b = current.hub.humanCreateTask({ title: "Restart-private", project: "demo", backlog: true });
    current.store.db.close(); current = createApp(path, "human");
    expect(current.store.getTask(b.id)).toMatchObject({ status: "backlog", seq: null });
    expect(current.store.agentById(a.id)!.id).toBe(a.id);
  } finally { current.store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("creating directly in backlog writes one hidden row: no open state, no wake sequence, no cursor movement", async () => {
  const f = setup();
  const beforeA = f.store.getCursors(f.a.id).task, beforeB = f.store.getCursors(f.b.id).task;
  const r = await f.req("/api/tasks", { title: "Draft the pricing page in private", project: "demo", backlog: true, ...DOC });
  expect(r.status).toBe(200);
  const created = (await r.json()) as any;
  expect(created.status).toBe("backlog");
  const t = f.store.getTask(created.id)!;
  expect(t).toMatchObject({ status: "backlog", claimedBy: null, assignee: null, offerBy: null, offerAt: null, seq: null });
  // The history never had an open moment: one created event, no status event.
  const events = f.store.taskEvents(t.id);
  expect(events.map((e) => e.kind)).toEqual(["created"]);
  expect(events[0].actor).toBe("human");
  expect(events[0].text).toContain("backlog");
  // No wake work, no offer, no load, and neither agent's cursor moved.
  expect(f.store.getCursors(f.a.id).task).toBe(beforeA);
  expect(f.store.getCursors(f.b.id).task).toBe(beforeB);
  expect(f.hub.pull(f.a.agent).ack.task).toBe(beforeA);
  expect(f.hub.pull(f.a.agent).items.filter((i: any) => i.type === "task")).toEqual([]);
  expect(f.hub.pull(f.b.agent).items.filter((i: any) => i.type === "task")).toEqual([]);
  expect(f.hub.listTasksFor(f.a.agent)).toEqual([]);
  expect(f.store.offeredTasks()).toEqual([]);
  expect(f.hub.listTeam(f.b.agent).find((a: any) => a.name === "worker")?.load).toEqual({ working: 0, offers: 0 });
  // The human sees it in state, and the task list for the human includes it.
  const state: any = await (await f.req("/api/state", undefined, "GET")).json();
  expect(state.tasks.find((x: any) => x.id === t.id)?.status).toBe("backlog");
  // It can still be assigned, which opens it privately and gives it a fresh wake sequence.
  f.hub.humanRelease(t.id, "worker");
  expect(f.store.getTask(t.id)?.status).toBe("open");
  expect(f.hub.listTasksFor(f.a.agent).some((x: any) => x.id === t.id)).toBe(true);
  expect(f.hub.listTasksFor(f.b.agent).some((x: any) => x.id === t.id)).toBe(false);
});

test("a normal create is unchanged, and backlog create validates its input", async () => {
  const f = setup();
  const ok = await f.req("/api/tasks", { title: "Public task", project: "demo", ...DOC });
  expect(ok.status).toBe(200);
  const open = (await ok.json()) as any;
  expect(open.status).toBe("open");
  expect(typeof open.seq).toBe("number");
  expect(f.hub.pull(f.a.agent).items.some((i: any) => i.type === "task" && i.task.id === open.id)).toBe(true);

  const count = f.store.listTasks("demo").length;
  for (const bad of ["yes", 1, null]) {
    const r = await f.req("/api/tasks", { title: "Bad backlog", project: "demo", backlog: bad });
    expect(r.status).toBe(400);
  }
  const both = await f.req("/api/tasks", { title: "Backlog with owner", project: "demo", backlog: true, assignee: "worker" });
  expect(both.status).toBe(400);
  expect((await both.json() as any).error).toMatch(/backlog/i);
  expect(f.store.listTasks("demo").length).toBe(count);
  expect(f.store.listTasks("demo").some((t) => t.title === "Backlog with owner")).toBe(false);
});
