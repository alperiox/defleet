import { test, expect } from "bun:test";
import { routeProblem, workspaceOfUpdate, splitUpdates, beepDue, workspaceLabel, toastLine, toastMore } from "../ui/workspaces.js";

const scope = { agents: ["claude-1", "codex-1"], tasks: ["AGEN-39", "AGEN-2"], chats: ["claude-1~codex-1"] };

test("universal views survive a workspace switch; a DM, task or agent chat of another workspace does not", () => {
  for (const view of ["inbox", "room", "tasks", "team", "devices", "usage", "access", "code", "settings", "knowledge", "activity"]) {
    expect(routeProblem({ view, arg: "" }, scope)).toBeNull();
  }
  expect(routeProblem({ view: "dm", arg: "claude-1" }, scope)).toBeNull();
  expect(routeProblem({ view: "dm", arg: "someone-else" }, scope)).toBe("agent");
  expect(routeProblem({ view: "task", arg: "AGEN-39" }, scope)).toBeNull();
  expect(routeProblem({ view: "task", arg: "KAPI-7" }, scope)).toBe("task");
  expect(routeProblem({ view: "chat", arg: "claude-1~codex-1" }, scope)).toBeNull();
  expect(routeProblem({ view: "chat", arg: "a~b" }, scope)).toBe("chat");
  expect(routeProblem({ view: "nonsense", arg: "" }, scope)).toBe("unknown");
});

test("an update's workspace comes from its agent, its room message, or its task", () => {
  const ctx = { agentWorkspace: { a1: "fleet", a2: "acme" } };
  expect(workspaceOfUpdate({ kind: "request", fromAgent: "a1", title: "", hash: "" }, ctx)).toBe("fleet");
  expect(workspaceOfUpdate({ kind: "message", thread: "dm:a2", title: "", hash: "" }, ctx)).toBe("acme");
  expect(workspaceOfUpdate({ kind: "message", thread: "dm:human:a2", title: "", hash: "" }, ctx)).toBe("acme");
  expect(workspaceOfUpdate({ kind: "message", thread: "room:fleet", workspace: "fleet", title: "", hash: "" }, ctx)).toBe("fleet");
  expect(workspaceOfUpdate({ kind: "task", taskWorkspace: "acme", title: "", hash: "" }, ctx)).toBe("acme");
  expect(workspaceOfUpdate({ kind: "message", thread: "dm:stranger", title: "", hash: "" }, ctx)).toBeNull();
  expect(workspaceOfUpdate({ kind: "task", title: "", hash: "" }, ctx)).toBeNull();
});

test("only updates from another workspace are forced; the active workspace keeps the hidden-tab rule", () => {
  const list = [
    { kind: "message", title: "a", hash: "#/dm/a", workspaceId: "fleet" },
    { kind: "message", title: "b", hash: "#/dm/b", workspaceId: "acme" },
    { kind: "message", title: "c", hash: "#/dm/c", workspaceId: null },
  ] as any;
  const { other, active } = splitUpdates(list, "fleet");
  expect(other.map((u) => u.title)).toEqual(["b"]);
  expect(active.map((u) => u.title)).toEqual(["a", "c"]);
});

test("a burst makes one beep, and the window resets afterwards", () => {
  expect(beepDue(0, 1000)).toBe(true);
  expect(beepDue(1000, 1500)).toBe(false);
  expect(beepDue(1000, 2500, 1500)).toBe(true);
  expect(beepDue(1000, 2600)).toBe(true);
});

test("the workspace label separates waiting requests from new cross-workspace updates", () => {
  expect(workspaceLabel("fleet")).toBe("fleet");
  expect(workspaceLabel("fleet", 2)).toBe("fleet (2 waiting)");
  expect(workspaceLabel("acme", 0, 3)).toBe("acme (3 new)");
  expect(workspaceLabel("acme", 1, 3)).toBe("acme (1 waiting, 3 new)");
});

test("the toast names the workspace and can summarise a batch", () => {
  expect(toastLine("acme", { kind: "message", title: "claude-1 replied", hash: "#/dm/claude-1" })).toBe("acme: claude-1 replied");
  expect(toastMore(1)).toBe("");
  expect(toastMore(3)).toBe("+2 more");
});
