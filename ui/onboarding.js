// First-run onboarding core: welcome tour steps and setup checklist state.
// Pure functions, so tests/ can import this file without a browser.
// The page imports it as /onboarding.js (served by src/api.ts).

export const TOUR_STEPS = [
  {
    id: "hub-workspaces",
    title: "The Hub & Workspaces",
    kicker: "Overview · Step 1 of 5",
    summary: "Where your fleet coordinates",
    body: "The hub is the shared coordination point for your autonomous coding agents. It keeps the task list, project history, and human decisions in one place. Workspaces keep projects and teams isolated so agents never step on each other's work."
  },
  {
    id: "agents",
    title: "Autonomous Agents",
    kicker: "Architecture · Step 2 of 5",
    summary: "Your AI coding workforce",
    body: "Agents are autonomous AI coding sessions (running Claude Code, Codex, OpenCode, Antigravity, or other harnesses). They join your fleet, claim tasks, report progress, and request guidance when decisions are needed."
  },
  {
    id: "devices",
    title: "Devices & Local Code",
    kicker: "Security · Step 3 of 5",
    summary: "Your code stays on your machine",
    body: "Agents run on your own machines (laptops, desktops, or cloud servers) by enrolling them as devices. Your source code, credentials, and git branches stay securely on your local device — the hub only coordinates leases, messages, and review artifacts."
  },
  {
    id: "tasks-needs-room",
    title: "Tasks, Needs You & Room",
    kicker: "Workflow · Step 4 of 5",
    summary: "How work gets done",
    body: "Tasks track work with verifiable acceptance criteria. When an agent has a question or needs approval, it surfaces under Needs you so you can reply or discuss directly. The Room lets you chat openly with your active fleet."
  },
  {
    id: "checklist",
    title: "Setup Checklist",
    kicker: "Get started · Step 5 of 5",
    summary: "Ready to get started",
    body: "Follow the setup checklist pinned to Needs you to enroll your first device, invite an agent, and create your first task. You can reopen this tour at any time from Settings, the ? cheat-sheet, or the :tour command."
  }
];

export const TOUR_DONE_KEY = "fleet-tour-done";
export const CHECKLIST_DISMISSED_KEY = "fleet-checklist-dismissed";

/**
 * Computes live setup checklist items and completion status from hub state.
 */
export function computeChecklist(hubState = {}, dismissed = false) {
  const connected = hubState.connected !== false;
  const devices = hubState.devices || [];
  const agents = (hubState.agents || []).filter((a) => !a.external);
  const tasks = hubState.tasks || [];
  const publicUrl = hubState.publicUrl || (typeof location !== "undefined" && location.protocol === "https:" ? location.origin : null);

  const hubReachable = connected;
  const deviceEnrolled = devices.length > 0;
  const agentCreated = agents.length > 0;
  const taskCreated = tasks.length > 0;
  const publicUrlConfigured = !!publicUrl;

  const items = [
    {
      id: "hub",
      label: "Hub reachable",
      why: "Connected to the hub API and live event stream.",
      done: hubReachable,
      tab: "inbox",
      hash: "#/inbox"
    },
    {
      id: "device",
      label: "Enroll a device",
      why: "Devices run your agent harnesses and host your code directories.",
      done: deviceEnrolled,
      tab: "devices",
      hash: "#/devices"
    },
    {
      id: "agent",
      label: "Create your first agent",
      why: "Agents connect to your fleet, claim tasks, and report progress.",
      done: agentCreated,
      tab: "team",
      hash: "#/team"
    },
    {
      id: "task",
      label: "Create your first task",
      why: "Tasks tell agents what to build with clear acceptance criteria.",
      done: taskCreated,
      tab: "tasks",
      hash: "#/tasks"
    },
    {
      id: "public",
      label: "Public URL / HTTPS (optional)",
      why: "Reach the hub from outside without requiring a local tunnel.",
      done: publicUrlConfigured,
      optional: true,
      tab: "settings",
      hash: "#/settings"
    }
  ];

  const requiredItems = items.filter((it) => !it.optional);
  const completedCount = requiredItems.filter((it) => it.done).length;
  const totalRequired = requiredItems.length;
  const isComplete = completedCount === totalRequired;
  const isVisible = !dismissed && !isComplete;

  return {
    hubReachable,
    deviceEnrolled,
    deviceCount: devices.length,
    agentCreated,
    agentCount: agents.length,
    taskCreated,
    taskCount: tasks.length,
    publicUrlConfigured,
    publicUrl,
    items,
    completedCount,
    totalRequired,
    isComplete,
    isVisible
  };
}

/**
 * Checks whether the welcome tour should open automatically.
 */
export function shouldAutoOpenTour({ storage, params, agentCount = 0, taskCount = 0 } = {}) {
  if (params) {
    if (typeof params.has === "function") {
      if (params.has("notour") || params.get("tour") === "0") return false;
      if (params.get("tour") === "1") return true;
      if (params.get("token") === "preview-only" && (agentCount > 0 || taskCount > 0)) return false;
    }
    if (typeof params === "string") {
      if (params.includes("notour") || params.includes("tour=0")) return false;
      if (params.includes("tour=1")) return true;
      if (params.includes("token=preview-only") && (agentCount > 0 || taskCount > 0)) return false;
    }
  }
  const done = storage ? storage.getItem(TOUR_DONE_KEY) : null;
  const dismissed = storage ? storage.getItem("fleet-tour-dismissed") : null;
  if (done === "1" || dismissed === "1") return false;

  const isFirstVisit = !done;
  const isEmptyHub = agentCount === 0 && taskCount === 0;

  return isFirstVisit || isEmptyHub;
}
