import { test, expect, afterEach } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { createApp } from "../src/app";
import { buildPrompt, type HelperConfig } from "../helper/fleet-helper";

const fixtures: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.db.close(); rmSync(f.hub.dataDir, { recursive: true, force: true }); } });
function setup(options: Record<string, unknown> = {}) {
  const f = createApp(":memory:", "human", { hubOwner: "owner", ...options }); fixtures.push(f);
  const a = f.store.addAgent({ name: "worker", owner: "owner", device: "d", skills: [] });
  const b = f.store.addAgent({ name: "other", owner: "owner", device: "d", skills: [] });
  const outside = f.store.addAgent({ name: "outside", owner: "guest", device: "d", skills: [] });
  const req = (path: string, body?: unknown, token = "human") => f.app.request(path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const upload = async (name = "brief.pdf", data: BodyInit = "%PDF-1.4\nexample", mime = "application/pdf", token = "human") => f.app.request(`/api/artifacts?name=${encodeURIComponent(name)}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": mime }, body: data });
  return { ...f, a, b, outside, req, upload };
}

test("human uploads stream to disk and an attachment-only DM wakes its recipient with metadata", async () => {
  const f = setup(); const up = await f.upload("../../brief.pdf"); expect(up.status).toBe(200);
  const art: any = await up.json(); expect(art.name).toBe("brief.pdf");
  const sent = await f.req("/api/dm/worker", { text: "", attachments: [art.id] }); expect(sent.status).toBe(200);
  const m: any = await sent.json();
  const pulled = f.hub.pull(f.store.agentById(f.a.id)!);
  const item = pulled.items.find((i: any) => i.type === "message" && i.message.id === m.id) as any;
  expect(item.message.attachments).toEqual([expect.objectContaining({ id: art.id, name: "brief.pdf", mime: "application/pdf", size: 16 })]);
  const downloaded = await f.req(`/agent/artifacts/${art.id}`, undefined, f.a.token);
  expect(await downloaded.text()).toBe("%PDF-1.4\nexample");
  expect(downloaded.headers.get("content-disposition")).toStartWith("attachment;");
  expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
  const state: any = await (await f.req("/api/state")).json();
  expect(state.dms.find((x: any) => x.id === m.id).attachments[0].mime).toBe("application/pdf");
});

test("human Room files are scoped to its workspace; outside/quarantine cannot download human files", async () => {
  const f = setup(); const ws = f.hub.createWorkspace("other-space"); f.hub.moveAgent("other", ws.id);
  const art: any = await (await f.upload()).json();
  expect((await f.req("/api/room", { text: "@worker", attachments: [art.id] })).status).toBe(200);
  expect((await f.req(`/agent/artifacts/${art.id}`, undefined, f.a.token)).status).toBe(200);
  const qItems = f.hub.pull({ ...f.store.agentById(f.a.id)!, quarantined: true }).items;
  expect(qItems.filter((i) => i.type === "message").flatMap((i: any) => i.message.attachments)).toEqual([]);
  expect((await f.req(`/agent/artifacts/${art.id}`, undefined, f.b.token)).status).toBe(404);
  expect((await f.req(`/agent/artifacts/${art.id}`, undefined, f.outside.token)).status).toBe(404);
  expect((await f.app.request(`/agent/artifacts/${art.id}`, { headers: { authorization: `Bearer ${f.a.token}`, "x-fleet-mode": "quarantine" } })).status).toBe(404);
  const privateArt: any = await (await f.upload()).json();
  await f.req("/api/dm/worker", { text: "private", attachments: [privateArt.id] });
  expect((await f.req(`/agent/artifacts/${privateArt.id}`, undefined, f.b.token)).status).toBe(404);
  expect((await f.req(`/agent/artifacts/${privateArt.id}`, undefined, f.outside.token)).status).toBe(404);
  expect((await f.req("/api/dm/outside", { text: "x", attachments: [(await (await f.upload()).json() as any).id] })).status).toBe(400);
});

test("send validates count, duplicates, unknown/foreign/used ids and malformed attachment values without partial messages", async () => {
  const f = setup(); const art: any = await (await f.upload()).json();
  for (const attachments of [[art.id, art.id], ["missing"], Array(11).fill(art.id), "not-array", [null], [42]]) {
    const before = f.store.messagesAnySince(0).length;
    expect((await f.req("/api/dm/worker", { text: "x", attachments })).status).toBe(400);
    expect(f.store.messagesAnySince(0)).toHaveLength(before);
  }
  expect((await f.req("/api/dm/worker", { text: "" })).status).toBe(400);
  const foreign = f.store.addArtifact({ id: crypto.randomUUID(), taskId: null, kind: "file", name: "foreign", mime: "text/plain", size: 1, uploadedBy: f.a.id });
  expect((await f.req("/api/dm/worker", { text: "x", attachments: [foreign.id] })).status).toBe(400);
  expect((await f.req("/api/dm/worker", { text: "x", attachments: [art.id] })).status).toBe(200);
  expect((await f.req("/api/room", { text: "x", attachments: [art.id] })).status).toBe(400);
});

test("human upload auth, configured byte/count caps, streamed overflow cleanup and safe media headers", async () => {
  const f = setup({ humanAttachmentMaxBytes: 8, humanAttachmentMaxCount: 2 });
  expect((await f.upload("x", "x", "text/plain", f.a.token)).status).toBe(401);
  expect((await f.upload("x", "")).status).toBe(400);
  const chunks = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); c.enqueue(new Uint8Array(5)); c.close(); } });
  expect((await f.upload("big", chunks)).status).toBe(413);
  expect(readdirSync(`${f.hub.dataDir}/artifacts`)).toEqual([]);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) { const r = await f.upload("<bad>.svg", "<svg/>", "image/svg+xml"); expect(r.status).toBe(200); const a: any = await r.json(); ids.push(a.id); expect(a.kind).toBe("screenshot"); }
  expect((await f.req("/api/dm/worker", { text: "", attachments: ids })).status).toBe(400);
  expect((await f.req("/api/dm/worker", { attachments: ids.slice(0, 2) })).status).toBe(200);
  const d = await f.req(`/agent/artifacts/${ids[0]}`, undefined, f.a.token);
  expect(d.headers.get("content-type")).toBe("application/octet-stream");
  expect(d.headers.get("content-disposition")).toStartWith("attachment;");
});

test("trusted helper prompt lists each file and exact safely quoted download command; quarantine omits it", () => {
  const cfg = { harness: "claude", workdir: "/work", agentName: "worker" } as HelperConfig;
  const msg = { type: "message", message: { id: 1, thread: "dm:a:human", from: "human", text: "read", attachments: [{ id: "abc-123", name: "brief.pdf", size: 16, mime: "application/pdf" }] } };
  const p = buildPrompt([msg], cfg, null);
  expect(p).toContain("brief.pdf"); expect(p).toContain("16 bytes"); expect(p).toContain("application/pdf");
  expect(p).toContain("download 'abc-123' --out"); expect(p).toContain("bun '"); expect(p).toContain("cannot read this format");
  expect(buildPrompt([msg], cfg, null, "quarantine")).not.toContain("brief.pdf");
});


test("declared oversize, interrupted uploads, deletion authorization and inert signed human downloads", async () => {
  const f = setup({ humanAttachmentMaxBytes: 8 });
  const declared = await f.app.request("/api/artifacts?name=big", { method: "POST", headers: { authorization: "Bearer human", "content-length": "100" }, body: "x" });
  expect(declared.status).toBe(413);
  const broken = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2)); c.error(new Error("disconnected")); } });
  expect((await f.upload("broken", broken)).status).toBe(400);
  expect(readdirSync(`${f.hub.dataDir}/artifacts`)).toEqual([]);
  const art: any = await (await f.upload("x.html", "<html/>", "text/html")).json();
  const del = (token: string) => f.app.request(`/api/artifacts/${art.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  expect((await del(f.a.token)).status).toBe(401);
  await f.req("/api/dm/worker", { text: "", attachments: [art.id] });
  expect((await del("human")).status).toBe(404);
  const state: any = await (await f.req("/api/state")).json();
  const url = state.dms[0].attachments[0].url;
  const served = await f.app.request(url);
  expect(served.headers.get("content-type")).toBe("application/octet-stream");
  expect(served.headers.get("content-disposition")).toStartWith("attachment;");
  expect(served.headers.get("x-content-type-options")).toBe("nosniff");
});

test("personal file metadata remains private after agent moves workspace and before upload is sent", async () => {
  const f = setup(); const art: any = await (await f.upload()).json();
  expect((await f.req(`/agent/artifacts/${art.id}`, undefined, f.a.token)).status).toBe(404);
  await f.req("/api/room", { text: "@worker", attachments: [art.id] });
  const ws = f.hub.createWorkspace("moved"); f.hub.moveAgent("worker", ws.id);
  expect((await f.req(`/agent/artifacts/${art.id}`, undefined, f.a.token)).status).toBe(404);
});
