// First-run onboarding core: concept tour steps and 3-step setup checklist state.
// Pure functions, so tests/ can import this file without a browser.
// The page imports it as /onboarding.js (served by src/api.ts).

export const TOUR_STEPS = [
  {
    id: "hub-workspaces",
    title: "The Hub & Workspaces",
    kicker: "Overview · 1 of 3",
    summary: "Where your fleet coordinates",
    body: "The hub is the shared coordination point for your autonomous coding agents. It keeps the task list, project history, and human decisions in one place. Workspaces keep projects and teams isolated so agents never collide."
  },
  {
    id: "devices",
    title: "Devices & Local Code",
    kicker: "Security · 2 of 3",
    summary: "Your code stays on your machine",
    body: "Agents run on your own machines (laptops, desktops, or cloud servers) by enrolling them as devices. Your source code, credentials, and git branches stay securely on your local device — the hub only coordinates leases, messages, and review artifacts."
  },
  {
    id: "agents-tasks",
    title: "Agents, Tasks & Needs You",
    kicker: "Workflow · 3 of 3",
    summary: "Autonomous work with human oversight",
    body: "Agents claim tasks with clear acceptance criteria. When an agent has a question or needs approval, it surfaces under Needs you so you can reply or discuss directly. The Room lets you chat openly with your active fleet."
  }
];

export const TOUR_DONE_KEY = "fleet-tour-done";
export const CHECKLIST_DISMISSED_KEY = "fleet-checklist-dismissed";

/**
 * Computes live 3-step setup checklist items and completion status from hub state.
 * Steps:
 *  1. Add your device
 *  2. Start an agent
 *  3. Give it a first task
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
      id: "device",
      label: "Add your device",
      title: "Add your device",
      why: "Enroll your machine so agents can run locally and access your code.",
      action: "Add a device",
      done: deviceEnrolled,
      tab: "devices",
      hash: "#/devices"
    },
    {
      id: "agent",
      label: "Start an agent",
      title: "Start an agent",
      why: "Launch an agent harness on your enrolled device to join the fleet.",
      action: "Start agent",
      done: agentCreated,
      tab: "devices",
      hash: "#/devices"
    },
    {
      id: "task",
      label: "Give it a first task",
      title: "Give it a first task",
      why: "Assign work with clear acceptance criteria for your agent to complete.",
      action: "Create task",
      done: taskCreated,
      tab: "tasks",
      hash: "#/tasks"
    }
  ];

  const nextStepIndex = items.findIndex((it) => !it.done);
  items.forEach((it, idx) => {
    it.active = idx === nextStepIndex;
    it.step = idx + 1;
  });

  const completedCount = items.filter((it) => it.done).length;
  const totalRequired = 3;
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
 * The primary onboarding is the 3-step guided setup inline on Needs you.
 * Concept tour only opens when explicit tour=1 is passed, and never opens
 * automatically after the three steps are done or once marked done/dismissed.
 */
export function shouldAutoOpenTour({ storage, params, deviceCount = 0, agentCount = 0, taskCount = 0 } = {}) {
  if (params) {
    if (typeof params.has === "function") {
      if (params.has("notour") || params.get("tour") === "0") return false;
      if (params.get("tour") === "1") return true;
    }
    if (typeof params === "string") {
      if (params.includes("notour") || params.includes("tour=0")) return false;
      if (params.includes("tour=1")) return true;
    }
  }

  const done = storage ? storage.getItem(TOUR_DONE_KEY) : null;
  const dismissed = storage ? storage.getItem("fleet-tour-dismissed") : null;
  if (done === "1" || dismissed === "1") return false;

  // Never appear automatically after the three steps are done
  if (deviceCount > 0 && agentCount > 0 && taskCount > 0) return false;

  // Fresh hub shows the 3-step guided setup directly without an overlay
  return false;
}
