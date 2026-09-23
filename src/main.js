import { Plugin, Modal, PluginSettingTab, Setting, Notice, FuzzySuggestModal, SecretComponent, addIcon } from 'obsidian';
import { loadVideo, extractVideoId } from './retrieval.mjs';
import { summarizeVideo } from './summary.mjs';
import defaultPrompt from '../prompts/summary.md';
import glossary from '../prompts/glossaries/general.md';
import { desktopFetch } from './transport.mjs';
import { defaults, folderPath, validateSettings, noteStem, transcriptNote, summaryNote, parseTranscriptNote, composePrompt, ensureFolder, availablePaths } from './core.mjs';

const explain = error => {
  const messages={
    SOURCE_TOO_LARGE:'This transcript exceeds the current 300,000-character limit. Nothing was sent. Shorter videos are supported; automatic chunking is not available yet.',
    TIMEOUT:'The request timed out. You can retry; a processed request may still be charged.',
    CANCELLED:'Cancelled. Any notes already saved remain in the vault.'};
  return messages[error.code] || error.message || 'The operation failed.';
};

export default class YouTubeNotes extends Plugin {
  async onload() {
    const saved=await this.loadData();
    // Only persist recognized settings; credentials never live in data.json.
    this.settings=Object.fromEntries(Object.keys(defaults).map(k=>[k,saved?.[k] ?? defaults[k]]));
    if(!this.settings.prompt) this.settings.prompt=defaultPrompt;
    this.controllers=new Set(); this.activeModal=null;
    addIcon('youtube-transcript-notes', '<rect x="8" y="20" width="84" height="60" rx="14" fill="none" stroke="currentColor" stroke-width="7"/><path d="M42 35 L65 50 L42 65 Z" fill="currentColor"/>');
    this.addRibbonIcon('youtube-transcript-notes','Import YouTube notes',()=>this.openImport());
    this.addCommand({id:'import',name:'Import transcript or summary',callback:()=>this.openImport()});
    this.addCommand({id:'summarize-note',name:'Summarize current transcript note',editorCallback:(editor,view)=>{
      try {
        const fm=this.app.metadataCache.getFileCache(view.file)?.frontmatter;
        const video=parseTranscriptNote(editor.getValue(),fm);
        this.openImport({video,sourcePath:view.file.path});
      } catch(e) {new Notice(explain(e));}
    }});
    this.addSettingTab(new NotesSettings(this.app,this));
  }
  onunload() {for(const c of this.controllers)c.abort();this.activeModal?.forceClose();}
  async saveSettings() {await this.saveData(Object.fromEntries(Object.keys(defaults).map(k=>[k,this.settings[k]])));}
  openImport(existing) {
    if(this.activeModal){new Notice('Finish or close the current import first.');return;}
    this.activeModal=new ImportModal(this,existing);this.activeModal.open();
  }
  key(settings=this.settings) {
    const key=this.app.secretStorage.getSecret(settings.secretName);
    if(!key) throw new Error('Choose or create an OpenRouter API secret in YouTube Transcript Notes settings.');
    return key;
  }
  async summarize(video,settings,signal,test=false) {
    validateSettings(settings,true);
    const prompt=composePrompt(settings,glossary)+(test?'\n\nCONNECTION TEST: Respond in at most two sentences. If web verification is enabled, check the spelling of JavaScript using an official source and cite it.':'');
    return summarizeVideo(video,{apiKey:this.key(settings),model:settings.model,prompt,
      maxTokens:settings.maxTokens,temperature:settings.temperature,webSearch:settings.webSearch,
      searchResults:settings.searchResults,fetch:desktopFetch,signal});
  }
}

class FolderPicker extends FuzzySuggestModal {
  constructor(app,onChoose){super(app);this.onChoose=onChoose;this.setPlaceholder('Choose a vault folder');}
  getItems(){return this.app.vault.getAllFolders(false);}
  getItemText(folder){return folder.path;}
  onChooseItem(folder){this.onChoose(folder.path);}
}

