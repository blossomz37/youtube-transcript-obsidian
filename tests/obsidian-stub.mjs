export class Element {
 constructor(tag='div',opts={}){this.tag=tag;this.textContent=opts.text||'';this.children=[];this.value='';}
 createEl(tag,opts){const e=new Element(tag,opts);this.children.push(e);return e;}
 createDiv(opts){return this.createEl('div',opts);} setAttribute(){} addClass(){} focus(){}
 empty(){this.children=[];} setText(t){this.textContent=t;} remove(){this.removed=true;}
}
export class Plugin {
 constructor(app){this.app=app;} async loadData(){return null;} async saveData(data){this.persisted=data;}
 addRibbonIcon(){} addCommand(){} addSettingTab(){}
}
export class Modal {
 constructor(app){this.app=app;this.contentEl=new Element();} setTitle(t){this.title=t;}
 open(){this.onOpen?.();} close(){this.onClose?.();}
}
export class PluginSettingTab {constructor(app,plugin){this.app=app;this.plugin=plugin;this.containerEl=new Element();}}
class Control {
 setValue(v){this.value=v;return this;} setDisabled(v){this.disabled=v;return this;}
 addOptions(){return this;} onChange(fn){this.change=fn;return this;}
}
export class Setting {
 constructor(el){this.el=el;} setName(){return this;} setDesc(){return this;}
 addDropdown(fn){fn(new Control());return this;}
}
export class Notice {constructor(message){this.message=message;}}
export class FuzzySuggestModal extends Modal {}
export class TFolder {}
export class SecretComponent {}
export function addIcon() {}
