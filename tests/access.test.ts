import { test, expect, afterAll } from "bun:test";
import { createApp } from "../src/app";

const { app, hub, store } = createApp(":memory:", "human-secret", { hubOwner: "alper" });
const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 30 });
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;
const human = { Authorization: "Bearer human-secret", "content-type": "application/json" };
const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: (init.headers as Record<string, string>) ?? human });
const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });
const state = async () => (await (await call("/api/state")).json()) as any;
const asAgent = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" });
const agentPull = (token: string) => fetch(`${base}/agent/pull`, { method: "POST", headers: asAgent(token), body: "{}" });
const agentRow = async (name: string) => (await state()).agents.find((a: any) => a.name === name);

for (const p of ["alpha", "beta"]) store.ensureProject(p, "default");

test("inviting an outside agent returns the token and the join prompt once, and marks it external", async () => {
  const res = await post("/api/external-agents", { name: "friend-1", owner: "bo", projects: ["alpha"], expiresInDays: 7 });
  expect(res.status).toBe(200);
  const made: any = await res.json();
  expect(made).toMatchObject({ name: "friend-1", owner: "bo", projects: ["alpha"] });
  expect(made.token.length).toBeGreaterThanOrEqual(32);
  expect(made.prompt).toContain("fleet join " + base);
  expect(made.prompt).toContain(made.token);                            // the prompt is what the person pastes; it carries the token.
  const row = await agentRow("friend-1");
  expect(row).toMatchObject({ owner: "bo", external: true, grants: ["alpha"] });
  expect(row.expiresAt).toBeGreaterThan(Date.now() + 6 * 86400_000);
  expect((await agentPull(made.token)).status).toBe(200);               // the token works for the agent API
  expect(JSON.stringify(await state())).not.toContain(made.token);      // and the hub never returns it again
});

test("only the human token can invite or revoke outside agents", async () => {
  const one = store.addAgent({ name: "friend-2", owner: "bo", device: "outside", skills: [] });
  expect((await fetch(`${base}/api/external-agents`, { method: "POST", body: JSON.stringify({ name: "x", owner: "bo" }) })).status).toBe(401);
  expect((await fetch(`${base}/api/external-agents/friend-2`, { method: "DELETE" })).status).toBe(401);
  expect((await fetch(`${base}/api/external-agents/friend-2`, { method: "DELETE", headers: asAgent(one.token) })).status).toBe(401);   // an agent token is not the human's
});

test("reserved names, duplicates, a team owner and unknown projects are refused", async () => {
  const status = async (body: unknown) => (await post("/api/external-agents", body)).status;
  expect(await status({ name: "human", owner: "bo" })).toBe(400);
  expect(await status({ name: "all", owner: "bo" })).toBe(400);
  expect(await status({ name: "you", owner: "bo" })).toBe(400);
  expect(await status({ name: "Friend Spaces", owner: "bo" })).toBe(400);
  expect(await status({ name: "friend-1", owner: "bo" })).toBe(409);                // already invited above
  expect(await status({ name: "friend-3", owner: "alper" })).toBe(400);             // the hub owner's agent is a team agent, not an outside one
  expect(await status({ name: "friend-3", owner: "" })).toBe(400);
  expect(await status({ name: "friend-3", owner: "bo", projects: ["nope"] })).toBe(400);
  expect(await status({ name: "friend-3", owner: "bo", expiresInDays: -1 })).toBe(400);
  expect(await status({ name: "friend-3", owner: "bo" })).toBe(200);                // the refused attempts left nothing behind
});

test("an expired token stops working at once, and the agent stays listed so it can be revoked", async () => {
  const gone = store.addAgent({ name: "friend-old", owner: "bo", device: "outside", skills: [], expiresAt: Date.now() - 1000 });
  expect(store.agentByToken(gone.token)).toBeNull();
  expect((await agentPull(gone.token)).status).toBe(401);
  const row = await agentRow("friend-old");
  expect(row.external).toBe(true);
  expect(row.expiresAt).toBeLessThan(Date.now());
});

test("rotating returns a new token once, the old one stops working, and the expiry is kept", async () => {
  const made: any = await (await post("/api/external-agents", { name: "friend-rotate", owner: "bo" })).json();
  const res = await post("/api/agents/friend-rotate/token", {});
  expect(res.status).toBe(200);
  const rotated: any = await res.json();
  expect(rotated.token).not.toBe(made.token);
  expect(rotated.prompt).toContain(rotated.token);
  expect((await agentPull(made.token)).status).toBe(401);
  expect((await agentPull(rotated.token)).status).toBe(200);
  // An invitation that has expired is not silently made permanent by rotating it.
  const old = store.addAgent({ name: "friend-lapsed", owner: "bo", device: "outside", skills: [], expiresAt: Date.now() - 1000 });
  const again: any = await (await post("/api/agents/friend-lapsed/token", {})).json();
  expect(again.expiresAt).toBeLessThan(Date.now());
  expect((await agentPull(again.token)).status).toBe(401);
  expect(old.token).not.toBe(again.token);
});

test("revoking an outside agent stops its token and releases its name; a team agent is refused", async () => {
  const made: any = await (await post("/api/external-agents", { name: "friend-revoke", owner: "bo", projects: ["beta"] })).json();
  const res = await call("/api/external-agents/friend-revoke", { method: "DELETE" });
  expect(res.status).toBe(200);
  expect((await agentPull(made.token)).status).toBe(401);
  expect(await agentRow("friend-revoke")).toBeUndefined();
  expect((await post("/api/external-agents", { name: "friend-revoke", owner: "bo" })).status).toBe(200);   // the name is free again
  const team = store.addAgent({ name: "team-1", owner: "alper", device: "laptop", skills: [] });
  expect((await call("/api/external-agents/team-1", { method: "DELETE" })).status).toBe(400);
  expect(store.agentById(team.id)).toBeTruthy();
  expect((await call("/api/external-agents/nobody", { method: "DELETE" })).status).toBe(404);
});

test("projects granted from the Access list are the ones the outside agent can see", async () => {
  await post("/api/external-agents", { name: "friend-grant", owner: "bo", projects: [] });
  const agent = () => store.listAgents().find((a) => a.name === "friend-grant")!;
  expect(hub.canAccessProject(agent(), "beta")).toBe(false);
  expect((await post("/api/agents/friend-grant/grants", { project: "beta" })).status).toBe(200);
  expect(hub.canAccessProject(agent(), "beta")).toBe(true);
  expect(hub.canAccessProject(agent(), "alpha")).toBe(false);
  expect((await call("/api/agents/friend-grant/grants/beta", { method: "DELETE" })).status).toBe(200);
  expect(hub.canAccessProject(agent(), "beta")).toBe(false);
});
