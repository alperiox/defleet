import * as crypto from "node:crypto";

export const tokenDigest = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const MISSING_DIGEST = "0".repeat(64);

/** Both operands are fixed-size SHA-256 digests, including a failed database lookup. */
export function digestMatches(actual: string, expected = MISSING_DIGEST): boolean {
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function tokenMatches(actual: string, expected: string): boolean {
  const matches = digestMatches(tokenDigest(actual), tokenDigest(expected));
  return matches && actual.length > 0 && expected.length > 0;
}
