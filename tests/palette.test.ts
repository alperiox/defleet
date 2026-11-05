// The free rebind fixture is z; x is reserved for Stop and ask.
import { test, expect } from "bun:test";
import { DEFAULT_KEYMAP, buildMap, sequenceConflicts } from "../ui/keys.js";
import {
  fuzzyScore, rankItems, parseCommand, paletteItems,
  KEYMAP_STORE, readOverrides, writeOverrides, overridesFor, saveKeymap, loadKeymap,
} from "../ui/palette.js";

const store = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
};

test("the shared table still has no conflicts and now opens the palette with ':'", () => {
  expect(sequenceConflicts()).toEqual([]);
  expect(buildMap().get(":")?.action).toBe("palette");
});

test("fuzzyScore: exact above prefix above word match above plain match above subsequence", () => {
  const q = "usage";
  const exact = fuzzyScore(q, "usage");
  const prefix = fuzzyScore(q, "usages");
  const word = fuzzyScore(q, "go to usage tab");
  const mid = fuzzyScore(q, "xusagex");
  const sub = fuzzyScore(q, "ustorage");
  for (const n of [exact!, prefix!, word!, mid!, sub!]) expect(n).toBeGreaterThan(0);
  expect(exact! > prefix!).toBe(true);
  expect(prefix! > word!).toBe(true);
  expect(word! > mid!).toBe(true);
  expect(mid! > sub!).toBe(true);
  expect(fuzzyScore("xyz", "usage")).toBeNull();
  expect(fuzzyScore("", "usage")).toBeNull();
  expect(fuzzyScore("  ", "usage")).toBeNull();
});

test("fuzzyScore is case-insensitive and prefers contiguous over gappy subsequence", () => {
  expect(fuzzyScore("USAGE", "Usage")).toBe(1000);
  const tight = fuzzyScore("agen", "agent-fleet");
  const spread = fuzzyScore("agen", "a p g e n t");
  expect(tight! > spread!).toBe(true);
  // A word-boundary subsequence beats a mid-word one.
  const atWord = fuzzyScore("usg", "usage left");
  const inside = fuzzyScore("usg", "xusageleft");
  expect(atWord! > inside!).toBe(true);
});

test("rankItems sorts by score, keeps catalogue order on ties, and keeps everything for an empty query", () => {
  const items = [
    { label: "Contact card", keywords: [] },
    { label: "usage tab", keywords: ["help"] },
    { label: "t", keywords: ["slouch"] },
  ];
  expect(rankItems("", items).map((i: any) => i.label)).toEqual(["Contact card", "usage tab", "t"]);
  expect(rankItems("slouch", items)[0]!.label).toBe("t");
  expect(rankItems("usage", items)[0]!.label).toBe("usage tab");
  const both = rankItems("t", items);   // "t" prefix-matches "t" and submatches other labels
  expect(both[0]!.label).toBe("t");
  expect(rankItems("zz", items)).toEqual([]);   // nothing matches, nothing is returned
});

test("parseCommand splits the verb, falls back to a plain search, and answers ':' alone", () => {
  expect(parseCommand(":agent codex-1")).toEqual({ kind: "agent", arg: "codex-1" });
  expect(parseCommand(":ws acme")).toEqual({ kind: "workspace", arg: "acme" });
  expect(parseCommand(":workspace acme")).toEqual({ kind: "workspace", arg: "acme" });
  expect(parseCommand(":task AGEN-12")).toEqual({ kind: "task", arg: "AGEN-12" });
  expect(parseCommand(":tab usage")).toEqual({ kind: "tab", arg: "usage" });
  expect(parseCommand(":dm beta")).toEqual({ kind: "agent", arg: "beta" });
  expect(parseCommand(":tour")).toEqual({ kind: "key", arg: "tour" });
  expect(parseCommand(":usage")).toEqual({ kind: null, arg: "usage" });
  expect(parseCommand(":")).toEqual({ kind: null, arg: "" });
  expect(parseCommand("codex")).toEqual({ kind: null, arg: "codex" });
  expect(parseCommand("")).toEqual({ kind: null, arg: "" });
});

test("paletteItems builds one row per object the source holds, scoped to that source only", () => {
  const items = paletteItems({
    agents: [{ name: "codex-1", external: false }, { name: "bo-laptop", external: true, status: "offline" }],
    workspaces: [{ id: "ws1", name: "acme" }],
    tasks: [{ key: "AGEN-12", title: "Access tab", status: "done" }, { title: "Only title" }],
    tabs: [{ view: "usage", label: "Usage" }],
    keymapActions: [{ id: "palette", keys: [":"], label: "Open the command palette", action: "palette", scope: "global" }],
  });
  expect(items).toHaveLength(2 + 1 + 1 + 1 + 1);
  const agent = items.find((i) => i.kind === "agent")!;
  expect(agent.target).toBe("dm:codex-1");
  expect(agent.label).toBe("codex-1");
  const ext = items.filter((i) => i.kind === "agent")[1]!;
  expect(ext.detail).toContain("outside agent");
  expect(items.find((i) => i.kind === "workspace")!.target).toBe("ws:ws1");
  // A task without a key and an id is not openable, so it gets no row.
  const task = items.find((i) => i.kind === "task")!;
  expect(task.target).toBe("task:AGEN-12");
  expect(task.label).toBe("AGEN-12 Access tab");
  expect(items.find((i) => i.kind === "tab")!.target).toBe("tab:usage");
  const key = items.find((i) => i.kind === "key")!;
  expect(key.target).toBe("key:palette");
  const byVerb = paletteItems({ agents: [{ name: "codex-1" }] });
  expect(byVerb[0]!.kind).toBe("agent");
  expect(paletteItems()).toEqual([]);
});

