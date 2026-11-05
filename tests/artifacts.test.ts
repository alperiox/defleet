import { test, expect, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { DOC } from "./fixtures";

const { app, hub, store } = createApp(":memory:", "human-secret", { maxArtifactBytes: 2000 });
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

const mk = (name: string) => store.addAgent({ name, owner: "alper", device: "d", skills: [] });
const ta = mk("claude-laptop"), tb = mk("opencode-mac");
const A = store.agentById(ta.id)!;
const task = hub.createTask(A, { title: "demo", project: "kapi", ...DOC });
hub.claim(A, task.id);
const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };
const upload = (token: string, qs: string, body: BodyInit) =>
  fetch(`${base}/agent/artifacts?${qs}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const state = async () => (await fetch(`${base}/api/state`, { headers: human })).json();

test("uploading needs the owner's agent token and a task they hold", async () => {
  expect((await fetch(`${base}/agent/artifacts?task=${task.key}&name=a.png&kind=screenshot`, { method: "POST", body: PNG })).status).toBe(401);
  expect((await upload(tb.token, `task=${task.key}&name=a.png&kind=screenshot`, PNG)).status).toBe(403);
  expect((await upload(ta.token, `task=NOPE-1&name=a.png&kind=screenshot`, PNG)).status).toBe(404);
  expect((await upload(ta.token, `task=${task.key}&name=a.png&kind=weird`, PNG)).status).toBe(400);
});

test("an uploaded screenshot is listed with a signed link that serves the exact bytes", async () => {
  const res = await upload(ta.token, `task=${task.key}&name=panel.png&kind=screenshot`, PNG);
  expect(res.status).toBe(200);
  const { id } = await res.json();
  const s = await state();
  const art = s.artifacts.find((x: any) => x.id === id);
  expect(art.name).toBe("panel.png");
  expect(art.kind).toBe("screenshot");
  expect(art.size).toBe(PNG.length);
  const got = await fetch(`${base}${art.url}`);
  expect(got.status).toBe(200);
  expect(got.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
  expect(s.taskEvents.some((e: any) => e.taskId === task.id && e.kind === "artifact")).toBe(true);
});

test("a link without a valid signature, or an expired or tampered one, is refused; the human token works directly", async () => {
  const { id } = await (await upload(ta.token, `task=${task.key}&name=s.png&kind=screenshot`, PNG)).json();
  const art = (await state()).artifacts.find((x: any) => x.id === id);
  const u = new URL(base + art.url);
  expect((await fetch(`${base}/artifacts/${id}/s.png`)).status).toBe(403);
  const bad = new URL(u); bad.searchParams.set("sig", "0".repeat(64));
  expect((await fetch(bad)).status).toBe(403);
  const old = new URL(u); old.searchParams.set("exp", String(Date.now() - 1000));
  expect((await fetch(old)).status).toBe(403);
  expect((await fetch(`${base}/artifacts/${id}/s.png`, { headers: { Authorization: "Bearer human-secret" } })).status).toBe(200);
});

test("range requests work, so a browser can seek in a video", async () => {
  const { id } = await (await upload(ta.token, `task=${task.key}&name=d.mp4&kind=video`, PNG)).json();
  const art = (await state()).artifacts.find((x: any) => x.id === id);
  const r = await fetch(`${base}${art.url}`, { headers: { Range: "bytes=2-5" } });
  expect(r.status).toBe(206);
  expect(r.headers.get("content-range")).toBe(`bytes 2-5/${PNG.length}`);
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG.slice(2, 6));
});

test("an oversized upload is rejected without being stored", async () => {
  const before = (await state()).artifacts.length;
  const res = await upload(ta.token, `task=${task.key}&name=big.mp4&kind=video`, new Uint8Array(5000));
  expect(res.status).toBe(413);
  expect((await state()).artifacts.length).toBe(before);
});

test("a hostile file name cannot escape the artifact folder", async () => {
  const res = await upload(ta.token, `task=${task.key}&name=${encodeURIComponent("../../../etc/passwd")}&kind=file`, PNG);
  expect(res.status).toBe(200);
  const { id } = await res.json();
  const art = (await state()).artifacts.find((x: any) => x.id === id);
  expect(art.name).not.toContain("/");
  expect(art.name).not.toContain("..");
  expect((await fetch(`${base}${art.url}`)).status).toBe(200);
});

test("attach_report stores markdown as the task's report, readable through its link", async () => {
  const r = hub.attachReport(A, task.key, "Outcome", "## Done\n\nIt works.");
  const art = (await state()).artifacts.find((x: any) => x.id === r.id);
  expect(art.kind).toBe("report");
  expect(await (await fetch(`${base}${art.url}`)).text()).toBe("## Done\n\nIt works.");
});

test("when the human asks for an outcome, the owner is told and the task cannot be completed without a report", async () => {
  const t2 = hub.createTask(A, { title: "needs outcome", project: "kapi", ...DOC });
  hub.claim(A, t2.id);
  hub.attachEvidence(A, t2.id, { kind: "test-output", ref: "bun test" });
  const res = await fetch(`${base}/api/tasks/${t2.id}/request-outcome`, { method: "POST", headers: human });
  expect(res.status).toBe(200);
  const dms = hub.pull(A).items.filter((i: any) => i.type === "message" && i.message.text.includes(t2.key));
  expect(dms.length).toBe(1);
  expect(() => hub.complete(A, t2.id)).toThrow(/outcome report/);
  hub.attachReport(A, t2.id, "Outcome", "All good.");
  expect(hub.complete(A, t2.id).status).toBe("done");
});


test("signed URLs authorize only their artifact ID; malformed Unicode signatures are refused without throwing", async () => {
  const first = await (await upload(ta.token, `task=${task.key}&name=one.txt&kind=file`, "first")).json();
  const second = await (await upload(ta.token, `task=${task.key}&name=two.txt&kind=file`, "second")).json();
  const art = (await state()).artifacts.find((x: any) => x.id === first.id);
  const url = new URL(base + art.url);
  expect(await (await fetch(url)).text()).toBe("first");
  const swapped = new URL(url); swapped.pathname = swapped.pathname.replace(first.id, second.id);
  expect((await fetch(swapped)).status).toBe(403);
  const renamed = new URL(url); renamed.pathname = `/artifacts/${first.id}/other-name.txt`;
  expect(await (await fetch(renamed)).text()).toBe("first");
  const malformed = new URL(url); malformed.searchParams.set("sig", "é".repeat(64));
  expect((await fetch(malformed)).status).toBe(403);
});
