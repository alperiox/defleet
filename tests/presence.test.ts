import { test, expect, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { openStore } from "../src/store";
import { Hub } from "../src/hub";

function fresh() {
  const store = openStore(":memory:");
  const hub = new Hub(store);
  hub.hubOwner = "alper";
  const mk = (name: string, owner = "alper") => { const { id } = store.addAgent({ name, owner, device: "d", skills: [] }); return store.agentById(id)!; };
  return { store, hub, a: mk("claude-laptop"), b: mk("opencode-mac") };
}

test("an agent is idle until its helper says it is working, and a working state that never ends is not believed forever", () => {
  const { hub, a } = fresh();
  expect(hub.activityOf(a.id).state).toBe("idle");
  hub.setActivity(a, "working", "KAPI-12");
  expect(hub.activityOf(a.id)).toMatchObject({ state: "working", note: "KAPI-12" });
  hub.setActivity(a, "idle");
  expect(hub.activityOf(a.id).state).toBe("idle");
  hub.setActivity(a, "working");
  const since = hub.activityOf(a.id).since;
  expect(hub.activityOf(a.id, since + 44 * 60_000).state).toBe("working");
  expect(hub.activityOf(a.id, since + 46 * 60_000).state).toBe("idle");     // the helper died mid-turn
});

test("a direct message moves from queued to received when the agent pulls it, and to read when the turn's receipt is acknowledged", () => {
  const { hub, a } = fresh();
  const m = hub.humanDm(a.name, "please look at KAPI-12");
  expect(hub.deliveryFor(m)).toEqual([{ agent: "claude-laptop", state: "queued" }]);
  const pulled = hub.pull(a);
  expect(pulled.items.length).toBe(1);
  expect(hub.deliveryFor(m)).toEqual([{ agent: "claude-laptop", state: "received" }]);
  hub.pull(a, pulled.ack);                      // the helper confirms only after a successful turn
  expect(hub.deliveryFor(m)).toEqual([{ agent: "claude-laptop", state: "read" }]);
});

test("a failed turn leaves the message received, not read, so it is retried and still visibly pending", () => {
  const { hub, a } = fresh();
  const m = hub.humanDm(a.name, "x");
  hub.pull(a);
  hub.pull(a);                                   // retry without an ack
  expect(hub.deliveryFor(m)[0].state).toBe("received");
});

test("a room message is for the agents it mentions; @all means every team agent; no mention means nobody", () => {
  const { hub, a, b } = fresh();
  const one = hub.humanSay("@claude-laptop hello");
  expect(hub.deliveryFor(one).map((d) => d.agent)).toEqual(["claude-laptop"]);
  const none = hub.humanSay("is anyone there?");
  expect(hub.deliveryFor(none)).toEqual([]);
  const all = hub.humanSay("@all status please");
  expect(hub.deliveryFor(all).map((d) => d.agent).sort()).toEqual(["claude-laptop", "opencode-mac"]);
  // and the agents are really woken by it
  expect(hub.pull(b).items.some((i: any) => i.type === "message" && i.message.id === all.id)).toBe(true);
  expect(hub.pull(a).items.some((i: any) => i.type === "message" && i.message.id === none.id)).toBe(false);
});

test("@all does not reach outside agents, who have no access to the main room", () => {
  const { store, hub } = fresh();
  const { id } = store.addAgent({ name: "friend-agent", owner: "sam", device: "x", skills: [] });
  const friend = store.agentById(id)!;
  const m = hub.humanSay("@all and @friend-agent hello");
  expect(hub.deliveryFor(m).map((d) => d.agent)).not.toContain("friend-agent");
  expect(hub.pull(friend).items.length).toBe(0);
});

// ---------- over HTTP ----------
const { app } = createApp(":memory:", "human-secret", { hubOwner: "alper" });
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));
const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };

test("the helper reports activity with its own token; the UI state shows it and the delivery of each message", async () => {
  const added: any = await (await fetch(`${base}/api/agents`, { method: "POST", headers: human, body: JSON.stringify({ name: "claude-laptop" }) })).json();
  const agent = { Authorization: `Bearer ${added.token}`, "content-type": "application/json" };
  expect((await fetch(`${base}/agent/activity`, { method: "POST", body: JSON.stringify({ state: "working" }) })).status).toBe(401);
  expect((await fetch(`${base}/agent/activity`, { method: "POST", headers: agent, body: JSON.stringify({ state: "dancing" }) })).status).toBe(400);
  expect((await fetch(`${base}/agent/activity`, { method: "POST", headers: agent, body: JSON.stringify({ state: "working", note: "2 items" }) })).status).toBe(200);
  await fetch(`${base}/api/room`, { method: "POST", headers: human, body: JSON.stringify({ text: "@claude-laptop hi" }) });
  await fetch(`${base}/api/room`, { method: "POST", headers: human, body: JSON.stringify({ text: "hello?" }) });
  const state: any = await (await fetch(`${base}/api/state`, { headers: human })).json();
  expect(state.agents[0].activity).toMatchObject({ state: "working", note: "2 items" });
  expect(state.room[0].delivery).toEqual([{ agent: "claude-laptop", state: "queued" }]);
  expect(state.room[1].delivery).toEqual([]);
});

test("the names all and everyone cannot be given to an agent, because @all is a broadcast", async () => {
  for (const name of ["all", "everyone"]) {
    const r = await fetch(`${base}/api/agents`, { method: "POST", headers: human, body: JSON.stringify({ name }) });
    expect(r.status).toBe(400);
  }
});
