// Canonical main integration is human-only in v1. No agent integrate_branch tool is registered.
import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Hub } from "./hub";
import type { Agent, Store } from "./store";

const MAX_WAIT_SECONDS = 25;
const nonblank = z.string().refine((value) => value.trim().length > 0, "must not be blank");

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

function guarded<A>(fn: (args: A, extra: { signal?: AbortSignal }) => unknown) {
  return async (args: A, extra: { signal?: AbortSignal } = {}) => {
    try {
      return ok(await fn(args, extra));
    } catch (e) {
      return fail(e);
    }
  };
}

function buildServer(hub: Hub, agent: Agent, requestSignal: AbortSignal): McpServer {
  const server = new McpServer({ name: "agent-fleet", version: "0.1.0" });
  const status = z.enum(["open", "claimed", "in_progress", "blocked", "done"]);

  server.registerTool("search_knowledge", { description: "Search approved workspace/global knowledge notes. Verify before relying on them.", inputSchema: { query: z.string(), project: z.string().optional(), kind: z.enum(["how-to", "fact", "gotcha", "environment"]).optional(), limit: z.number().int().min(1).max(10).optional() } }, guarded((a) => hub.searchKnowledge(agent, a)));
  server.registerTool("get_knowledge", { description: "Read one approved knowledge note, sources and history; verify its contents before use.", inputSchema: { id: z.string() } }, guarded((a) => hub.getKnowledge(agent, a.id)));
  server.registerTool("propose_knowledge", { description: "Propose a reusable note for human approval. Never include secrets or private/backlog task material.", inputSchema: { kind: z.enum(["how-to", "fact", "gotcha", "environment"]), title: z.string(), body: z.string(), verify: z.string(), project: z.string().optional(), sources: z.array(z.object({ kind: z.enum(["task", "message", "url"]), ref: z.string() })).max(5).optional() } }, guarded((a) => hub.proposeKnowledge(agent, a)));
  server.registerTool("verify_knowledge", { description: "After running a note's verification, attest success or propose a correction on failure. Never silently archive it.", inputSchema: { id: z.string(), ok: z.boolean(), note: z.string() } }, guarded((a) => hub.verifyKnowledge(agent, a.id, a.ok, a.note)));

  server.registerTool("create_task", {
    description: "Create a task another agent could pick up with no questions. description: what to build, where it lives, why, links to anything relevant. acceptance: how to tell it is done. Give parent_id (a task key like KAPI-3 or id) to make a subtask (marked AI-generated). assignee is an agent name.",
    inputSchema: {
      title: nonblank, project: nonblank, description: z.string(), acceptance: z.string(),
      parent_id: z.string().optional(), assignee: z.string().optional(),
      needs_preview: z.boolean().optional().describe("true when the result is visual or user-facing and the human should see it: completing then requires a screenshot or video"),
    },
  }, guarded((a) => hub.createTask(agent, { title: a.title, project: a.project, parentId: a.parent_id, assignee: a.assignee, description: a.description, acceptance: a.acceptance, needsPreview: a.needs_preview })));

  server.registerTool("get_task", {
    description: "Read everything about a task by key (KAPI-3) or id: description, acceptance criteria, owner, status, subtasks, evidence and the full history. Read this before asking questions about a task.",
    inputSchema: { task_id: z.string() },
  }, guarded((a) => hub.taskDetail(a.task_id, agent)));

  server.registerTool("ask_owner", {
    description: "Ask the owner of a task (whoever claimed it, else its assignee, else its creator) a question about it. They get a DM with the task attached and answer in that thread.",
    inputSchema: { task_id: z.string(), question: z.string() },
  }, guarded((a) => { hub.askOwner(agent, a.task_id, a.question); return { ok: true }; }));

  server.registerTool("get_outcome", {
    description: "Read what a task produced: status, latest note, the report text and the list of files (id, kind, name). Works for any task in a project you can see. Download a file with the helper: bun helper.ts download <file-id>.",
    inputSchema: { task_id: z.string() },
  }, guarded((a) => hub.getOutcome(agent, a.task_id)));

  server.registerTool("request_outcome", {
    description: "Ask for a task's outcome. If it is done and has a report you get it immediately. If it is done without a report the owner is asked to write one. If it is not done you get its status and the owner is asked for an update.",
    inputSchema: { task_id: z.string() },
  }, guarded((a) => hub.askForOutcome(agent, a.task_id)));

  server.registerTool("request_takeover", {
    description: "Ask to finish someone else's unfinished task, with a reason. The owner is told. If you are an external agent the human must approve the handoff.",
    inputSchema: { task_id: z.string(), reason: z.string() },
  }, guarded((a) => hub.requestTakeover(agent, a.task_id, a.reason)));

  server.registerTool("attach_report", {
    description: "Attach a short written outcome report (markdown) to a task you hold: what was asked, what you did, how to verify it, results, known gaps and next steps. Screenshots and videos are uploaded separately (see /skills/outcome-report.md on the hub). Required before complete_task when the human asked for an outcome.",
    inputSchema: { task_id: z.string(), title: z.string(), markdown: z.string() },
  }, guarded((a) => { const r = hub.attachReport(agent, a.task_id, a.title, a.markdown); return { id: r.id, name: r.name }; }));

  server.registerTool("add_comment", {
    description: "Add a note to a task's history (a finding, a decision, a pointer). It does not wake anyone; use ask_owner to ask a question.",
    inputSchema: { task_id: z.string(), text: z.string() },
  }, guarded((a) => { hub.addComment(agent, a.task_id, a.text); return { ok: true }; }));

  server.registerTool("escalate", {
    description: "You and another agent disagree and it blocks work: file it for the human. It appears in their Needs-you list with both positions (not as a private message), and your task is marked blocked. Both of you get the decision.",
    inputSchema: {
      question: z.string(), my_position: z.string(), their_position: z.string().optional(),
      with_agent: z.string().optional(), task_id: z.string().optional(),
    },
  }, guarded((a) => hub.escalate(agent, { task: a.task_id, withAgent: a.with_agent, question: a.question, myPosition: a.my_position, theirPosition: a.their_position })));

  server.registerTool("claim_task", {
    description: "Claim an open task. Fails with 'already claimed' if someone else holds it.",
    inputSchema: { task_id: z.string() },
  }, guarded((a) => hub.claim(agent, a.task_id)));

  server.registerTool("post_status", {
    description: "Report progress on a task you claimed.",
    inputSchema: { task_id: z.string(), status, note: z.string().optional() },
  }, guarded((a) => { hub.postStatus(agent, a.task_id, a.status, a.note); return { ok: true }; }));

  server.registerTool("attach_evidence", {
    description: "Attach evidence (test output, diff, artifact link) to a task you claimed. Required before complete_task.",
    inputSchema: { task_id: z.string(), kind: nonblank, ref: nonblank, note: z.string().optional() },
  }, guarded((a) => { hub.attachEvidence(agent, a.task_id, { kind: a.kind, ref: a.ref, note: a.note }); return { ok: true }; }));

  server.registerTool("complete_task", {
    description: "Mark a task you claimed as done. Rejected with 'evidence required' if no evidence is attached.",
    inputSchema: { task_id: z.string() },
  }, guarded((a) => hub.complete(agent, a.task_id)));

  server.registerTool("say", {
    description: "Post a message. thread is 'room' or 'dm:<agent name>' or 'dm:human'. Use @agent-name in the room to wake an agent. To show a file (screenshot, chart, video), upload it first with `bun helper.ts upload --file <path>` (no task needed), then pass the returned ids in `attachments`. Give `task_id` (a task you hold) to also file them under that task.",
    inputSchema: { thread: z.string(), text: z.string().default(""), attachments: z.array(z.string()).max(10).default([]), task_id: z.string().optional() },
  }, guarded((a) => hub.say(agent, a.thread, a.text, a.attachments, a.task_id)));

  server.registerTool("read_thread", {
    description: "Read messages in a thread after a message id (0 for all).",
    inputSchema: { thread: z.string(), after_id: z.number().int().default(0) },
  }, guarded((a) => ({ messages: hub.readThread(agent, a.thread, a.after_id) })));

  server.registerTool("ask_human", {
    description: "Ask the human. kind: decision (quick answer), session (longer task; give link to a page you host), approval. The answer arrives via wait_for_work or inbox.",
    inputSchema: {
      kind: z.enum(["decision", "session", "approval"]), text: z.string(),
      link: z.string().optional(), task_id: z.string().optional(),
    },
  }, guarded((a) => hub.askHuman(agent, { kind: a.kind, text: a.text, link: a.link, taskId: a.task_id })));

  server.registerTool("inbox", {
    description: "Fetch human answers. Answers stay here until you acknowledge them: pass the ids you have handled as ack.",
    inputSchema: { ack: z.array(z.string()).optional() },
  }, guarded((a: { ack?: string[] }) => hub.inbox(agent, a.ack)));

  server.registerTool("my_requests", {
    description: "List every question you have asked the human, with answers. Use it to recover after a restart.",
    inputSchema: {},
  }, guarded(() => ({ requests: hub.myRequests(agent) })));

  server.registerTool("release_task", {
    description: "Give a task you claimed back (you are stuck, or going offline). A brief is required: what is done, what is left, where the files, branch or notes are. The next agent starts from it. Pass to=<agent name> to offer it to a specific agent, who may accept or decline.",
    inputSchema: { task_id: z.string(), brief: z.string(), to: z.string().optional() },
  }, guarded((a: { task_id: string; brief: string; to?: string }) => hub.release(agent, a.task_id, a.to, a.brief)));

  server.registerTool("accept_task", {
    description: "Accept a task that was offered to you (see `offer` on it in list_tasks or wait_for_work). It becomes yours and the lease starts. Answer offers promptly: an unanswered offer goes back to the pool.",
    inputSchema: { task_id: z.string() },
  }, guarded((a) => hub.acceptTask(agent, a.task_id)));

  server.registerTool("decline_task", {
    description: "Decline a task that was offered to you. A reason is required (busy, wrong tool, missing access) and, if you know, who would be better. It goes back to the pool and whoever offered it is told. The human can still assign it to you directly.",
    inputSchema: { task_id: z.string(), reason: z.string() },
  }, guarded((a) => hub.declineTask(agent, a.task_id, a.reason)));

  server.registerTool("list_agents", {
    description: "The team you can delegate to: each agent's declared role, whether it is online and busy, its device, tool, model and folder when known, and its load (tasks in progress, offers waiting). Read it before assigning work, and pick by role and load, not by name alone.",
    inputSchema: {},
  }, guarded(() => ({ agents: hub.listTeam(agent) })));

  server.registerTool("set_profile", {
    description: "Declare what you are for, in one or two lines (at most 200 characters): your strengths, your machine, what you should not be given. Other agents read it when deciding who gets a task.",
    inputSchema: { role: z.string() },
  }, guarded((a) => {
    if (agent.quarantined) throw new Error("not available while handling an outside request");
    hub.setRole(agent, a.role); return { ok: true };
  }));

  server.registerTool("record_touch", {
    description: "Declare an action you took outside the hub (shell command, file change, service call, git push). Call it for each one.",
    inputSchema: { action: z.string(), target: z.string() },
  }, guarded((a) => { hub.recordTouch(agent, a.action, a.target); return { ok: true }; }));

  server.registerTool("wait_for_work", {
    description: `Block until there is something for you (a task, a human answer, a mention or DM) or the timeout passes (max ${MAX_WAIT_SECONDS}s). Returns {items, ack}. Pass the previous call's ack back as ack to confirm you received those items; anything not acknowledged is delivered again.`,
    inputSchema: {
      timeout_seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(20),
      ack: z.object({ msg: z.number().int(), task: z.number().int(), answers: z.array(z.string()) }).optional(),
    },
  }, guarded((a: { timeout_seconds: number; ack?: { msg: number; task: number; answers: string[] } }, extra) => {
    const signals = [requestSignal, extra.signal].filter((x): x is AbortSignal => !!x);
    return hub.waitForWork(agent, a.timeout_seconds * 1000, a.ack, AbortSignal.any(signals));
  }));

  server.registerTool("list_tasks", {
    description: "List tasks, optionally for one project. A task with `offer` set is waiting for your accept_task or decline_task; one with `handoff` carries the previous holder's brief.",
    inputSchema: { project: z.string().optional() },
  }, guarded((a) => ({ tasks: hub.listTasksFor(agent, a.project) })));

  return server;
}

export function mountMcp(app: Hono, hub: Hub, store: Store): void {
  app.get("/skills.md", async (c) => {
    const body = await Bun.file(new URL("./skills.md", import.meta.url)).text();
    return c.text(body);
  });

  app.all("/mcp", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const agent = store.agentByToken(token);
    if (!agent) return c.json({ error: "unauthorized" }, 401);
    store.touchAgent(agent.id);

    // The helper sets this header when it runs a quarantined turn; everything the agent writes is then tainted.
    const quarantined = c.req.header("x-fleet-mode") === "quarantine";
    const server = buildServer(hub, quarantined ? { ...agent, quarantined } : agent, c.req.raw.signal);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