class ImportModal extends Modal {
  constructor(plugin, existing) {
    super(plugin.app);
    this.plugin = plugin;
    this.existing = existing;
    this.video = existing?.video;
    this.source = this.video?.metadata.source_url || '';
    this.mode = existing ? 'summary' : plugin.settings.mode;
    this.settings = { ...plugin.settings, mode: this.mode };
    this.state = 'ready';
    this.saved = {};
    this.busy = false;
    this.closed = false;
    this.duplicateChoice = false;
  }
  onOpen() {
    this.setTitle(this.existing ? 'Create summary from transcript' : 'Create notes from YouTube');
    this.contentEl.addClass('ytn-modal');
    this.status = this.contentEl.createDiv({ cls: 'ytn-status', attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
    this.body = this.contentEl.createDiv();
    this.render();
  }
  onClose() {
    this.closed = true;
    this.controller?.abort();
    if (this.plugin.activeModal === this) this.plugin.activeModal = null;
    this.contentEl.empty();
  }
  forceClose() { super.close(); }
  close() {
    if (this.closePrompt) return;
    if (this.busy || (this.result && !this.saved.summary)) {
      const prompt = new Modal(this.app);
      this.closePrompt = prompt;
      prompt.contentEl.addClass('ytn-modal');
      prompt.setTitle(this.busy ? 'Stop and close?' : 'Discard unsaved summary?');
      prompt.contentEl.createEl('p', { text: this.busy
        ? 'This stops the current request. Any notes already saved stay in your vault. Processed AI usage may still be charged.'
        : 'The summary has not been saved. Closing discards it; generating it again may incur another charge. Saved notes stay in your vault.' });
      const actions = prompt.contentEl.createDiv({ cls: 'ytn-actions' });
      this.button(actions, this.busy ? 'Keep working' : 'Keep summary', () => prompt.close(), true);
      this.button(actions, this.busy ? 'Stop and close' : 'Discard and close', () => { prompt.close(); this.controller?.abort(); this.forceClose(); });
      prompt.onClose = () => { this.closePrompt = null; };
      prompt.open();
      return;
    }
    this.forceClose();
  }
  button(parent, label, action, primary = false) {
    const button = parent.createEl('button', { text: label, cls: primary ? 'mod-cta' : '' });
    button.onclick = action;
    return button;
  }
  get createLabel() { return { transcript: 'Create transcript', summary: 'Create summary', both: 'Create notes' }[this.mode]; }
  validSource() { try { extractVideoId(this.source); return true; } catch { return false; } }
  transition(state, message = '') {
    this.state = state;
    this.message = message;
    if (!this.closed) {
      this.render();
      if (state !== 'ready') this.body.querySelector?.('button:not([disabled])')?.focus();
    }
  }
  render() {
    if (this.closed) return;
    const el = this.body;
    el.empty();
    this.status.setText(this.message || '');
    this.start = null;
    this.recover = null;
    this.duplicates = null;
    if (this.state === 'ready') {
      const label = el.createEl('label', { text: 'YouTube link', cls: 'ytn-label' });
      this.url = el.createEl('input', { type: 'url', placeholder: 'Paste a YouTube link', cls: 'ytn-url' });
      this.url.id = 'ytn-video-url';
      label.setAttribute('for', this.url.id);
      this.url.value = this.source;
      this.url.disabled = !!this.existing;
      this.url.oninput = () => { this.source = this.url.value; this.start.disabled = !this.validSource(); };
      this.url.onkeydown = e => { if (e.key === 'Enter' && this.validSource()) { e.preventDefault(); this.run(); } };
      new Setting(el).setName('Create').addDropdown(d => {
        d.addOptions({ transcript: 'Transcript', summary: 'Summary', both: 'Both' }).setValue(this.mode).setDisabled(!!this.existing);
        d.onChange(v => { this.mode = v; this.render(); });
      });
      el.createEl('p', { cls: 'ytn-hint', text: this.mode === 'both' ? 'Creates two linked notes.'
        : this.mode === 'summary' ? 'Creates one AI summary note.' : 'Creates one transcript note. No AI request is made.' });
      const destination = el.createDiv({ cls: 'ytn-context-row' });
      destination.createEl('span', { text: `Save to: ${this.settings.folder}` });
      this.button(destination, 'Change', () => new FolderPicker(this.app, async path => {
        this.settings.folder = path;
        this.plugin.settings.folder = path;
        try { await this.plugin.saveSettings(); } catch { new Notice('The folder will be used for this import, but the preference could not be saved.'); }
        this.render();
      }).open());
      if (this.mode !== 'transcript') {
        const context = el.createDiv({ cls: 'ytn-context-row' });
        const model = this.settings.model === 'openai/gpt-5.6-luna' ? 'Luna'
          : this.settings.model === 'openai/gpt-6-astra' ? 'Astra' : this.settings.model;
        context.createEl('span', { text: `${model} · ${this.settings.detail === 'detailed' ? 'Detailed notes' : 'Brief overview'} · Web verification ${this.settings.webSearch ? 'on' : 'off'}` });
        this.button(context, 'Settings', () => this.editSettings());
        el.createEl('p', { cls: 'ytn-hint', text: `AI summaries send this video’s text to OpenRouter. Usage charges apply.${this.settings.webSearch ? ' Web searches cost extra.' : ''}` });
        const info = el.createEl('details', { cls: 'ytn-details' });
        info.createEl('summary', { text: 'Data and costs' });
        info.createEl('p', { text: 'Only this video’s metadata and transcript are sent to OpenRouter and the selected model provider. Web verification also uses a search provider. Other vault notes are not sent. Failed or stopped requests may still incur charges.' });
      }
      const actions = el.createDiv({ cls: 'ytn-actions' });
      this.start = this.button(actions, this.createLabel, () => this.run(), true);
      this.start.disabled = !this.validSource();
      this.button(actions, 'Cancel', () => this.close());
      if (this.existing) this.start.focus(); else this.url.focus();
      return;
    }
    if (this.video?.metadata.title) el.createEl('p', { text: this.video.metadata.title, cls: 'ytn-video-title' });
    if (this.state === 'duplicates') {
      this.duplicates = el.createDiv({ cls: 'ytn-note-list' });
      for (const file of this.matches) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const kind = fm?.youtube_note === 'transcript' ? 'transcript' : fm?.youtube_note === 'summary' ? 'summary' : 'note';
        const row = this.duplicates.createDiv({ cls: 'ytn-note-row' });
        const details = row.createDiv();
        details.createEl('strong', { text: kind[0].toUpperCase() + kind.slice(1) });
        details.createEl('p', { text: file.path, cls: 'ytn-hint' });
        this.button(row, `Open ${kind}`, () => this.openNote(file.path), kind === this.mode || (this.mode === 'both' && kind === 'summary'));
        if (kind === 'transcript' && this.mode === 'summary') this.button(row, 'Create summary from this transcript', () => this.useTranscript(file));
      }
      el.createEl('p', { cls: 'ytn-hint', text: 'Existing notes will stay unchanged.' + (this.mode !== 'transcript' ? ' Creating a new summary uses AI and incurs charges.' : '') });
      const actions = el.createDiv({ cls: 'ytn-actions' });
      this.button(actions, this.createLabel.replace('Create ', 'Create new '), () => { this.duplicateChoice = true; this.run(); });
      this.button(actions, 'Back', () => this.transition('ready'));
      this.button(actions, 'Cancel', () => this.close());
      return;
    }
    if (this.busy) {
      if (this.saved.transcript) el.createEl('p', { text: 'Your transcript is saved and will be kept if you stop.', cls: 'ytn-hint' });
      else if (this.state === 'summarizing') el.createEl('p', { text: 'Closing or stopping ends this request. Processed AI usage may still be charged.', cls: 'ytn-hint' });
      const actions = el.createDiv({ cls: 'ytn-actions' });
      const stop = this.button(actions, this.state === 'summarizing' ? 'Stop summarizing' : 'Cancel import', () => {
        this.controller?.abort(); stop.disabled = true; stop.setText('Stopping…');
      });
      // Vault writes cannot be cancelled once dispatched.
      stop.disabled = this.state === 'saving';
      return;
    }
    const actions = el.createDiv({ cls: 'ytn-actions' });
    if (this.state === 'success') {
      if (this.saved.summary) this.button(actions, 'Open summary', () => this.openNote(this.saved.summary), true);
      if (this.saved.transcript) this.button(actions, 'Open transcript', () => this.openNote(this.saved.transcript), !this.saved.summary);
      this.button(actions, 'Done', () => this.close());
      if (this.result) el.createEl('p', { cls: 'ytn-hint', text: `Model: ${this.result.model} · Reported cost: ${this.result.usage.cost === undefined ? 'not returned' : '$' + this.result.usage.cost.toFixed(5)}` });
      if (this.warning) el.createEl('p', { cls: 'ytn-hint', text: this.warning });
      return;
    }
    // Failure/cancellation actions are determined by what actually exists.
    if (this.failurePhase === 'setup') {
      this.button(actions, 'Back to form', () => this.transition('ready'), true);
      if (this.mode !== 'transcript') this.button(actions, 'Settings', () => this.editSettings());
    } else {
      const retry = this.recoveryPending ? 'Retry saving transcript' : this.result ? 'Retry saving' : this.failurePhase === 'summary' ? 'Retry summary' : 'Try again';
      this.start = this.button(actions, retry, () => this.recoveryPending ? this.saveRecovery() : this.run(), true);
      if (this.failurePhase === 'fetch') this.button(actions, 'Edit link', () => this.transition('ready'));
    }
    if (this.saved.transcript) this.button(actions, 'Open transcript', () => this.openNote(this.saved.transcript));
    else if (this.canRecover() && !this.recoveryPending) this.recover = this.button(actions, 'Save transcript instead', () => this.saveRecovery());
    this.button(actions, this.saved.transcript ? 'Done' : 'Cancel', () => this.close());
    if (this.errorDetail) {
      const details = el.createEl('details', { cls: 'ytn-details' });
      details.createEl('summary', { text: 'Technical details' });
      details.createEl('p', { text: this.errorDetail });
    }
  }
  editSettings() {
    const modal = new Modal(this.app);
    modal.setTitle('YouTube Transcript Notes settings');
    const tab = new NotesSettings(this.app, this.plugin);
    tab.containerEl = modal.contentEl;
    modal.onOpen = () => tab.display();
    modal.onClose = () => {
      // A changed configuration starts a fresh attempt; existing notes stay put.
      this.settings = { ...this.plugin.settings, mode: this.mode };
      this.transition('ready');
    };
    modal.open();
  }
  async openNote(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) { new Notice('This note was moved or deleted. Check the vault file list.'); return; }
    if (this.result && !this.saved.summary) { new Notice('Save the pending summary before opening another note, or close this dialog to discard it.'); return; }
    try { await this.app.workspace.getLeaf(false).openFile(file); this.close(); }
    catch { new Notice('The note could not be opened. It is still saved in your vault.'); }
  }
  async useTranscript(file) {
    if (this.busy) return;
    try {
      // Prefer current editor text so unsaved caption corrections are included.
      let content;
      this.app.workspace.iterateAllLeaves?.(leaf => {
        if (leaf.view.file?.path === file.path && leaf.view.editor) content = leaf.view.editor.getValue();
      });
      if (content === undefined) content = await this.app.vault.read(file);
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      this.video = parseTranscriptNote(content, fm);
      this.existing = { video: this.video, sourcePath: file.path };
      this.duplicateChoice = true;
      await this.run();
    } catch (error) { this.failurePhase = 'setup'; this.transition('error', explain(error)); }
  }
  canRecover() {
    return !this.busy && ['error', 'cancelled'].includes(this.state) && !!this.video?.segments?.length
      && !this.saved.transcript && !this.existing && !this.result;
  }
  async saveRecovery() {
    if (!this.canRecover()) return;
    this.recoveryPending = true;
    this.busy = true;
    this.transition('saving', 'Saving transcript…');
    try {
      await ensureFolder(this.app.vault, this.settings.folder);
      this.paths = availablePaths(this.app.vault, this.settings.folder, noteStem(this.video));
      this.originalTranscript = transcriptNote(this.video);
      const file = await this.app.vault.create(this.paths.transcript, this.originalTranscript);
      this.saved.transcript = file.path;
      this.busy = false;
      this.transition('success', `Transcript saved in ${this.settings.folder}. No summary was created.`);
    } catch (error) {
      this.busy = false; this.failurePhase = 'save'; this.errorDetail = String(error.message || 'Unknown error');
      this.transition('error', 'The transcript could not be saved. Check the destination folder and try again.');
    }
  }
  async run() {
    if (this.busy || this.closed || this.state === 'success') return;
    this.busy = true;
    this.controller = new AbortController();
    this.plugin.controllers.add(this.controller);
    const signal = this.controller.signal;
    this.errorDetail = null;
    try {
      this.failurePhase = 'setup';
      this.settings = { ...this.settings, mode: this.mode, folder: folderPath(this.settings.folder) };
      const id = extractVideoId(this.source);
      const fingerprint = JSON.stringify(this.settings);
      if (this.resultFingerprint !== fingerprint) this.result = null;
      this.resultFingerprint = fingerprint;
      if ((this.attemptedId && this.attemptedId !== id) || (this.video && this.video.metadata.video_id !== id)) {
        this.video = null; this.saved = {}; this.result = null; this.paths = null; this.duplicateChoice = false;
      }
      this.attemptedId = id;
      this.matches = (this.app.vault.getFolderByPath(this.settings.folder)?.children || []).filter(f => f.extension === 'md' && this.app.metadataCache.getFileCache(f)?.frontmatter?.youtube_video_id === id);
      if (this.matches.length && !this.duplicateChoice && !this.existing && !this.saved.transcript) {
        this.busy = false;
        this.transition('duplicates', 'This video is already in the destination folder.');
        return;
      }
      validateSettings(this.settings, this.mode !== 'transcript');
      if (this.mode !== 'transcript') this.plugin.key(this.settings);
      this.failurePhase = 'fetch';
      if (!this.video) {
        this.transition('fetching', 'Getting video details and captions…');
        this.video = await loadVideo(id, { language: this.settings.language || undefined, fetch: desktopFetch, signal });
      }
      if (this.video.status !== 'ok') { this.video = null; throw new Error('YouTube has no available captions for this video. Try another public video.'); }
      signal.throwIfAborted();
      this.failurePhase = 'save';
      this.transition('saving', 'Preparing notes…');
      await ensureFolder(this.app.vault, this.settings.folder);
      this.paths = this.paths || availablePaths(this.app.vault, this.settings.folder, noteStem(this.video));
      if (this.mode !== 'summary' && !this.saved.transcript) {
        signal.throwIfAborted();
        this.originalTranscript = transcriptNote(this.video);
        const file = await this.app.vault.create(this.paths.transcript, this.originalTranscript);
        this.saved.transcript = file.path;
      }
      if (this.mode !== 'transcript') {
        if (!this.result) {
          this.failurePhase = 'summary';
          this.transition('summarizing', this.saved.transcript ? 'Transcript saved. Creating summary…' : 'Creating summary…');
          this.result = await this.plugin.summarize(this.video, this.settings, signal);
        }
        signal.throwIfAborted();
        this.failurePhase = 'save';
        this.transition('saving', 'Saving summary…');
        if (!this.saved.summary) {
          const sourcePath = this.existing?.sourcePath || this.saved.transcript;
          const file = await this.app.vault.create(this.paths.summary, summaryNote(this.video, this.result, sourcePath, this.settings));
          this.saved.summary = file.path;
        }
        if (this.saved.transcript) {
          const transcript = this.app.vault.getAbstractFileByPath(this.saved.transcript);
          if (transcript) {
            try { await this.app.vault.process(transcript, content => content === this.originalTranscript
              ? content.replace('## Video description', `Summary: [[${this.saved.summary.replace(/\.md$/, '')}]]\n\n## Video description`) : content); }
            catch { this.warning = 'Both notes are saved, but the link back to the summary could not be added.'; }
          }
        }
      }
      this.plugin.settings.mode = this.mode;
      try { await this.plugin.saveSettings(); } catch { this.warning = 'Notes are saved, but the output preference could not be remembered.'; }
      this.busy = false;
      const count = Object.keys(this.saved).length;
      this.transition('success', `${count === 2 ? 'Two notes' : this.saved.summary ? 'Summary' : 'Transcript'} saved in ${this.settings.folder}.`);
    } catch (error) {
      this.busy = false;
      this.errorDetail = String(error.message || 'Unknown error');
      let message;
      if (signal.aborted) message = this.saved.transcript ? 'Stopped. Your transcript is saved.' : 'Stopped. No notes were saved.';
      else if (this.failurePhase === 'setup') message = explain(error);
      else if (this.result) message = 'Your summary is ready, but could not be saved. Check the destination folder and retry saving.';
      else if (this.failurePhase === 'summary') message = this.saved.transcript
        ? 'Your transcript is saved. The summary could not be created.' : 'The summary could not be created. You can still save the transcript.';
      else if (this.failurePhase === 'fetch') message = error.code ? explain(error) : error.message === 'YouTube has no available captions for this video. Try another public video.' ? error.message : 'Captions could not be retrieved. Check the link and try again.';
      else message = 'The note could not be saved. Check the destination folder and try again.';
      this.transition(signal.aborted ? 'cancelled' : 'error', message);
    } finally {
      this.plugin.controllers.delete(this.controller);
      this.busy = false;
    }
  }
}

