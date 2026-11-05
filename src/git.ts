import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import type { Hono } from "hono";
import type { Agent, Store } from "./store";
import { diskState, diskPolicy, treeBytes, DISK_LIMITS, type DiskState } from "./disk";

const pushQueues=new Map<string,Promise<void>>();
async function pushLock(root:string){
 const previous=pushQueues.get(root)??Promise.resolve();let releaseQueue!:()=>void;
 const current=new Promise<void>(r=>releaseQueue=r),tail=previous.then(()=>current);pushQueues.set(root,tail);await previous;
 const lock=`${root}/.fleet-operation.lock`;mkdirSync(root,{recursive:true});const start=Date.now();
 try{for(;;){try{mkdirSync(lock);writeFileSync(`${lock}/pid`,String(process.pid));break;}catch(e){
  if((e as any).code!=="EEXIST")throw e;
  try{const pid=Number(readFileSync(`${lock}/pid`,"utf8"));if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);}catch(reason){if((reason as any).code==="ESRCH"){rmSync(lock,{recursive:true,force:true});continue;}}}}catch{}
  if(Date.now()-start>30000)throw Error("repository maintenance is busy; retry shortly");await Bun.sleep(50);
 }}}catch(e){releaseQueue();if(pushQueues.get(root)===tail)pushQueues.delete(root);throw e;}
 let released=false;return()=>{if(released)return;released=true;rmSync(lock,{recursive:true,force:true});releaseQueue();if(pushQueues.get(root)===tail)pushQueues.delete(root);};
}

const PROJECT = /^[a-z0-9][a-z0-9._-]{0,60}$/;

