// bun scripts/check-doc-links.ts [tree] — public entry docs only; no network requests.
import { existsSync,readFileSync,statSync } from 'node:fs';
import { dirname,resolve,relative } from 'node:path';
export function headingIds(markdown:string):Set<string>{
 const counts=new Map<string,number>(),ids=new Set<string>();
 const text=markdown.replace(/```[\s\S]*?```/g,'');
 for(const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)){
  const slug=match[1].toLowerCase().replace(/<[^>]*>/g,'').replace(/[^\p{L}\p{N}_\-\s]/gu,'').replace(/\s/g,'-');
  const count=counts.get(slug)??0;counts.set(slug,count+1);ids.add(count?`${slug}-${count}`:slug);
 }
 for(const m of text.matchAll(/\bid=["']([^"']+)["']/g))ids.add(m[1]);return ids;
}
export function checkDocLinks(root:string):{checked:number;images:number;errors:string[]}{
 const errors:string[]=[],start=['README.md','CONTRIBUTING.md','docs/configuration.md','docs/operations.md'];let checked=0,images=0;
 for(const file of start){const path=resolve(root,file);if(!existsSync(path)){errors.push(`missing document: ${file}`);continue;}const text=readFileSync(path,'utf8').replace(/```[\s\S]*?```/g,'');
  const targets=[...text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(m=>m[1]);
  for(const m of text.matchAll(/\b(?:src|srcset|href)=["']([^"']+)["']/g))targets.push(m[1]);
  for(const raw of targets){if(/^(https?:|mailto:|data:)/i.test(raw))continue;checked++;const [part,fragment]=raw.replace(/^<|>$/g,'').split('#');const target=part?resolve(dirname(path),decodeURIComponent(part)):path;
   if(!existsSync(target)){errors.push(`${file}: missing ${raw}`);continue;}
   if(fragment&&target.endsWith('.md')&&!headingIds(readFileSync(target,'utf8')).has(decodeURIComponent(fragment)))errors.push(`${file}: missing anchor ${raw}`);
   if(/\/docs\/media\/.*\.png$/.test(target)){images++;if(statSync(target).size>=600000)errors.push(`${relative(root,target)} exceeds 600 KB`);}
  }
 }
 return{checked,images,errors};
}
if(import.meta.main){const result=checkDocLinks(resolve(process.argv[2]??'.'));console.log(JSON.stringify(result,null,2));if(result.errors.length)process.exit(1);}
