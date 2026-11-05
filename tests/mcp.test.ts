import { DOC } from "./fixtures";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openStore } from "../src/store";
import { Hub } from "../src/hub";
import { mountMcp } from "../src/mcp";

const store = openStore(":memory:");
const hub = new Hub(store);
hub.dataDir = mkdtempSync(`${tmpdir()}/fleet-mcp-`);
const app = new Hono();
mountMcp(app, hub, store);
const server = Bun.serve({ port: 0, fetch: app.fetch });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

const a = store.addAgent({ name: "claude-laptop", owner: "alper", device: "laptop", skills: [] });
const b = store.addAgent({ name: "opencode-mac", owner: "alper", device: "mac", skills: [] });

async function connect(token: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args }) as Promise<any>;
const text = (r: any) => r.content[0].text as string;
const json = (r: any) => JSON.parse(text(r));

test("no token and a wrong token get 401 and write nothing", async () => {
  const before = store.touchesFor().length;
  const none = await fetch(`${base}/mcp`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  const bad = await fetch(`${base}/mcp`, { method: "POST", body: "{}", headers: { Authorization: "Bearer nope", "content-type": "application/json" } });
  expect(none.status).toBe(401);
  expect(bad.status).toBe(401);
  expect(store.touchesFor().length).toBe(before);
});

test("a valid token lists the 30 fleet tools", async () => {
  const c = await connect(a.token);
  const { tools } = await c.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "accept_task", "add_comment", "ask_human", "ask_owner", "attach_evidence", "attach_report", "claim_task", "complete_task", "create_task", "decline_task", "escalate", "get_knowledge", "get_outcome", "get_task",
    "inbox", "list_agents", "list_tasks", "my_requests", "post_status", "propose_knowledge", "read_thread", "record_touch", "release_task", "request_outcome", "request_takeover", "say", "search_knowledge", "set_profile", "verify_knowledge", "wait_for_work",
  ]);
  await c.close();
});

test("a second agent claiming the same task gets isError 'already claimed'", async () => {
  const ca = await connect(a.token);
  const cb = await connect(b.token);
  const created = JSON.parse(text(await call(ca, "create_task", { ...DOC, title: "feed", project: "dash" })));
  const first = await call(ca, "claim_task", { task_id: created.id });
  expect(first.isError).toBeFalsy();
  const second = await call(cb, "claim_task", { task_id: created.id });
  expect(second.isError).toBe(true);
  expect(text(second)).toContain("already claimed");
  await ca.close(); await cb.close();
});

test("complete_task without evidence returns isError 'evidence required'", async () => {
  const c = await connect(a.token);
  const t = JSON.parse(text(await call(c, "create_task", { ...DOC, title: "x", project: "dash" })));
  await call(c, "claim_task", { task_id: t.id });
  const r = await call(c, "complete_task", { task_id: t.id });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("evidence required");
  await c.close();
});

test("wait_for_work returns an empty list and an ack at the timeout", async () => {
  const c = await connect(b.token);
  const r = json(await call(c, "wait_for_work", { timeout_seconds: 1 }));
  expect(r.items).toEqual([]);
  expect(r.ack).toEqual({ msg: expect.any(Number), task: expect.any(Number), answers: [] });
  await c.close();
});

test("post_status 'done' is rejected, pointing at complete_task", async () => {
  const c = await connect(a.token);
  const t = json(await call(c, "create_task", { ...DOC, title: "bypass?", project: "dash" }));
  await call(c, "claim_task", { task_id: t.id });
  const r = await call(c, "post_status", { task_id: t.id, status: "done" });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("complete_task");
  await c.close();
});

test("release_task gives a claimed task back so another agent can claim it", async () => {
  const ca = await connect(a.token);
  const cb = await connect(b.token);
  const t = json(await call(ca, "create_task", { ...DOC, title: "stuck", project: "dash" }));
  await call(ca, "claim_task", { task_id: t.id });
  expect((await call(ca, "release_task", { task_id: t.id, brief: "Data is prepared and the script is written but untested. Left: run it and attach the result." })).isError).toBeFalsy();
  expect((await call(cb, "claim_task", { task_id: t.id })).isError).toBeFalsy();
  await ca.close(); await cb.close();
});

