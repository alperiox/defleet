import { test, expect } from "bun:test";
import { openStore } from "../src/store";

function fresh() {
  const store = openStore(":memory:");
  const a = store.addAgent({ name: "claude-laptop", owner: "alper", device: "laptop", skills: ["manage"] });
  const b = store.addAgent({ name: "opencode-mac", owner: "alper", device: "mac", skills: ["build"] });
  return { store, a, b };
}

test("claiming a task twice throws 'already claimed'", () => {
  const { store, a, b } = fresh();
  const t = store.addTask({ title: "collect data", project: "dash", createdBy: a.id, aiGenerated: false });
  store.claimTask(t.id, a.id);
  expect(() => store.claimTask(t.id, b.id)).toThrow("already claimed");
});

test("agentByToken returns null for unknown token and the agent for a valid one", () => {
  const { store, a } = fresh();
  expect(store.agentByToken("nope")).toBeNull();
  expect(store.agentByToken(a.token)?.name).toBe("claude-laptop");
});

test("a task title that looks like SQL round-trips verbatim", () => {
  const { store, a } = fresh();
  const title = "Robert'); DROP TABLE tasks;--";
  const t = store.addTask({ title, project: "dash", createdBy: a.id, aiGenerated: false });
  expect(store.getTask(t.id)?.title).toBe(title);
  expect(store.listTasks("dash").length).toBe(1);
});

test("messagesSince returns messages in insertion order", () => {
  const { store, a } = fresh();
  const m1 = store.addMessage({ thread: "room", from: a.id, text: "one" });
  store.addMessage({ thread: "room", from: a.id, text: "two\nlines" });
  const all = store.messagesSince("room", 0);
  expect(all.map((m) => m.text)).toEqual(["one", "two\nlines"]);
  expect(store.messagesSince("room", m1.id).length).toBe(1);
});

test("answering a request closes it for the human but keeps it for the asker", () => {
  const { store, a } = fresh();
  const r = store.addRequest({ fromAgent: a.id, owner: "alper", kind: "decision", text: "jsonl or parquet?" });
  expect(store.openRequests().length).toBe(1);
  store.answerRequest(r.id, "parquet");
  expect(store.openRequests().length).toBe(0);
  const mine = store.requestsFor(a.id);
  expect(mine.length).toBe(1);
  expect(mine[0].answer).toBe("parquet");
});

test("a task assigned to one agent cannot be claimed by another", () => {
  const { store, a, b } = fresh();
  const t = store.addTask({ title: "x", project: "dash", createdBy: a.id, aiGenerated: false, assignee: b.id });
  expect(t.assignee).toBe(b.id);
  expect(() => store.claimTask(t.id, a.id)).toThrow("assigned to another agent");
  expect(store.claimTask(t.id, b.id).claimedBy).toBe(b.id);
});

test("cursors default to zero and persist per agent", () => {
  const { store, a, b } = fresh();
  expect(store.getCursors(a.id)).toEqual({ msg: 0, task: 0 });
  store.setCursors(a.id, { msg: 5, task: 3 });
  expect(store.getCursors(a.id)).toEqual({ msg: 5, task: 3 });
  expect(store.getCursors(b.id)).toEqual({ msg: 0, task: 0 });
});

test("tasks carry an increasing seq", () => {
  const { store, a } = fresh();
  const t1 = store.addTask({ title: "1", project: "p", createdBy: a.id, aiGenerated: false });
  const t2 = store.addTask({ title: "2", project: "p", createdBy: a.id, aiGenerated: false });
  expect(t2.seq).toBeGreaterThan(t1.seq);
});

test("the raw agent token is never stored in the database", () => {
  const { store, a } = fresh();
  const rows = store.db.query("SELECT token FROM agents").all() as { token: string }[];
  expect(rows.length).toBe(2);
  for (const r of rows) expect(r.token).not.toBe(a.token);
  expect(JSON.stringify(rows)).not.toContain(a.token);
});

test("a revoked agent's token stops authenticating, other agents are unaffected", () => {
  const { store, a, b } = fresh();
  expect(store.revokeAgent("claude-laptop")).toBe(true);
  expect(store.agentByToken(a.token)).toBeNull();
  expect(store.agentByToken(b.token)?.name).toBe("opencode-mac");
  expect(store.revokeAgent("no-such-agent")).toBe(false);
});

test("tasks carry a description, acceptance criteria and a readable per-project key", () => {
  const { store, a } = fresh();
  const t1 = store.addTask({ title: "one", project: "kapi", createdBy: a.id, aiGenerated: false, description: "why and how", acceptance: "tests pass" });
  const t2 = store.addTask({ title: "two", project: "kapi", createdBy: a.id, aiGenerated: false });
  const d1 = store.addTask({ title: "three", project: "dashboard", createdBy: a.id, aiGenerated: false });
  expect([t1.key, t2.key, d1.key]).toEqual(["KAPI-1", "KAPI-2", "DASH-1"]);
  expect(t1.description).toBe("why and how");
  expect(t1.acceptance).toBe("tests pass");
  expect(t2.description).toBeNull();
});

