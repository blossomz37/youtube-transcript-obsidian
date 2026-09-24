import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, folderPath, validateSettings, availablePaths, ensureFolder, transcriptNote, parseTranscriptNote, summaryNote, composePrompt, noteStem } from '../src/core.mjs';
import { desktopFetch } from '../src/transport.mjs';
const video={metadata:{video_id:'abcdefghijk',title:'A: title / [[bad]]',source_url:'https://www.youtube.com/watch?v=abcdefghijk',channel_name:'Test',description:'Description',duration_seconds:4000},selected_track:{language_code:'en',is_generated:true},segments:[{start:0,text:'Original caption.'},{start:3601.2,text:'Later caption.'}]};
const fm={youtube_note:'transcript',youtube_video_id:'abcdefghijk',title:'Synthetic',caption_language:'en',captions:'auto-generated'};
test('vault paths reject traversal and hidden config directories',()=>{
 for(const p of ['','/tmp','../notes','.obsidian/plugins','notes/../other','notes//x','C:\\notes','notes/.hidden'])assert.throws(()=>folderPath(p));
 assert.equal(folderPath('Notes/YouTube/'),'Notes/YouTube');
 assert.doesNotMatch(noteStem(video),/[:/\[\]]/);
});
test('transcript-only does not require AI settings; paid settings validated before work',()=>{
 const s={...defaults,prompt:''};validateSettings(s,false);assert.throws(()=>validateSettings(s,true));
 for(const change of [{maxTokens:0},{temperature:NaN},{searchResults:6},{model:''}])assert.throws(()=>validateSettings({...s,prompt:'Prompt',...change},true));
 validateSettings({...s,prompt:'Prompt',temperature:null});
});
test('long timestamp transcript round trip preserves edits, rejects unparsed text instead of discarding',()=>{
 const note=transcriptNote(video).replace('Original caption.','User correction.');
 const parsed=parseTranscriptNote(note,fm);
 assert.equal(parsed.segments[0].text,'User correction.');assert.equal(parsed.segments[1].start,3601);
 assert.equal(parsed.metadata.description,'Description');
 assert.throws(()=>parseTranscriptNote(note+'\nUnstamped paragraph',fm));
 assert.throws(()=>parseTranscriptNote(note,{...fm,youtube_note:'summary'}));
 assert.throws(()=>parseTranscriptNote(note.replace('[1:00:01]','[1:99:01]'),fm));
});
test('duplicate files select a new pair even when only one companion exists',()=>{
 const vault={getAbstractFileByPath:p=>p==='Notes/example - Summary.md'?{}:null};
 assert.deepEqual(availablePaths(vault,'Notes','example'),{transcript:'Notes/example 2 - Transcript.md',summary:'Notes/example 2 - Summary.md'});
});
test('folder creation checks file conflicts and only creates missing parents',async()=>{
 const entries=new Map([['Notes',{children:[]}]]);const created=[];
 const vault={getAbstractFileByPath:p=>entries.get(p),createFolder:async p=>{created.push(p);entries.set(p,{children:[]});}};
 await ensureFolder(vault,'Notes/YouTube');assert.deepEqual(created,['Notes/YouTube']);
 entries.set('blocked',{});await assert.rejects(ensureFolder(vault,'blocked/child'));
});
test('summary records model, cost, requested search and real returned sources',()=>{
 const note=summaryNote(video,{model:'model/id',usage:{cost:0.01},citations:[],summary:'## Summary\nText'},'Notes/source.md',defaults);
 assert.match(note,/model: "model\/id"/);assert.match(note,/web_sources_returned: 0/);assert.match(note,/\[\[Notes\/source\]\]/);assert.doesNotMatch(note,/api.key/i);
});
test('summary body starts with a YouTube embed with or without a transcript link',()=>{
 const result={model:'model/id',usage:{},citations:[],summary:'## Summary\nText'};
 for(const path of [null,'Notes/source.md']) {
  const note=summaryNote(video,result,path,defaults);
  assert.ok(note.startsWith('---\n'));
  const body=note.split('\n---\n\n')[1];
  assert.equal(body, '![](https://www.youtube.com/watch?v=abcdefghijk)\n\n'
    +(path?'Transcript: [[Notes/source]]\n\n':'')+result.summary+'\n');
 }
});
test('web and detailed overrides preserve a separate evidence boundary',()=>{
 const p=composePrompt({...defaults,prompt:'Source only.',webSearch:true,detail:'detailed'},'Name spelling');
 assert.match(p,/WEB VERIFICATION OVERRIDE/);assert.match(p,/separate "## Web verification"/);assert.match(p,/every substantive chapter/);
 assert.doesNotMatch(composePrompt({...defaults,prompt:'Source only.'},''),/WEB VERIFICATION OVERRIDE/);
});
test('desktop transport refuses off-provider destinations and credentials',async()=>{
 for(const url of ['http://youtube.com','https://openrouter.ai.evil.test','https://key@openrouter.ai','https://localhost','https://youtube.com:444'])await assert.rejects(desktopFetch(url));
 const c=new AbortController();c.abort();await assert.rejects(desktopFetch('https://openrouter.ai/api/v1/models',{signal:c.signal}));
});
