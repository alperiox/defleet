// Copied into bare repos by ensureRepo; no imports from the deployed source tree.
import { readdirSync, lstatSync } from 'node:fs';
const run=(...args:string[])=>{const r=Bun.spawnSync(['git',...args]);if(r.exitCode)throw Error(r.stderr.toString());return r.stdout.toString().trim();};
const fail=(s:string):never=>{console.error('fleet: '+s);process.exit(1);};
const bytes=(p:string):number=>{const s=lstatSync(p);return s.isSymbolicLink()?0:s.isDirectory()?readdirSync(p).reduce((n,e)=>n+bytes(p+'/'+e),0):s.size;};
const limit=(key:string,otherwise:number)=>{try{return Math.min(Number(run('config','--get','fleet.'+key))||otherwise,otherwise);}catch{return otherwise;}};
const zero='0'.repeat(40), user=process.env.REMOTE_USER;
if(!user)fail('pushes require an authenticated agent');
const input=await Bun.stdin.text();let total=0;const seen=new Set<string>();
for(const line of input.trim().split('\n')){
 const [old,next,ref]=line.split(' ');
 if(!ref?.startsWith(`refs/heads/${user}/`)||ref===`refs/heads/${user}/`)fail(`${user} may only push to refs/heads/${user}/<branch>`);
 if(next===zero)fail('branch deletes are human-only');
 if(old!==zero&&Bun.spawnSync(['git','merge-base','--is-ancestor',old,next]).exitCode)fail('force pushes refused; use a new branch after rebasing');
 const objects=run('rev-list','--objects',next,'--not','--all').split('\n').filter(Boolean).map(l=>l.split(' ')[0]).filter(id=>!seen.has(id));
 for(const id of objects)seen.add(id);
 if(objects.length){const p=Bun.spawnSync(['git','cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],{stdin:Buffer.from(objects.join('\n')+'\n')});if(p.exitCode)fail('could not inspect incoming objects');for(const l of p.stdout.toString().trim().split('\n')){const[,type,size]=l.split(' ');const n=Number(size);if(!Number.isFinite(n))fail('invalid incoming object');if(type==='blob'&&n>limit('maxBlobBytes',25*1024**2))fail('blob exceeds 25 MB; upload recordings and datasets as task artifacts');total+=n;}}
}
if(total>limit('maxPushBytes',100*1024**2))fail('push adds more than 100 MB; upload large data as task artifacts');
if(bytes('.')+total>limit('maxProjectBytes',500*1024**2))fail('project repository exceeds 500 MB budget');
if(bytes('..')+total>limit('maxReposBytes',2*1024**3))fail('repositories exceed 2 GiB budget');
