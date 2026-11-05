import {test,expect} from 'bun:test';
import {headingIds,checkDocLinks} from '../scripts/check-doc-links';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
test('documentation checker resolves anchors, duplicates, HTML pictures and image budgets',()=>{
 const dir=mkdtempSync(tmpdir()+'/doc-links-');try{mkdirSync(dir+'/docs/media',{recursive:true});writeFileSync(dir+'/README.md','[valid](docs/configuration.md#network-and-tokens)\n<picture><img src="docs/media/demo.png"></picture>');writeFileSync(dir+'/docs/configuration.md','# Network and tokens');writeFileSync(dir+'/docs/operations.md','# Operations');writeFileSync(dir+'/CONTRIBUTING.md','# Contributing');writeFileSync(dir+'/docs/media/demo.png',Buffer.alloc(100));expect(checkDocLinks(dir).errors).toEqual([]);writeFileSync(dir+'/docs/media/demo.png',Buffer.alloc(600000));expect(checkDocLinks(dir).errors[0]).toContain('600 KB');writeFileSync(dir+'/README.md','[broken](docs/configuration.md#absent)\n[missing](absent.md)');expect(checkDocLinks(dir).errors).toHaveLength(2);expect([...headingIds('# First `word`\n# First `word`\n```\n# Not a heading\n```')]).toEqual(['first-word','first-word-1']);}finally{rmSync(dir,{recursive:true,force:true});}
});
