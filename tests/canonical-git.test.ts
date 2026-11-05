import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ensureRepo, seedRepo, integrate, repoStatus, maintainRepos } from '../src/git';
import { diskPolicy } from '../src/disk';
import { openStore } from '../src/store';
const dir=()=>mkdtempSync(`${tmpdir()}/canonical-`);
async function git(cwd:string,...args:string[]) { const p=Bun.spawn(['git','-c','user.name=test','-c','user.email=t@t',...args],{cwd,stdout:'pipe',stderr:'pipe',env:{...process.env,REMOTE_USER:args[0]==='push'?(args.at(-1)?.split('/')[0]??'alice'):'alice'}});const out=await new Response(p.stdout).text(),err=await new Response(p.stderr).text();if(await p.exited)throw Error(err);return out.trim(); }
async function fixture(){const data=dir(),src=dir(),store=openStore(':memory:');await git(src,'init','-b','main');writeFileSync(`${src}/base`,'base');await git(src,'add','.');await git(src,'commit','-m','base');await seedRepo(data,'demo',src);return{data,src,store};}
test('seed verifies canonical main, refuses reseeding, and creates an empty repo eagerly',async()=>{const{data,src}=await fixture();expect((await repoStatus(data,'demo')).main).toBe(await git(src,'rev-parse','main'));await expect(seedRepo(data,'demo',src)).rejects.toThrow('already');await ensureRepo(`${data}/repos`,'empty');expect((await repoStatus(data,'empty')).main).toBeNull();});
test('two agent branches require rebase after human ff integration, audited and CAS guarded',async()=>{const{data,src,store}=await fixture();const main=await git(src,'rev-parse','main');for(const agent of ['alice','bob']){await git(src,'checkout','-B',`${agent}/demo`,main);writeFileSync(`${src}/${agent}`,agent);await git(src,'add','.');await git(src,'commit','-m',agent);await git(src,'push',`${data}/repos/demo.git`,`${agent}/demo`);}const a=await integrate(data,store,'demo','alice/demo',main,'human');expect(a.toSha).not.toBe(main);await expect(integrate(data,store,'demo','bob/demo',main,'human')).rejects.toThrow('changed');await expect(integrate(data,store,'demo','bob/demo',a.toSha,'human')).rejects.toThrow('rebase');await git(src,'checkout','bob/demo');await git(src,'rebase','alice/demo');await git(src,'branch','bob/rebased');await git(src,'push',`${data}/repos/demo.git`,'bob/rebased');const b=await integrate(data,store,'demo','bob/rebased',a.toSha,'human');expect(store.listIntegrations('demo')).toHaveLength(2);expect((await repoStatus(data,'demo')).main).toBe(b.toSha);await expect(integrate(data,store,'demo','main',b.toSha,'human')).rejects.toThrow('branch');});
test('disk and independent budgets enforce exact boundaries',()=>{expect(diskPolicy('push',{free:8*1024**3,repos:0,artifacts:0,db:0})).toBeNull();expect(diskPolicy('push',{free:8*1024**3-1,repos:0,artifacts:0,db:0})).toContain('8 GiB');expect(diskPolicy('upload',{free:4*1024**3-1,repos:0,artifacts:0,db:0})).toContain('4 GiB');expect(diskPolicy('upload',{free:9*1024**3,repos:2*1024**3,artifacts:0,db:0},1)).toBeNull();expect(diskPolicy('upload',{free:9*1024**3,repos:0,artifacts:4*1024**3,db:0},1)).toContain('artifact');});
test('maintenance prunes only aged merged refs and fsck passes',async()=>{const{data,src,store}=await fixture();await git(src,'branch','alice/old');await git(src,'push',`${data}/repos/demo.git`,'alice/old');const sha=await git(src,'rev-parse','main');store.addIntegration({project:'demo',branch:'alice/old',fromSha:sha,toSha:sha,actor:'human',createdAt:Date.now()-31*86400000});const r=await maintainRepos(data,store,{weekly:true});expect(r.errors).toEqual([]);expect((await repoStatus(data,'demo')).branches.some(b=>b.name==='alice/old')).toBe(false);expect((await repoStatus(data,'demo')).main).toBe(sha);});

test('hook refuses own branch delete, tags, force, blob/push/project/total quota before accepting refs',async()=>{
 const{data,src}=await fixture(),repo=`${data}/repos/demo.git`;
 const push=async(...args:string[])=>{const p=Bun.spawn(['git','-C',src,'push',repo,...args],{env:{...process.env,REMOTE_USER:'alice'},stdout:'pipe',stderr:'pipe'});const err=await new Response(p.stderr).text();return{code:await p.exited,err};};
 await git(src,'checkout','-b','alice/task');writeFileSync(`${src}/small`,'new');await git(src,'add','.');await git(src,'commit','-m','task');expect((await push('alice/task')).code).toBe(0);
 expect((await push(':alice/task')).err).toContain('deletes');await git(src,'tag','test');expect((await push('test')).code).not.toBe(0);
 await git(src,'reset','--hard','HEAD~1');expect((await push('--force','alice/task')).err).toContain('force');
 writeFileSync(`${src}/large`,'x'.repeat(1000));await git(src,'add','.');await git(src,'commit','-m','large');
 for(const[key,value,reason]of [['maxBlobBytes','500','blob'],['maxPushBytes','500','push adds'],['maxProjectBytes','1','project repository'],['maxReposBytes','1','repositories']]){
  await git(repo,'config','fleet.'+key,value);expect((await push('HEAD:refs/heads/alice/quota')).err).toContain(reason);await git(repo,'config','--unset','fleet.'+key);
 }
 expect((await repoStatus(data,'demo')).branches.some(b=>b.name==='alice/quota')).toBe(false);
});

test('helper canonical identity survives resumed trusted turns and is absent in quarantine',async()=>{
 const{buildPrompt}=await import('../helper/fleet-helper');const cfg={project:'demo',branch:'alice/DEMO-1',base:'a'.repeat(40),workdir:'/allowed/worktree',hubUrl:'https://fleet.example',harness:'codex'} as any;
 const prompt=buildPrompt([],cfg,null);expect(prompt).toContain('Work in a worktree of the hub repo and push your branch to the hub');expect(prompt).toContain('main@'+'a'.repeat(40));expect(prompt).toContain('/allowed/worktree');expect(buildPrompt([],cfg,null,'quarantine')).not.toContain('/allowed/worktree');const existing={...cfg,project:undefined,codebases:[{project:'demo',main:'b'.repeat(40)}]};expect(buildPrompt([],existing,null)).toContain('has canonical main@'+'b'.repeat(40));expect(buildPrompt([],existing,null,'quarantine')).not.toContain('fleet.example/git');
});

test('migration copies tags and discards only the three obsolete staging refs',async()=>{
 const{src}=await fixture(),data=dir();await ensureRepo(`${data}/repos`,'demo');const repo=`${data}/repos/demo.git`;
 await git(src,'tag','-a','v1','-m','release');
 for(const name of ['codex-1/agen-3-4','codex-1/agen-5','codex-1/agen-7','codex-1/active'])await git(repo,'fetch',src,`main:refs/heads/${name}`);
 await seedRepo(data,'demo',src);const names=(await repoStatus(data,'demo')).branches.map(b=>b.name);expect(names).toEqual(expect.arrayContaining(['main','codex-1/active']));expect(names).toHaveLength(2);expect(await git(repo,'rev-parse','v1^{}')).toBe(await git(src,'rev-parse','main'));
});
