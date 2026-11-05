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

const { id: aId } = store.addAgent({ name: "worker-agent", owner: "alper", device: "laptop", skills: [] });
const agent = store.agentById(aId)!;

// Agent in another workspace
const ws2 = hub.createWorkspace("other-team");
const { id: otherId } = store.addAgent({ name: "other-agent", owner: "alper", device: "desktop", skills: [], workspaceId: ws2.id });
const otherAgent = store.agentById(otherId)!;

const auth = { Authorization: "Bearer human-secret", "content-type": "application/json" };

test("humanDm prefixes first message when discussing a request", () => {
  const req = hub.askHuman(agent, { kind: "decision", text: "Should we use YAML or JSON?" });
  const msg = hub.humanDm("worker-agent", "Let's talk about the formats", [], req.id);
  expect(msg.text).toBe(`Discussing request ${req.id}: Should we use YAML or JSON?\n\nLet's talk about the formats`);
  expect(msg.from).toBe(HUMAN);

  // The request must remain open
  expect(store.getRequest(req.id)?.answer).toBeNull();
  expect(store.openRequests().some((r) => r.id === req.id)).toBe(true);
});

test("humanDm subsequent message in the same thread does not repeat prefix", () => {
  const req = store.openRequests().find((r) => r.text.includes("YAML or JSON"))!;
  const msg2 = hub.humanDm("worker-agent", "Also consider TOML", [], req.id);
  expect(msg2.text).toBe("Also consider TOML");
  expect(msg2.text).not.toContain("Discussing request");

  // Still open
  expect(store.getRequest(req.id)?.answer).toBeNull();
});

test("POST /api/dm/:agent passes requestId and prefixes first message over HTTP", async () => {
  const req = hub.askHuman(agent, { kind: "approval", text: "Deploy migration 004 to production?" });
  const res = await fetch(`${base}/api/dm/worker-agent`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ text: "Are migrations backward-compatible?", requestId: req.id }),
  });
  expect(res.status).toBe(200);
  const msg: any = await res.json();
  expect(msg.text).toBe(`Discussing request ${req.id}: Deploy migration 004 to production?\n\nAre migrations backward-compatible?`);

  // Request stays open
  expect(store.getRequest(req.id)?.answer).toBeNull();
  expect(store.openRequests().some((r) => r.id === req.id)).toBe(true);
});

test("GET /api/requests/:id returns open request and answered request", async () => {
  const req = hub.askHuman(agent, { kind: "decision", text: "Query format?" });
  const res1 = await fetch(`${base}/api/requests/${req.id}`, { headers: auth });
  expect(res1.status).toBe(200);
  const data1: any = await res1.json();
  expect(data1.id).toBe(req.id);
  expect(data1.answer).toBeNull();

  // Answer it with normal answer endpoint
  await fetch(`${base}/api/requests/${req.id}/answer`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ answer: "Parquet" }),
  });

  const res2 = await fetch(`${base}/api/requests/${req.id}`, { headers: auth });
  expect(res2.status).toBe(200);
  const data2: any = await res2.json();
  expect(data2.id).toBe(req.id);
  expect(data2.answer).toBe("Parquet");
});

test("human can discuss a request with an agent in another workspace", async () => {
  const req = hub.askHuman(otherAgent, { kind: "decision", text: "Can we share the auth service?" });
  const res = await fetch(`${base}/api/dm/other-agent`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ text: "Tell me more about latency requirements", requestId: req.id }),
  });
  expect(res.status).toBe(200);
  const msg: any = await res.json();
  expect(msg.text).toContain(`Discussing request ${req.id}: Can we share the auth service?`);
  expect(store.openRequests().some((r) => r.id === req.id)).toBe(true);
});
