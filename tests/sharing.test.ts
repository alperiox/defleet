import { test, expect, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { DOC } from "./fixtures";

const { app, hub, store } = createApp(":memory:", "human-secret", { hubOwner: "alper" });
const server = Bun.serve({ port: 0, fetch: app.fetch });
afterAll(() => server.stop(true));
const base = `http://localhost:${server.port}`;
const mk = (name: string, owner: string) => { const r = store.addAgent({ name, owner, device: "d", skills: [] }); return { token: r.token, agent: store.agentById(r.id)! }; };
const me = mk("claude-laptop", "alper"), me2 = mk("opencode-mac", "alper"), friend = mk("friend-agent", "sam"), outsider = mk("stranger", "eve");
hub.grant("friend-agent", "shared");
// Reads and acknowledges, so each call returns only what is new.
const pull = (a: { agent: any }) => { const r = hub.pull(a.agent); hub.pull(a.agent, r.ack); return r.items as any[]; };
const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };

function doneTask(project: string, withReport: boolean) {
  const t = hub.createTask(me.agent, { title: `done in ${project}`, project, ...DOC });
  hub.claim(me.agent, t.id);
  hub.attachEvidence(me.agent, t.id, { kind: "test-output", ref: "bun test" });
  if (withReport) hub.attachReport(me.agent, t.id, "Outcome", "## Result\nIt works. See the screenshot.");
  hub.complete(me.agent, t.id);
  return t;
}

test("a finished task's outcome is readable by an agent that can see its project, and by no one else", () => {
  const t = doneTask("shared", true);
  const o = hub.getOutcome(friend.agent, t.key);
  expect(o.status).toBe("done");
  expect(o.report).toContain("It works");
  expect(o.artifacts.map((a) => a.kind)).toEqual(["report"]);
  const hidden = doneTask("secret", true);
  expect(() => hub.getOutcome(friend.agent, hidden.key)).toThrow("no such task");
  expect(() => hub.getOutcome(outsider.agent, t.key)).toThrow("no such task");
  expect(hub.getOutcome(me2.agent, hidden.key).report).toContain("It works");
});

test("requesting the outcome of a finished task returns the report at once and records that it was shared", () => {
  const t = doneTask("shared", true);
  const r = hub.askForOutcome(friend.agent, t.key);
  expect(r.state).toBe("delivered");
  expect(r.report).toContain("It works");
  expect(hub.taskDetail(t.key).events.some((e) => e.kind === "outcome-shared")).toBe(true);
});

test("requesting the outcome of a finished task that has no report asks the owner to write one", () => {
  const t = doneTask("shared", false);
  pull(me);
  const r = hub.askForOutcome(friend.agent, t.key);
  expect(r.state).toBe("requested");
  const dm = pull(me).find((i) => i.type === "message");
  expect(dm.message.text).toContain("attach_report");
  expect(dm.trust).toBe("external");
});

test("asking about an unfinished task gives its status and pings the owner", () => {
  const t = hub.createTask(me.agent, { title: "in flight", project: "shared", ...DOC });
  hub.claim(me.agent, t.id);
  hub.postStatus(me.agent, t.id, "in_progress", "halfway through the schema");
  pull(me);
  const r = hub.askForOutcome(friend.agent, t.key);
  expect(r.state).toBe("status");
  expect(r.status).toBe("in_progress");
  expect(r.note).toContain("halfway");
  expect(pull(me).some((i) => i.type === "message")).toBe(true);
  expect(() => hub.askForOutcome(me.agent, t.key)).toThrow(/you own/);
});

test("an internal agent asking to take over a task just messages the owner", () => {
  const t = hub.createTask(me.agent, { title: "take me", project: "shared", ...DOC });
  hub.claim(me.agent, t.id);
  pull(me);
  hub.requestTakeover(me2.agent, t.key, "I have the tests half written already");
  expect(pull(me).find((i) => i.type === "message").message.text).toContain("half written");
  expect(store.openRequests().some((r) => r.kind === "handoff")).toBe(false);
});

test("an external agent asking to take over a task files a handoff for the human; approval hands it over", () => {
  const t = hub.createTask(me.agent, { title: "hand me over", project: "shared", ...DOC });
  hub.claim(me.agent, t.id);
  hub.requestTakeover(friend.agent, t.key, "we own the integration and can finish this today");
  const req = store.openRequests().find((r) => r.kind === "handoff")!;
  expect(req.text).toContain(t.key);
  expect(req.text).toContain("friend-agent");
  expect(req.taskId).toBe(t.id);
  hub.decideHandoff(req.id, true);
  const after = store.getTask(t.id)!;
  expect(after.claimedBy).toBeNull();
  expect(after.assignee).toBe(friend.agent.id);
  expect(hub.claim(friend.agent, t.key).claimedBy).toBe(friend.agent.id);
  expect(pull(friend).some((i) => i.type === "answer")).toBe(true);
});

test("declining a handoff leaves the task with its owner and tells the requester", () => {
  const t = hub.createTask(me.agent, { title: "keep me", project: "shared", ...DOC });
  hub.claim(me.agent, t.id);
  hub.requestTakeover(friend.agent, t.key, "please");
  const req = store.openRequests().find((r) => r.kind === "handoff" && r.taskId === t.id)!;
  hub.decideHandoff(req.id, false);
  expect(store.getTask(t.id)!.claimedBy).toBe(me.agent.id);
  const ans = pull(friend).filter((i) => i.type === "answer").pop();
  expect(ans.request.answer).toMatch(/declin/i);
});

test("a task cannot be handed to an external agent by the owner agent directly", () => {
  const t = hub.createTask(me.agent, { title: "no direct handoff", project: "shared", ...DOC });
  hub.claim(me.agent, t.id);
  expect(() => hub.release(me.agent, t.key, "friend-agent", "Data is prepared and the script is written but untested. Left: run it and attach the result.")).toThrow(/human/);
});

test("the human can decide a handoff through the API; other request kinds are refused", async () => {
  const t = hub.createTask(me.agent, { title: "api handoff", project: "shared", ...DOC });
  hub.claim(me.agent, t.id);
  hub.requestTakeover(friend.agent, t.key, "ready to take it");
  const req = store.openRequests().find((r) => r.kind === "handoff" && r.taskId === t.id)!;
  const ok = await fetch(`${base}/api/requests/${req.id}/decide`, { method: "POST", headers: human, body: JSON.stringify({ approve: true }) });
  expect(ok.status).toBe(200);
  expect(store.getTask(t.id)!.assignee).toBe(friend.agent.id);
  const other = hub.askHuman(me.agent, { kind: "decision", text: "which stack?" });
  const bad = await fetch(`${base}/api/requests/${other.id}/decide`, { method: "POST", headers: human, body: JSON.stringify({ approve: true }) });
  expect(bad.status).toBe(400);
});

test("an agent downloads an outcome file only for projects it can see", async () => {
  const t = doneTask("shared", true);
  const o = hub.getOutcome(friend.agent, t.key);
  const url = `${base}/agent/artifacts/${o.artifacts[0].id}`;
  const ok = await fetch(url, { headers: { Authorization: `Bearer ${friend.token}` } });
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain("It works");
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { Authorization: `Bearer ${outsider.token}` } })).status).toBe(404);
});
