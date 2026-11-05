// The free rebind fixture is z; x is reserved for Stop and ask.
import { test, expect } from "bun:test";
import {
  DEFAULT_KEYMAP, buildMap, sequenceConflicts, rebind, toggleBinding,
  keyToken, isInsertTarget, reduceKey, hintText, clampIndex, stepIndex,
} from "../ui/keys.js";

const ev = (key: string, mods: Record<string, boolean> = {}) => ({ key, isComposing: false, keyCode: 0, ...mods });

test("the keymap has one table with the keys the brief lists, and no duplicate sequence", () => {
  expect(sequenceConflicts()).toEqual([]);
  const map = buildMap();
  for (const seq of ["j", "k", "Enter", "i", "/", "Escape", "g g", "G", "[", "]", "J", "K", "a", "?"]) expect(map.has(seq)).toBe(true);
  for (const [letter, tab] of [["n", "inbox"], ["r", "room"], ["t", "tasks"], ["m", "team"], ["d", "devices"], ["u", "usage"], ["a", "access"], ["c", "code"]]) {
    expect(map.get("g " + letter)!.action).toBe("tab:" + tab);
  }
  // Every action appears once, with a label and a scope.
  expect(new Set(DEFAULT_KEYMAP.map((e: any) => e.id)).size).toBe(DEFAULT_KEYMAP.length);
  for (const entry of DEFAULT_KEYMAP) { expect(entry.label.length).toBeGreaterThan(0); expect(entry.keys.length).toBeGreaterThan(0); }
});

test("keyToken passes what the page can act on and refuses modifiers, IME and editing keys", () => {
  expect(keyToken(ev("j"))).toBe("j");
  expect(keyToken(ev("J", { shiftKey: true }))).toBe("J");
  expect(keyToken(ev("?"))).toBe("?");
  expect(keyToken(ev(" "))).toBe("space");
  expect(keyToken(ev("Enter"))).toBe("Enter");
  expect(keyToken(ev("Escape"))).toBe("Escape");
  expect(keyToken(ev("j", { ctrlKey: true }))).toBeNull();
  expect(keyToken(ev("k", { metaKey: true }))).toBeNull();
  expect(keyToken(ev("n", { altKey: true }))).toBeNull();
  expect(keyToken(ev("Process", { isComposing: true }))).toBeNull();
  expect(keyToken({ key: "j", keyCode: 229 })).toBeNull();
  expect(keyToken(ev("Tab"))).toBeNull();
  expect(keyToken(ev("Backspace"))).toBeNull();
  expect(keyToken(ev("Shift"))).toBeNull();
});

