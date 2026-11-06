import { test, expect, describe } from "bun:test";
import {
  TOUR_STEPS,
  computeChecklist,
  shouldAutoOpenTour,
  TOUR_DONE_KEY,
  CHECKLIST_DISMISSED_KEY
} from "../ui/onboarding.js";

describe("onboarding tour steps", () => {
  test("has 3 distinct concept steps with required fields", () => {
    expect(TOUR_STEPS.length).toBe(3);
    const ids = new Set(TOUR_STEPS.map((s) => s.id));
    expect(ids.size).toBe(3);

    for (const step of TOUR_STEPS) {
      expect(step.id.length).toBeGreaterThan(0);
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.kicker.length).toBeGreaterThan(0);
      expect(step.summary.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
  });

  test("covers the core concepts in order", () => {
    expect(TOUR_STEPS[0].title).toContain("Hub");
    expect(TOUR_STEPS[1].title).toContain("Devices");
    expect(TOUR_STEPS[2].title).toContain("Agents");
  });
});

describe("setup checklist computation (3-step guided setup)", () => {
  test("initial empty state: 0 of 3 complete, step 1 highlighted", () => {
    const cl = computeChecklist({ connected: true, devices: [], agents: [], tasks: [] }, false);
    expect(cl.hubReachable).toBe(true);
    expect(cl.deviceEnrolled).toBe(false);
    expect(cl.agentCreated).toBe(false);
    expect(cl.taskCreated).toBe(false);
    expect(cl.completedCount).toBe(0);
    expect(cl.totalRequired).toBe(3);
    expect(cl.isComplete).toBe(false);
    expect(cl.isVisible).toBe(true);

    expect(cl.items.length).toBe(3);
    expect(cl.items[0].id).toBe("device");
    expect(cl.items[0].active).toBe(true);
    expect(cl.items[0].done).toBe(false);

    expect(cl.items[1].id).toBe("agent");
    expect(cl.items[1].active).toBe(false);
    expect(cl.items[1].done).toBe(false);

    expect(cl.items[2].id).toBe("task");
    expect(cl.items[2].active).toBe(false);
    expect(cl.items[2].done).toBe(false);
  });

  test("ticking as state changes and highlighting the next undone step", () => {
    // 1. Device added -> 1 of 3, step 2 highlighted
    let cl = computeChecklist({
      connected: true,
      devices: [{ id: "dev-1", name: "laptop", online: true }],
      agents: [],
      tasks: []
    });
    expect(cl.deviceEnrolled).toBe(true);
    expect(cl.completedCount).toBe(1);
    expect(cl.totalRequired).toBe(3);
    expect(cl.isComplete).toBe(false);
    expect(cl.isVisible).toBe(true);
    expect(cl.items[0].done).toBe(true);
    expect(cl.items[0].active).toBe(false);
    expect(cl.items[1].active).toBe(true); // Step 2 highlighted

    // 2. Agent created -> 2 of 3, step 3 highlighted
    cl = computeChecklist({
      connected: true,
      devices: [{ id: "dev-1", name: "laptop", online: true }],
      agents: [{ id: "ag-1", name: "codex-1", external: false }],
      tasks: []
    });
    expect(cl.agentCreated).toBe(true);
    expect(cl.completedCount).toBe(2);
    expect(cl.isComplete).toBe(false);
    expect(cl.isVisible).toBe(true);
    expect(cl.items[0].done).toBe(true);
    expect(cl.items[1].done).toBe(true);
    expect(cl.items[2].active).toBe(true); // Step 3 highlighted

    // 3. Task created -> 3 of 3 complete, card disappears
    cl = computeChecklist({
      connected: true,
      devices: [{ id: "dev-1", name: "laptop", online: true }],
      agents: [{ id: "ag-1", name: "codex-1", external: false }],
      tasks: [{ id: "task-1", key: "AGEN-1", title: "First task" }]
    });
    expect(cl.taskCreated).toBe(true);
    expect(cl.completedCount).toBe(3);
    expect(cl.isComplete).toBe(true);
    // Disappears when done
    expect(cl.isVisible).toBe(false);
  });

  test("disappears when dismissed", () => {
    const cl = computeChecklist({ connected: true, devices: [], agents: [], tasks: [] }, true);
    expect(cl.isComplete).toBe(false);
    expect(cl.isVisible).toBe(false);
  });

  test("external agents do not satisfy first agent check", () => {
    const cl = computeChecklist({
      connected: true,
      devices: [],
      agents: [{ id: "ext-1", name: "outside", external: true }],
      tasks: []
    });
    expect(cl.agentCreated).toBe(false);
    expect(cl.completedCount).toBe(0);
  });

  test("step actions, tabs, and hashes are correctly configured", () => {
    const cl = computeChecklist({ connected: true, devices: [], agents: [], tasks: [] }, false);
    expect(cl.items[0].action).toBe("Add a device");
    expect(cl.items[0].hash).toBe("#/devices");
    expect(cl.items[1].action).toBe("Start agent");
    expect(cl.items[1].hash).toBe("#/devices");
    expect(cl.items[2].action).toBe("Create task");
    expect(cl.items[2].hash).toBe("#/tasks");
  });

  test("tracks device, agent, and task counts accurately", () => {
    const cl = computeChecklist({
      connected: true,
      devices: [{ id: "d1" }, { id: "d2" }],
      agents: [{ id: "a1", external: false }, { id: "a2", external: true }],
      tasks: [{ id: "t1" }, { id: "t2" }, { id: "t3" }]
    });
    expect(cl.deviceCount).toBe(2);
    expect(cl.agentCount).toBe(1);
    expect(cl.taskCount).toBe(3);
    expect(cl.completedCount).toBe(3);
    expect(cl.isComplete).toBe(true);
    expect(cl.isVisible).toBe(false);
  });
});

describe("shouldAutoOpenTour", () => {
  const mockStorage = (data: Record<string, string> = {}) => ({
    getItem: (k: string) => data[k] || null,
    setItem: (k: string, v: string) => { data[k] = v; }
  });

  test("fresh hub has no overlay by default (guided setup is inline)", () => {
    const s = mockStorage();
    expect(shouldAutoOpenTour({ storage: s, deviceCount: 0, agentCount: 0, taskCount: 0 })).toBe(false);
  });

  test("opens when tour=1 query param is explicitly set", () => {
    const s = mockStorage();
    const params = new URLSearchParams("tour=1");
    expect(shouldAutoOpenTour({ storage: s, params, deviceCount: 0, agentCount: 0, taskCount: 0 })).toBe(true);
  });

  test("does not open when tour is marked completed", () => {
    const s = mockStorage({ [TOUR_DONE_KEY]: "1" });
    expect(shouldAutoOpenTour({ storage: s, deviceCount: 0, agentCount: 0, taskCount: 0 })).toBe(false);
  });

  test("does not open when tour is dismissed in session", () => {
    const s = mockStorage({ "fleet-tour-dismissed": "1" });
    expect(shouldAutoOpenTour({ storage: s, deviceCount: 0, agentCount: 0, taskCount: 0 })).toBe(false);
  });

  test("respects notour query param", () => {
    const s = mockStorage();
    const params = new URLSearchParams("notour=1");
    expect(shouldAutoOpenTour({ storage: s, params, deviceCount: 0, agentCount: 0, taskCount: 0 })).toBe(false);
  });

  test("respects tour=0 query param", () => {
    const s = mockStorage();
    const params = new URLSearchParams("tour=0");
    expect(shouldAutoOpenTour({ storage: s, params, deviceCount: 0, agentCount: 0, taskCount: 0 })).toBe(false);
  });

  test("never appears automatically after the three steps are done", () => {
    const s = mockStorage();
    expect(shouldAutoOpenTour({ storage: s, deviceCount: 1, agentCount: 1, taskCount: 1 })).toBe(false);
  });
});