class NotesSettings extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display(){
    const el=this.containerEl;el.empty();el.addClass('ytn-settings');const s=this.plugin.settings;
    const save=()=>this.plugin.saveSettings().catch(()=>new Notice('Could not save plugin settings.'));
    el.createEl('h2',{text:'YouTube Transcript Notes'});
    new Setting(el).setName('Destination folder').setDesc('Inside this vault. A new folder is created on import.').addText(t=>{t.setValue(s.folder).onChange(v=>{s.folder=v;save();});this.folderInput=t;}).addButton(b=>b.setButtonText('Browse').onClick(()=>new FolderPicker(this.app,p=>{s.folder=p;this.folderInput.setValue(p);save();}).open()));
    new Setting(el).setName('Caption language').setDesc('Blank prefers English, then available captions. Use en, es, etc. No automatic translation.').addText(t=>t.setValue(s.language).onChange(v=>{s.language=v.trim();save();}));
    new Setting(el).setName('OpenRouter API key').setDesc('Choose or create a vault-local secret. Only its name is stored in plugin settings.').addComponent(e=>new SecretComponent(this.app,e).setValue(s.secretName).onChange(v=>{s.secretName=v;save();}));
    new Setting(el).setName('Model').setDesc('OpenRouter model ID. Luna is the economical default; Astra is a more expensive alternative.').addText(t=>t.setValue(s.model).onChange(v=>{s.model=v.trim();save();}));
    new Setting(el).setName('Maximum output tokens').setDesc('Includes model reasoning where applicable. A ceiling, not a requested answer length.').addText(t=>t.setValue(String(s.maxTokens)).onChange(v=>{s.maxTokens=Number(v);save();}));
    new Setting(el).setName('Temperature').setDesc('Blank uses the provider default. Some models do not support an explicit temperature.').addText(t=>t.setPlaceholder('Provider default').setValue(s.temperature===null?'':String(s.temperature)).onChange(v=>{s.temperature=v.trim()===''?null:Number(v);save();}));
    new Setting(el).setName('Summary detail').addDropdown(d=>d.addOptions({brief:'Brief overview',detailed:'Detailed notes'}).setValue(s.detail).onChange(v=>{s.detail=v;save();}));
    new Setting(el).setName('Web verification').setDesc('Optional fact and spelling checks in a separate cited section. Uses OpenRouter’s Exa search integration; additional charges apply. Original transcript stays intact.').addToggle(t=>t.setValue(s.webSearch).onChange(v=>{s.webSearch=v;save();}));
    new Setting(el).setName('Maximum search results').setDesc('1–5. This bounds retrieved results, not total dollar cost or verification completeness.').addText(t=>t.setValue(String(s.searchResults)).onChange(v=>{s.searchResults=Number(v);save();}));
    new Setting(el).setName('Test settings').setDesc('Makes one small paid request with these settings, including search if enabled.').addButton(b=>b.setButtonText('Test settings').onClick(async()=>{
      b.setDisabled(true);const c=new AbortController();this.plugin.controllers.add(c);const started=Date.now();
      this.testResult.setText('Testing…');
      try{const result=await this.plugin.summarize({metadata:{title:'Connection test',description:'Synthetic test of summary configuration.'},segments:[{start:0,text:'JavaScript is a programming language. This is a settings test, not a video.'}]},{...s},c.signal,true);
        this.testResult.setText(`Connected: ${result.model}\n${((Date.now()-started)/1000).toFixed(1)} seconds · Reported cost: ${result.usage.cost===undefined?'not returned':'$'+result.usage.cost.toFixed(5)}\n${s.webSearch?`${result.citations.length} web sources returned. This does not guarantee every claim was verified.`:'Web search off.'}`);
      }catch(e){this.testResult.setText(explain(e));}finally{this.plugin.controllers.delete(c);b.setDisabled(false);}
    }));
    this.testResult=el.createDiv({cls:'ytn-test-result',attr:{role:'status','aria-live':'polite'}});
    new Setting(el).setName('Summary prompt').setDesc('Changes save automatically. Detail and web-verification instructions are appended to this prompt.').addButton(b=>b.setButtonText('Reset to default').onClick(()=>{
      const modal=new Modal(this.app);modal.setTitle('Reset summary prompt?');modal.contentEl.createEl('p',{text:'This replaces your customized prompt with the bundled default.'});
      const yes=modal.contentEl.createEl('button',{text:'Reset prompt',cls:'mod-warning'});yes.onclick=()=>{s.prompt=defaultPrompt;save();modal.close();this.display();};modal.open();
    }));
    new Setting(el).setClass('ytn-prompt').addTextArea(t=>t.setValue(s.prompt).onChange(v=>{s.prompt=v;save();}));
  }
}
