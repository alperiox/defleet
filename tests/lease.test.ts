import { test, expect, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { DOC } from "./fixtures";

const { app, hub, store } = createApp(":memory:", "human-secret", { hubOwner: "alper" });
const server = Bun.serve({ port: 0, fetch: app.fetch });
afterAll(() => server.stop(true));
const base = `http://localhost:${server.port}`;
const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };
const mk = (name: string) => { const r = store.addAgent({ name, owner: "alper", device: "d", skills: [] }); return store.agentById(r.id)!; };
const holder = mk("claude-laptop"), other = mk("opencode-mac");
const MIN = 60_000;

function held(title = "modernize the pilot ui") {
  const t = hub.createTask(holder, { title, project: "kapi", ...DOC });
  hub.claim(holder, t.id);
  return t;
}

test("a claim is a lease: it records who holds the task and since when, and is active while the holder is around", () => {
  const t = held();
  hub.pull(holder);                                         // the holder's helper is connected
  const lease = hub.leaseOf(hub.taskDetail(t.id).task);
  expect(lease).toMatchObject({ holder: "claude-laptop", state: "active" });
  expect(lease!.since).toBeGreaterThan(0);
  expect(hub.leaseOf(hub.taskDetail(hub.createTask(holder, { title: "unclaimed", project: "kapi", ...DOC }).id).task)).toBeNull();
});

test("a second agent cannot claim a held task, is told who holds it, and is told not to work on it in parallel", () => {
  const t = held();
  hub.pull(holder);
  let msg = "";
  try { hub.claim(other, t.id); } catch (e) { msg = (e as Error).message; }
  expect(msg).toMatch(/held by claude-laptop/);
  expect(msg).toMatch(/do not work on this task in parallel/i);
  expect(msg).toMatch(/ask_owner|ask_human/);
  const ev = hub.taskDetail(t.id, holder) as any;
  expect(JSON.stringify(ev.events)).toMatch(/claim-refused/);        // the human sees the contention in the task's history
  expect(hub.taskDetail(t.id).task.claimedBy).toBe(holder.id);
});

test("a lease whose holder has gone silent expires, and another agent can take the task over; the history says so", () => {
  const t = held();
  hub.pull(holder);
  const later = Date.now() + 31 * MIN;
  expect(hub.leaseOf(hub.taskDetail(t.id).task, later)?.state).toBe("stale");
  expect(hub.leaseOf(hub.taskDetail(t.id).task, Date.now() + 10 * MIN)?.state).toBe("active");
  const taken = hub.claim(other, t.id, later);
  expect(taken.claimedBy).toBe(other.id);
  const detail = JSON.stringify((hub.taskDetail(t.id, other) as any).events);
  expect(detail).toMatch(/lease-expired/);
  expect(detail).toMatch(/claude-laptop/);
});

test("a holder that is busy in a turn keeps its lease through a long task", () => {
  const t = held();
  hub.pull(holder);
  hub.setActivity(holder, "working", "KAPI");
  const later = Date.now() + 31 * MIN;                       // silent on the wire, but its helper says it is working
  expect(hub.leaseOf(hub.taskDetail(t.id).task, later)?.state).toBe("active");
  expect(() => hub.claim(other, t.id, later)).toThrow(/held by claude-laptop/);
  hub.setActivity(holder, "idle");                           // leave no state behind for the next test
});

test("the agent that lost its lease is told who has the task now, instead of a bare refusal", () => {
  const t = held();
  hub.pull(holder);
  hub.claim(other, t.id, Date.now() + 31 * MIN);
  let msg = "";
  try { hub.attachEvidence(holder, t.id, { kind: "note", ref: "x" }); } catch (e) { msg = (e as Error).message; }
  expect(msg).toMatch(/not your task/);
  expect(msg).toMatch(/opencode-mac/);
});

test("the human can reassign a held task to a named agent, or return it to the pool", async () => {
  const t = held();
  const to = await fetch(`${base}/api/tasks/${t.id}/release`, { method: "POST", headers: human, body: JSON.stringify({ to: "opencode-mac" }) });
  expect(to.status).toBe(200);
  const after: any = await to.json();
  expect(after).toMatchObject({ status: "open", claimedBy: null, assignee: other.id });
  expect((await fetch(`${base}/api/tasks/${t.id}/release`, { method: "POST", headers: human, body: JSON.stringify({ to: "nobody" }) })).status).toBe(400);
  const t2 = held("another one");
  const pool = await fetch(`${base}/api/tasks/${t2.id}/release`, { method: "POST", headers: human });
  expect((await pool.json() as any).assignee).toBeNull();
});

test("the UI state carries each task's lease", async () => {
  const t = held("shown in the ui");
  hub.pull(holder);
  const state: any = await (await fetch(`${base}/api/state`, { headers: human })).json();
  const row = state.tasks.find((x: any) => x.id === t.id);
  expect(row.lease).toMatchObject({ holder: "claude-laptop", state: "active" });
});