test("my_requests lets a restarted agent recover its questions and answers", async () => {
  const c = await connect(a.token);
  const q = json(await call(c, "ask_human", { kind: "decision", text: "which?" }));
  hub.humanAnswer(q.id, "the first");
  const mine = json(await call(c, "my_requests")).requests;
  expect(mine.find((r: any) => r.id === q.id).answer).toBe("the first");
  await c.close();
});

test("a client that abandons wait_for_work does not lose the answer", async () => {
  const c = await connect(b.token);
  const q = json(await call(c, "ask_human", { kind: "decision", text: "lost?" }));
  const ctl = new AbortController();
  const orphan = fetch(`${base}/mcp`, {
    method: "POST", signal: ctl.signal,
    headers: { Authorization: `Bearer ${b.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_work", arguments: { timeout_seconds: 20 } } }),
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 100));
  ctl.abort();
  await orphan;
  await new Promise((r) => setTimeout(r, 100));
  hub.humanAnswer(q.id, "kept");
  const next = json(await call(c, "wait_for_work", { timeout_seconds: 2 }));
  expect(next.items.map((i: any) => i.request?.answer)).toContain("kept");
  await c.close();
});

test("GET /skills.md is public and teaches the protocol", async () => {
  const r = await fetch(`${base}/skills.md`);
  expect(r.status).toBe(200);
  const body = await r.text();
  expect(body).toContain("wait_for_work");
  expect(body).toContain("attach_evidence");
});

test("create_task through MCP refuses a bare title and explains what is missing; ask_owner, get_task and escalate work", async () => {
  const ca = await connect(a.token), cb = await connect(b.token);
  const bare = await call(ca, "create_task", { title: "bare", project: "mcpx", description: "short", acceptance: "ok" });
  expect(bare.isError).toBe(true);
  expect(text(bare)).toContain("description required");
  const t = JSON.parse(text(await call(ca, "create_task", { ...DOC, title: "documented", project: "mcpx" })));
  expect(t.key).toMatch(/^MCPX-\d+$/);
  await call(ca, "claim_task", { task_id: t.key });
  const detail = JSON.parse(text(await call(cb, "get_task", { task_id: t.key })));
  expect(detail.task.description).toBe(DOC.description);
  expect(detail.events[0].kind).toBe("created");
  expect(text(await call(cb, "ask_owner", { task_id: t.key, question: "which port?" }))).toContain("ok");
  const esc = await call(cb, "escalate", { question: "Which port?", my_position: "8787", their_position: "9000", with_agent: "claude-laptop", task_id: t.key });
  expect(JSON.parse(text(esc)).kind).toBe("dispute");
  await ca.close(); await cb.close();
});

test("attach_report through MCP stores the report on the task and shows in get_task", async () => {
  const ca = await connect(a.token);
  const t = JSON.parse(text(await call(ca, "create_task", { ...DOC, title: "reported", project: "mcpr" })));
  await call(ca, "claim_task", { task_id: t.key });
  const r = JSON.parse(text(await call(ca, "attach_report", { task_id: t.key, title: "Outcome", markdown: "## Done\nworks" })));
  expect(r.name).toBe("Outcome.md");
  const d = JSON.parse(text(await call(ca, "get_task", { task_id: t.key })));
  expect(d.artifacts.map((x: any) => x.kind)).toEqual(["report"]);
  await ca.close();
});


test("MCP rejects empty task titles/projects and evidence kinds/refs without writes", async () => {
  const c = await connect(a.token);
  try {
    for (const field of ["title", "project"]) for (const value of ["", "   "]) {
      const before = store.listTasks().length;
      expect((await call(c, "create_task", { ...DOC, title: "valid", project: "hardening", [field]: value })).isError).toBe(true);
      expect(store.listTasks().length).toBe(before);
    }
    const t = json(await call(c, "create_task", { ...DOC, title: "evidence validation", project: "hardening" }));
    await call(c, "claim_task", { task_id: t.id });
    for (const field of ["kind", "ref"]) for (const value of ["", "   "]) {
      expect((await call(c, "attach_evidence", { task_id: t.id, kind: "test", ref: "output", [field]: value })).isError).toBe(true);
    }
    expect(store.allEvidence().filter(e => e.taskId === t.id)).toEqual([]);
  } finally { await c.close(); }
});