test("two projects sharing a four-letter prefix never get the same key", () => {
  const { store, a } = fresh();
  const x = store.addTask({ title: "x", project: "dashboard", createdBy: a.id, aiGenerated: false });
  const y = store.addTask({ title: "y", project: "dashboard-v2", createdBy: a.id, aiGenerated: false });
  expect(x.key).not.toBe(y.key);
});

test("resolveTask finds a task by full id, key (any case) or a unique id prefix, and null otherwise", () => {
  const { store, a } = fresh();
  const t = store.addTask({ title: "one", project: "kapi", createdBy: a.id, aiGenerated: false });
  expect(store.resolveTask(t.id)?.id).toBe(t.id);
  expect(store.resolveTask("kapi-1")?.id).toBe(t.id);
  expect(store.resolveTask(t.id.slice(0, 8))?.id).toBe(t.id);
  expect(store.resolveTask("KAPI-99")).toBeNull();
  expect(store.resolveTask("")).toBeNull();
  expect(store.resolveTask("%")).toBeNull();
});

test("task events are an append-only history, and children are listed", () => {
  const { store, a, b } = fresh();
  const p = store.addTask({ title: "parent", project: "kapi", createdBy: a.id, aiGenerated: false });
  const c = store.addTask({ title: "child", project: "kapi", parentId: p.id, createdBy: a.id, aiGenerated: true });
  store.addTaskEvent({ taskId: p.id, actor: a.id, kind: "status", text: "started" });
  store.addTaskEvent({ taskId: p.id, actor: b.id, kind: "comment", text: "looks good" });
  const ev = store.taskEvents(p.id);
  expect(ev.map((e) => e.text)).toEqual(["started", "looks good"]);
  expect(ev[0].kind).toBe("status");
  expect(store.childrenOf(p.id).map((t) => t.id)).toEqual([c.id]);
});

test("a dispute request remembers the other agent involved", () => {
  const { store, a, b } = fresh();
  const r = store.addRequest({ fromAgent: a.id, owner: "alper", kind: "dispute", text: "we disagree", withAgent: b.id });
  expect(r.kind).toBe("dispute");
  expect(r.withAgent).toBe(b.id);
});

test("opening a database made by an older version adds the new columns and backfills keys", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { Database } = await import("bun:sqlite");
  const path = `${mkdtempSync(`${tmpdir()}/fleet-mig-`)}/old.db`;
  const old = new Database(path, { create: true });
  old.run(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL, parent_id TEXT, created_by TEXT NOT NULL,
    ai_generated INTEGER NOT NULL, status TEXT NOT NULL, claimed_by TEXT, assignee TEXT, note TEXT, created_at INTEGER NOT NULL)`);
  old.run(`CREATE TABLE requests (id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
    link TEXT, task_id TEXT, answer TEXT, delivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
  for (const [i, p] of [["t1", "kapi"], ["t2", "kapi"], ["t3", "other"]]) {
    old.run("INSERT INTO tasks VALUES (?,?,?,NULL,'x',0,'open',NULL,NULL,'old note',1)", [i, `task ${i}`, p]);
  }
  old.close();
  const store = openStore(path);
  expect(store.listTasks().map((t) => t.key)).toEqual(["KAPI-1", "KAPI-2", "OTHE-1"]);
  expect(store.getTask("t1")?.description).toBeNull();
  expect(store.getTask("t1")?.note).toBe("old note");
  const fresh2 = store.addTask({ title: "new", project: "kapi", createdBy: "x", aiGenerated: false });
  expect(fresh2.key).toBe("KAPI-3");
  expect(store.openRequests()).toEqual([]);
});

test("revoking an agent frees its name for a new agent but keeps the old record readable", () => {
  const { store, a } = fresh();
  expect(store.revokeAgent("claude-laptop")).toBe(true);
  expect(store.agentById(a.id)?.name).toMatch(/^claude-laptop~revoked/);
  const again = store.addAgent({ name: "claude-laptop", owner: "alper", device: "laptop", skills: [] });
  expect(again.id).not.toBe(a.id);
  expect(store.agentByToken(again.token)?.name).toBe("claude-laptop");
  expect(store.agentByToken(a.token)).toBeNull();
  expect(store.revokeAgent("claude-laptop")).toBe(true);                       // a second revoke of the new one works too
  expect(store.listAgents().length).toBe(1);                                      // removed agents are not listed as agents (only the other one from fresh() is)
  expect(store.listRetiredAgents().filter((x) => x.name === "claude-laptop").length).toBe(2);   // but the history can still name them, without the internal suffix
});


test("every store connection has a bounded SQLite busy timeout", () => {
  const store = openStore(":memory:");
  try {
    const row = store.db.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(row.timeout).toBe(5000);
  } finally { store.db.close(); }
});