test("a verb filter keeps its own kind and rankItems then sorts that slice", () => {
  const items = paletteItems({ agents: [{ name: "codex-1" }, { name: "antigravity-1" }], tasks: [{ key: "AGEN-1", title: "commit" }] });
  const cmd = parseCommand(":agent anti");
  const picked = rankItems(cmd.arg, items.filter((i) => i.kind === cmd.kind));
  expect(picked.map((i) => i.target)).toEqual(["dm:antigravity-1"]);
});

test(":tour ranks Welcome tour first when tour is enabled in source", () => {
  const items = paletteItems({ tour: true, agents: [{ name: "codex-1" }] });
  const cmd = parseCommand(":tour");
  const picked = rankItems(cmd.arg, cmd.kind ? items.filter((i) => i.kind === cmd.kind) : items);
  expect(picked[0]?.target).toBe("tour:open");
  expect(picked[0]?.label).toBe("Welcome tour");
});

const AGENTS = [{ id: "ws", name: " fleet keymap " }];
void AGENTS;

test("loadKeymap applies stored rebinds, refuses conflicts and garbage, and drops clones of the default", () => {
  const defaults = DEFAULT_KEYMAP;
  // Nothing stored: the table is exactly the default.
  const clean = loadKeymap(store(), defaults);
  expect(clean.entries).toEqual(defaults);
  expect(clean.overrides).toEqual({});

  // A valid rebind survives a round trip through storage.
  const s1 = store();
  writeOverrides(s1, { "list-down": "z", top: "g x" });
  const loaded = loadKeymap(s1, defaults);
  expect(loaded.entries.find((e: any) => e.id === "list-down")!.keys).toEqual(["z"]);
  expect(loaded.entries.find((e: any) => e.id === "list-up")!.keys).toEqual(["k"]);
  expect(loaded.overrides).toEqual({ "list-down": "z", top: "g x" });
  expect(sequenceConflicts(loaded.entries as any)).toEqual([]);

  // Conflicts, unknown actions and malformed sequences are dropped one by one.
  const s2 = store();
  writeOverrides(s2, { "list-down": "k", "no-such-action": "z", top: "g xx", open: "." });
  const rerun = loadKeymap(s2, defaults);
  expect(rerun.entries.find((e: any) => e.id === "list-down")!.keys).toEqual(["j"]);   // still default
  expect(rerun.overrides).toEqual({ open: "." });                                      // only the valid one is kept

  // An override that equals the default is not a customization.
  const s3 = store();
  writeOverrides(s3, { "list-up": "k", "dm-next": "J" });
  expect(loadKeymap(s3, defaults).overrides).toEqual({});
});

test("overridesFor and saveKeymap write only the departures from the default table", () => {
  const rebound = DEFAULT_KEYMAP.map((e: any) => (e.id === "list-down" ? { ...e, keys: ["z"] } : e));
  expect(overridesFor(rebound as any, DEFAULT_KEYMAP as any)).toEqual({ "list-down": "z" });
  expect(overridesFor(DEFAULT_KEYMAP as any, DEFAULT_KEYMAP as any)).toEqual({});
  const s = store();
  saveKeymap(s as any, rebound as any, DEFAULT_KEYMAP as any);
  expect(s.getItem(KEYMAP_STORE)).toBe(JSON.stringify({ "list-down": "z" }));
  saveKeymap(s as any, DEFAULT_KEYMAP as any, DEFAULT_KEYMAP as any);
  expect(s.getItem(KEYMAP_STORE)).toBe("{}");
});

test("readOverrides survives corrupt storage, and writeOverrides survives a blocked store", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(readOverrides(broken as any)).toEqual({});
  const junk = { getItem: () => "{not json", setItem: () => {} };
  expect(readOverrides(junk as any)).toEqual({});
  const weird = { getItem: () => JSON.stringify([1, 2]), setItem: () => {} };   // an array is not an override map
  expect(readOverrides(weird as any)).toEqual({});
  expect(() => writeOverrides(broken as any, { a: "b" })).not.toThrow();
  writeOverrides(undefined as any, { a: "b" });   // also fine when there is no store at all
});

test("a stored rebind keeps conflict detection in check across a save/load cycle", () => {
  const s = store();
  let entries = DEFAULT_KEYMAP.map((e: any) => ({ ...e }));
  const attempt = sequenceConflicts((entries as any).map((e: any) => (e.id === "list-down" ? { ...e, keys: ["k"] } : e)));
  expect(attempt).toEqual([{ sequence: "k", actions: ["list-down", "list-up"] }]);   // what the editor refuses
  entries = entries.map((e: any) => (e.id === "list-down" ? { ...e, keys: ["z"] } : e)) as any;
  saveKeymap(s as any, entries, DEFAULT_KEYMAP as any);
  const back = loadKeymap(s, DEFAULT_KEYMAP as any);
  expect(back.entries.find((e: any) => e.id === "list-down")!.keys).toEqual(["z"]);
  expect(sequenceConflicts(back.entries as any)).toEqual([]);
});
