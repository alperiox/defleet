import { test,expect } from 'bun:test';
import { mkdtempSync,writeFileSync,readdirSync,readFileSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApp } from '../src/app';
import { seedRepo,repoStatus,gitRun } from '../src/git';
import { prepareWorktree } from '../shared/worktree';
const dir=()=>mkdtempSync(`${tmpdir()}/canonical-flow-`);
async function commit(path:string,name:string){writeFileSync(`${path}/${name}`,name);await gitRun(path,'add','.');await gitRun(path,'-c','user.name=fixture','-c','user.email=t@t','commit','-m',name);}
test('canonical hub: two agents fetch worktrees, push, human integrates, divergence needs new rebased branch',async()=>{
 const root=dir(),data=`${root}/data`,db=`${root}/fleet.db`,src=dir();const{app,store,hub}=createApp(db,'human',{dataDir:data,hubOwner:'owner'});
 const alice=store.addAgent({name:'alice',owner:'owner',device:'d',skills:[]}),bob=store.addAgent({name:'bob',owner:'owner',device:'d',skills:[]});store.ensureProject('demo','default');
 await gitRun(src,'init','-b','main');await commit(src,'base');const{main}=await seedRepo(data,'demo',src);
 // Separate process so synchronous worktree setup can use real Git HTTP without blocking the server.
 const code=`import {createApp} from ${JSON.stringify(resolve('src/app.ts'))};const {app}=createApp(process.env.TEST_DB,'human',{dataDir:process.env.TEST_DATA,hubOwner:'owner'});const s=Bun.serve({port:0,hostname:'127.0.0.1',fetch:app.fetch,idleTimeout:30});console.log(s.port);`;
 const server=Bun.spawn([process.execPath,'-e',code],{env:{...process.env,TEST_DB:db,TEST_DATA:data},stdout:'pipe',stderr:'pipe'});
 const reader=server.stdout.getReader();const first=await reader.read();const port=Number(new TextDecoder().decode(first.value).trim());expect(port).toBeGreaterThan(0);const url=`http://127.0.0.1:${port}`;
 const request=(path:string,token:string,body?:unknown)=>app.fetch(new Request('http://fixture'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined}));
 try{
  const a=prepareWorktree(dir(),'alice',url,alice.token,{project:'demo',branch:'alice/DEMO-1-one',base:main});
  const bRoot=dir(),b=prepareWorktree(bRoot,'bob',url,bob.token,{project:'demo',branch:'bob/DEMO-2-two',base:main});
  expect(readFileSync(`${a.dir}/base`,'utf8')).toBe('base');expect(readFileSync(`${b.dir}/base`,'utf8')).toBe('base');
  await commit(a.dir,'alice');await commit(b.dir,'bob');
  const push=async(path:string,token:string)=>{const p=Bun.spawn(['git','-C',path,'push','fleet','HEAD'],{env:{...process.env,FLEET_TOKEN:token,GIT_TERMINAL_PROMPT:'0'},stdout:'pipe',stderr:'pipe'});const err=await new Response(p.stderr).text();expect(await p.exited,err).toBe(0);};
  await push(a.dir,alice.token);await push(b.dir,bob.token);
  expect((await request('/api/repos/demo/integrate',alice.token,{branch:a.branch,expectedMain:main})).status).toBe(401);
  expect((await request('/api/repos/demo/integrate','human',{branch:a.branch,expectedMain:main})).status).toBe(200);
  const next=(await repoStatus(data,'demo')).main;
  const refused=await request('/api/repos/demo/integrate','human',{branch:b.branch,expectedMain:next});expect(refused.status).toBe(409);expect((await refused.json()).error).toContain('rebase');
  const fetcher=Bun.spawn(['git','-C',b.dir,'fetch','fleet'],{env:{...process.env,FLEET_TOKEN:bob.token},stdout:'pipe',stderr:'pipe'});await new Response(fetcher.stderr).text();expect(await fetcher.exited).toBe(0);await gitRun(b.dir,'-c','user.name=fixture','-c','user.email=t@t','rebase','refs/remotes/fleet/main');await gitRun(b.dir,'checkout','-b','bob/DEMO-2-rebased');await push(b.dir,bob.token);
  expect((await request('/api/repos/demo/integrate','human',{branch:'bob/DEMO-2-rebased',expectedMain:next})).status).toBe(200);
  expect(prepareWorktree(bRoot,'bob',url,bob.token,{project:'demo',branch:'bob/new-request',base:next!}).branch).toBe('bob/DEMO-2-rebased');
  writeFileSync(`${b.dir}/dirty`,'pending');expect(()=>prepareWorktree(bRoot,'bob',url,bob.token,{project:'demo',branch:'bob/new',base:next!})).toThrow('dirty');
  const guestWs=hub.createWorkspace('Guest');store.db.query("UPDATE workspaces SET visibility='private' WHERE id=?").run(guestWs.id);const guest=store.addAgent({name:'guest',owner:'owner',device:'d',skills:[],workspaceId:guestWs.id});store.grantProject(guest.id,'demo');
  const denied=await fetch(`${url}/git/demo.git/info/refs?service=git-upload-pack`,{headers:{Authorization:'Basic '+btoa('x:'+guest.token)}});expect(denied.status).toBe(403);
  const quarantine=await fetch(`${url}/git/demo.git/info/refs?service=git-upload-pack`,{headers:{Authorization:'Basic '+btoa('x:'+alice.token),'x-fleet-mode':'quarantine'}});expect(quarantine.status).toBe(403);
  const device=store.addDevice('fixture');store.touchDevice(device.id,{harnesses:[{id:'claude',label:'Claude',path:'/bin/claude'}],roots:[root]});
  const launched=await request(`/api/devices/${device.id}/launch`,'human',{name:'launch-agent',harness:'claude',dir:root,project:'demo'});expect(launched.status).toBe(200);const payload=(await launched.json()).request.payload;expect(payload.project).toBe('demo');expect(payload.base).toBe((await repoStatus(data,'demo')).main);expect(payload.branch).toStartWith('launch-agent/');
  expect(store.listIntegrations('demo')).toHaveLength(2);
  hub.humanCreateTask({title:'Work from canonical main',project:'demo',assignee:'alice'});
  const pulled=await request('/agent/pull',alice.token,{});expect((await pulled.json()).codebases[0].main).toBe((await repoStatus(data,'demo')).main);
  const quarantined=await app.fetch(new Request('http://fixture/agent/pull',{method:'POST',headers:{Authorization:'Bearer '+alice.token,'x-fleet-mode':'quarantine'},body:'{}'}));expect((await quarantined.json()).codebases).toBeUndefined();
 }finally{server.kill();await server.exited;reader.releaseLock();}
},30000);