export async function gitRun(path: string, ...args: string[]): Promise<string> {
  const p=Bun.spawn(["git","-C",path,...args],{stdout:"pipe",stderr:"pipe"});
  const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);
  if(await p.exited)throw new Error(err.trim()||"git failed");return out.trim();
}
const initializedRepos=new Set<string>();
export function ensureRepo(root:string,project:string):Promise<void>{
 try{
  if(!PROJECT.test(project))throw Error("bad project name");const path=`${root}/${project}.git`;
  if(initializedRepos.has(path)&&existsSync(path))return Promise.resolve();
  mkdirSync(root,{recursive:true});
  const git=(...args:string[])=>{const p=Bun.spawnSync(["git",...args]);if(p.exitCode)throw Error(p.stderr.toString());};
  if(!existsSync(path))git("init","--bare","--initial-branch=main",path);
  git("-C",path,"config","http.receivepack","true");git("-C",path,"config","gc.autoDetach","false");git("-C",path,"config","core.logAllRefUpdates","true");
  writeFileSync(`${path}/hooks/fleet-policy.ts`,readFileSync(new URL("./git-hook.ts",import.meta.url)));
  const quote=(v:string)=>"'"+v.replace(/'/g,"'\\''")+"'";
  writeFileSync(`${path}/hooks/pre-receive`,`#!/bin/sh\nexec ${quote(process.execPath)} hooks/fleet-policy.ts\n`);chmodSync(`${path}/hooks/pre-receive`,0o755);
  initializedRepos.add(path);return Promise.resolve();
 }catch(e){return Promise.reject(e);}
}
async function resolveRef(path:string,ref:string):Promise<string|null>{try{return await gitRun(path,"rev-parse","--verify",ref+"^{commit}");}catch{return null;}}
export async function seedRepo(data:string,project:string,source:string){
 const unlock=await pushLock(`${data}/repos`);try{return await seedUnlocked(data,project,source);}finally{unlock();}
}
async function seedUnlocked(data:string,project:string,source:string){
 await ensureRepo(`${data}/repos`,project);const repo=`${data}/repos/${project}.git`;
 if(await resolveRef(repo,"refs/heads/main"))throw Error("canonical main already exists; seed refused");
 const sha=await gitRun(source,"rev-parse","--verify","refs/heads/main^{commit}");
 // Fetch to a temporary namespace: main is published only after object checks pass.
 await gitRun(repo,"fetch","--no-tags",source,"refs/heads/main:refs/fleet-seed/main","+refs/tags/*:refs/fleet-seed/tags/*");
 try{
  const rows=await gitRun(repo,"rev-list","--objects","--all");
  const ids=rows.split("\n").filter(Boolean).map(l=>l.split(" ")[0]);
  const p=Bun.spawn(["git","-C",repo,"cat-file","--batch-check=%(objecttype) %(objectsize)"],{stdin:Buffer.from(ids.join("\n")+"\n"),stdout:"pipe",stderr:"pipe"});
  const sizes=await new Response(p.stdout).text();if(await p.exited)throw Error("seed inspection failed");
  if(sizes.split("\n").some(l=>l.startsWith("blob ")&&Number(l.split(" ")[1])>DISK_LIMITS.blob))throw Error("seed contains blob over 25 MB");
  if(treeBytes(repo)>DISK_LIMITS.project||treeBytes(`${data}/repos`)>DISK_LIMITS.repos)throw Error("seed exceeds repository budget");
  for(const ref of (await gitRun(repo,"for-each-ref","--format=%(refname)","refs/fleet-seed/tags")).split("\n").filter(Boolean)){const object=await gitRun(repo,"rev-parse",ref);await gitRun(repo,"update-ref",ref.replace("refs/fleet-seed/tags/","refs/tags/"),object);}
  await gitRun(repo,"update-ref","refs/heads/main",sha,"0".repeat(40));
  // Human-selected migration default: discard the three obsolete codex-1 staging refs.
  for(const name of ["codex-1/agen-3-4","codex-1/agen-5","codex-1/agen-7"]){const ref=`refs/heads/${name}`;if(await resolveRef(repo,ref))await gitRun(repo,"update-ref","-d",ref);}
  if(await resolveRef(repo,"refs/heads/main")!==sha)throw Error("seed verification failed");return {project,main:sha};
 }finally{for(const ref of (await gitRun(repo,"for-each-ref","--format=%(refname)","refs/fleet-seed")).split("\n").filter(Boolean))await gitRun(repo,"update-ref","-d",ref);await gitRun(repo,"gc","--prune=now");}
}
export async function integrate(data:string,store:Store,project:string,branch:string,expectedMain:string,actor:string){
 if(!PROJECT.test(project)||!/^[-a-z0-9]+\/[-a-zA-Z0-9._/]+$/.test(branch)||branch.includes(".."))throw Error("invalid task branch");
 const unlock=await pushLock(`${data}/repos`);try{
 const repo=`${data}/repos/${project}.git`;
 if(!/^[a-f0-9]{40}$/.test(expectedMain))throw Error("expectedMain must be a full SHA");
 if(await gitRun(repo,"rev-parse","--is-bare-repository")!=="true")throw Error("dirty/non-bare repository refused; integration requires the canonical bare repo");
 const main=await resolveRef(repo,"refs/heads/main");if(main!==expectedMain)throw Error("main changed; reload before integrating");
 const next=await resolveRef(repo,`refs/heads/${branch}`);if(!next)throw Error("no such branch");
 if(next===main)throw Error("branch is already integrated");
 try{await gitRun(repo,"merge-base","--is-ancestor",main,next);}catch{throw Error("non-fast-forward: rebase on main and push a new branch; conflicts must be resolved in your worktree");}
 // No checked-out files exist in a bare repo; only a clean ff and compare-and-swap are accepted.
 try{await gitRun(repo,"update-ref","refs/heads/main",next,expectedMain);}catch{throw Error("main changed concurrently; reload before integrating");}
 const result={project,branch,fromSha:main,toSha:next,actor,createdAt:Date.now()};
 try{store.addIntegration(result);}catch(e){try{await gitRun(repo,"update-ref","refs/heads/main",main,next);}catch{throw Error("integration audit failed after main advanced; inspect canonical main before retrying");}throw Error("integration audit failed; main restored");}
 await gitRun(repo,"gc","--auto");return result;
 }finally{unlock();}
}
export async function repoStatus(data:string,project:string,store?:Store):Promise<RepoInfo>{
 if(!PROJECT.test(project))throw Error("bad project name");
 const path=`${data}/repos/${project}.git`,main=await resolveRef(path,"refs/heads/main");
 const raw=await gitRun(path,"for-each-ref","--sort=-committerdate","--format=%(refname:short)%1f%(objectname)%1f%(subject)%1f%(authorname)%1f%(committerdate:iso-strict)","refs/heads");
 const branches=[];for(const l of raw.split("\n").filter(Boolean)){const[name,sha,subject,author,date]=l.split("\x1f");let ahead=0,behind=0;if(main){const counts=(await gitRun(path,"rev-list","--left-right","--count",`${main}...${sha}`)).split(/\s+/).map(Number);[behind,ahead]=counts;}
 let activity=Date.parse(date);try{const log=await gitRun(path,"reflog","show","--format=%gD","--date=unix","-1",`refs/heads/${name}`);const stamp=/@\{(\d+)\}/.exec(log);if(stamp)activity=Number(stamp[1])*1000;}catch{}
 branches.push({name,sha,subject,author,date,ahead,behind,idle: name!=="main"&&ahead>0&&Date.now()-activity>60*86400000});}
 return{project,main,size:treeBytes(path),warning:treeBytes(path)>DISK_LIMITS.warnProject,branches,lastIntegration:store?.listIntegrations(project)[0]??null};
}
export async function maintainRepos(data:string,store:Store,opts:{weekly?:boolean;now?:number}={}){
 const errors:string[]=[],pruned:string[]=[];const now=opts.now??Date.now();
 const root=`${data}/repos`;if(!existsSync(root))return{errors,pruned};const unlock=await pushLock(root);try{
 for(const entry of readdirSync(root).filter(e=>e.endsWith(".git"))){const project=entry.slice(0,-4),path=`${root}/${entry}`;
  let repo:RepoInfo;try{repo=await repoStatus(data,project,store);}catch(e){errors.push(`${project}: ${String(e)}`);continue;}
  try{await gitRun(path,"fsck","--full");}catch(e){errors.push(`${repo.project}: ${String(e)}`);}
  for(const r of store.listIntegrations(repo.project)){if(now-r.createdAt<30*86400000||!r.branch.includes("/"))continue;
   const ref=`refs/heads/${r.branch}`,sha=await resolveRef(path,ref);if(sha!==r.toSha||!repo.main)continue;
   try{await gitRun(path,"merge-base","--is-ancestor",sha,repo.main);await gitRun(path,"update-ref","-d",ref,sha);pruned.push(`${repo.project}/${r.branch}`);}catch{}}
  if(opts.weekly&&repo.size>50*1024**2){try{await gitRun(path,"gc","--prune=now");}catch(e){errors.push(`${repo.project}: ${String(e)}`);}}
 }return{errors,pruned};}finally{unlock();}
}

function agentFromBasic(store: Store, header: string | undefined) {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  return store.agentByToken(decoded.slice(decoded.indexOf(":") + 1));
}

export interface RepoInfo { project:string;main:string|null;size:number;warning:boolean;lastIntegration:any; branches:{name:string;sha:string;subject:string;author:string;date:string;ahead:number;behind:number;idle:boolean}[] }
export async function listRepos(dataDir:string,store?:Store):Promise<RepoInfo[]>{const root=`${dataDir}/repos`;if(!existsSync(root))return[];const result=[];for(const entry of readdirSync(root).filter(e=>PROJECT.test(e.slice(0,-4))&&e.endsWith(".git")).sort())result.push(await repoStatus(dataDir,entry.slice(0,-4),store));return result;}

/** Serves git over HTTP with agent tokens as the password. Repos are created on first use. */
export function mountGit(app: Hono, store: Store, dataDir: string, allowed: (agent: Agent, project: string) => boolean = () => true, notice: (message:string)=>void = () => {}, storage:()=>DiskState=()=>diskState(dataDir,store.dbPath)): void {
  const root = `${dataDir}/repos`;
  app.all("/git/*", async (c) => {
    const agent = agentFromBasic(store, c.req.header("authorization"));
    if (!agent) return new Response("authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="fleet"' } });

    const url = new URL(c.req.url);
    const m = /^\/git\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
    const project = m ? decodeURIComponent(m[1]) : "";
    if (!m || !PROJECT.test(project)) return c.json({ error: "bad project name" }, 400);
    if (c.req.header("x-fleet-mode")==="quarantine" || !allowed(agent, project)) return c.json({ error: "no access to this project" }, 403);
    const pushing = url.searchParams.get("service") === "git-receive-pack" || m[2]?.endsWith("/git-receive-pack") || c.req.header("content-type") === "application/x-git-receive-pack-request";
    if(pushing){const error=diskPolicy("push",storage());if(error){notice(error);return c.json({error},507);}}
    const unlock=c.req.method==="POST"&&pushing?await pushLock(root):()=>{};
    if(pushing){const error=diskPolicy("push",storage());if(error){unlock();notice(error);return c.json({error},507);}}
    try { await ensureRepo(root, project); } catch { unlock(); return c.json({ error: "could not create repository" }, 500); }

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: dataDir,
      GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${project}.git${m[2] ?? ""}`, REQUEST_METHOD: c.req.method, QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: c.req.header("content-type") ?? "", REMOTE_USER: agent.name, REMOTE_ADDR: "127.0.0.1",
    };
    const len = c.req.header("content-length");
    if (len) env.CONTENT_LENGTH = len;
    const enc = c.req.header("content-encoding");
    if (enc) env.HTTP_CONTENT_ENCODING = enc;
    const proto = c.req.header("git-protocol");
    if (proto) env.GIT_PROTOCOL = proto;

    const proc = Bun.spawn(["git", "http-backend"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    // Drain stderr to prevent a verbose hook from blocking the backend.
    void new Response(proc.stderr).text();
    void proc.exited.then(async()=>{try{if(pushing)await gitRun(`${root}/${project}.git`,"gc","--auto");}catch{}finally{unlock();}});
    const body = c.req.raw.body;
    if (body) {
      const reader = body.getReader();
      let received=0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received+=value.length;
          if(pushing&&received>DISK_LIMITS.push+1024**2){await reader.cancel();proc.kill();unlock();return c.json({error:"push request exceeds 101 MiB transport limit; use artifacts for large files"},413);}
          proc.stdin.write(value);
        }
      } catch { proc.kill();unlock();return c.json({error:"interrupted Git upload"},400); } finally {reader.releaseLock();}
    }
    await proc.stdin.end();

    // CGI output: header lines, a blank line, then the body. Read only until the headers are complete and stream
    // the rest straight through, so a large clone never sits in memory.
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let head = new Uint8Array(0);
    let end = -1, sep = 0;
    while (end < 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = new Uint8Array(head.length + value.length);
      next.set(head); next.set(value, head.length);
      head = next;
      for (let k = 0; k < head.length - 1; k++) {
        if (head[k] === 13 && head[k + 1] === 10 && head[k + 2] === 13 && head[k + 3] === 10) { end = k; sep = 4; break; }
        if (head[k] === 10 && head[k + 1] === 10) { end = k; sep = 2; break; }
      }
      if (head.length > 64 * 1024 && end < 0) break;
    }
    if (end < 0) return c.json({ error: "git backend produced no response" }, 502);
    const headers = new Headers();
    let status = 200;
    for (const line of new TextDecoder().decode(head.slice(0, end)).split(/\r?\n/)) {
      const k = line.indexOf(":");
      if (k < 0) continue;
      const name = line.slice(0, k).trim(), value = line.slice(k + 1).trim();
      if (name.toLowerCase() === "status") status = parseInt(value, 10) || 200;
      else headers.set(name, value);
    }
    const rest = head.slice(end + sep);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { if (rest.length) controller.enqueue(rest); },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      },
      cancel() { reader.cancel().catch(() => {}); proc.kill(); },
    });
    return new Response(stream, { status, headers });
  });
}