test("isInsertTarget is true only for fields that take typing", () => {
  expect(isInsertTarget({ tagName: "INPUT", isContentEditable: false })).toBe(true);
  expect(isInsertTarget({ tagName: "textarea", isContentEditable: false })).toBe(true);
  expect(isInsertTarget({ tagName: "SELECT", isContentEditable: false })).toBe(true);
  expect(isInsertTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  expect(isInsertTarget({ tagName: "DIV", isContentEditable: false })).toBe(false);
  expect(isInsertTarget({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
  expect(isInsertTarget(null)).toBe(false);
});

test("one key with an exact binding runs it; an unknown key does nothing", () => {
  const map = buildMap(), idle = { pending: "", at: 0 };
  expect(reduceKey(idle, "j", map, 10)).toMatchObject({ action: "list-down", pending: "" });
  expect(reduceKey(idle, "x", map, 10)).toMatchObject({ action: "stop" });
  expect(reduceKey(idle, "z", map, 10)).toMatchObject({ action: null, pending: "" });
  expect(reduceKey(idle, "J", map, 10)).toMatchObject({ action: "dm-next" });
});

test("a prefix waits for the second key, and both halves work", () => {
  const map = buildMap();
  const first = reduceKey({ pending: "", at: 0 }, "g", map, 100);
  expect(first).toMatchObject({ action: null, pending: "g" });
  expect(hintText(first.pending)).toBe("g …");
  expect(reduceKey({ pending: first.pending, at: first.at }, "n", map, 200)).toMatchObject({ action: "tab:inbox", pending: "" });
  expect(reduceKey({ pending: "g", at: 100 }, "g", map, 200)).toMatchObject({ action: "top", pending: "" });
  expect(reduceKey({ pending: "g", at: 100 }, "t", map, 200)).toMatchObject({ action: "tab:tasks" });
});

test("the g sequence times out after one second and runs nothing", () => {
  const map = buildMap();
  const first = reduceKey({ pending: "", at: 0 }, "g", map, 1000);
  expect(first.pending).toBe("g");
  // 1001 ms later the pending prefix is stale: "n" is not a binding on its own, so nothing happens.
  expect(reduceKey(first, "n", map, 2100, 1000)).toMatchObject({ action: null, pending: "" });
  // And a fresh "g" after a stale one starts a new sequence rather than completing "g g" by accident.
  expect(reduceKey({ pending: "g", at: 1000 }, "g", map, 2500, 1000)).toMatchObject({ action: null, pending: "g" });
});

test("a dead prefix falls back to the key's own binding when it has one", () => {
  const map = buildMap([...DEFAULT_KEYMAP, { id: "q", action: "quit", keys: ["q"], label: "q", scope: "global" }, { id: "gx", action: "gx", keys: ["gx"], label: "gx", scope: "global" }]);
  // "g" + "q" is not a sequence; "q" alone is bound, so it runs instead of being swallowed.
  expect(reduceKey({ pending: "g", at: 0 }, "q", map, 10)).toMatchObject({ action: "quit", pending: "" });
  // "g" + "z": neither the pair nor "z" is bound, and the prefix is cleared.
  expect(reduceKey({ pending: "g", at: 0 }, "z", map, 10)).toMatchObject({ action: null, pending: "" });
});

test("selection steps clamp, start sensibly and wrap only when asked", () => {
  expect(clampIndex(-5, 3)).toBe(-1);
  expect(clampIndex(0, 0)).toBe(-1);
  expect(clampIndex(9, 3)).toBe(2);
  expect(stepIndex(-1, 3, 1)).toBe(0);
  expect(stepIndex(-1, 3, -1)).toBe(2);
  expect(stepIndex(2, 3, 1)).toBe(2);
  expect(stepIndex(2, 3, 1, true)).toBe(0);
  expect(stepIndex(0, 3, -1)).toBe(0);
  expect(stepIndex(0, 3, -1, true)).toBe(2);
  expect(stepIndex(0, 0, 1)).toBe(-1);
});

test("rebinding refuses a key another action already owns, and names the owner", () => {
  const entries = DEFAULT_KEYMAP;
  const clash = rebind(entries, "list-down", "k");
  expect(clash.ok).toBe(false);
  expect((clash as any).reason).toBe("conflict");
  expect((clash as any).with).toBe("list-up");
  expect((clash as any).label).toBe("Select the previous item");
  const free = rebind(entries, "list-down", "z");
  expect(free.ok).toBe(true);
  const next = (free as any).entries;
  expect(next.find((e: any) => e.id === "list-down").keys).toEqual(["z"]);
  expect(next.find((e: any) => e.id === "list-up").keys).toEqual(["k"]);
  expect(rebind(entries, "list-down", "  ")).toMatchObject({ ok: false, reason: "empty" });
  expect(rebind(entries, "top", "g x")).toMatchObject({ ok: true });
  expect(rebind(entries, "top", "g xx")).toMatchObject({ ok: false, reason: "sequence" });
  // Rebinding to the action's own current key is not a conflict.
  expect(rebind(entries, "list-down", "j").ok).toBe(true);
  // A duplicate table is reported, so a hand-edited keymap can be checked at load.
  expect(sequenceConflicts([{ id: "a", keys: ["j"], label: "a", action: "a", scope: "list" }, { id: "b", keys: ["j"], label: "b", action: "b", scope: "list" }]))
    .toEqual([{ sequence: "j", actions: ["a", "b"] }]);
});

test("adding an action is one row in DEFAULT_KEYMAP", () => {
  // AGEN-18 adds Discuss this way: one entry, then the existing cheat-sheet, hint and parser pick it up.
  const extended = [...DEFAULT_KEYMAP, { id: "discuss", keys: ["d"], label: "Discuss this request", action: "discuss", scope: "needs" as const }];
  expect(sequenceConflicts(extended)).toEqual([]);
  expect(reduceKey({ pending: "", at: 0 }, "d", buildMap(extended), 10)).toMatchObject({ action: "discuss", pending: "" });
});

test("toggleBinding rewrites one action and leaves the rest alone", () => {
  const next = toggleBinding(DEFAULT_KEYMAP, "open", "o");
  expect(next.find((e: any) => e.id === "open")!.keys).toEqual(["o"]);
  expect(next.find((e: any) => e.id === "list-down")!.keys).toEqual(["j"]);
  expect(next.length).toBe(DEFAULT_KEYMAP.length);
});
