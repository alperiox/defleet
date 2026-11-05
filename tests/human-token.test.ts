import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveHumanToken } from "../src/human-token";

const dir = () => mkdtempSync(`${tmpdir()}/fleet-ht-`);

test("an explicit token wins and nothing is written", () => {
  const d = dir();
  expect(resolveHumanToken("from-env", `${d}/human-token`)).toEqual({ token: "from-env", generated: false });
  expect(() => readFileSync(`${d}/human-token`)).toThrow();
});

test("with no token set, one is generated once, kept privately, and reused on the next start", () => {
  const d = dir(), file = `${d}/human-token`;
  const first = resolveHumanToken(undefined, file);
  expect(first.generated).toBe(true);
  expect(first.token.length).toBeGreaterThanOrEqual(32);
  expect(statSync(file).mode & 0o077).toBe(0);
  const second = resolveHumanToken(undefined, file);
  expect(second).toEqual({ token: first.token, generated: false });
});

test("a blank saved file is replaced rather than accepted as an empty password", () => {
  const d = dir(), file = `${d}/human-token`;
  writeFileSync(file, "  \n");
  expect(resolveHumanToken(undefined, file).token.length).toBeGreaterThanOrEqual(32);
});
