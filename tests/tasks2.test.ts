import { test, expect } from "bun:test";
import { openStore } from "../src/store";
import { Hub, HUMAN } from "../src/hub";
import { DOC } from "./fixtures";

function setup() {
  const store = openStore(":memory:");
  const hub = new Hub(store);
  const mk = (name: string) => store.agentById(store.addAgent({ name, owner: "alper", device: "d", skills: [] }).id)!;
  return { store, hub, a: mk("claude-laptop"), b: mk("opencode-mac") };
}

test("an agent cannot create a bare-title task: description and acceptance criteria are required", () => {
  const { hub, a } = setup();
  expect(() => hub.createTask(a, { title: "do it", project: "kapi" })).toThrow(/description/);
  expect(() => hub.createTask(a, { title: "do it", project: "kapi", description: "too short", acceptance: "ok" })).toThrow(/description/);
  expect(() => hub.createTask(a, { title: "do it", project: "kapi", description: DOC.description })).toThrow(/acceptance/);
  expect(hub.createTask(a, { title: "do it", project: "kapi", ...DOC }).key).toBe("KAPI-1");
});

test("the human can still add a quick task without a description", () => {
  const { hub } = setup();
  expect(hub.humanCreateTask({ title: "sketch schema", project: "kapi" }).description).toBeNull();
});

test("every task tool accepts the readable key or an id prefix", () => {
  const { hub, store, a } = setup();
  const t = hub.createTask(a, { title: "x", project: "kapi", ...DOC });
  hub.claim(a, "kapi-1");
  hub.postStatus(a, t.id.slice(0, 8), "in_progress", "started");
  hub.attachEvidence(a, "KAPI-1", { kind: "test-output", ref: "bun test" });
  expect(hub.complete(a, "KAPI-1").status).toBe("done");
  expect(() => hub.claim(a, "KAPI-404")).toThrow("no such task");
  expect(store.getTask(t.id)?.status).toBe("done");
});

test("task history records who did what, in order, including status notes", () => {
  const { hub, a, b } = setup();
  const t = hub.createTask(a, { title: "x", project: "kapi", ...DOC });
  hub.claim(a, t.id);
  hub.postStatus(a, t.id, "in_progress", "wrote the schema");
  hub.postStatus(a, t.id, "blocked");
  hub.attachEvidence(a, t.id, { kind: "test-output", ref: "bun test", note: "12 pass" });
  hub.addComment(b, t.id, "can you also cover the empty case?");
  hub.attachEvidence(a, t.id, { kind: "diff", ref: "branch" });
  hub.complete(a, t.id);
  const d = hub.taskDetail(t.id);
  expect(d.events.map((e) => e.kind)).toEqual(["created", "claimed", "status", "status", "evidence", "comment", "evidence", "completed"]);
  expect(d.events[2].text).toContain("in_progress");
  expect(d.events[2].text).toContain("wrote the schema");
  expect(d.events[5].actor).toBe(b.id);
  expect(d.evidence.length).toBe(2);
});

test("ask_owner sends the question to the task's owner as a DM that wakes them, with the task attached", () => {
  const { hub, a, b } = setup();
  const t = hub.createTask(a, { title: "backend API", project: "kapi", ...DOC });
  hub.claim(a, t.id);
  hub.askOwner(b, t.id, "Which auth scheme should the endpoint use?");
  const got = hub.pull(a).items;
  expect(got.length).toBe(1);
  const m = (got[0] as any).message;
  expect(m.text).toContain("KAPI-1");
  expect(m.text).toContain("Which auth scheme");
  expect(m.from).toBe(b.id);
  expect(hub.taskDetail(t.id).events.some((e) => e.kind === "question")).toBe(true);
});

test("ask_owner falls back to the assignee, then the creator, and refuses to ask yourself", () => {
  const { hub, a, b } = setup();
  const t = hub.createTask(a, { title: "x", project: "kapi", assignee: "opencode-mac", ...DOC });
  hub.askOwner(a, t.id, "any update?");
  expect(hub.pull(b).items.filter((i) => i.type === "message").length).toBe(1);
  const u = hub.createTask(a, { title: "y", project: "kapi", ...DOC });
  hub.askOwner(b, u.id, "what is the expected format?");
  expect(hub.pull(a).items.length).toBe(1);
  expect(() => hub.askOwner(a, u.id, "me?")).toThrow(/you own/);
});

test("a task with open subtasks cannot be completed, and the error names them", () => {
  const { hub, a } = setup();
  const p = hub.createTask(a, { title: "parent", project: "kapi", ...DOC });
  const c = hub.createTask(a, { title: "child", project: "kapi", parentId: p.id, ...DOC });
  hub.claim(a, p.id);
  hub.attachEvidence(a, p.id, { kind: "summary", ref: "x" });
  expect(() => hub.complete(a, p.id)).toThrow(/KAPI-2/);
  hub.claim(a, c.id);
  hub.attachEvidence(a, c.id, { kind: "summary", ref: "y" });
  hub.complete(a, c.id);
  expect(hub.complete(a, p.id).status).toBe("done");
});

test("a subtask cannot be added under a task that is already done", () => {
  const { hub, a } = setup();
  const p = hub.createTask(a, { title: "parent", project: "kapi", ...DOC });
  hub.claim(a, p.id);
  hub.attachEvidence(a, p.id, { kind: "summary", ref: "x" });
  hub.complete(a, p.id);
  expect(() => hub.createTask(a, { title: "late", project: "kapi", parentId: p.id, ...DOC })).toThrow(/done/);
});

test("escalate files a dispute for the human with both positions and the task, and blocks the task", () => {
  const { hub, store, a, b } = setup();
  const t = hub.createTask(a, { title: "auth", project: "kapi", ...DOC });
  hub.claim(a, t.id);
  const r = hub.escalate(a, { task: t.id, withAgent: "opencode-mac", question: "Which auth scheme?",
    myPosition: "API keys: simple for the demo.", theirPosition: "OAuth: closer to production." });
  expect(r.kind).toBe("dispute");
  expect(r.text).toContain("KAPI-1");
  expect(r.text).toContain("API keys");
  expect(r.text).toContain("OAuth");
  expect(r.text).toContain("Which auth scheme?");
  expect(r.withAgent).toBe(b.id);
  expect(store.openRequests().map((x) => x.id)).toContain(r.id);
  expect(store.getTask(t.id)?.status).toBe("blocked");
});

test("when the human settles a dispute, both agents hear the decision", () => {
  const { hub, a, b } = setup();
  const r = hub.escalate(a, { withAgent: "opencode-mac", question: "Which stack?", myPosition: "Bun", theirPosition: "Node" });
  hub.humanAnswer(r.id, "Use Bun.");
  const forA = hub.pull(a).items.map((i: any) => i.type);
  expect(forA).toContain("answer");
  const forB = hub.pull(b).items as any[];
  expect(forB.length).toBe(1);
  expect(forB[0].message.text).toContain("Use Bun.");
  expect(forB[0].message.from).toBe(HUMAN);
});
