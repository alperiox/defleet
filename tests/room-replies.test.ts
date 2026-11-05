import { test, expect } from "bun:test";
import { openStore } from "../src/store";
import { Hub } from "../src/hub";
import { createApp } from "../src/app";

function fresh() {
  const store = openStore(":memory:"), hub = new Hub(store);
  hub.hubOwner = "owner";
  const mk = (name: string, workspaceId = "default") => store.agentById(store.addAgent({ name, owner: "owner", device: "test", skills: [], workspaceId }).id)!;
  return { store, hub, a: mk("alpha"), b: mk("beta"), mk };
}

test("plain human Room replies wake only the latest speaking agent and keep the text unchanged", () => {
  const { store, hub, a, b } = fresh();
  try {
    hub.say(a, "room", "First response"); hub.say(b, "room", "Latest response");
    const reply = hub.humanSay("Please continue");
    expect(reply.text).toBe("Please continue");
    expect(hub.deliveryFor(reply)).toEqual([{ agent: b.name, state: "queued" }]);
    expect(hub.pull(b).items.some(i => i.type === "message" && i.message.id === reply.id)).toBe(true);
    expect(hub.pull(a).items.some(i => i.type === "message" && i.message.id === reply.id)).toBe(false);
    hub.say(a, "room", "A newer response");
    const restarted = new Hub(store);
    expect(restarted.deliveryFor(store.messagesSince("room", 0).find(m => m.id === reply.id)!)).toEqual([{ agent: b.name, state: "queued" }]);
  } finally { store.db.close(); }
});

test("the reply window expires 20 minutes after the agent message; human follow-ups do not extend it", () => {
  const { store, hub, a } = fresh();
  try {
    const m = hub.say(a, "room", "Ready");
    store.db.query("UPDATE messages SET created_at = ? WHERE id = ?").run(Date.now() - 19 * 60_000, m.id);
    expect(hub.deliveryFor(hub.humanSay("One more thing"))).toHaveLength(1);
    store.db.query("UPDATE messages SET created_at = ? WHERE id = ?").run(Date.now() - 20 * 60_000, m.id);
    expect(hub.deliveryFor(hub.humanSay("After the window"))).toEqual([]);
    expect(hub.deliveryFor(hub.humanSay("@alpha After the window"))).toHaveLength(1);
    expect(hub.deliveryFor(store.messagesSince("room", 0).find(m => m.text === "One more thing")!)).toHaveLength(1);
  } finally { store.db.close(); }
});

test("explicit mentions override automatic replies, including broadcasts and unknown names", () => {
  const { store, hub, a, b } = fresh();
  try {
    hub.say(a, "room", "Ready");
    expect(hub.deliveryFor(hub.humanSay("@beta Please check")).map(d => d.agent)).toEqual([b.name]);
    expect(hub.deliveryFor(hub.humanSay("@all Please check"))).toHaveLength(2);
    expect(hub.deliveryFor(hub.humanSay("@missing Please check"))).toEqual([]);
  } finally { store.db.close(); }
});

test("Room reply windows stay within a workspace and ignore DMs and agent-to-agent chatter", () => {
  const { store, hub, a, b, mk } = fresh();
  try {
    const ws = hub.createWorkspace("Other"), c = mk("charlie", ws.id);
    hub.say(a, "room", "Default reply"); hub.say(c, "room", "Other reply"); hub.say(b, "dm:human", "Private reply");
    expect(hub.deliveryFor(hub.humanSay("Default"))).toEqual([{ agent: a.name, state: "queued" }]);
    expect(hub.deliveryFor(hub.humanSay("Other", ws.id))).toEqual([{ agent: c.name, state: "queued" }]);
    expect(hub.deliveryFor(hub.say(b, "room", "Agent chatter"))).toEqual([]);
    hub.moveAgent(b.name, ws.id);
    expect(hub.deliveryFor(hub.humanSay("No longer here"))).toEqual([]);
    hub.removeAgent(c.name);
    expect(hub.deliveryFor(hub.humanSay("Removed", ws.id))).toEqual([]);
  } finally { store.db.close(); }
});

test("REST Room posting routes a plain reply and state exposes its message deadline", async () => {
  const { app, hub, store } = createApp(":memory:", "test-human");
  try {
    const agent = store.agentById(store.addAgent({ name: "responder", owner: "owner", device: "test", skills: [] }).id)!;
    const m = hub.say(agent, "room", "What next?");
    const headers = { Authorization: "Bearer test-human", "content-type": "application/json" };
    const res = await app.request("/api/room", { method: "POST", headers, body: JSON.stringify({ text: "Continue" }) });
    expect(res.status).toBe(200);
    const state: any = await (await app.request("/api/state", { headers })).json();
    expect(state.room.at(-1).delivery).toEqual([{ agent: agent.name, state: "queued" }]);
    expect(state.roomReplies).toContainEqual({ workspaceId: "default", agent: agent.name, messageId: m.id, expiresAt: m.createdAt + 20 * 60_000 });
  } finally { store.db.close(); }
});
