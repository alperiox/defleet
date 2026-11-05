import { DOC } from "./fixtures";
import { test, expect } from "bun:test";
import { openStore } from "../src/store";
import { Hub } from "../src/hub";

function fresh() {
  const store = openStore(":memory:");
  const hub = new Hub(store);
  const mk = (name: string, device: string) => {
    const { id } = store.addAgent({ name, owner: "alper", device, skills: [] });
    return store.agentById(id)!;
  };
  return { store, hub, a: mk("claude-laptop", "laptop"), b: mk("opencode-mac", "mac") };
}

test("two agents claim one task: exactly one succeeds, the other is told it is already claimed", () => {
  const { hub, a, b } = fresh();
  const t = hub.createTask(a, { ...DOC, title: "collect", project: "dash" });
  const results = [a, b].map((ag) => { try { hub.claim(ag, t.id); return "ok"; } catch (e: any) { return e.message; } });
  expect(results.filter((r) => r === "ok").length).toBe(1);
  expect(results.some((r) => r.startsWith("already claimed"))).toBe(true);   // and it says who holds it, so nobody works in parallel
});

test("complete without evidence is rejected and the task stays not done; with evidence it succeeds", () => {
  const { hub, store, a } = fresh();
  const t = hub.createTask(a, { ...DOC, title: "x", project: "p" });
  hub.claim(a, t.id);
  expect(() => hub.complete(a, t.id)).toThrow("evidence required");
  expect(store.getTask(t.id)!.status).not.toBe("done");
  hub.attachEvidence(a, t.id, { kind: "test-output", ref: "bun test: 8 pass" });
  expect(hub.complete(a, t.id).status).toBe("done");
});

test("complete by an agent that did not claim the task is rejected 'not your task'", () => {
  const { hub, a, b } = fresh();
  const t = hub.createTask(a, { ...DOC, title: "x", project: "p" });
  hub.claim(a, t.id);
  hub.attachEvidence(a, t.id, { kind: "k", ref: "r" });
  expect(() => hub.complete(b, t.id)).toThrow("not your task");
});

test("post_status cannot mark a task done, so the evidence rule cannot be bypassed", () => {
  const { hub, store, a } = fresh();
  const t = hub.createTask(a, { ...DOC, title: "x", project: "p" });
  hub.claim(a, t.id);
  expect(() => hub.postStatus(a, t.id, "done")).toThrow("complete_task");
  expect(store.getTask(t.id)!.status).not.toBe("done");
});

test("a done task accepts no further status changes", () => {
  const { hub, a } = fresh();
  const t = hub.createTask(a, { ...DOC, title: "x", project: "p" });
  hub.claim(a, t.id);
  hub.attachEvidence(a, t.id, { kind: "k", ref: "r" });
  hub.complete(a, t.id);
  expect(() => hub.postStatus(a, t.id, "in_progress")).toThrow("already done");
});

test("post_status cannot set 'open' or 'claimed' (use release_task)", () => {
  const { hub, a } = fresh();
  const t = hub.createTask(a, { ...DOC, title: "x", project: "p" });
  hub.claim(a, t.id);
  expect(() => hub.postStatus(a, t.id, "open")).toThrow("release_task");
});

test("releasing a claimed task lets another agent claim it", () => {
  const { hub, store, a, b } = fresh();
  const t = hub.createTask(a, { ...DOC, title: "x", project: "p" });
  hub.claim(a, t.id);
  const released = hub.release(a, t.id, undefined, "Data is prepared and the script is written but untested. Left: run it and attach the result.");
  expect(released.status).toBe("open");
  expect(released.claimedBy).toBeNull();
  expect(hub.claim(b, t.id).claimedBy).toBe(b.id);
  expect(store.getTask(t.id)!.claimedBy).toBe(b.id);
});

test("only the owner can release, and a handoff target becomes the assignee", () => {
  const { hub, a, b } = fresh();
  const t = hub.createTask(a, { ...DOC, title: "x", project: "p" });
  hub.claim(a, t.id);
  expect(() => hub.release(b, t.id, undefined, "Data is prepared and the script is written but untested. Left: run it and attach the result.")).toThrow("not your task");
  const handed = hub.release(a, t.id, "opencode-mac", "Data is prepared and the script is written but untested. Left: run it and attach the result.");
  expect(handed.assignee).toBe(b.id);
  expect(() => hub.claim(a, t.id)).toThrow("assigned to another agent");
  expect(hub.claim(b, t.id).claimedBy).toBe(b.id);
});

test("the human can free a stuck task", () => {
  const { hub, a, b } = fresh();
  const t = hub.createTask(a, { ...DOC, title: "x", project: "p" });
  hub.claim(a, t.id);
  hub.humanRelease(t.id);
  expect(hub.claim(b, t.id).claimedBy).toBe(b.id);
});

test("an answer reaches the asking agent's inbox only, and is redelivered until acknowledged", () => {
  const { hub, store, a, b } = fresh();
  const r = hub.askHuman(a, { kind: "decision", text: "jsonl or parquet?" });
  hub.humanAnswer(r.id, "parquet");
  expect(hub.inbox(b).answers.length).toBe(0);
  expect(hub.inbox(a).answers.map((x) => x.answer)).toEqual(["parquet"]);
  expect(hub.inbox(a).answers.map((x) => x.answer)).toEqual(["parquet"]);
  expect(hub.inbox(a, [r.id]).answers.length).toBe(0);
  expect(store.requestsFor(a.id)[0].answer).toBe("parquet");
});

