import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { projectWorktree, underRoots } from './paths';
export interface CanonicalWork {project:string;branch:string;base:string}
/** Never resets an existing checkout. A resumed agent keeps its clean task branch and recorded base. */
export function prepareWorktree(root:string,name:string,hubUrl:string,token:string,work:CanonicalWork):{dir:string;branch:string;base:string}{
 if(!/^[a-f0-9]{40}$/.test(work.base)||!work.branch.startsWith(name+'/')||work.branch.includes('..')||!/^[-a-zA-Z0-9._/]+$/.test(work.branch))throw Error('invalid canonical worktree metadata');
 const dir=projectWorktree(root,work.project,name),repo=join(dirname(dir),'.repo.git');
 const checkPath=(p:string)=>{const allowed=realpathSync(root);if(!underRoots(p,[root]))throw Error('canonical worktree path escapes allowed root');let current=root;for(const part of p.slice(root.length).split('/').filter(Boolean)){current=join(current,part);if(!existsSync(current))mkdirSync(current);if(!underRoots(realpathSync(current),[allowed]))throw Error('canonical worktree path escapes allowed root');}};
 checkPath(dirname(dir));
 const env={...process.env,FLEET_TOKEN:token,GIT_TERMINAL_PROMPT:'0'};
 const git=(cwd:string,...args:string[])=>{const p=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',env});if(p.status)throw Error((p.stderr||p.stdout||'git failed').trim());return p.stdout.trim();};
 const url=new URL(hubUrl);url.pathname=`/git/${work.project}.git`;url.search='';url.hash='';url.username='';url.password='';
 if(!existsSync(repo))git(root,'init','--bare',repo);checkPath(repo);
 git(repo,'config','--replace-all',`credential.${new URL(hubUrl).origin}.helper`,'');
 git(repo,'config','--add',`credential.${new URL(hubUrl).origin}.helper`,'!f() { printf "%s\\n" "username=agent" "password=$FLEET_TOKEN"; }; f');
 git(repo,'config','remote.fleet.url',url.toString());
 git(repo,'config','remote.fleet.fetch','+refs/heads/*:refs/remotes/fleet/*');
 git(repo,'fetch','fleet','+refs/heads/*:refs/remotes/fleet/*');
 if(existsSync(dir)){
  checkPath(dir);if(git(dir,'status','--porcelain'))throw Error('existing worktree is dirty; commit or move it before launch');
  if(realpathSync(resolve(dir,git(dir,'rev-parse','--git-common-dir')))!==realpathSync(repo))throw Error('existing worktree belongs to another repository');
  const branch=git(dir,'symbolic-ref','--short','HEAD');if(!branch.startsWith(name+'/'))throw Error('existing worktree is not on this agent’s branch');
  return{dir,branch,base:git(dir,'merge-base','HEAD','refs/remotes/fleet/main')};
 }
 const base=git(repo,'rev-parse','refs/remotes/fleet/main');if(base!==work.base)throw Error('canonical main changed since launch was requested; launch again');
 git(repo,'worktree','add','-b',work.branch,dir,'refs/remotes/fleet/main');return{dir,branch:work.branch,base};
}
