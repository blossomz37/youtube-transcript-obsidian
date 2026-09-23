import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const temp=await mkdtemp(join(tmpdir(),'youtube-notes-tests-'));
await build({entryPoints:[new URL('../src/main.js',import.meta.url).pathname],outfile:join(temp,'plugin.mjs'),bundle:true,platform:'node',format:'esm',loader:{'.md':'text'},alias:{obsidian:new URL('./obsidian-stub.mjs',import.meta.url).pathname}});
const {default:Plugin}=await import(pathToFileURL(join(temp,'plugin.mjs')));
test.after(()=>rm(temp,{recursive:true,force:true}));
const video={status:'ok',metadata:{video_id:'abcdefghijk',title:'Synthetic',source_url:'https://www.youtube.com/watch?v=abcdefghijk',duration_seconds:10},selected_track:{language_code:'en',is_generated:true},segments:[{start:0,text:'Original words.'}]};
const result={summary:'## Summary\nGenerated.',model:'test/model',usage:{cost:0.01},citations:[]};
async function setup(){
 const files=new Map(),bodies=new Map();let failSummary=false;
 const vault={getAbstractFileByPath:p=>files.get(p),getMarkdownFiles:()=>[...files.values()].filter(f=>f.extension==='md'),
 async createFolder(p){files.set(p,{path:p,children:[]});},
 async create(p,text){if(files.has(p))throw new Error('Already exists');if(failSummary&&p.endsWith('Summary.md'))throw new Error('Disk unavailable');const f={path:p,basename:p.split('/').at(-1).replace(/\.md$/,''),extension:'md'};files.set(p,f);bodies.set(p,text);return f;},
 async process(f,fn){bodies.set(f.path,fn(bodies.get(f.path)));}};
 const app={vault,secretStorage:{getSecret:()=> 'synthetic-key'},metadataCache:{getFileCache:()=>({frontmatter:{youtube_video_id:'abcdefghijk'}})},workspace:{getLeaf:()=>({openFile:async()=>{}})}};
 const plugin=new Plugin(app);await plugin.onload();plugin.summarize=async()=>result;
 plugin.openImport({video,sourcePath:'Original.md'});const modal=plugin.activeModal;
 return {plugin,modal,files,bodies,setFailSummary:v=>failSummary=v};
}
test('Both retains transcript on provider failure and retries without duplicating it',async()=>{
 const t=await setup();t.modal.existing=null;t.modal.mode='both';let calls=0;
 t.plugin.summarize=async()=>{if(++calls===1)throw new Error('Provider unavailable');return result;};
 await t.modal.run();assert.equal(t.files.size,2);assert.ok(t.modal.saved.transcript);assert.equal(t.modal.saved.summary,undefined);
 await t.modal.run();assert.equal(calls,2);assert.equal(t.files.size,3);assert.match(t.bodies.get(t.modal.saved.transcript),/Summary: \[\[/);
 assert.match(t.bodies.get(t.modal.saved.summary),/Transcript: \[\[/);
});
test('concurrent user edit is preserved while summary links to transcript',async()=>{
 const t=await setup();t.modal.existing=null;t.modal.mode='both';
 t.plugin.summarize=async()=>{t.bodies.set(t.modal.saved.transcript,'User-edited note');return result;};
 await t.modal.run();assert.equal(t.bodies.get(t.modal.saved.transcript),'User-edited note');assert.ok(t.modal.saved.summary);
});
test('failed note save retains generated answer and retry does not spend again',async()=>{
 const t=await setup();let calls=0;t.plugin.summarize=async()=>{calls++;return result;};t.setFailSummary(true);
 await t.modal.run();assert.equal(calls,1);assert.ok(t.modal.result);assert.equal(t.modal.saved.summary,undefined);
 t.setFailSummary(false);await t.modal.run();assert.equal(calls,1);assert.ok(t.modal.saved.summary);
});
test('duplicate detection prevents a paid request until user chooses another copy',async()=>{
 const t=await setup();t.modal.existing=null;t.modal.mode='both';await t.plugin.app.vault.create('Existing.md','Keep me');
 let calls=0;t.plugin.summarize=async()=>{calls++;return result;};await t.modal.run();assert.equal(calls,0);assert.ok(t.modal.duplicates);assert.equal(t.bodies.get('Existing.md'),'Keep me');
 t.modal.duplicateChoice=true;await t.modal.run();assert.equal(calls,1);assert.equal(t.bodies.get('Existing.md'),'Keep me');
});
test('cancellation prevents saving a returned summary but retains saved transcript',async()=>{
 const t=await setup();t.modal.existing=null;t.modal.mode='both';t.plugin.summarize=async()=>{t.modal.controller.abort();return result;};
 await t.modal.run();assert.ok(t.modal.saved.transcript);assert.equal(t.modal.saved.summary,undefined);assert.match(t.modal.status.textContent,/Stopped/);
});
test('summary-only failure can save transcript instead and finish without an AI retry',async()=>{
 const t=await setup();t.modal.existing=null;t.plugin.summarize=async()=>{throw new Error('Failure');};
 await t.modal.run();assert.ok(t.modal.recover);await t.modal.saveRecovery();assert.ok(t.modal.saved.transcript);
 assert.equal(t.modal.state,'success');assert.equal(t.modal.saved.summary,undefined);assert.equal(t.modal.recover,null);
});

function buttons(modal) {
 const labels=[];
 const walk=el=>{if(el.tag==='button')labels.push(el.textContent);for(const child of el.children||[])walk(child);};
 walk(modal.contentEl);return labels;
}
test('empty form has one create action, no recovery, and recovery handler safely does nothing',async()=>{
 const t=await setup();t.modal.forceClose();t.plugin.openImport();const modal=t.plugin.activeModal;
 assert.ok(buttons(modal).includes('Create notes'));assert.equal(modal.start.disabled,true);
 assert.equal(modal.recover,null);assert.equal(modal.canRecover(),false);
 await modal.saveRecovery();assert.equal(t.files.size,0);
 modal.url.value='https://www.youtube.com/watch?v=abcdefghijk';modal.url.oninput();assert.equal(modal.start.disabled,false);
});
test('progress removes create and recovery controls; completion offers explicit open actions',async()=>{
 const t=await setup();t.modal.existing=null;t.modal.mode='both';
 t.plugin.summarize=async()=>{assert.deepEqual(buttons(t.modal),['Stop summarizing']);return result;};
 await t.modal.run();assert.deepEqual(buttons(t.modal),['Open summary','Open transcript','Done']);
});
test('duplicate screen replaces form actions with short labels',async()=>{
 const t=await setup();t.modal.existing=null;await t.plugin.app.vault.create('Very long file name.md','Original');
 t.plugin.app.metadataCache.getFileCache=()=>({frontmatter:{youtube_video_id:'abcdefghijk',youtube_note:'summary'}});
 await t.modal.run();assert.deepEqual(buttons(t.modal),['Open summary','Create new summary','Back','Cancel']);
});
test('unexpected generation exception stays in technical details, and only relevant recovery exists',async()=>{
 const t=await setup();t.modal.existing=null;t.plugin.summarize=async()=>{throw new TypeError("Cannot read properties of undefined (reading 'folder')");};
 await t.modal.run();assert.doesNotMatch(t.modal.status.textContent,/undefined|properties/);
 assert.match(t.modal.errorDetail,/undefined/);assert.deepEqual(buttons(t.modal),['Retry summary','Save transcript instead','Cancel']);
});
test('close protects a generated but unsaved summary',async()=>{
 const t=await setup();t.setFailSummary(true);await t.modal.run();t.modal.close();
 assert.ok(t.modal.closePrompt);assert.equal(t.modal.closed,false);
 t.modal.closePrompt.close();assert.ok(t.modal.result);assert.equal(t.modal.closePrompt,null);
});
test('recovery save failure retries only the transcript without another AI request',async()=>{
 const t=await setup();t.modal.existing=null;let calls=0;
 t.plugin.summarize=async()=>{calls++;throw new Error('Provider unavailable');};
 await t.modal.run();const create=t.plugin.app.vault.create;let fail=true;
 t.plugin.app.vault.create=async(...args)=>{if(fail)throw new Error('Disk unavailable');return create(...args);};
 await t.modal.saveRecovery();assert.deepEqual(buttons(t.modal),['Retry saving transcript','Cancel']);
 fail=false;await t.modal.start.onclick();assert.equal(calls,1);assert.equal(t.modal.state,'success');assert.ok(t.modal.saved.transcript);
});
