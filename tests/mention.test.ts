import { test, expect } from "bun:test";
import { mentionAt, suggestAgents, applyMention } from "../ui/mention.js";

const agents = [
  { name: "claude-laptop", online: true }, { name: "opencode-mac", online: false }, { name: "prime-one", online: true }, { name: "claude-desktop", online: false },
];

test("typing @ at the start or after a space opens a mention; the text after it is the query", () => {
  expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionAt("hey @cl", 7)).toEqual({ start: 4, query: "cl" });
  expect(mentionAt("hey @claude-lap and more", 15)).toEqual({ start: 4, query: "claude-lap" });   // the caret decides, not the end of the text
});

test("an @ inside a word, an email, or after the caret is not a mention", () => {
  expect(mentionAt("mail me@example.com", 19)).toBeNull();
  expect(mentionAt("hello", 5)).toBeNull();
  expect(mentionAt("@claude hello", 13)).toBeNull();       // the caret is past the name, in ordinary text
  expect(mentionAt("a @b c", 2)).toBeNull();               // caret before the @
});

test("suggestions match by prefix first, then anywhere, with online agents ahead of offline ones", () => {
  expect(suggestAgents(agents, "").map((a: any) => a.name)).toEqual(["claude-laptop", "prime-one", "claude-desktop", "opencode-mac"]);
  expect(suggestAgents(agents, "cl").map((a: any) => a.name)).toEqual(["claude-laptop", "claude-desktop"]);
  expect(suggestAgents(agents, "mac").map((a: any) => a.name)).toEqual(["opencode-mac"]);
  expect(suggestAgents(agents, "CLAUDE-L").map((a: any) => a.name)).toEqual(["claude-laptop"]);
  expect(suggestAgents(agents, "zzz")).toEqual([]);
});

test("choosing an agent replaces the typed fragment with the full name and a space, and puts the caret after it", () => {
  expect(applyMention("hey @cl and more", { start: 4, query: "cl" }, "claude-laptop")).toEqual({ text: "hey @claude-laptop  and more", caret: 19 });
  expect(applyMention("@", { start: 0, query: "" }, "prime-one")).toEqual({ text: "@prime-one ", caret: 11 });
});
