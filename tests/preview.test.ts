import { test, expect, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { DOC } from "./fixtures";

const { app, hub, store } = createApp(":memory:", "human-secret", { hubOwner: "alper" });
const server = Bun.serve({ port: 0, fetch: app.fetch });
afterAll(() => server.stop(true));
const base = `http://localhost:${server.port}`;
const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };
const r = store.addAgent({ name: "claude-laptop", owner: "alper", device: "d", skills: [] });
const agent = store.agentById(r.id)!;

const art = (taskId: string, kind: "screenshot" | "video" | "file" | "report", name: string) =>
  hub.recordArtifact(agent, taskId, { id: crypto.randomUUID(), kind, name, mime: kind === "video" ? "video/mp4" : "image/png", size: 10 });

function ready(needsPreview: boolean) {
  const t = hub.createTask(agent, { title: "restyle the panel", project: "kapi", ...DOC, needsPreview } as any);
  hub.claim(agent, t.id);
  hub.attachEvidence(agent, t.id, { kind: "test-output", ref: "bun test: pass" });
  return t;
}

test("a task flagged as needing a preview cannot be completed without a screenshot or video, and the refusal says what to do", () => {
  const t = ready(true);
  expect(t.previewRequired).toBe(true);
  expect(() => hub.complete(agent, t.id)).toThrow(/preview required/i);
  try { hub.complete(agent, t.id); } catch (e) { expect((e as Error).message).toMatch(/screenshot/); expect((e as Error).message).toMatch(/not (host|a server)|do not host/i); }
  art(t.id, "report", "r.md");                                  // a written report is not a preview
  expect(() => hub.complete(agent, t.id)).toThrow(/preview required/i);
  art(t.id, "screenshot", "panel-phone.png");
  expect(hub.complete(agent, t.id).status).toBe("done");
});

test("a video counts as a preview", () => {
  const t = ready(true);
  art(t.id, "video", "demo.mp4");
  expect(hub.complete(agent, t.id).status).toBe("done");
});

test("a task that does not need a preview completes with evidence alone, as before", () => {
  const t = ready(false);
  expect(t.previewRequired).toBe(false);
  expect(hub.complete(agent, t.id).status).toBe("done");
});

test("the human can flag a task when creating it, or later, and see it in the state", async () => {
  const made = await (await fetch(`${base}/api/tasks`, { method: "POST", headers: human, body: JSON.stringify({ title: "new landing page", project: "kapi", needsPreview: true }) })).json() as any;
  expect(made.previewRequired).toBe(true);
  const plain = await (await fetch(`${base}/api/tasks`, { method: "POST", headers: human, body: JSON.stringify({ title: "fix a typo", project: "kapi" }) })).json() as any;
  expect(plain.previewRequired).toBe(false);
  expect((await fetch(`${base}/api/tasks/${plain.id}/preview`, { method: "POST", body: JSON.stringify({ required: true }) })).status).toBe(401);
  expect((await fetch(`${base}/api/tasks/${plain.id}/preview`, { method: "POST", headers: human, body: JSON.stringify({ required: true }) })).status).toBe(200);
  const state: any = await (await fetch(`${base}/api/state`, { headers: human })).json();
  expect(state.tasks.find((t: any) => t.id === plain.id).previewRequired).toBe(true);
  expect((await fetch(`${base}/api/tasks/${plain.id}/preview`, { method: "POST", headers: human, body: JSON.stringify({ required: "yes" }) })).status).toBe(400);
});

test("the agent that is handed such a task is told, in the task itself, that a preview is due", async () => {
  const { buildPrompt } = await import("../helper/fleet-helper");
  const t = ready(true);
  const prompt = buildPrompt([{ type: "task", task: t, trust: "owner", by: { name: "human", owner: "alper" } }] as any, { harness: "claude" } as any, null);
  expect(prompt).toMatch(/preview/i);
  expect(prompt).toMatch(/screenshot/i);
});
