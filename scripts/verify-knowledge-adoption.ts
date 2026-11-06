// Chromium -> Hono in process. No listener or live workspace data.
import {chromium} from 'playwright-core';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from '../src/app';
const output=resolve(process.argv[2]??'artifacts/knowledge-adoption');mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL??'chrome'}),checks:unknown[]=[];
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
try{for(const theme of ['light','dark'] as const)for(const width of [1440,400]){
 const{app,hub,store}=createApp(':memory:','preview-only',{hubOwner:'owner'});const made=store.addAgent({name:'worker',owner:'owner',device:'demo',skills:[]}),agent=store.agentById(made.id)!;
 const task=hub.humanCreateTask({title:'Verify clean service setup',project:'demo',description:'Check setup in a clean folder and record the reusable steps.',acceptance:'The setup check passes and its result is attached.'});hub.claim(agent,task.id);hub.attachEvidence(agent,task.id,{kind:'test',ref:'Clean setup passed'});hub.complete(agent,task.id);
 const page=await browser.newPage({viewport:{width,height:1000},colorScheme:theme,reducedMotion:'reduce'}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>localStorage.setItem('fleet-tour-done','1'));
 await page.route('**/*',async route=>{const r=route.request();if(new URL(r.url()).pathname==='/api/events')return route.fulfill({status:200,contentType:'text/event-stream',body:': demo\n\n'});const res=await app.fetch(new Request(r.url(),{method:r.method(),headers:r.headers(),body:['GET','HEAD'].includes(r.method())?undefined:r.postDataBuffer()}));await route.fulfill({status:res.status,headers:Object.fromEntries(res.headers),body:Buffer.from(await res.arrayBuffer())});});
 const visit=async(hash:string)=>{await page.goto('http://fleet.test/?token=preview-only#/'+hash);await page.locator('#login').waitFor({state:'hidden'});};
 const shot=async(name:string)=>{check(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'sideways scroll');await page.screenshot({path:`${output}/${theme}-${width}-${name}.png`,fullPage:name==='suggestion'});};
 try{
  await visit('knowledge');await page.waitForFunction(()=>document.getElementById('kb-list')?.textContent?.includes('Proposals appear here'));const empty=await page.locator('#kb-list').innerText();check(empty.includes('approve them before other agents can read them'),'approval guidance missing');check(empty.includes('Suggest notes from this task'),'empty-state creation guidance missing');await shot('empty');
  await visit('task/'+task.key);const suggest=page.getByRole('button',{name:'Suggest notes from this task',exact:true});await suggest.waitFor();check(await suggest.isEnabled(),'finished task suggestion disabled');await suggest.click();await page.getByText('Asked worker to propose notes. Review them in Knowledge before approving.',{exact:true}).waitFor();check(store.dmsWithHuman().at(-1)?.text.includes('human approval'),'suggestion did not send human DM');check(hub.searchKnowledge(agent,{}).entries.length===0,'button created knowledge automatically');await shot('suggestion');
  const entry=hub.proposeKnowledge(agent,{kind:'how-to',title:'Verify setup from a clean worktree',body:'Start from canonical main in a clean worktree, install the locked dependencies, then run the setup check before changing local configuration.',verify:'Repeat the setup check in a fresh worktree.',project:'demo',sources:[{kind:'task',ref:task.key}]});
  await visit('knowledge');await page.locator(`[data-kb-id="${entry.id}"]`).waitFor();const nav=page.locator('#nav button.item').filter({hasText:'Knowledge'});check((await nav.innerText()).includes('Proposed 1'),'Proposed nav count missing');check(!hub.searchKnowledge(agent,{}).entries.length,'proposal leaked before approval');
  if(width===400)await page.locator('#burger').click();await shot('proposed-badge');if(width===400)await page.locator('#burger').click();
  await page.locator(`[data-kb-id="${entry.id}"]`).click();await page.locator('#kb-approve').click();await page.waitForFunction(()=>document.getElementById('kb-editor-status')?.textContent?.includes('Approved'));check(hub.searchKnowledge(agent,{}).entries.length===1,'human approval did not publish');check(await nav.locator('.badge').count()===0,'Proposed badge not cleared');await page.locator('[data-kb-filter="approved"]').click();await shot('approved');
  hub.humanStatus(task.id,'backlog');hub.humanRelease(task.id,agent.id);hub.humanStatus(task.id,'done');await visit('task/'+task.key);check(await page.getByRole('button',{name:'Suggest notes from this task',exact:true}).isDisabled(),'private task suggestion enabled');check(!errors.length,errors.join('\n'));
  checks.push({theme,width,emptyGuidance:'pass',explicitSuggestionDm:'pass',noAutomaticNote:'pass',proposedBadge:'pass',approvalGate:'pass',privateRefusal:'pass',overflow:false,pageErrors:errors});
 }finally{await page.close();}
}
 await Bun.write(`${output}/checks.json`,JSON.stringify(checks,null,2));console.log(JSON.stringify(checks));
}finally{await browser.close();}
