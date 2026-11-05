import { diskState, type DiskState } from "./disk";
import { Hono } from "hono";
import { Hub } from "./hub";
import { mountApi } from "./api";
import { mountMcp } from "./mcp";
import { mountAgentApi } from "./agent-api";
import { openStore } from "./store";
import { mountArtifacts } from "./artifacts";
import { mountGit, ensureRepo } from "./git";
import { mountDevices } from "./devices";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { mountSecurity, type SecurityOptions } from "./security";
import { resolvePublicUrl } from "./public-url";

export interface AppOptions { storage?:()=>DiskState; security?: SecurityOptions; dataDir?: string; maxArtifactBytes?: number; humanAttachmentMaxBytes?: number; humanAttachmentMaxCount?: number; hubOwner?: string; leaseMinutes?: number; offerMinutes?: number; /** HUB_PUBLIC_URL: the address people reach the hub at, when it differs from the request origin (a tunnel). */ publicUrl?: string }

export function createApp(dbPath: string, humanToken: string, opts: AppOptions = {}) {
  // Fail before opening the database: a wrong public address in a join prompt is worse than a hub that will not start.
  const publicUrl = resolvePublicUrl(opts.publicUrl);
  const bytes = opts.humanAttachmentMaxBytes ?? 25 * 1024 * 1024;
  const count = opts.humanAttachmentMaxCount ?? 10;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(count) || count < 1 || count > 10) throw new Error("human attachment limits require positive integer bytes and a count from 1 to 10");
  const store = openStore(dbPath);
  const hub = new Hub(store);
  hub.humanAttachmentMaxBytes = bytes; hub.humanAttachmentMaxCount = count;
  // Uploaded files and git repos live beside the database (a temp folder for in-memory test databases).
  hub.dataDir = opts.dataDir ?? (dbPath === ":memory:" ? mkdtempSync(`${tmpdir()}/fleet-data-`) : `${dirname(dbPath)}/data`);
  store.projectCreated = (project) => { void ensureRepo(`${hub.dataDir}/repos`,project).catch(e=>console.error("repository creation failed",project,e)); };
  let lastDiskNote=0;
  const diskNotice=(text:string)=>{if(Date.now()-lastDiskNote>3600000){lastDiskNote=Date.now();store.addMessage({thread:"room",from:"human",text:"Hub disk guard: "+text});hub.notify();}};
  hub.diskNotice=diskNotice;
  hub.hubOwner = opts.hubOwner ?? "";
  hub.cleanupTaskFiles();
  if (opts.leaseMinutes && opts.leaseMinutes > 0) hub.leaseMs = opts.leaseMinutes * 60_000;
  if (opts.offerMinutes && opts.offerMinutes > 0) hub.offerMs = opts.offerMinutes * 60_000;
  const app = new Hono();
  mountSecurity(app, opts.security);
  mountMcp(app, hub, store);
  mountAgentApi(app, hub, store, publicUrl);
  const storage=opts.storage??(()=>diskState(hub.dataDir,dbPath));
  const artifacts = mountArtifacts(app, hub, store, humanToken, hub.dataDir, opts.maxArtifactBytes ?? 200 * 1024 * 1024,storage);
  mountGit(app, store, hub.dataDir, (a, p) => hub.canAccessRepo(a, p), diskNotice,storage);
  mountApi(app, hub, store, humanToken, artifacts.signedUrl, hub.dataDir, opts.security, publicUrl,storage);
  mountDevices(app, hub, store);          // after mountApi: the /api routes here sit behind its human-token check
  return { app, hub, store };
}
