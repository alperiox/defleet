import { test, expect, describe } from "bun:test";
import {
  TOUR_STEPS,
  computeChecklist,
  shouldAutoOpenTour,
  TOUR_DONE_KEY,
  CHECKLIST_DISMISSED_KEY
} from "../ui/onboarding.js";

describe("onboarding tour steps", () => {
  test("has 5 distinct steps with required fields", () => {
    expect(TOUR_STEPS.length).toBe(5);
    const ids = new Set(TOUR_STEPS.map((s) => s.id));
    expect(ids.size).toBe(5);

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
    expect(TOUR_STEPS[1].title).toContain("Agents");
    expect(TOUR_STEPS[2].title).toContain("Devices");
    expect(TOUR_STEPS[3].title).toContain("Tasks");
    expect(TOUR_STEPS[4].title).toContain("Checklist");
  });
});

describe("setup checklist computation", () => {
  test("initial empty state", () => {
    const cl = computeChecklist({ connected: true, devices: [], agents: [], tasks: [] }, false);
    expect(cl.hubReachable).toBe(true);
    expect(cl.deviceEnrolled).toBe(false);
    expect(cl.agentCreated).toBe(false);
    expect(cl.taskCreated).toBe(false);
    expect(cl.publicUrlConfigured).toBe(false);
    expect(cl.completedCount).toBe(1); // Hub reachable is 1 of 4
    expect(cl.totalRequired).toBe(4);
    expect(cl.isComplete).toBe(false);
    expect(cl.isVisible).toBe(true);
  });

  test("ticking as state changes", () => {
    // 1. Device added
    let cl = computeChecklist({
      connected: true,
      devices: [{ id: "dev-1", name: "laptop", online: true }],
      agents: [],
      tasks: []
    });
    expect(cl.deviceEnrolled).toBe(true);
    expect(cl.completedCount).toBe(2);
    expect(cl.isComplete).toBe(false);
    expect(cl.isVisible).toBe(true);

    // 2. Agent created
    cl = computeChecklist({
      connected: true,
      devices: [{ id: "dev-1", name: "laptop", online: true }],
      agents: [{ id: "ag-1", name: "codex-1", external: false }],
      tasks: []
    });
    expect(cl.agentCreated).toBe(true);
    expect(cl.completedCount).toBe(3);
    expect(cl.isComplete).toBe(false);

    // 3. Task created
    cl = computeChecklist({
      connected: true,
      devices: [{ id: "dev-1", name: "laptop", online: true }],
      agents: [{ id: "ag-1", name: "codex-1", external: false }],
      tasks: [{ id: "task-1", key: "AGEN-1", title: "First task" }]
    });
    expect(cl.taskCreated).toBe(true);
    expect(cl.completedCount).toBe(4);
    expect(cl.isComplete).toBe(true);
    // Disappears when done
    expect(cl.isVisible).toBe(false);
  });

  test("disappears when dismissed", () => {
    const cl = computeChecklist({ connected: true, devices: [], agents: [], tasks: [] }, true);
    expect(cl.isComplete).toBe(false);
    expect(cl.isVisible).toBe(false);
  });

  test("optional public URL item", () => {
    const withPublic = computeChecklist({
      connected: true,
      publicUrl: "https://fleet.example.com",
      devices: [],
      agents: [],
      tasks: []
    });
    expect(withPublic.publicUrlConfigured).toBe(true);
    expect(withPublic.publicUrl).toBe("https://fleet.example.com");
    // Public URL does not change the required total
    expect(withPublic.totalRequired).toBe(4);
  });

  test("external agents do not satisfy first agent check", () => {
    const cl = computeChecklist({
      connected: true,
      devices: [],
      agents: [{ id: "ext-1", name: "outside", external: true }],
      tasks: []
    });
    expect(cl.agentCreated).toBe(false);
    expect(cl.completedCount).toBe(1);
  });
});

describe("shouldAutoOpenTour", () => {
  const mockStorage = (data: Record<string, string> = {}) => ({
    getItem: (k: string) => data[k] || null,
    setItem: (k: string, v: string) => { data[k] = v; }
  });

  test("opens on first visit after login", () => {
    const s = mockStorage();
    expect(shouldAutoOpenTour({ storage: s, agentCount: 5, taskCount: 3 })).toBe(true);
  });

  test("opens on empty hub", () => {
    const s = mockStorage();
    expect(shouldAutoOpenTour({ storage: s, agentCount: 0, taskCount: 0 })).toBe(true);
  });

  test("does not open when tour is completed", () => {
    const s = mockStorage({ [TOUR_DONE_KEY]: "1" });
    expect(shouldAutoOpenTour({ storage: s, agentCount: 0, taskCount: 0 })).toBe(false);
  });

  test("does not open when tour is dismissed in session", () => {
    const s = mockStorage({ "fleet-tour-dismissed": "1" });
    expect(shouldAutoOpenTour({ storage: s, agentCount: 0, taskCount: 0 })).toBe(false);
  });

  test("respects notour query param", () => {
    const s = mockStorage();
    const params = new URLSearchParams("notour=1");
    expect(shouldAutoOpenTour({ storage: s, params, agentCount: 0, taskCount: 0 })).toBe(false);
  });

  test("respects tour=0 query param", () => {
    const s = mockStorage();
    const params = new URLSearchParams("tour=0");
    expect(shouldAutoOpenTour({ storage: s, params, agentCount: 0, taskCount: 0 })).toBe(false);
  });

  test("suppresses tour on preview-only with populated hub unless tour=1", () => {
    const s = mockStorage();
    const params = new URLSearchParams("token=preview-only");
    expect(shouldAutoOpenTour({ storage: s, params, agentCount: 2, taskCount: 1 })).toBe(false);

    // Empty hub on preview-only still opens tour for verification
    expect(shouldAutoOpenTour({ storage: s, params, agentCount: 0, taskCount: 0 })).toBe(true);

    // Explicit tour=1 opens even on populated preview
    const tourParams = new URLSearchParams("token=preview-only&tour=1");
    expect(shouldAutoOpenTour({ storage: s, params: tourParams, agentCount: 2, taskCount: 1 })).toBe(true);
  });
});
