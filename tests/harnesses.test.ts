import { test, expect } from "bun:test";
import { HARNESSES, harnessInfo, normalizeHarnessName, detectHarnesses, validateSessionId } from "../shared/harnesses";

test("the registry lists every supported harness once, with what the rest of the system needs to know", () => {
  expect(HARNESSES.map((h) => h.id)).toEqual(["claude", "opencode", "prime", "codex", "antigravity", "custom"]);
  expect(harnessInfo("claude")).toMatchObject({ label: "Claude Code", bin: "claude", safeMode: true, quarantine: true });
  expect(harnessInfo("opencode")).toMatchObject({ safeMode: true, quarantine: false, model: "required" });
  expect(harnessInfo("prime")).toMatchObject({ safeMode: false, quarantine: false, model: "required" });
  expect(harnessInfo("codex")).toMatchObject({ bin: "codex", model: "optional", quarantine: false });
  // `agy` is the Antigravity CLI. It cannot be quarantined, and its support is new enough that the first add self-checks it.
  expect(harnessInfo("antigravity")).toMatchObject({ label: "Antigravity", bin: "agy", model: "optional", safeMode: true, quarantine: false, unverified: true });
  expect(harnessInfo("custom")).toMatchObject({ bin: null, safeMode: false });
});

test("each harness lists the permission levels it can start with, and they agree with what the CLI accepts", async () => {
  const { extraArgsFor } = await import("../cli/fleet");
  for (const h of HARNESSES) {
    expect(h.permissions.length).toBeGreaterThan(0);
    for (const p of ["safe", "edits", "open"] as const) {
      let ok = true;
      try { extraArgsFor(h.id, p); } catch { ok = false; }
      expect(ok).toBe(h.permissions.includes(p));
    }
  }
});

test("the names people type resolve to a harness, and anything else is not one", () => {
  expect(normalizeHarnessName("prime-agent")).toBe("prime");
  expect(normalizeHarnessName("Codex")).toBe("codex");
  expect(normalizeHarnessName("claude-code")).toBe("claude");
  expect(normalizeHarnessName("agy")).toBe("antigravity");
  expect(normalizeHarnessName("Antigravity")).toBe("antigravity");
  expect(normalizeHarnessName("hermes")).toBeNull();      // goes through the adapter prompt until it is verified
  expect(normalizeHarnessName(42)).toBeNull();
});

test("a device reports the harnesses it has, in registry order, using only the commands it can find", () => {
  const found = new Map([["claude", "/usr/bin/claude"], ["codex", "/opt/codex"]]);
  expect(detectHarnesses((bin) => found.get(bin) ?? null).map((d) => [d.id, d.path])).toEqual([["claude", "/usr/bin/claude"], ["codex", "/opt/codex"], ["custom", null]]);
});

test("codex: the example model is one bare slug the CLI can be given, and the model may be left out", () => {
  const codex = harnessInfo("codex");
  expect(codex.model).toBe("optional");                 // with no -m, codex uses its own default for the account
  expect(codex.modelExample).toMatch(/^[a-z0-9][a-z0-9.\-]*$/);   // one word: it is pasted after -m, never shell-parsed
  expect(codex.modelExample).not.toContain(" ");
});

test("antigravity: the example model is one slug `agy models` prints, and the model may be left out", () => {
  const agy = harnessInfo("antigravity");
  expect(agy.model).toBe("optional");                   // with no --model, agy uses the model chosen in its own UI
  expect(agy.modelExample).toBe("gemini-3.8-flash-medium");
  expect(agy.modelExample).toMatch(/^[a-z0-9][a-z0-9.\-]*$/);
  // It is listed by the installed CLI (agy 1.4.12), so it can be typed without asking the model list first.
  expect(agy.aliases).toEqual(["antigravity", "agy"]);
});

test("session ids are checked per harness, and prime-agent cannot adopt one", () => {
  expect(validateSessionId("codex", "01a19329-9069-7dd1-b5a1-ee5af7a024fd")).toBeNull();
  expect(validateSessionId("codex", "01a1a02c-ec95-70a3-8b58-c3dad733214f")).toBeNull();   // a real id codex 0.166 reported
  expect(validateSessionId("codex", "nope")).toMatch(/uuid/i);
  // `codex exec resume --last` must never be what adopting means: "latest" is the newest session in the folder,
  // which may belong to another agent.
  expect(validateSessionId("codex", "latest")).toMatch(/uuid/i);
  expect(validateSessionId("codex", "--last")).toMatch(/uuid/i);
  expect(validateSessionId("claude", "bf26ea24-5be5-4119-954f-199f787baf9d")).toBeNull();
  expect(validateSessionId("opencode", "ses_abc123")).toBeNull();
  // Antigravity's conversation_id is a UUID; "the latest conversation" is never how it is resumed.
  expect(validateSessionId("antigravity", "055a398f-db14-4c5f-abbb-1bf03f8120a7")).toBeNull();
  expect(validateSessionId("antigravity", "nope")).toMatch(/uuid/i);
  expect(validateSessionId("antigravity", "latest")).toMatch(/uuid/i);
  expect(validateSessionId("prime", "x")).toMatch(/prime-agent/);
  expect(validateSessionId("custom", " ")).toMatch(/empty/i);
});