test('local second-copy backup includes live SQLite, repos and artifacts; drill and retention work',async()=>{
 const root=dir(),data=`${root}/data`,db=`${root}/fleet.db`,dest=`${root}/backups`,src=dir();const{store}=createApp(db,'human',{dataDir:data});store.ensureProject('demo','default');await gitRun(src,'init','-b','main');await commit(src,'base');await seedRepo(data,'demo',src);writeFileSync(`${data}/artifacts/proof`,'artifact');
 mkdirSync(`${dest}/daily`,{recursive:true});mkdirSync(`${dest}/weekly`,{recursive:true});for(let i=0;i<10;i++)mkdirSync(`${dest}/daily/2000010${i}`);for(let i=0;i<5;i++)mkdirSync(`${dest}/weekly/2000-W0${i}`);
 const p=Bun.spawn(['sh','scripts/backup.sh',db,data,dest,'--drill'],{stdout:'pipe',stderr:'pipe'});const out=await new Response(p.stdout).text(),err=await new Response(p.stderr).text();expect(await p.exited,err).toBe(0);expect(out).toContain('Backup complete');expect(readdirSync(`${dest}/daily`)).toHaveLength(7);expect(readdirSync(`${dest}/weekly`)).toHaveLength(4);const latest=readdirSync(`${dest}/daily`).sort().at(-1)!;expect(readFileSync(`${dest}/daily/${latest}/artifacts/proof`,'utf8')).toBe('artifact');expect(readFileSync(`${dest}/daily/${latest}/main-shas.txt`,'utf8')).toContain(await gitRun(src,'rev-parse','main'));
},15000);

test('route disk guards return 507 without blocking reads and throttle room warning to once an hour',async()=>{
 let free=7*1024**3,artifacts=0;const{app,store,hub}=createApp(':memory:','human',{storage:()=>({free,artifacts,repos:0,db:0})});const a=store.addAgent({name:'worker',owner:'owner',device:'d',skills:[]});
 const auth={Authorization:'Basic '+btoa('x:'+a.token)},agent={Authorization:'Bearer '+a.token};
 const req=(path:string,method='GET',headers:any=auth,body?:string)=>app.fetch(new Request('http://fixture'+path,{method,headers,body}));
 expect((await req('/git/demo.git/info/refs?service=git-receive-pack')).status).toBe(507);expect((await req('/git/demo.git/info/refs?service=git-receive-pack')).status).toBe(507);expect((await req('/git/demo.git/info/refs?service=git-upload-pack')).status).toBe(200);
 expect((await req('/agent/artifacts?name=proof','POST',agent,'ok')).status).toBe(200);
 free=3*1024**3;expect((await req('/agent/artifacts?name=proof','POST',agent,'no')).status).toBe(507);expect((await req('/api/artifacts?name=proof','POST',{Authorization:'Bearer human'},'no')).status).toBe(507);
 const task=hub.humanCreateTask({title:'Quota report',project:'demo',assignee:'worker'});hub.claim(store.agentById(a.id)!,task.key);expect(()=>hub.attachReport(store.agentById(a.id)!,task.key,'proof','report')).toThrow('4 GiB');
 const room=store.db.query("SELECT text FROM messages WHERE text LIKE 'Hub disk guard:%'").all();expect(room).toHaveLength(1);
 free=10*1024**3;artifacts=4*1024**3;expect((await req('/agent/artifacts?name=proof','POST',agent,'no')).status).toBe(507);
});
