// Workspace routing and cross-workspace notifications: the pure parts, so they can be tested without a browser.
// The page owns the DOM; this file decides what a route means and which updates belong to which workspace.

/** Views that exist in every workspace and never need the route to change when the workspace does. */
export const UNIVERSAL_VIEWS = new Set(["inbox", "room", "tasks", "team", "devices", "usage", "access", "code", "settings", "knowledge", "activity"]);

/**
 * Why the current route cannot be shown in this workspace, or null when it can.
 * scope: { agents: string[], tasks: string[], chats: string[] } — names/keys/routes visible in the workspace.
 */
export function routeProblem(route, scope) {
  const view = route?.view ?? "", arg = route?.arg ?? "";
  if (UNIVERSAL_VIEWS.has(view)) return null;
  if (view === "dm") return scope.agents.includes(arg) ? null : "agent";
  if (view === "task") return scope.tasks.includes(arg) ? null : "task";
  if (view === "chat") return scope.chats.includes(arg) ? null : "chat";
  return "unknown";
}

/** Which workspace an update belongs to, from its agent/task/thread. null means "cannot tell", which stays on today's path. */
export function workspaceOfUpdate(update, context) {
  const agentWs = context.agentWorkspace || {};
  if (update.kind === "request") return agentWs[update.fromAgent] ?? null;
  if (update.kind === "task") return update.taskWorkspace ?? null;
  if (update.kind === "message") {
    if (update.workspace) return update.workspace;                          // room message: it carries its workspace
    const ids = String(update.thread || "").split(":").slice(1).filter(Boolean);
    for (const id of ids) if (agentWs[id]) return agentWs[id];
    return null;
  }
  return null;
}

/** Active-workspace updates keep the old "only when hidden" rule; every other workspace always notifies. */
export function splitUpdates(updates, activeWorkspace) {
  const other = [], active = [];
  for (const u of updates) (u.workspaceId && u.workspaceId !== activeWorkspace ? other : active).push(u);
  return { other, active };
}

/** One beep per burst: a series of updates within the window makes a single sound. */
export function beepDue(lastBeepAt, now, gapMs = 1500) {
  return !lastBeepAt || now - lastBeepAt >= gapMs;
}

/** What the workspace selector shows: waiting requests and new cross-workspace updates are different things. */
export function workspaceLabel(name, waiting = 0, fresh = 0) {
  const parts = [];
  if (waiting) parts.push(waiting + " waiting");
  if (fresh) parts.push(fresh + " new");
  return parts.length ? name + " (" + parts.join(", ") + ")" : name;
}

/** The toast line for a cross-workspace update: "acme: claude-1 replied". */
export function toastLine(workspaceName, update) {
  return workspaceName + ": " + update.title;
}

/** A short hash for a batch: the newest update plus how many others came with it. */
export function toastMore(count) {
  return count > 1 ? "+" + (count - 1) + " more" : "";
}
