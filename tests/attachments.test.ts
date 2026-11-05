import { test, expect, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { DOC } from "./fixtures";

const { app, hub, store } = createApp(":memory:", "human-secret", { hubOwner: "alper" });
const server = Bun.serve({ port: 0, fetch: app.fetch });
afterAll(() => server.stop(true));
const base = `http://localhost:${server.port}`;
const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };
const mk = (name: string, owner = "alper") => { const r = store.addAgent({ name, owner, device: "d", skills: [] }); return { a: store.agentById(r.id)!, token: r.token }; };
const claude = mk("claude-laptop"), oc = mk("opencode-mac"), friend = mk("friend-agent", "sam");
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const upload = (token: string, q: Record<string, string>, body: BodyInit = png) =>
  fetch(`${base}/agent/artifacts?${new URLSearchParams(q)}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });

test("an agent can upload a file with no task, and it waits unattached", async () => {
  const res = await upload(claude.token, { kind: "screenshot", name: "loss.png" });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(store.getArtifact(body.id)!.taskId).toBe("");
});

test("a message carries its attachments, and the UI state lists them with a link", async () => {
  const up: any = await (await upload(claude.token, { kind: "screenshot", name: "curve.png" })).json();
  const m = hub.say(claude.a, "dm:human", "here are the loss curves", [up.id]);
  const state: any = await (await fetch(`${base}/api/state`, { headers: human })).json();
  const msg = state.dms.find((x: any) => x.id === m.id);
  expect(msg.attachments).toHaveLength(1);
  expect(msg.attachments[0]).toMatchObject({ id: up.id, kind: "screenshot", name: "curve.png" });
  expect(msg.attachments[0].url).toContain(`/artifacts/${up.id}/`);
  expect((await fetch(`${base}${msg.attachments[0].url}`)).status).toBe(200);
});

test("an attachment alone is enough, but a message with nothing at all is refused", async () => {
  const up: any = await (await upload(claude.token, { kind: "file", name: "a.txt" }, "x")).json();
  expect(hub.say(claude.a, "dm:human", "", [up.id]).id).toBeGreaterThan(0);
  expect(() => hub.say(claude.a, "dm:human", "  ", [])).toThrow(/empty/i);
});

test("you cannot attach someone else's upload, a missing one, or one already used", async () => {
  const up: any = await (await upload(claude.token, { kind: "file", name: "mine.txt" }, "x")).json();
  expect(() => hub.say(oc.a, "dm:human", "mine now", [up.id])).toThrow(/not yours|no such/i);
  expect(() => hub.say(claude.a, "dm:human", "x", ["nope"])).toThrow(/no such/i);
  hub.say(claude.a, "dm:human", "first", [up.id]);
  expect(() => hub.say(claude.a, "dm:human", "again", [up.id])).toThrow(/already/i);
});

test("naming a task you hold also puts the file on that task, so a preview counts", async () => {
  const t = hub.createTask(claude.a, { title: "panel", project: "kapi", ...DOC, needsPreview: true } as any);
  hub.claim(claude.a, t.id);
  const up: any = await (await upload(claude.token, { kind: "screenshot", name: "panel.png" })).json();
  hub.say(claude.a, "dm:human", "looks like this", [up.id], t.id);
  expect(store.getArtifact(up.id)!.taskId).toBe(t.id);
  hub.attachEvidence(claude.a, t.id, { kind: "test-output", ref: "ok" });
  expect(hub.complete(claude.a, t.id).status).toBe("done");
});

test("naming a task you do not hold is refused and the file stays unattached", async () => {
  const t = hub.createTask(claude.a, { title: "other", project: "kapi", ...DOC } as any);
  hub.claim(claude.a, t.id);
  const up: any = await (await upload(oc.token, { kind: "screenshot", name: "x.png" })).json();
  expect(() => hub.say(oc.a, "dm:human", "x", [up.id], t.id)).toThrow(/not your task/i);
  expect(store.getArtifact(up.id)!.messageId).toBeNull();
});

test("at most ten attachments on a message", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 11; i++) ids.push(((await (await upload(claude.token, { kind: "file", name: `f${i}.txt` }, "x")).json()) as any).id);
  expect(() => hub.say(claude.a, "dm:human", "many", ids)).toThrow(/at most 10/i);
});

test("an outside agent can attach only where it can already speak", async () => {
  const up: any = await (await upload(friend.token, { kind: "screenshot", name: "s.png" })).json();
  expect(() => hub.say(friend.a, "room", "hi", [up.id])).toThrow();
});

test("a stray upload does not pile up forever: an agent may hold at most 50 unattached files", async () => {
  const g = mk("stray-agent");
  for (let i = 0; i < 50; i++) expect((await upload(g.token, { kind: "file", name: `s${i}.txt` }, "x")).status).toBe(200);
  expect((await upload(g.token, { kind: "file", name: "one-more.txt" }, "x")).status).toBe(429);
});
