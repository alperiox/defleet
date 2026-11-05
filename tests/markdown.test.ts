import { test, expect } from "bun:test";
import { parseMarkdown, parseInline } from "../ui/markdown.js";

const types = (blocks: any[]) => blocks.map((b) => b.t);

test("headings, paragraphs, rules and blank-line separation", () => {
  const b = parseMarkdown("# Title\n\nfirst line\nsecond line\n\n---\n\n### Small");
  expect(types(b)).toEqual(["h", "p", "hr", "h"]);
  expect(b[0].level).toBe(1);
  expect(b[3].level).toBe(3);
  expect(b[1].inl.some((n: any) => n.t === "br")).toBe(true);
});

test("bullet and numbered lists, with inline formatting inside items", () => {
  const b = parseMarkdown("- one\n- **two**\n\n1. a\n2. b");
  expect(types(b)).toEqual(["ul", "ol"]);
  expect(b[0].items.length).toBe(2);
  expect(b[0].items[1][0]).toEqual({ t: "b", c: [{ t: "text", v: "two" }] });
  expect(b[1].items.length).toBe(2);
});

test("fenced code keeps its text verbatim, including markdown and html", () => {
  const b = parseMarkdown("```ts\nconst a = **x** <b>hi</b>;\n```");
  expect(b).toEqual([{ t: "code", lang: "ts", text: "const a = **x** <b>hi</b>;" }]);
});

test("an unclosed fence does not swallow the rest as formatting", () => {
  const b = parseMarkdown("```\nstill code");
  expect(b[0].t).toBe("code");
  expect(b[0].text).toBe("still code");
});

test("inline: bold, italic, code and links", () => {
  const n = parseInline("a **b** and *c* and `d` and [e](https://x.dev/p)");
  expect(n.map((x: any) => x.t)).toEqual(["text", "b", "text", "i", "text", "code", "text", "a"]);
  expect(n[7].href).toBe("https://x.dev/p");
});

test("only http and https links become links; javascript: and data: stay as plain text", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "JaVaScRiPt:alert(1)"]) {
    const n = parseInline(`[click](${bad})`);
    expect(n.some((x: any) => x.t === "a")).toBe(false);
    expect(JSON.stringify(n)).toContain("click");
  }
});

test("raw html is never interpreted: it comes back as literal text nodes", () => {
  const n = parseInline('<img src=x onerror=alert(1)> <script>x</script>');
  expect(n.every((x: any) => x.t === "text")).toBe(true);
  expect(n.map((x: any) => x.v).join("")).toContain("<img src=x onerror=alert(1)>");
});

test("blockquotes and tables", () => {
  const b = parseMarkdown("> quoted *text*\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |");
  expect(types(b)).toEqual(["quote", "table"]);
  expect(b[1].head.length).toBe(2);
  expect(b[1].rows.length).toBe(2);
});

test("lone asterisks, underscores in words and empty input do not break or loop", () => {
  expect(parseMarkdown("")).toEqual([]);
  expect(parseInline("2 * 3 = 6 and snake_case_name").map((x: any) => x.t ?? "").every((t: string) => t === "text")).toBe(true);
  const huge = "*".repeat(5000) + "[" .repeat(2000) + "`".repeat(3000);
  expect(() => parseMarkdown(huge)).not.toThrow();
});
