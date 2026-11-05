import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** The human token comes from HUB_HUMAN_TOKEN. If it is not set, one is generated on first start and kept in a
 * private file beside the database, so there is always a way to find it (`bun run src/admin.ts human-token`). */
export function resolveHumanToken(fromEnv: string | undefined, file: string): { token: string; generated: boolean } {
  if (fromEnv) return { token: fromEnv, generated: false };
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return { token: saved, generated: false };
  }
  const token = randomBytes(24).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { token, generated: true };
}
