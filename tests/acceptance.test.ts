import { DOC } from "./fixtures";
import { test, expect, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app";

const { app, store } = createApp(":memory:", "human-secret");
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

const mgr = store.addAgent({ name: "claude-laptop", owner: "alper", device: "laptop", skills: ["manage"] });
const wrk = store.addAgent({ name: "opencode-mac", owner: "alper", device: "mac", skills: ["build"] });

async function connect(token: string) {
  const c = new Client({ name: "agent", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as any;
const json = (r: any) => JSON.parse(r.content[0].text);
const human = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { Authorization: "Bearer human-secret", "content-type": "application/json" } });

test("two harnesses on two devices finish a task together while the human answers one ping", async () => {
  const manager = await connect(mgr.token);
  const worker = await connect(wrk.token);

  // Manager owns the parent and splits it; subtasks are AI-generated and attributed to it.
  const parent = json(await call(manager, "create_task", { ...DOC, title: "Build dashboard", project: "dash" }));
  await call(manager, "claim_task", { task_id: parent.id });
  const collect = json(await call(manager, "create_task", { ...DOC, title: "Collect data", project: "dash", parent_id: parent.id, assignee: "opencode-mac" }));
  const backend = json(await call(manager, "create_task", { ...DOC, title: "Backend API", project: "dash", parent_id: parent.id, assignee: "claude-laptop" }));

  // Worker wakes with exactly its own task.
  const first = json(await call(worker, "wait_for_work", { timeout_seconds: 2 }));
  expect(first.items.length).toBe(1);
  expect(first.items[0].task.id).toBe(collect.id);

  await call(worker, "claim_task", { task_id: collect.id });
  await call(worker, "post_status", { task_id: collect.id, status: "in_progress", note: "fetching" });
  await call(worker, "record_touch", { action: "ran-shell", target: "curl feed" });

  // Worker asks the human, then waits; the human answers over REST from "a phone".
  const waiting = call(worker, "wait_for_work", { timeout_seconds: 10, ack: first.ack });
  await call(worker, "ask_human", { kind: "decision", text: "JSONL or Parquet?", task_id: collect.id });
  const state1 = await (await human("/api/state")).json();
  expect(state1.requests.length).toBe(1);
  await human(`/api/requests/${state1.requests[0].id}/answer`, { method: "POST", body: JSON.stringify({ answer: "Parquet, we query by column" }) });
  const woke = json(await waiting).items;
  expect(woke[0].type).toBe("answer");
  expect(woke[0].request.answer).toBe("Parquet, we query by column");

  // The manager first receives the subtask assigned to it, then is woken by a room mention.
  const own = json(await call(manager, "wait_for_work", { timeout_seconds: 2 }));
  expect(own.items.map((i: any) => i.type)).toEqual(["task"]);
  expect(own.items[0].task.id).toBe(backend.id);

  // Worker talks to the manager in the room, which wakes the manager.
  const mgrWait = call(manager, "wait_for_work", { timeout_seconds: 5, ack: own.ack });
  await call(worker, "say", { thread: "room", text: "@claude-laptop feed is Parquet, columns: ts,value" });
  expect(json(await mgrWait).items[0].type).toBe("message");

  // Worker finishes with evidence.
  await call(worker, "attach_evidence", { task_id: collect.id, kind: "test-output", ref: "feed.test: 3 pass" });
  expect((await call(worker, "complete_task", { task_id: collect.id })).isError).toBeFalsy();

  // Manager finishes its own subtask, then the parent: rejected first, accepted with evidence.
  await call(manager, "claim_task", { task_id: backend.id });
  await call(manager, "attach_evidence", { task_id: backend.id, kind: "diff", ref: "backend.diff" });
  await call(manager, "complete_task", { task_id: backend.id });
  const early = await call(manager, "complete_task", { task_id: parent.id });
  expect(early.isError).toBe(true);
  await call(manager, "attach_evidence", { task_id: parent.id, kind: "report", ref: "both subtasks done, tests green" });
  expect((await call(manager, "complete_task", { task_id: parent.id })).isError).toBeFalsy();

  // The human's view shows the whole story.
  const s = await (await human("/api/state")).json();
  expect(s.agents.map((a: any) => a.name).sort()).toEqual(["claude-laptop", "opencode-mac"]);
  const byTitle = Object.fromEntries(s.tasks.map((t: any) => [t.title, t]));
  expect(byTitle["Build dashboard"].aiGenerated).toBe(false);
  expect(byTitle["Collect data"].aiGenerated).toBe(true);
  expect(byTitle["Collect data"].parentId).toBe(parent.id);
  expect(s.tasks.every((t: any) => t.status === "done")).toBe(true);
  expect(s.room.some((m: any) => m.text.includes("Parquet"))).toBe(true);
  expect(new Set(s.touches.map((t: any) => t.source))).toEqual(new Set(["hub", "declared"]));
  expect(s.requests.length).toBe(0);

  await manager.close(); await worker.close();
});
