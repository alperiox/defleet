// bun scripts/shoot-readme.ts [output-dir] [--phone-preview <dir>]
// Demo-only data. Every browser request is handled in-process; no listening socket or live hub.
import { chromium } from 'playwright-core';
import { mkdirSync,mkdtempSync,writeFileSync,statSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApp } from '../src/app';
import { seedRepo } from '../src/git';
const gitRun=async(cwd:string,...args:string[])=>{const p=Bun.spawn(['git','-C',cwd,'-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{stdout:'pipe',stderr:'pipe'});const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);if(await p.exited)throw Error(`Demo git ${args.join(' ')}: ${err||out}`);return out.trim();};
const out=resolve(process.argv[2]??'docs/media'),phoneAt=process.argv.indexOf('--phone-preview');mkdirSync(out,{recursive:true});
const phone=phoneAt>=0?resolve(process.argv[phoneAt+1]):null;if(phone)mkdirSync(phone,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{channel:process.env.PLAYWRIGHT_CHANNEL??'chrome'})});
const outputs:{file:string;bytes:number}[]=[];
try{
 for(const theme of ['light','dark'] as const){
  const {app,hub,store}=createApp(':memory:','demo-preview',{hubOwner:'you'});
  const src=mkdtempSync(`${tmpdir()}/readme-source-`);
  const made=store.addAgent({name:'builder',owner:'you',device:'workstation',skills:['implementation']});const builder=store.agentById(made.id)!;
  const reviewer=store.agentById(store.addAgent({name:'reviewer',owner:'you',device:'laptop',skills:['review']}).id)!;
  store.touchAgent(builder.id);store.touchAgent(reviewer.id);
  const task=hub.humanCreateTask({title:'Ship a reliable health-check endpoint',project:'demo',description:'Add a small health endpoint and a test, with a short recovery checklist.',acceptance:'The endpoint responds, the test passes, and the evidence is attached.'});hub.claim(builder,task.id);hub.postStatus(builder,task.id,'in_progress','Endpoint and tests are ready. Checking rollout details.');
  hub.humanCreateTask({title:'Add a compact activity summary',project:'demo',description:'An idea to review when the current release is complete.',backlog:true});
  hub.humanCreateTask({title:'Review the endpoint test coverage',project:'demo',assignee:'reviewer'});
  hub.askHuman(builder,{kind:'decision',text:'The health check passes. Should I enable it for a small group first, or roll it out to everyone?',taskId:task.id});
  hub.askHuman(reviewer,{kind:'approval',text:'The recovery checklist is ready for your review before we call the release complete.',taskId:task.id});
  hub.humanDm('builder','Please verify the change and attach a short recovery checklist.');hub.say(builder,'dm:human','The endpoint test passes. I am checking the rollout plan before proceeding.');
  hub.humanSay('Use this room for the release plan. Please keep decisions on the task.');hub.say(reviewer,'room','I will review the coverage while builder checks recovery.');
  const kb=hub.proposeKnowledge(builder,{kind:'how-to',title:'Check service health after a rollout',body:'Run the endpoint check, inspect the current error rate, then confirm the recovery checklist before widening the rollout.',verify:'Run the health-check test and confirm the current checklist.',project:'demo',sources:[{kind:'task',ref:task.key}]});
  hub.humanKnowledge('default','create',undefined,{kind:'fact',title:'Every release needs recovery evidence',body:'Attach the checks used to verify recovery to the release task.',verify:'Read the current release checklist.',sources:[]});
  const device=store.addDevice('workstation');store.touchDevice(device.id,{hostname:'demo-workstation',roots:['/work/demo'],harnesses:[{id:'claude',label:'Claude Code',path:'/tools/claude'},{id:'codex',label:'Codex',path:'/tools/codex'}],usage:{claude:{source:'Harness-reported usage (demo)',observedAt:Date.now(),windows:[{label:'Current session',window:'session',usedFraction:0.28,resetsAt:Date.now()+3*3600000},{label:'Weekly usage',window:'weekly',usedFraction:0.46,resetsAt:Date.now()+4*86400000}]},codex:{source:'Local session totals (demo)',observedAt:Date.now(),windows:[],totals:{tokens:18400,sessions:3,prompts:12,note:'Illustrative local totals'}}}});
  await gitRun(src,'init','-b','main');writeFileSync(`${src}/README.md`,'# Demo service\n');await gitRun(src,'add','-f','.');await gitRun(src,'-c','user.name=Demo','-c','user.email=demo','commit','-m','Start the service');await seedRepo(hub.dataDir,'demo',src);await gitRun(src,'checkout','-b','builder/DEMO-1-health');writeFileSync(`${src}/health.txt`,'Health check and recovery checklist\n');await gitRun(src,'add','-f','.');await gitRun(src,'-c','user.name=Demo','-c','user.email=demo','commit','-m','Add health-check evidence');await gitRun(`${hub.dataDir}/repos/demo.git`,'fetch',src,'builder/DEMO-1-health:refs/heads/builder/DEMO-1-health');
  const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:theme,reducedMotion:'reduce',locale:'en-US'});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('fleet-tour-done','1'));
  await page.route('**/*',async route=>{const r=route.request();if(new URL(r.url()).pathname==='/api/events')return route.fulfill({status:200,contentType:'text/event-stream',body:': demo\n\n'});const res=await app.fetch(new Request(r.url(),{method:r.method(),headers:r.headers(),body:['GET','HEAD'].includes(r.method())?undefined:r.postDataBuffer()}));await route.fulfill({status:res.status,headers:Object.fromEntries(res.headers),body:Buffer.from(await res.arrayBuffer())});});
  const visit=async(hash:string)=>{await page.goto('http://demo.invalid/?token=demo-preview#/'+hash);await page.locator('#login').waitFor({state:'hidden'});};
  const shot=async(name:string)=>{await page.evaluate(()=>document.fonts.ready);if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error(`${name}: horizontal overflow`);const file=`${out}/${name}-${theme}.png`;await page.screenshot({path:file,fullPage:true});const bytes=statSync(file).size;if(bytes>=600000)throw Error(`${file} exceeds 600 KB`);outputs.push({file,bytes});};
  try{
   await visit('inbox');await page.locator('#reqBox .card.req').first().waitFor();await shot('hero');
   if(phone){await page.setViewportSize({width:400,height:1000});await page.screenshot({path:`${phone}/hero-phone-${theme}.png`,fullPage:false});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('phone overflow');await page.setViewportSize({width:1440,height:1000});}
   await page.locator('#reqBox .card.req').filter({hasText:'small group'}).getByRole('button',{name:'Discuss',exact:true}).click();await page.locator('#thread-discuss .card.req').waitFor();await shot('discuss');
   await visit('tasks');await page.locator('#chips').getByRole('button',{name:'backlog',exact:true}).click();await page.getByText('Add a compact activity summary',{exact:true}).waitFor();await shot('tasks');
   hub.setActivity(builder,'working','Checking the rollout plan','demo-turn');await visit('dm/builder');await page.locator('#stop-header:not([hidden])').waitFor();await page.locator('#stop-header').click();await page.locator('#stop-question').fill('What have you found so far? Check state before continuing.');await shot('stop');
   await visit('room');await page.locator('#attachmentInput').setInputFiles({name:'recovery-checklist.txt',mimeType:'text/plain',buffer:Buffer.from('Check endpoint, errors and recovery evidence.\n')});await page.waitForFunction(()=>document.querySelectorAll('#attachmentList .attachment-chip[data-status="ready"]').length===1);await page.locator('#compose').fill('Please use this checklist for the release.');await shot('attachments');
   await visit('usage');await page.locator('.usage-device').first().waitFor();await shot('usage');
   await visit('knowledge');await page.locator(`[data-kb-id="${kb.id}"]`).click();await page.locator('#kb-body').waitFor();await shot('knowledge');
   await visit('code');await page.locator('#repo-disk').waitFor();await page.locator('#v-code .branch').filter({hasText:'builder/DEMO-1-health'}).getByRole('button',{name:'Integrate',exact:true}).waitFor();await shot('code');
   await visit('inbox');await page.keyboard.press(':');await page.locator('#palette-input').fill(':tab');await page.locator('#palette-results').waitFor();await shot('palette');
   if(errors.length)throw Error(errors.join('\n'));
  }finally{await page.close();rmSync(src,{recursive:true,force:true});rmSync(hub.dataDir,{recursive:true,force:true});store.db.close();}
 }
 console.log(JSON.stringify(outputs,null,2));
}finally{await browser.close();}
