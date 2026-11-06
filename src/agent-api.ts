import { repoStatus, gitRun } from "./git";
import { installInstructions, installScript } from "../cli/fleet";
import { hubOrigin } from "./public-url";
import { bundled } from "./bundles";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Hub } from "./hub";
import type { Store } from "./store";

// Endpoints for the per-device helper. They authenticate with the agent's own token, never the human's.
export function mountAgentApi(app: Hono, hub: Hub, store: Store, publicUrl = ""): void {
  const agentOf = (header: string | undefined) => {
    const h = header ?? "";
    return store.agentByToken(h.startsWith("Bearer ") ? h.slice(7) : "");
  };

  app.get("/agent/repos/:project",async c=>{const a=agentOf(c.req.header("authorization"));if(!a)return c.json({error:"unauthorized"},401);if(c.req.header("x-fleet-mode")==="quarantine"||!hub.canAccessRepo(a,c.req.param("project")))return c.json({error:"no repository access"},403);const repo=await repoStatus(hub.dataDir,c.req.param("project")).catch(()=>null);return c.json({main:repo?.main??null,project:c.req.param("project")});});
  app.get("/helper.ts", async (c) =>
    c.text(await bundled("../helper/fleet-helper.ts")),
  );

  // Longer how-to documents, fetched when needed so skills.md stays short.
  app.get("/skills/:name", async (c) => {
    const name = c.req.param("name");
    if (!/^[a-z0-9-]+\.md$/.test(name)) return c.json({ error: "not found" }, 404);
    const file = Bun.file(new URL(`./skills/${name}`, import.meta.url));
    if (!(await file.exists())) return c.json({ error: "not found" }, 404);
    return c.text(await file.text());
  });

  // A helper that cannot sandbox outside requests reports them here instead of running a turn for them.
  app.post("/agent/refuse", async (c) => {
    const agent = agentOf(c.req.header("authorization"));
    if (!agent) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    hub.refuseUntrusted(agent, Array.isArray(body?.items) ? body.items : []);
    return c.json({ ok: true });
  });

  app.get("/fleet.ts", async (c) =>
    c.text(await bundled("../cli/fleet.ts")),
  );

  // What a new agent reads to set itself up. It carries this hub's address and never a token.
  app.get("/install.md", (c) => c.text(installInstructions({ hubUrl: hubOrigin(c.req.url, publicUrl) })));

  app.get("/install.sh", (c) => c.body(installScript(hubOrigin(c.req.url, publicUrl)), 200, { "content-type": "text/x-shellscript; charset=utf-8" }));

  // The helper says when it starts and finishes a turn, so the human can see which agent is working right now.
  app.post("/agent/activity", async (c) => {
    const agent = agentOf(c.req.header("authorization"));
    if (!agent) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    if (body?.state !== "working" && body?.state !== "idle") return c.json({ error: "state must be working or idle" }, 400);
    hub.setActivity(agent, body.state, typeof body.note === "string" ? body.note.slice(0, 80) : undefined, typeof body.turn === "string" ? body.turn.slice(0, 80) : undefined);
    return c.json({ ok: true });
  });

  app.post("/agent/pull", async (c) => {
    const agent = agentOf(c.req.header("authorization"));
    if (!agent) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const ack = body?.ack;
    if (ack && (!Number.isSafeInteger(ack.msg) || ack.msg < 0 || !Number.isSafeInteger(ack.task) || ack.task < 0 || !Array.isArray(ack.answers) || ack.answers.some((id: unknown) => typeof id !== "string") || (ack.interrupted !== undefined && (!Array.isArray(ack.interrupted) || ack.interrupted.length > 10000 || ack.interrupted.some((i: any) => !i || !["task", "message"].includes(i.type) || typeof i.id !== "string" || !Number.isSafeInteger(i.seq) || i.seq < 0))))) return c.json({ error: "invalid acknowledgement" }, 400);
    if (c.req.header("x-fleet-mode") === "quarantine") agent.quarantined = true;
    let knowledge;
    try { knowledge = hub.knowledgeIndex(agent); } catch { /* denied callers receive no index or version */ }
    const pulled=hub.pull(agent,ack),codebases:{project:string;main:string}[]=[];
    for(const project of [...new Set(pulled.items.filter((i:any)=>i.type==="task").map((i:any)=>i.task.project as string))]){
      if(!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(project)||!hub.canAccessRepo(agent,project))continue;
      try{const main=await gitRun(`${hub.dataDir}/repos/${project}.git`,"rev-parse","--verify","refs/heads/main");if(/^[a-f0-9]{40}$/.test(main))codebases.push({project,main});}catch{}
    }
    return c.json({ ...pulled, ...(codebases.length?{codebases}:{}), ...(knowledge ? { knowledge } : {}), self: { name: agent.name, workspace: hub.workspaceNameOf(agent), instructions: agent.instructions, knowledgeAllowed: !!knowledge } });
  });

  // The helper holds this open. "wake" means there is work to pull; it carries no content.
  app.get("/agent/events", (c) => {
    const agent = agentOf(c.req.header("authorization"));
    if (!agent) return c.json({ error: "unauthorized" }, 401);
    if (c.req.header("x-fleet-mode") === "quarantine") agent.quarantined = true;
    const knowledgeVersion = () => { try { return hub.knowledgeIndex(agent).version; } catch { return ""; } };
    return streamSSE(c, async (stream) => {
      let knownKnowledge = knowledgeVersion();
      let open = true;
      let woke = false;
      const check = () => {
        if (!open) return;
        const nextKnowledge = knowledgeVersion();
        if (nextKnowledge && nextKnowledge !== knownKnowledge) { knownKnowledge = nextKnowledge; void stream.writeSSE({ event: "wake", data: "1" }); }
        const pending = hub.pull(agent).items.length > 0;
        if (pending && !woke) void stream.writeSSE({ event: "wake", data: "1" });
        woke = pending;
      };
      const off = hub.onChange(check);
      const offStop = hub.onAgentStop(agent.id, (event) => { if (open) void stream.writeSSE({ event: "stop", data: JSON.stringify(event) }); });
      stream.onAbort(() => { open = false; off(); offStop(); });
      await stream.writeSSE({ event: "hello", data: "1" });
      const stop = hub.pendingStop(agent.id);
      if (stop) await stream.writeSSE({ event: "stop", data: JSON.stringify(stop) });
      check();
      while (open) {
        await stream.sleep(15000);
        if (open) {
          store.touchAgent(agent.id);
          await stream.writeSSE({ event: "ping", data: "1" });
        }
      }
    });
  });
}
