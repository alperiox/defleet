import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { createApp } from "../src/app";
test("four knowledge MCP tools enforce owner approval and reject external and quarantine calls", async () => {
 const { app, hub, store } = createApp(":memory:", "human", { hubOwner: "owner" });
 const team = store.addAgent({ name: "team", owner: "owner", device: "d", skills: [] }); const guest = store.addAgent({ name: "guest", owner: "guest", device: "d", skills: [] });
 const rpc = async (method: string, params: unknown, token = team.token, quarantine = false) => (await app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(quarantine ? { "x-fleet-mode": "quarantine" } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as Promise<any>;
 try {
  const list = await rpc("tools/list", {}); expect(list.result.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["search_knowledge", "get_knowledge", "propose_knowledge", "verify_knowledge"]));
  const entry = { kind: "fact", title: "Staging routing", body: "Staging uses the internal gateway.", verify: "Check routing", sources: [] };
  const proposal = await rpc("tools/call", { name: "propose_knowledge", arguments: entry }); expect(proposal.result.isError).toBeFalsy();
  for (const [token, quarantine] of [[guest.token, false], [team.token, true]] as const) for (const name of ["search_knowledge", "get_knowledge", "propose_knowledge", "verify_knowledge"]) {
   const response = await rpc("tools/call", { name, arguments: name === "propose_knowledge" ? entry : name === "search_knowledge" ? { query: "staging" } : { id: "unknown", ok: true, note: "checked" } }, token, quarantine);
   expect(response.result?.isError || response.error).toBeTruthy();
  }
  const denied = await app.request("/api/knowledge?workspace=default", { method: "POST", headers: { authorization: `Bearer ${team.token}`, "content-type": "application/json" }, body: JSON.stringify(entry) }); expect(denied.status).toBe(401);
 } finally { store.db.close(); rmSync(hub.dataDir, { recursive: true, force: true }); }
});