test("myRequests returns the agent's own requests with their answers", () => {
  const { hub, a, b } = fresh();
  const r = hub.askHuman(a, { kind: "decision", text: "q?" });
  hub.humanAnswer(r.id, "yes");
  expect(hub.myRequests(a).map((x) => x.answer)).toEqual(["yes"]);
  expect(hub.myRequests(b)).toEqual([]);
});

test("waitForWork with nothing to do resolves empty near the timeout", async () => {
  const { hub, a } = fresh();
  const t0 = Date.now();
  const { items } = await hub.waitForWork(a, 200);
  const dt = Date.now() - t0;
  expect(items).toEqual([]);
  expect(dt).toBeGreaterThanOrEqual(150);
  expect(dt).toBeLessThan(600);
});

test("waitForWork wakes within 100ms when a task is assigned to the agent mid-wait", async () => {
  const { hub, a, b } = fresh();
  const waiting = hub.waitForWork(b, 5000);
  const t0 = Date.now();
  setTimeout(() => hub.createTask(a, { ...DOC, title: "for mac", project: "dash", assignee: "opencode-mac" }), 20);
  const { items } = await waiting;
  expect(Date.now() - t0).toBeLessThan(100);
  expect(items.length).toBe(1);
  expect(items[0].type).toBe("task");
});

test("a pending task is redelivered until acknowledged, then not again", async () => {
  const { hub, a, b } = fresh();
  hub.createTask(a, { ...DOC, title: "pending", project: "dash", assignee: "opencode-mac" });
  const first = await hub.waitForWork(b, 100);
  expect(first.items.length).toBe(1);
  const again = await hub.waitForWork(b, 100);
  expect(again.items.length).toBe(1);
  const acked = await hub.waitForWork(b, 100, first.ack);
  expect(acked.items).toEqual([]);
});

test("an abandoned wait cannot swallow an answer: the next wait still receives it", async () => {
  const { hub, a } = fresh();
  const r = hub.askHuman(a, { kind: "decision", text: "q?" });
  const orphan = hub.waitForWork(a, 5000); // the client that made this call is gone
  hub.humanAnswer(r.id, "parquet");
  await orphan;
  const next = await hub.waitForWork(a, 100);
  expect(next.items.map((i) => i.type === "answer" && i.request.answer)).toEqual(["parquet"]);
  expect(hub.inbox(a).answers.map((x) => x.answer)).toEqual(["parquet"]);
});

test("aborting a wait resolves it empty at once", async () => {
  const { hub, a } = fresh();
  const ctl = new AbortController();
  const t0 = Date.now();
  const waiting = hub.waitForWork(a, 5000, undefined, ctl.signal);
  setTimeout(() => ctl.abort(), 30);
  const { items } = await waiting;
  expect(items).toEqual([]);
  expect(Date.now() - t0).toBeLessThan(200);
});

test("a room @mention wakes the mentioned agent but a message from itself does not", async () => {
  const { hub, a, b } = fresh();
  const waiting = hub.waitForWork(b, 5000);
  setTimeout(() => hub.say(a, "room", "hey @opencode-mac can you take the feed?"), 20);
  const { items, ack } = await waiting;
  expect(items[0].type).toBe("message");
  hub.say(b, "room", "I said @opencode-mac to myself");
  expect((await hub.waitForWork(b, 100, ack)).items).toEqual([]);
});

test("a DM to an agent by name is delivered as a message item", async () => {
  const { hub, a, b } = fresh();
  hub.say(a, "dm:opencode-mac", "private note");
  const { items } = await hub.waitForWork(b, 100);
  expect(items.length).toBe(1);
  expect(items[0].type === "message" && items[0].message.text).toBe("private note");
});

test("the human can DM an agent, and an agent's DM to the human is visible to the human", async () => {
  const { hub, store, a, b } = fresh();
  hub.humanDm("opencode-mac", "how is it going?");
  const { items } = await hub.waitForWork(b, 100);
  expect(items[0].type === "message" && items[0].message.text).toBe("how is it going?");
  hub.say(b, "dm:human", "fine, almost done");
  hub.say(a, "dm:human", "also fine");
  const texts = store.dmsWithHuman().map((m) => m.text);
  expect(texts).toEqual(["how is it going?", "fine, almost done", "also fine"]);
});

test("subtasks are marked aiGenerated and every mutating call adds a hub touch", () => {
  const { hub, store, a } = fresh();
  const parent = hub.createTask(a, { ...DOC, title: "dashboard", project: "dash" });
  const sub = hub.createTask(a, { ...DOC, title: "backend", project: "dash", parentId: parent.id });
  expect(parent.aiGenerated).toBe(false);
  expect(sub.aiGenerated).toBe(true);
  hub.claim(a, sub.id);
  hub.say(a, "room", "hi");
  const hubTouches = store.touchesFor(a.id).filter((t) => t.source === "hub");
  expect(hubTouches.length).toBeGreaterThanOrEqual(4);
  hub.recordTouch(a, "ran-shell", "rm -rf build");
  expect(store.touchesFor(a.id).at(-1)!.source).toBe("declared");
});


test("room mentions match complete agent names, never prefixes or email addresses", () => {
  const { store, hub, a } = fresh();
  const short = store.agentById(store.addAgent({ name: "claude", owner: "alper", device: "x", skills: [] }).id)!;
  expect(hub.deliveryFor(hub.humanSay("@claude-laptop: hello")).map(x => x.agent)).toEqual([a.name]);
  expect(hub.deliveryFor(hub.humanSay("mail person@claude or @claude-laptops"))).toEqual([]);
  expect(hub.deliveryFor(hub.humanSay("(@CLAUDE), hello")).map(x => x.agent)).toEqual([short.name]);
});
