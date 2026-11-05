// Chromium HTTP is routed into Hono; no preview listener or port is opened.
import { createRequire } from 'node:module';
import { mkdirSync,mkdtempSync,writeFileSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApp } from '../src/app';
import { seedRepo,gitRun,repoStatus } from '../src/git';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_CORE??'/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const output=resolve(process.argv[2]??'artifacts/canonical-code');mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL??'chrome'}),checks:unknown[]=[];
const check=(ok:unknown,why:string)=>{if(!ok)throw Error(why);};
try{
 for(const theme of ['light','dark'])for(const width of [1440,400]){
  const {app,store,hub}=createApp(':memory:','preview-only',{hubOwner:'owner'});
  store.ensureProject('demo','default');const src=mkdtempSync(`${tmpdir()}/canonical-preview-`);await gitRun(src,'init','-b','main');
  const commit=async(name:string)=>{writeFileSync(`${src}/${name}`,name);await gitRun(src,'add','.');await gitRun(src,'-c','user.name=worker','-c','user.email=fixture@local','commit','-m',name);};
  await commit('Initial project');const {main}=await seedRepo(hub.dataDir,'demo',src);
  for(const[name,file]of [['worker/DEMO-1-recovery','Document recovery'],['reviewer/DEMO-2-checks','Add checks']]){await gitRun(src,'checkout','-B',name,main);await commit(file);await gitRun(`${hub.dataDir}/repos/demo.git`,'fetch',src,`${name}:refs/heads/${name}`);}
  const page=await browser.newPage({viewport:{width,height:1000},colorScheme:theme,...(theme==='light'&&width===1440?{recordVideo:{dir:output,size:{width:1440,height:1000}}}:{})});
  await page.addInitScript(()=>localStorage.setItem('fleet-tour-done','1'));
  const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));let free=7.5*1024**3;
  await page.route('**/*',async(route:any)=>{const req=route.request(),path=new URL(req.url()).pathname;
   if(path==='/api/events')return route.fulfill({status:200,contentType:'text/event-stream',body:': fixture\n\n'});
   // Only the banner's free-space measurement is a deterministic fixture; integration uses real Git.
   if(path==='/api/storage')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({free,repos:245760,artifacts:41943040,db:1048576})});
   const res=await app.fetch(new Request(req.url(),{method:req.method(),headers:req.headers(),body:['GET','HEAD'].includes(req.method())?undefined:req.postDataBuffer()}));await route.fulfill({status:res.status,headers:Object.fromEntries(res.headers),body:Buffer.from(await res.arrayBuffer())});
  });
  try{
   await page.goto('http://fleet.test/?token=preview-only#/code');await page.locator('#repo-disk').waitFor();
   check((await page.locator('#repo-disk').innerText()).includes('Pushes paused'),'low disk banner missing');
   const row=page.locator('#v-code .branch').filter({hasText:'worker/DEMO-1-recovery'});const go=row.getByRole('button',{name:'Integrate',exact:true});await go.waitFor();check(await go.isEnabled(),'ff branch not enabled');
   check(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'horizontal overflow');await page.screenshot({path:`${output}/${theme}-${width}-ready.png`,fullPage:true});
   await go.click();await page.waitForFunction(()=>document.getElementById('v-code')?.textContent?.includes('Last integration: worker/DEMO-1-recovery'));
   check((await repoStatus(hub.dataDir,'demo')).main!==main,'integration failed');const behind=page.locator('#v-code .branch').filter({hasText:'reviewer/DEMO-2-checks'}).getByRole('button',{name:'Integrate',exact:true});check(await behind.isDisabled(),'diverged branch enabled');check((await behind.getAttribute('title'))?.includes('Rebase'),'rebase explanation missing');
   check(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'horizontal overflow after integration');await page.screenshot({path:`${output}/${theme}-${width}-integrated.png`,fullPage:true});
   free=3.5*1024**3;await page.reload();await page.waitForFunction(()=>document.getElementById('repo-disk')?.textContent?.includes('Pushes and uploads paused'));await page.screenshot({path:`${output}/${theme}-${width}-disk-stop.png`,fullPage:true});check(!errors.length,errors.join('\n'));
   checks.push({theme,width,integration:'pass',divergedRefusal:'pass',pushOnlyDiskBanner:'pass',uploadDiskBanner:'pass',overflow:false,pageErrors:errors});
  }finally{const video=page.video();await page.close();if(video)renameSync(await video.path(),`${output}/canonical-code-demo.webm`);}
 }
 await Bun.write(`${output}/checks.json`,JSON.stringify(checks,null,2));console.log(JSON.stringify(checks));
}finally{await browser.close();}
