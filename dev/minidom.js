'use strict';
/* Minimal DOM + Obsidian API stub, just enough to exercise PiChatView.headless. */

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach((x) => x && this.set.add(x)); this.el._cls = this.set; }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) { if (on === undefined) on = !this.set.has(c); on ? this.set.add(c) : this.set.delete(c); return on; }
  toString() { return [...this.set].join(' '); }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.style = {};
    this.classList = new ClassList(this);
    this._cls = this.classList.set;
    this._text = '';
    this._listeners = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] || null; }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }

  appendChild(c) { if (c && typeof c === 'object') { c.parentNode = this; this.children.push(c); } return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  setAttribute(k, v) {
    if (k === 'class') { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); this._cls = this.classList.set; return; }
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.classList.toString();
    return k in this.attrs ? this.attrs[k] : null;
  }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) { if (k === 'class') { this.classList.set = new Set(); this._cls = this.classList.set; } delete this.attrs[k]; }

  addClass(...c) { this.classList.add(...c); }
  removeClass(...c) { this.classList.remove(...c); }
  toggleClass(c, on) { return this.classList.toggle(c, on); }
  hasClass(c) { return this.classList.contains(c); }

  setText(t) { this._text = String(t); this.children = []; }
  empty() { this.children = []; this._text = ''; }
  detach() { this.remove(); }

  createEl(tag, opts) { return makeEl(tag, opts, this); }
  createDiv(opts) { return makeEl('div', opts, this); }
  createSpan(opts) { return makeEl('span', opts, this); }

  addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); }
  removeEventListener() {}
  dispatch(type, ev) { for (const fn of (this._listeners[type] || [])) fn(ev || {}); }

  /** Flat walk including self, matching the subset of selectors main.js uses. */
  _walk() {
    const out = [this];
    for (const c of this.children) out.push(...c._walk());
    return out;
  }
  _matches(sel) {
    // supports: ".a", ".a.b", "tag", "tag.cls", "a.internal-link"
    const rot = sel.trim().match(/^([a-zA-Z-]*)((?:\.[\w-]+)*)$/);
    if (!rot) return false;
    if (rot[1] && this.tagName !== rot[1].toUpperCase()) return false;
    for (const cls of rot[2].split('.').filter(Boolean)) if (!this.classList.contains(cls)) return false;
    return true;
  }
  querySelectorAll(sel) { return this._walk().filter((e) => e !== null && e._matches && e._matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    let n = this;
    while (n) { if (n._matches && n._matches(sel)) return n; n = n.parentNode; }
    return null;
  }
  focus() {}
}

function makeEl(tag, opts, parent) {
  const el = new El(tag);
  if (opts && typeof opts === 'object') {
    if (opts.cls) el.setAttribute('class', opts.cls);
    if (opts.text !== undefined) el.setText(opts.text);
    if (opts.attr) for (const k of Object.keys(opts.attr)) el.setAttribute(k, opts.attr[k]);
  }
  if (parent) parent.appendChild(el);
  return el;
}

const document = { createElement: (t) => new El(t) };

/* ---------------- obsidian API stubs ---------------- */

class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.contentEl = new El('div');
    this.app = global.__PI_APP__;
  }
}
class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  async loadData() { return global.__PI_DATA__ || {}; }
  async saveData(d) { global.__PI_SAVED__ = d; }
  registerView() {} addRibbonIcon() {} addCommand() {} addSettingTab() {} registerEvent() {}
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new El('div'); } }
class Modal { constructor(app) { this.app = app; this.contentEl = new El('div'); } open() {} close() {} }
class Setting {
  constructor(el) { this.el = el; }
  setName() { return this; } setDesc() { return this; }
  addText(cb) { cb({ setValue: () => ({ onChange: () => {} }), inputEl: new El('input') }); return this; }
  addTextArea(cb) { cb({ setValue: () => ({ onChange: () => {} }), inputEl: new El('textarea') }); return this; }
  addToggle(cb) { cb({ setValue: () => ({ onChange: () => {} }) }); return this; }
  addDropdown(cb) { const chain = { addOption: () => chain, setValue: () => ({ onChange: () => {} }) }; cb(chain); return this; }
}
const MarkdownRenderer = {
  render(app, md, el) { el.setText(md); },   // markdown → plain text is enough for assertions
};
const setIcon = () => {};
const Notice = class { constructor(m) { (global.__NOTICES__ || (global.__NOTICES__ = [])).push(String(m)); } };
const TFile = class {};
const WorkspaceLeaf = class {};

module.exports = {
  El, document,
  Plugin, ItemView, Notice, PluginSettingTab, Setting,
  MarkdownRenderer, setIcon, Modal, TFile, WorkspaceLeaf,
  obsidian: { Plugin, ItemView, Notice, PluginSettingTab, Setting, MarkdownRenderer, setIcon, Modal, TFile, WorkspaceLeaf },
};
