import { statSync } from "node:fs";

// The helper and the fleet command are downloaded to other devices as one file each, but in the repository they share
// modules (shared/harnesses.ts). The hub bundles them when asked, so a device always gets a file that runs on its own.
const cache = new Map<string, { key: string; text: string }>();

const SOURCES = ["../helper/fleet-helper.ts", "../cli/fleet.ts", "../shared/harnesses.ts"].map((p) => new URL(p, import.meta.url).pathname);

/** The entry file with its imports inlined. Rebuilt only when one of the sources changed. */
export async function bundled(entry: string): Promise<string> {
  const path = new URL(entry, import.meta.url).pathname;
  const key = SOURCES.map((p) => { try { return statSync(p).mtimeMs; } catch { return 0; } }).join(":");
  const hit = cache.get(path);
  if (hit && hit.key === key) return hit.text;
  const result = await Bun.build({ entrypoints: [path], target: "bun" });
  if (!result.success || result.outputs.length !== 1) throw new Error(`could not bundle ${entry}: ${result.logs.map(String).join("; ")}`);
  const text = await result.outputs[0].text();
  cache.set(path, { key, text });
  return text;
}
