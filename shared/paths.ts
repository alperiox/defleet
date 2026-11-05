import { posix } from "node:path";

/** Whether `dir` is one of `roots` or inside one, judged by the path text alone (the hub cannot look at another machine's disk).
 * `..` is resolved first, and /work-evil is not inside /work. */
export function underRoots(dir: string, roots: string[]): boolean {
  if (!dir.startsWith("/")) return false;
  const d = posix.normalize(dir).replace(/\/+$/, "") || "/";
  return roots.some((r) => {
    const root = posix.normalize(r).replace(/\/+$/, "") || "/";
    return d === root || d.startsWith(root === "/" ? "/" : root + "/");
  });
}

/** Canonical worktrees stay beneath a device-allowed root; the chosen launch folder is the root. */
export function projectWorktree(root:string,project:string,agent:string):string {
 if(!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(project)||!/^[-a-z0-9]{1,40}$/.test(agent))throw Error("invalid project or agent");
 return posix.join(root,".fleet-worktrees",project,agent);
}
