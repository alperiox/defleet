import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// The UI is one HTML file with no build step, so these pin the behaviours that matter by reading it.
const ui = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");

test("task keys in agent text link only to tasks that exist in the workspace being viewed, and never inside a link or code", () => {
  expect(ui).toContain("state.tasks.some((x) => x.key === key)");
  expect(ui).not.toContain("raw.tasks.some((x) => x.key === key)");
  expect(ui).toContain('if (n.t === "code") return [el("code", {}, n.v)]');
  expect(ui).toContain("inlineNodes(n.c, false)");
});

test("screenshots and videos open in a layer, not a new tab", () => {
  const outcome = ui.slice(ui.indexOf("function outcomeSection"), ui.indexOf("function renderTaskPage"));
  expect(outcome).toContain("openLightbox(");
  expect(outcome).not.toContain("_blank\", rel: \"noopener noreferrer\" },\n    el(\"img\"");
});

test("the outcome comes before the facts on the task page", () => {
  const page = ui.slice(ui.indexOf("function renderTaskPage"));
  expect(page.indexOf("outcomeSection(")).toBeLessThan(page.indexOf('class: "facts"'));
});

test("a task link keeps its own key: the click handler must not read the loop's match object", () => {
  const fn = ui.slice(ui.indexOf("function linkKeys"), ui.indexOf("function inlineNodes"));
  const handler = fn.slice(fn.indexOf('addEventListener("click"'));
  expect(handler.split("\n")[0]).not.toContain("m[1]");
});

test("message attachments render as thumbnails that open the same viewer", () => {
  expect(ui).toContain("attachmentNodes(m.attachments)");
  const fn = ui.slice(ui.indexOf("function attachmentNodes"), ui.indexOf("function blockNodes"));
  expect(fn).toContain("openLightbox(media");
});
