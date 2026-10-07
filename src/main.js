'use strict';

/*
 * Pi Agent — Obsidian plugin that embeds the Pi coding agent (pi kernel).
 * No build step: this file is loaded directly by Obsidian (CommonJS, desktop only).
 *
 * Positioning (v1): Obsidian 内的本地优先 Pi 前端。
 *   1) 会话与历史留在本地：会话索引存在 data.json（可读 JSON），真正的对话历史由 pi
 *      自己保存在 ~/.pi/agent/sessions/，用 --session-id 续接，本插件不重造存储层。
 *   2) 只做前端，不做内核：不注入 prompt、不做模型路由、不代理网络、不读密钥。
 *   3) 不碰 Vault：除用户显式要求外，插件只在 Vault 中读写笔记，不在 Vault 里建私有数据库。
 *
 * Backend wiring: spawns the `pi` CLI with `--mode json`, parses its newline-delimited
 * JSON event stream, and renders a chat UI with streaming text/thinking, grouped tool
 * cards, unified diffs, sessions and settings.
 *
 * pi event reference: docs/json.md (`session` / `message_start|update|end` / `turn_end` /
 * `tool_execution_start|update|end` / `agent_end` / `agent_settled`).
 */

const obsidian = require('obsidian');
const {
  Plugin, ItemView, Notice, PluginSettingTab, Setting,
  MarkdownRenderer, setIcon, Modal,
} = obsidian;
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');

const VIEW_TYPE_PI = 'pi-agent-view';

/** data.json schema version; bump to force a one-time conversation migration. */
const DATA_VERSION = 5;

/**
 * Study mode is fully isolated from daily coding use:
 *   - separate config dir  (own AGENTS.md + skills)
 *   - separate session dir (own history)
 *   - separate conversation list in the panel
 * so study usage never costs the daily pi any context or tokens.
 */
// Resolved relative to this file. When bundling, dev/build.js inlines this module's
// source in place of this assignment so the shipped main.js is self-contained.
const studyProfile = require('./study-profile.js');

/** Tool names that should get a diff-style preview in their card. */
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'patch', 'apply_patch']);

const DEFAULT_SETTINGS = {
  backend: 'pi',                 // pi | claude | codex | custom
  piBin: 'pi',
  claudeBin: 'claude',
  codexBin: 'codex',
  customCommand: '',
  cwd: 'vault',                  // vault | custom
  customCwd: '',
  provider: '',                  // 留空=用 pi 自身默认(provider 改名也不受影响)
  model: '',                     // 留空=用 pi 自身默认
  thinking: 'medium',
  allowedTools: 'read,write,edit,bash',
  requireApproval: false,        // confirm before each run
  appendSystemPrompt: '',
  extraPath: '',
  maxHistory: 0,                 // 0 = 全量回放(pi 本来就带完整 context)
  showThinking: true,

  /* ---- 模式：code=日常编程（用你的 ~/.pi/agent） / study=学习（隔离 profile） ---- */
  mode: 'study',
  // 学习 profile 目录。留空 => <vault>/.obsidian/<STUDY_PROFILE_DIRNAME>。放在 .obsidian 下是
  // 为了性能隔离：让日常 pi 的 AGENTS.md / skills 扫描永远碰不到学习人格。
  studyDir: '',
  studyModel: '',                // 留空=继承 pi 默认模型
  studyThinking: 'high',         // 学习需要更深推理
  studyCwd: '',                  // 留空=整个 vault
  studySkills: true,
  studyProfileSetUp: false,

  /* ---- 学习人格配置（开源泛化：任意学科可用，不再硬编码考研） ---- */
  studyPreset: studyProfile.DEFAULT_PRESET,   // general | kaoyan408 | language | programming
  studyLanguage: '',             // '' = 跟随预设；否则 zh | en
  studyGoal: '',                 // 留空 = 用预设的目标文案
  studyNoteRoots: [],            // [{path, desc}] 学习笔记所在目录
  studyMistakeBook: '',          // 错题本路径
  studyTemplate: '',             // 错题笔记模板路径
  studyDailyLog: '',             // 每日/周期性日志目录
  studyStatusField: '',          // 掌握度字段名，默认 status
  studyStatusValues: [],         // 掌握度取值，从弱到强
};

/* ------------------------------ helpers ------------------------------ */

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Wrap a vault path in quotes when it contains characters the shell/CLI would split on. */
function quoteRef(p) {
  return /[\s"'\\$`()]/.test(p) ? '"' + String(p).replace(/(["\\])/g, '\\$1') + '"' : p;
}

function lineDiff(oldStr, newStr) {
  const A = String(oldStr).split('\n');
  const B = String(newStr).split('\n');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['-', A[i]]); i++; }
    else { out.push(['+', B[j]]); j++; }
  }
  while (i < n) out.push(['-', A[i++]]);
  while (j < m) out.push(['+', B[j++]]);
  return out;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** pi tool results arrive as { content: [{type:'text', text}] } (or a bare string). */
function resultToText(res) {
  if (res == null) return '';
  if (typeof res === 'string') return res;
  if (Array.isArray(res.content)) {
    return res.content.map((c) => (c && typeof c.text === 'string') ? c.text : '').join('\n');
  }
  if (typeof res.text === 'string') return res.text;
  try { return JSON.stringify(res, null, 2); } catch (e) { return String(res); }
}

/** Trailing-edge throttle: collapses many streaming updates into one DOM pass. */
function throttle(fn, ms) {
  let timer = null, lastArgs = null;
  return function throttled(...args) {
    lastArgs = args;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const a = lastArgs; lastArgs = null;
      fn.apply(this, a);
    }, ms);
  };
}

/* --------------------------- data migration --------------------------- */

/**
 * v3 data stored tool calls as top-level `{role:'tool'}` messages mixed into the
 * transcript, and persisted live DOM references (`_el`, `_card`, …) into data.json.
 * Normalize to `{role:'user'|'assistant'}` where tools live on the assistant message.
 * v5 adds `mode` ('code' | 'study'); pre-v5 conversations default to 'code'.
 * Idempotent: safe to run on every load.
 */
function migrateConversations(list) {
  if (!Array.isArray(list)) return { changed: true, list: [] };
  let changed = false;

  const out = list.map((conv) => {
    const src = (conv && Array.isArray(conv.messages)) ? conv.messages : null;
    const messages = [];
    if (!src) changed = true;

    for (const raw of (src || [])) {
      if (!raw || typeof raw !== 'object') { changed = true; continue; }
      if (raw.role === 'tool') {
        changed = true;
        let host = null;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') { host = messages[i]; break; }
        }
        if (!host) { host = { role: 'assistant', text: '', thinking: '', tools: [], ts: raw.ts || Date.now() }; messages.push(host); }
        host.tools.push(cleanTool(raw.tool || {}));
        continue;
      }
      if (raw.role === 'assistant') {
        const msg = {
          role: 'assistant',
          text: typeof raw.text === 'string' ? raw.text : '',
          thinking: typeof raw.thinking === 'string' ? raw.thinking : '',
          tools: Array.isArray(raw.tools) ? raw.tools.map(cleanTool) : [],
          ts: raw.ts || Date.now(),
        };
        for (const k of Object.keys(raw)) if (!(k in msg)) changed = true;
        if (!msg.text && !msg.thinking && !msg.tools.length) { changed = true; continue; }
        messages.push(msg);
        continue;
      }
      // user (or anything with plain text)
      messages.push({ role: 'user', text: typeof raw.text === 'string' ? raw.text : '', ts: raw.ts || Date.now() });
      if (raw.role !== 'user') changed = true;
    }

    const mode = (conv && (conv.mode === 'study' || conv.mode === 'code')) ? conv.mode : 'code';
    const clean = {
      id: conv && conv.id ? conv.id : uuid(),
      name: conv && conv.name ? conv.name : '对话 1',
      mode,
      piSessionId: conv && conv.piSessionId ? conv.piSessionId : uuid(),
      messages,
      created: (conv && conv.created) || Date.now(),
    };
    if (!conv || !conv.id || !conv.piSessionId || !conv.mode) changed = true;
    return clean;
  });

  return { changed, list: out };
}

function cleanTool(t) {
  return {
    name: t.name || 'tool',
    args: (t.args && typeof t.args === 'object') ? t.args : null,
    result: typeof t.result === 'string' || t.result == null ? (t.result || '') : resultToText(t.result),
    isError: !!t.isError,
    status: t.status === 'running' ? 'done' : (t.status || 'done'),
    callId: t.callId || uuid(),
    diffText: typeof t.diffText === 'string' ? t.diffText : '',
    running: false,
  };
}

/* ------------------------------ approval modal ------------------------------ */

class ApprovalModal extends Modal {
  constructor(app, payload, onDecision) {
    super(app);
    this.payload = payload;
    this.onDecision = onDecision;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Pi Agent — 确认执行' });
    contentEl.createEl('p', { text: '即将运行 Pi。工作目录与允许的工具如下：', cls: 'pi-approve-hint' });
    const box = contentEl.createDiv({ cls: 'pi-approve-box' });
    box.createEl('div', { text: '工具：' + (this.payload.tools || '(全部)') });
    box.createEl('div', { text: '模型：' + (this.payload.model || '(默认)') });
    box.createEl('div', { text: '目录：' + (this.payload.cwd || '(默认)') });
    const pre = box.createEl('pre', { cls: 'pi-approve-prompt' });
    pre.setText(this.payload.prompt);
    const row = contentEl.createDiv({ cls: 'pi-approve-actions' });
    const cancel = row.createEl('button', { text: '取消' });
    cancel.onclick = () => { this.close(); this.onDecision(false); };
    const ok = row.createEl('button', { text: '运行', cls: 'mod-cta' });
    ok.onclick = () => { this.close(); this.onDecision(true); };
  }
  onClose() { this.contentEl.empty(); }
}

/* ------------------------------ settings tab ------------------------------ */

class PiSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Pi Agent 设置' });
    containerEl.createEl('p', {
      cls: 'pi-settings-intro',
      text: '本插件是 Pi 内核的前端：不做模型路由、不注入 prompt、不存密钥。Provider / Model 留空即跟随 pi 自己的默认配置。',
    });

    new Setting(containerEl)
      .setName('后端内核')
      .setDesc('pi=Pi 内核（流式文本/思考/工具卡片）；claude / codex / 自定义=文本模式（无工具卡片）')
      .addDropdown((d) => d
        .addOption('pi', 'Pi (pi kernel)')
        .addOption('claude', 'Claude Code')
        .addOption('codex', 'Codex')
        .addOption('custom', '自定义命令')
        .setValue(s.backend)
        .onChange(async (v) => { s.backend = v; await this.plugin.saveSettings(); this.display(); }));

    const showPiFields = s.backend === 'pi';

    new Setting(containerEl)
      .setName('pi 可执行路径')
      .setDesc('pi 二进制路径或命令名（默认 pi）')
      .addText((t) => t.setValue(s.piBin)
        .onChange(async (v) => { s.piBin = v.trim() || 'pi'; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('PATH 追加目录')
      .setDesc('追加到子进程 PATH 末尾，用于找不到 pi 时兜底（例如 /opt/homebrew/bin）')
      .addText((t) => t.setValue(s.extraPath)
        .onChange(async (v) => { s.extraPath = v.trim(); await this.plugin.saveSettings(); }));

    if (showPiFields) {
      new Setting(containerEl)
        .setName('Provider')
        .setDesc('传给 pi --provider。留空=跟随 pi 默认（推荐）')
        .addText((t) => t.setValue(s.provider)
          .onChange(async (v) => { s.provider = v.trim(); await this.plugin.saveSettings(); }));

      new Setting(containerEl)
        .setName('Model')
        .setDesc('传给 pi --model。留空=跟随 pi 默认（推荐）')
        .addText((t) => t.setValue(s.model)
          .onChange(async (v) => { s.model = v.trim(); await this.plugin.saveSettings(); }));

      new Setting(containerEl)
        .setName('思考级别')
        .setDesc('pi --thinking')
        .addDropdown((d) => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
          .forEach((o) => d.addOption(o, o))
          .setValue(s.thinking)
          .onChange(async (v) => { s.thinking = v; await this.plugin.saveSettings(); }));

      new Setting(containerEl)
        .setName('显示思考过程')
        .setDesc('把 pi 的 thinking 流折叠展示在回复上方')
        .addToggle((t) => t.setValue(s.showThinking)
          .onChange(async (v) => { s.showThinking = v; await this.plugin.saveSettings(); }));

      new Setting(containerEl)
        .setName('允许的工具')
        .setDesc('逗号分隔，传给 pi --tools，例如 read,write,edit,bash')
        .addText((t) => t.setValue(s.allowedTools)
          .onChange(async (v) => { s.allowedTools = v.trim(); await this.plugin.saveSettings(); }));

      new Setting(containerEl)
        .setName('附加系统提示')
        .setDesc('传给 pi --append-system-prompt（可留空）。插件本身不注入任何 prompt')
        .addTextArea((t) => {
          t.setValue(s.appendSystemPrompt)
            .onChange(async (v) => { s.appendSystemPrompt = v; await this.plugin.saveSettings(); });
          t.inputEl.rows = 3;
        });
    }

    new Setting(containerEl)
      .setName('发送前确认')
      .setDesc('每次运行前弹窗确认（pi 内核本身无逐次权限门，这里是发送级确认）')
      .addToggle((t) => t.setValue(s.requireApproval)
        .onChange(async (v) => { s.requireApproval = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('工作目录')
      .setDesc('Pi 的工作目录')
      .addDropdown((d) => d
        .addOption('vault', '整个 Vault')
        .addOption('custom', '自定义路径')
        .setValue(s.cwd)
        .onChange(async (v) => { s.cwd = v; await this.plugin.saveSettings(); this.display(); }));

    if (s.cwd === 'custom') {
      new Setting(containerEl)
        .setName('自定义工作目录')
        .addText((t) => t.setValue(s.customCwd)
          .onChange(async (v) => { s.customCwd = v.trim(); await this.plugin.saveSettings(); }));
    }

    new Setting(containerEl)
      .setName('面板回放条数')
      .setDesc('只影响面板显示，不影响 pi 的上下文（0 = 全部）。对话很长时可减少回放以保持流畅')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.maxHistory))
          .onChange(async (v) => { s.maxHistory = clampInt(v, 0, 2000, 0); await this.plugin.saveSettings(); });
      });

    /* ---------------- 学习模式（隔离） ---------------- */
    containerEl.createEl('h2', { text: '学习模式' });
    containerEl.createEl('p', {
      cls: 'pi-settings-intro',
      text: '学习模式使用**完全独立的** pi 配置目录与会话历史（默认 <vault>/.obsidian/pi-study），'
        + '所以学习用的 AGENTS.md、skills、对话历史都不会进入你日常编程的 pi，不占用其上下文也不消耗 token。'
        + 'API 凭据通过符号链接共享，无需重新配置。',
    });

    new Setting(containerEl)
      .setName('默认模式')
      .setDesc('打开面板时使用的模式，可在面板顶部随时切换')
      .addDropdown((d) => d
        .addOption('study', '学习')
        .addOption('code', '编程')
        .setValue(s.mode)
        .onChange(async (v) => { s.mode = v; this.plugin.activeIds && (this.plugin.conversationId = this.plugin.activeIds[v]); this.plugin.setMode(v); this.display(); }));

    new Setting(containerEl)
      .setName('学习 profile 目录')
      .setDesc('留空则用 <vault>/.obsidian/pi-study。放在 .obsidian 下可确保日常 pi 的 AGENTS.md 扫描不会碰到它')
      .addText((t) => t.setValue(s.studyDir)
        .onChange(async (v) => { s.studyDir = v.trim(); await this.plugin.saveSettings(); this.display(); }));

    new Setting(containerEl)
      .setName('学习模型')
      .setDesc('留空 = 继承 pi 默认模型。可填更强的模型用于讲解与出题')
      .addText((t) => t.setValue(s.studyModel)
        .onChange(async (v) => { s.studyModel = v.trim(); await this.plugin.saveSettings(); this.display(); }));

    new Setting(containerEl)
      .setName('学习思考级别')
      .setDesc('学习任务建议 high（默认）')
      .addDropdown((d) => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        .forEach((o) => d.addOption(o, o))
        .setValue(s.studyThinking)
        .onChange(async (v) => { s.studyThinking = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('学习工作目录')
      .setDesc('留空 = 整个 Vault。也可限定到如 <vault>/408考研 以缩小检索范围')
      .addText((t) => t.setValue(s.studyCwd)
        .onChange(async (v) => { s.studyCwd = v.trim(); await this.plugin.saveSettings(); this.display(); }));

    new Setting(containerEl)
      .setName('启用学习 skills')
      .setDesc('加载 quiz-me / make-cards / review-notes / teach-concept / study-plan，并按学习模式关闭其它 skills')
      .addToggle((t) => t.setValue(s.studySkills)
        .onChange(async (v) => { s.studySkills = v; await this.plugin.saveSettings(); }));

    /* ---------- 学习人格（配置驱动，任意学科可用） ---------- */
    containerEl.createEl('h3', { text: '学习人格' });
    containerEl.createEl('p', {
      cls: 'pi-settings-intro',
      text: '选择预设后只改你想改的字段即可（留空 = 用预设值）。修改后需点下方「建立 / 修复学习 profile」重新生成；'
        + '已经生成过的 AGENTS.md / skills 不会被覆盖，想用新配置请先删除该文件或改名。',
    });

    const presetOptions = {};
    for (const key of Object.keys(studyProfile.PRESETS)) presetOptions[key] = studyProfile.PRESETS[key].label;
    new Setting(containerEl)
      .setName('学习预设')
      .setDesc('提供开箱即用的学科配置，可被下面的字段覆盖')
      .addDropdown((d) => {
        for (const k of Object.keys(presetOptions)) d.addOption(k, presetOptions[k]);
        d.setValue(s.studyPreset).onChange(async (v) => {
          s.studyPreset = v;
          // 切换预设时清空覆盖字段，避免把上一个预设的值带过去
          s.studyGoal = ''; s.studyNoteRoots = [];
          s.studyMistakeBook = ''; s.studyTemplate = ''; s.studyDailyLog = '';
          s.studyStatusField = ''; s.studyStatusValues = []; s.studyLanguage = '';
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('学习目标')
      .setDesc('留空 = 用预设。例如「考研 408 + 数学一」「通过 JLPT N2」')
      .addText((t) => t.setValue(s.studyGoal)
        .onChange(async (v) => { s.studyGoal = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('笔记目录')
      .setDesc('逗号分隔，例如 408考研/, 考研数学笔记/ 。留空 = 用预设（预设为空时 agent 会自己探索 vault）')
      .addText((t) => t.setValue((s.studyNoteRoots || []).map((r) => r.path).join(', '))
        .onChange(async (v) => {
          s.studyNoteRoots = v.split(',').map((x) => x.trim()).filter(Boolean).map((p) => ({ path: p }));
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('错题本路径')
      .setDesc('留空 = 用预设。agent 会把掌握不了的题写到这里')
      .addText((t) => t.setValue(s.studyMistakeBook)
        .onChange(async (v) => { s.studyMistakeBook = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('错题模板路径')
      .setDesc('留空 = 用预设。agent 会先读它、沿用里面的 frontmatter 字段')
      .addText((t) => t.setValue(s.studyTemplate)
        .onChange(async (v) => { s.studyTemplate = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('日志 / 计划目录')
      .setDesc('留空 = 用预设。学习计划会写在这里')
      .addText((t) => t.setValue(s.studyDailyLog)
        .onChange(async (v) => { s.studyDailyLog = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('掌握度字段')
      .setDesc('留空 = status。笔记 frontmatter 里表示掌握程度的字段名')
      .addText((t) => t.setValue(s.studyStatusField)
        .onChange(async (v) => { s.studyStatusField = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('掌握度取值')
      .setDesc('逗号分隔，从弱到强。留空 = 用预设。例如 完全不会, 比较掌握, 完全掌握')
      .addText((t) => t.setValue((s.studyStatusValues || []).join(', '))
        .onChange(async (v) => {
          s.studyStatusValues = v.split(',').map((x) => x.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('人格语言')
      .setDesc('AGENTS.md / skills 的书写语言。auto = 跟随预设')
      .addDropdown((d) => d
        .addOption('', 'auto（跟随预设）')
        .addOption('zh', '中文')
        .addOption('en', 'English')
        .setValue(s.studyLanguage || '')
        .onChange(async (v) => { s.studyLanguage = v; await this.plugin.saveSettings(); this.display(); }));

    // 回显当前生效的解析结果，让用户清楚预设实际给了什么
    const resolved = this.plugin.studyConfig();
    const goalText = (resolved.goal && typeof resolved.goal === 'object')
      ? (resolved.goal[resolved.lang] || resolved.goal.zh || resolved.goal.en || '')
      : String(resolved.goal || '');
    const resolvedBox = containerEl.createDiv({ cls: 'pi-profile-info' });
    resolvedBox.createEl('div', { text: '语言：' + resolved.lang });
    resolvedBox.createEl('div', { text: '目标：' + goalText });
    resolvedBox.createEl('div', { text: '笔记目录：' + (resolved.noteRoots.map((r) => r.path).join(', ') || '(未配置)') });
    resolvedBox.createEl('div', { text: '掌握度：' + resolved.statusField + ' = ' + resolved.statusValues.join(' / ') });
    resolvedBox.createEl('div', { text: '卡片分隔符：' + resolved.cardSyntax.singleLine + ' / '
      + resolved.cardSyntax.singleLineReversed + ' / ' + resolved.cardSyntax.multiLine
      + (resolved.cardSyntax.detected ? '（已检测到 spaced-repetition 配置）' : '（默认值，未检测到插件配置）') });

    const studyRow = containerEl.createDiv({ cls: 'pi-settings-actions' });
    const setupBtn = studyRow.createEl('button', { text: '建立 / 修复学习 profile' });
    setupBtn.onclick = () => { this.plugin.setupStudyProfile({ quiet: false }); this.display(); };
    const openBtn = studyRow.createEl('button', { text: '打开学习模式' });
    openBtn.onclick = () => { this.plugin.setMode('study'); this.plugin.activateView(); };
    const regenBtn = studyRow.createEl('button', { text: '重新生成人格文件' });
    regenBtn.setAttr('title', '删除已生成的 AGENTS.md 与 skills 后重建（你手改过的内容会丢失）');
    regenBtn.onclick = () => { this.plugin.regenerateStudyPersona(); this.display(); };

    const info = this.plugin.studyProfileInfo;
    const infoBox = containerEl.createDiv({ cls: 'pi-profile-info' });
    if (info && info.error) {
      infoBox.createEl('div', { cls: 'pi-profile-error', text: '错误: ' + info.error });
    } else if (info) {
      infoBox.createEl('div', { text: '目录：' + info.dir });
      infoBox.createEl('div', { text: '会话：' + info.sessionDir });
      if (info.linked.length) infoBox.createEl('div', { text: '共享凭据：' + info.linked.join(', ') });
      if (info.created.length) infoBox.createEl('div', { text: '已创建：' + info.created.join(', ') });
      if (info.warnings.length) infoBox.createEl('div', { cls: 'pi-profile-error', text: info.warnings.join('；') });
    }

    containerEl.createEl('h3', { text: '会话数据' });
    containerEl.createEl('p', {
      cls: 'pi-settings-intro',
      text: '面板里的对话记录（用于回放）保存在本插件 data.json；真正的 Pi 会话历史由 pi 自己保存在 ~/.pi/agent/sessions/，两者用 session-id 关联。',
    });
    const row = containerEl.createDiv({ cls: 'pi-settings-actions' });
    const clearBtn = row.createEl('button', { text: '清空面板会话记录' });
    clearBtn.onclick = async () => {
      const mode = this.plugin.settings.mode;
      this.plugin.conversationsStore = this.plugin.conversationsStore.filter((c) => (c.mode || 'code') !== mode);
      const fresh = this.plugin._blankConversation(null, mode);
      this.plugin.conversationsStore.push(fresh);
      this.plugin.conversationId = fresh.id;
      this.plugin.activeIds[mode] = fresh.id;
      this.plugin.persistNow();
      for (const v of this.plugin.views) v.renderTranscript();
      this.display();
      new Notice('已清空「' + (mode === 'study' ? '学习' : '编程') + '」模式的面板会话记录（Pi 侧会话文件未删除）');
    };
    row.createEl('span', {
      cls: 'pi-settings-hint',
      text: this.plugin.resolveCwd(),
    });
  }
}

/* ------------------------------ chat view ------------------------------ */

class PiChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.msgEls = new Map();
    this.toolEls = new Map();
    this.live = null;          // in-flight assistant message (not yet committed to the store)
    this._streamFlush = throttle(() => this._flushStream(), 70);
    this._lastUsage = null;
  }

  getViewType() { return VIEW_TYPE_PI; }
  getDisplayText() { return 'Pi Agent'; }
  getIcon() { return 'bot'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('pi-agent-root');
    root.toggleClass('pi-mode-study', this.plugin.settings.mode === 'study');

    // ---- toolbar ----
    const bar = root.createDiv({ cls: 'pi-toolbar' });
    const left = bar.createDiv({ cls: 'pi-toolbar-left' });

    // Mode switch: 学习(隔离 profile) / 编程(日常 ~/.pi/agent)
    this.modeGroup = left.createDiv({ cls: 'pi-mode-group' });
    this.modeBtns = {};
    for (const [mode, label, icon] of [['study', '学习', 'graduation-cap'], ['code', '编程', 'code']]) {
      const b = this.modeGroup.createEl('button', { cls: 'pi-mode-btn', attr: { title: mode === 'study' ? '学习模式（隔离的学习人格与会话，不占用编程上下文）' : '编程模式（使用你日常的 ~/.pi/agent 配置与会话）' } });
      const ic = b.createEl('span', { cls: 'pi-mode-icon' });
      setIcon(ic, icon);
      b.createEl('span', { text: label });
      b.onclick = () => this.plugin.setMode(mode);
      this.modeBtns[mode] = b;
    }

    this.modelLabel = left.createEl('span', { cls: 'pi-chip', text: this.plugin.modelLabel() });
    this.chipThinking = left.createEl('span', { cls: 'pi-chip', text: 'thinking:' + this.plugin.activeThinking() });
    this.cwdLabel = left.createEl('span', { cls: 'pi-chip pi-chip-dim', text: this.plugin.cwdLabel() });
    this.usageChip = left.createEl('span', { cls: 'pi-chip pi-chip-dim pi-usage-chip', text: '' });
    this.usageChip.addClass('pi-hidden');

    const right = bar.createDiv({ cls: 'pi-toolbar-right' });
    this._iconBtn(right, 'plus', '新建对话', () => this.plugin.newConversation());
    this._iconBtn(right, 'git-branch', '会话', () => this.toggleSidebar());
    this._iconBtn(right, 'book-open', '引用当前笔记', () => this.referenceActiveNote());
    this.stopBtn = this._iconBtn(right, 'square', '中止 (Esc)', () => this.plugin.abort());
    this.stopBtn.addClass('pi-hidden');

    // ---- body: sidebar + transcript ----
    this.bodyEl = root.createDiv({ cls: 'pi-body' });
    this.sidebarEl = this.bodyEl.createDiv({ cls: 'pi-sidebar pi-hidden' });
    this.mainEl = this.bodyEl.createDiv({ cls: 'pi-main' });
    this.listEl = this.mainEl.createDiv({ cls: 'pi-messages' });

    // ---- input ----
    const inputWrap = this.mainEl.createDiv({ cls: 'pi-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'pi-input',
      attr: { rows: '2', placeholder: '问点什么…（@ 引用笔记 · Enter 发送 · Shift+Enter 换行）' },
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submit(); }
      if (e.key === 'Escape' && this.plugin.proc) { e.preventDefault(); this.plugin.abort(); }
    });
    this.inputEl.addEventListener('input', () => this._autoGrow());
    const actions = inputWrap.createDiv({ cls: 'pi-input-actions' });
    this.statusEl = actions.createEl('span', { cls: 'pi-status' });
    this.sendBtn = actions.createEl('button', { text: '发送', cls: 'mod-cta' });
    this.sendBtn.onclick = () => this.submit();

    this.renderTranscript();
    this.plugin._trackView(this);
  }

  _iconBtn(parent, icon, title, fn) {
    const b = parent.createEl('button', { cls: 'pi-icon-btn', attr: { 'aria-label': title, title } });
    setIcon(b, icon);
    b.onclick = fn;
    return b;
  }

  _autoGrow() {
    const el = this.inputEl;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
  }

  async onClose() {
    this.plugin._untrackView(this);
  }

  /* -------- transcript rendering -------- */

  renderTranscript() {
    this.listEl.empty();
    this.msgEls.clear();
    this.toolEls.clear();

    const all = this.plugin.conversation.messages;
    const max = clampInt(this.plugin.settings.maxHistory, 0, 2000, 0);
    const msgs = max > 0 ? all.slice(-max) : all;

    if (!msgs.length && !this.live) {
      const empty = this.listEl.createDiv({ cls: 'pi-empty' });
      empty.createEl('div', { cls: 'pi-empty-title', text: 'Pi Agent' });
      empty.createEl('div', { text: '在当前库上运行 Pi 内核。试试：“总结 408考研 目录结构”或“帮我修复 首页.md 里的失效链接”。' });
    } else {
      if (msgs.length < all.length) {
        this.listEl.createDiv({
          cls: 'pi-history-note',
          text: '仅显示最近 ' + msgs.length + ' 条（共 ' + all.length + ' 条，可在设置中调整）',
        });
      }
      for (const m of msgs) this.renderMessage(m);
    }
    if (this.live) this._ensureLiveEl();
    this.scrollToEnd();
  }

  renderMessage(m) {
    const wrap = this.listEl.createDiv({ cls: 'pi-msg pi-msg-' + m.role });
    if (m.role === 'user') {
      const bubble = wrap.createDiv({ cls: 'pi-bubble pi-bubble-user' });
      const body = bubble.createDiv({ cls: 'pi-md pi-md-user' });
      this._renderMarkdown(body, m.text, true);
      m._bodyEl = body;
    } else {
      const bubble = wrap.createDiv({ cls: 'pi-bubble pi-bubble-assistant' });
      this._renderAssistantBody(bubble, m);
    }
    m._el = wrap;
    m._wrapEl = wrap;
    if (m._id) this.msgEls.set(m._id, wrap);

    const tools = (m.role === 'assistant' && Array.isArray(m.tools)) ? m.tools : [];
    for (const t of tools) this._ensureToolCard(m, t);
    this._syncGroupState(m);
    return wrap;
  }

  /** Lazily create the tool-card container for a message and render a card into it. */
  _ensureToolCard(m, tool) {
    if (tool._card) return tool._card;
    if (!m._groupEl) {
      const anchor = m._wrapEl || m._el;
      if (!anchor) return null;
      m._groupEl = anchor.createDiv({ cls: 'pi-tool-cards pi-tool-group-pending' });
    }
    return this._renderToolCard(m._groupEl, tool);
  }

  /** Group styling: open while tools run, settled once every tool finished. */
  _syncGroupState(m) {
    if (!m || !m._groupEl) return;
    const tools = m.tools || [];
    const pending = tools.some((t) => t.running);
    m._groupEl.toggleClass('pi-tool-group-pending', pending);
    m._groupEl.toggleClass('pi-tool-group', !pending);
  }

  _renderAssistantBody(bubble, m) {
    bubble.empty();
    const thinkingText = m.thinking || '';
    if (thinkingText && this.plugin.settings.showThinking) {
      const det = bubble.createEl('details', { cls: 'pi-thinking' });
      det.createEl('summary', { cls: 'pi-thinking-summary', text: '思考过程' });
      const body = det.createDiv({ cls: 'pi-thinking-body' });
      body.setText(thinkingText);
      m._thinkingEl = body;
      m._thinkingCard = det;
    } else {
      m._thinkingEl = null;
      m._thinkingCard = null;
    }
    const body = bubble.createDiv({ cls: 'pi-md' });
    this._renderMarkdown(body, m.text);
    m._bodyEl = body;
    return body;
  }

  _renderToolCard(parent, tool) {
    const card = parent.createEl('details', { cls: 'pi-tool-card' + (tool.isError ? ' pi-tool-error' : '') });
    const summary = card.createEl('summary', { cls: 'pi-tool-summary' });
    const iconSpan = summary.createEl('span', { cls: 'pi-tool-icon' });
    setIcon(iconSpan, this._toolIcon(tool.name));
    summary.createEl('span', { cls: 'pi-tool-name', text: tool.name || 'tool' });
    summary.createEl('span', { cls: 'pi-tool-arg', text: this._toolArgPreview(tool) });
    const st = summary.createEl('span', { cls: 'pi-tool-state', text: tool.running ? '…' : (tool.isError ? '✗' : '✓') });
    const bodyEl = card.createDiv({ cls: 'pi-tool-body' });
    tool._card = card;
    tool._stateEl = st;
    tool._summaryEl = summary;
    tool._bodyEl = bodyEl;
    this._renderToolBody(bodyEl, tool);
    // Diffs stay open so edits are visible without a click; other tools stay collapsed.
    if (WRITE_TOOLS.has(tool.name) || tool.isError) card.setAttribute('open', '');
    else card.removeAttribute('open');
    return card;
  }

  _toolIcon(name) {
    switch (name) {
      case 'read': return 'file-text';
      case 'write': return 'file-plus';
      case 'edit': return 'pencil';
      case 'bash': return 'terminal';
      case 'grep': return 'search';
      case 'glob':
      case 'ls': return 'folder';
      case 'web_fetch':
      case 'fetch': return 'globe';
      default: return 'wrench';
    }
  }

  _toolArgPreview(tool) {
    const a = tool.args || {};
    if (tool.name === 'read') return a.path || '';
    if (tool.name === 'bash') {
      const c = String(a.command || '').split('\n')[0];
      return c.length > 90 ? c.slice(0, 90) + '…' : c;
    }
    if (Array.isArray(a.edits) && a.edits.length) {
      return (a.path || '') + (a.edits.length > 1 ? '  (' + a.edits.length + ' 处)' : '');
    }
    if (a.path) return a.path;
    if (a.query) return String(a.query);
    return '';
  }

  _renderToolBody(el, tool) {
    el.empty();
    const a = tool.args || {};

    // Prefer the authoritative diff reported by pi (`result.details.diff`).
    let diffText = tool.diffText || '';
    if (!diffText && tool.name === 'edit' && Array.isArray(a.edits)) {
      const parts = [];
      for (const ed of a.edits) {
        if (ed && typeof ed.oldText === 'string' && typeof ed.newText === 'string') {
          for (const [tag, line] of lineDiff(ed.oldText, ed.newText)) {
            parts.push(tag + ' ' + line);
          }
        }
      }
      diffText = parts.join('\n');
    }
    if (!diffText && tool.name === 'write' && typeof a.content === 'string') {
      diffText = a.content.split('\n').map((l) => '+ ' + l).join('\n');
    }

    if (diffText) {
      const d = el.createDiv({ cls: 'pi-diff' });
      let count = 0;
      for (const raw of diffText.split('\n')) {
        const tag = raw[0];
        if (tag !== '+' && tag !== '-' && tag !== ' ') continue;
        const cls = tag === '+' ? 'pi-diff-add' : (tag === '-' ? 'pi-diff-del' : 'pi-diff-ctx');
        d.createEl('div', { cls: 'pi-diff-line ' + cls, text: raw });
        count++;
      }
      if (!count) d.createEl('div', { cls: 'pi-diff-line pi-diff-ctx', text: '(无变化的行)' });
    } else if (Object.keys(a).length) {
      el.createEl('pre', { cls: 'pi-tool-args', text: JSON.stringify(a, null, 2) });
    }

    if (tool.result !== undefined && tool.result !== null && String(tool.result).length) {
      const r = el.createDiv({ cls: 'pi-tool-result' });
      r.createEl('div', { cls: 'pi-tool-result-label', text: tool.isError ? '错误' : '结果' });
      r.createEl('pre', { text: String(tool.result) });
    }
    if (tool.running) el.createEl('div', { cls: 'pi-tool-running', text: '运行中…' });
  }

  _renderMarkdown(el, md, isUser) {
    el.empty();
    if (!md) return;
    el.toggleClass('pi-md-user', !!isUser);
    try {
      MarkdownRenderer.render(this.app, md, el, this.plugin.activeNotePath(), this);
    } catch (e) {
      el.setText(md);
    }
    this._wireLinks(el);
    this._addCopyButtons(el);
  }

  /** Make internal links clickable inside the panel (renderers emit anchors). */
  _wireLinks(el) {
    if (el._piLinksWired) return;
    el._piLinksWired = true;
    el.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a.internal-link, a.external-link') : null;
      if (!a) return;
      if (a.hasClass && a.hasClass('external-link')) return; // let the default handler open it
      const target = a.getAttribute('data-href') || a.getAttribute('href');
      if (!target) return;
      e.preventDefault();
      this.app.workspace.openLinkText(target, this.plugin.activeNotePath(), false);
    });
  }

  _addCopyButtons(el) {
    const pres = el.querySelectorAll ? el.querySelectorAll('pre') : [];
    pres.forEach((pre) => {
      if (pre.querySelector && pre.querySelector('.pi-copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'pi-copy-btn';
      btn.setAttribute('aria-label', '复制');
      btn.textContent = '复制';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = pre.querySelector('code');
        const text = code ? code.textContent : pre.textContent;
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = '已复制';
          setTimeout(() => { btn.textContent = '复制'; }, 1200);
        }).catch(() => {});
      });
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  }

  /* -------- input -------- */

  submit() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = '';
    this._autoGrow();
    this.plugin.send(text);
  }

  setBusy(busy) {
    this.sendBtn.disabled = busy;
    this.sendBtn.setText(busy ? '运行中…' : '发送');
    this.stopBtn.toggleClass('pi-hidden', !busy);
  }

  setStatus(text) { this.statusEl.setText(text || ''); }

  setUsage(usage) {
    if (!usage) return;
    const inp = usage.inputTokens != null ? usage.inputTokens : usage.input;
    const out = usage.outputTokens != null ? usage.outputTokens : usage.output;
    const parts = [];
    if (inp) parts.push('↑' + fmtNum(inp));
    if (out) parts.push('↓' + fmtNum(out));
    const cached = (usage.cacheRead || 0) + (usage.cacheWrite || 0);
    if (cached) parts.push('cache ' + fmtNum(cached));
    if (!parts.length) { this.usageChip.addClass('pi-hidden'); return; }
    this.usageChip.setText(parts.join(' · '));
    this.usageChip.removeClass('pi-hidden');
  }

  scrollToEnd() {
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  referenceActiveNote() {
    const f = this.app.workspace.getActiveFile();
    if (!f) { new Notice('没有打开的笔记'); return; }
    const cur = this.inputEl.value;
    this.inputEl.value = (cur ? cur + ' ' : '') + '@' + quoteRef(f.path) + ' ';
    this.inputEl.focus();
  }

  toggleSidebar() {
    this.sidebarEl.toggleClass('pi-hidden', !this.sidebarEl.hasClass('pi-hidden'));
    if (!this.sidebarEl.hasClass('pi-hidden')) this.renderSidebar();
    else this.sidebarEl.empty();
  }

  renderSidebar() {
    const s = this.sidebarEl;
    s.empty();
    const head = s.createDiv({ cls: 'pi-sidebar-head' });
    head.createEl('span', { text: '会话' });
    const nb = head.createEl('button', { cls: 'pi-icon-btn', attr: { title: '新建' } });
    setIcon(nb, 'plus');
    nb.onclick = () => { this.plugin.newConversation(); this.renderSidebar(); };
    const list = s.createDiv({ cls: 'pi-session-list' });
    for (const c of this.plugin.conversations()) {
      const item = list.createDiv({ cls: 'pi-session-item' + (c.id === this.plugin.conversation.id ? ' is-active' : '') });
      item.createEl('span', { cls: 'pi-session-name', text: c.name || '(未命名)' });
      item.onclick = () => { this.plugin.openConversation(c.id); this.renderSidebar(); };
      const del = item.createEl('button', { cls: 'pi-icon-btn pi-session-del', attr: { title: '删除' } });
      setIcon(del, 'trash');
      del.onclick = (e) => { e.stopPropagation(); this.plugin.deleteConversation(c.id); this.renderSidebar(); };
    }
  }

  /* -------- streaming (live assistant message) -------- */

  _beginTurn() {
    // A new assistant message must never silently discard an in-flight one.
    if (this.live) this._commitLive(null);
    this.live = { role: 'assistant', text: '', thinking: '', tools: [], ts: Date.now(), _live: true };
    this._liveEl = null;
    this._streamDirty = { thinking: false, text: false };
  }

  _pushDelta(kind, delta) {
    if (!this.live) this._beginTurn();
    if (!delta) return;
    if (kind === 'thinking') { this.live.thinking += delta; this._streamDirty.thinking = true; }
    else { this.live.text += delta; this._streamDirty.text = true; }
    this._ensureLiveEl();
    this._streamFlush();
  }

  /** Lazily create the bubble for the in-flight message on the first token. */
  _ensureLiveEl() {
    if (!this.live || this._liveEl) return;
    this._liveEl = this.renderMessage(this.live);
    this.scrollToEnd();
  }

  _flushStream() {
    const m = this.live;
    if (!m || !this._liveEl) return;
    if (this._streamDirty.thinking) {
      // The first token may be thinking, so the card can still be missing here.
      if (!m._thinkingEl && this.plugin.settings.showThinking && m.thinking) {
        this._renderAssistantBody(m._bubbleEl, m);
        if (m._thinkingCard) m._thinkingCard.setAttribute('open', m.thinking.length < 600 ? '' : 'x');
      } else if (m._thinkingEl) {
        m._thinkingEl.setText(m.thinking);
        m._thinkingEl.scrollTop = m._thinkingEl.scrollHeight;
      }
    }
    if (this._streamDirty.text && m._bodyEl) {
      this._renderMarkdown(m._bodyEl, m.text);
      m._bodyEl.addClass('pi-streaming');
    }
    this._streamDirty = { thinking: false, text: false };
    this.scrollToEnd();
  }

  /** Freeze the in-flight message into the persisted transcript. */
  _commitLive(authoritative) {
    const live = this.live;
    if (!live) return null;
    if (authoritative) {
      if (typeof authoritative.text === 'string' && authoritative.text) live.text = authoritative.text;
      if (typeof authoritative.thinking === 'string' && authoritative.thinking) live.thinking = authoritative.thinking;
    }
    // Streaming renders are throttled; flush *after* applying the authoritative text so
    // the frozen bubble shows the final content, not the last throttled frame.
    if (this._streamDirty && (this._streamDirty.text || this._streamDirty.thinking)) this._flushStream();
    if (!live.text && !live.thinking && !live.tools.length) { this.live = null; return null; }
    if (live._bodyEl) live._bodyEl.removeClass('pi-streaming');
    const committed = this.plugin.commitMessage(live);
    this.live = null;
    this._liveEl = null;
    this.plugin.persist();
    return committed;
  }

  /* -------- event stream from pi -------- */

  handleEvent(ev) {
    const plugin = this.plugin;
    switch (ev.type) {
      case 'session':
        if (ev.id && plugin.conversation.piSessionId !== ev.id) {
          plugin.conversation.piSessionId = ev.id;
          plugin.persist();
        }
        break;

      case 'message_start': {
        const msg = ev.message || {};
        if (msg.role === 'assistant') this._beginTurn();
        break;
      }

      case 'message_end': {
        const msg = ev.message || {};
        if (msg.role === 'assistant') {
          if (msg.usage) { this._lastUsage = msg.usage; this.setUsage(msg.usage); }
          const content = Array.isArray(msg.content) ? msg.content : [];
          const text = content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
          const thinking = content.filter((c) => c && (c.type === 'thinking' || c.type === 'reasoning'))
            .map((c) => c.thinking || c.text || '').join('');
          this._commitLive({ text, thinking });
        } else if (msg.role === 'toolResult') {
          // Authoritative result; tool_execution_end already handled the UI, but a
          // result-only path (no execution event) still needs to land somewhere.
          const m = this._toolMsgById(msg.toolCallId);
          if (m && m.tool && m.tool.running) this._finishTool(m.tool, msg.content, !!msg.isError);
        }
        break;
      }

      case 'message_update': {
        const e = ev.assistantMessageEvent || {};
        switch (e.type) {
          case 'text_delta':
            this._pushDelta('text', e.delta);
            break;
          case 'thinking_delta':
          case 'reasoning_delta':
            if (plugin.settings.showThinking) this._pushDelta('thinking', e.delta || e.text);
            break;
          case 'toolcall_start': {
            if (!this.live) this._beginTurn();
            const tool = {
              name: e.toolName || 'tool', args: null, _argBuf: '', status: 'running',
              running: true, callId: e.id, isError: false, result: '', diffText: '',
            };
            this.live.tools.push(tool);
            this._ensureLiveEl();
            this._ensureToolCard(this.live, tool);
            this._syncGroupState(this.live);
            this.scrollToEnd();
            break;
          }
          case 'toolcall_delta': {
            const t = this._lastLiveTool();
            if (t) t._argBuf += e.delta || '';
            break;
          }
          case 'toolcall_end': {
            const t = this._lastLiveTool();
            if (t && e.toolCall) {
              let args = e.toolCall.arguments;
              if (typeof args === 'string') { try { args = JSON.parse(args); } catch (err) {} }
              t.args = (args && typeof args === 'object') ? args : t.args;
              t.name = e.toolCall.name || t.name;
            }
            break;
          }
          default: break;
        }
        break;
      }

      case 'tool_execution_start': {
        const t = this._toolById(ev.toolCallId);
        if (t) {
          t.running = true;
          t.status = 'running';
          if (ev.args && typeof ev.args === 'object') t.args = ev.args;
          if (ev.toolName) t.name = ev.toolName;
          const hit = this._toolMsgById(ev.toolCallId);
          if (hit && !t._card) this._ensureToolCard(hit.msg, t);
          this._patchTool(t);
        }
        break;
      }

      case 'tool_execution_update': {
        const t = this._toolById(ev.toolCallId);
        if (t) {
          const partial = resultToText(ev.partialResult);
          if (partial) { t.result = partial; this._patchTool(t); }
        }
        break;
      }

      case 'tool_execution_end': {
        const t = this._toolById(ev.toolCallId);
        if (!t) break;
        this._finishTool(t, ev.result, !!ev.isError);
        break;
      }

      case 'turn_end':
        this._finalizeTurn();
        break;

      case 'agent_end':
      case 'agent_settled':
        if (this.live) this._commitLive(null);
        this._finalizeTurn();
        plugin.persist();
        break;

      default: break;
    }
  }

  _finishTool(tool, result, isError) {
    tool.result = resultToText(result);
    tool.isError = isError;
    tool.status = isError ? 'error' : 'done';
    tool.running = false;
    if (result && result.details && typeof result.details.diff === 'string') tool.diffText = result.details.diff;
    this._patchTool(tool);
  }

  _patchTool(tool) {
    if (tool._stateEl) tool._stateEl.setText(tool.running ? '…' : (tool.isError ? '✗' : '✓'));
    if (tool._card) tool._card.toggleClass('pi-tool-error', !!tool.isError);
    if (tool._summaryEl) {
      const argEl = tool._summaryEl.querySelector('.pi-tool-arg');
      if (argEl) argEl.setText(this._toolArgPreview(tool));
    }
    if (tool._bodyEl) this._renderToolBody(tool._bodyEl, tool);
    const hit = this._toolMsgById(tool.callId);
    if (hit) {
      if (!tool._card) this._ensureToolCard(hit.msg, tool);
      this._syncGroupState(hit.msg);
      if (!tool.running && (tool.isError || tool.diffText || WRITE_TOOLS.has(tool.name)) && tool._card) {
        tool._card.setAttribute('open', '');
      }
    }
  }

  /** After each turn: reveal diffs / errors so the user does not have to hunt for them. */
  _finalizeTurn() {
    const msgs = this.plugin.conversation.messages.slice(-8);
    for (const m of msgs) {
      for (const t of (m.tools || [])) {
        if (!t._card) continue;
        if (WRITE_TOOLS.has(t.name) || t.isError || t.diffText) t._card.setAttribute('open', '');
      }
    }
    this.scrollToEnd();
  }

  _lastLiveTool() {
    const tools = this.live ? this.live.tools : null;
    return tools && tools.length ? tools[tools.length - 1] : null;
  }

  _allMessages() {
    const list = this.plugin.conversation.messages.slice();
    if (this.live) list.push(this.live);
    return list;
  }

  _toolById(callId) {
    if (!callId) return null;
    for (const m of this._allMessages()) {
      for (const t of ((m.role === 'assistant' && m.tools) || [])) {
        if (t.callId === callId) return t;
      }
    }
    return null;
  }

  _toolMsgById(callId) {
    if (!callId) return null;
    for (const m of this._allMessages()) {
      for (const t of ((m.role === 'assistant' && m.tools) || [])) {
        if (t.callId === callId) return { msg: m, tool: t };
      }
    }
    return null;
  }

  refreshHeader() {
    if (this.modelLabel) this.modelLabel.setText(this.plugin.modelLabel());
    if (this.chipThinking) this.chipThinking.setText('thinking:' + this.plugin.activeThinking());
    if (this.cwdLabel) this.cwdLabel.setText(this.plugin.cwdLabel());
    const study = this.plugin.settings.mode === 'study';
    this.contentEl.toggleClass('pi-mode-study', study);
    if (this.modeBtns) {
      for (const m of ['study', 'code']) {
        if (this.modeBtns[m]) this.modeBtns[m].toggleClass('is-active', (m === 'study') === study);
      }
    }
    if (this.inputEl) {
      this.inputEl.setAttribute('placeholder', study
        ? '学习模式 · 考考我 / 讲讲这个概念 / 复习 / 做成卡片…（Enter 发送）'
        : '编程模式 · 问点什么…（@ 引用笔记 · Enter 发送）');
    }
  }
}

function fmtNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/* ------------------------------ plugin ------------------------------ */

class PiAgentPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    const loaded = await this.loadData();
    const migrated = migrateConversations(this.settings.__conversations || []);
    this.conversationsStore = migrated.list;

    // Legacy data had a single conversation list with a string id. Normalize to per-mode ids.
    let activeIds = this.settings.__activeConversation;
    if (!activeIds || typeof activeIds !== 'object' || Array.isArray(activeIds)) {
      activeIds = { code: typeof activeIds === 'string' ? activeIds : null, study: null };
    }
    this.activeIds = { code: activeIds.code || null, study: activeIds.study || null };

    // Ensure each mode has at least one conversation to land in.
    for (const mode of ['code', 'study']) {
      if (!this.conversationsStore.some((c) => c.mode === mode)) {
        this.conversationsStore.push(this._blankConversation(this._defaultConvName(mode), mode));
      }
    }
    for (const mode of ['code', 'study']) {
      const list = this.conversationsStore.filter((c) => c.mode === mode);
      if (!this.activeIds[mode] || !list.some((c) => c.id === this.activeIds[mode])) {
        this.activeIds[mode] = list[list.length - 1].id;
      }
    }
    this.conversationId = this.activeIds[this.settings.mode] || this.activeIds.code;

    if (migrated.changed || (loaded && loaded.__version !== DATA_VERSION)) {
      this.persistNow();
    } else if (loaded && !('__conversations' in loaded)) {
      this.persist();
    }

    this.proc = null;
    this.views = [];
    this._persistQueued = false;

    // 初始化隔离的学习 profile（不触碰 ~/.pi/agent，只创建自己的目录 + symlink 凭据）
    this.studyProfileInfo = null;
    if (this.settings.mode === 'study' || !this.settings.studyProfileSetUp) {
      this.setupStudyProfile({ quiet: true });
    }

    this.registerView(VIEW_TYPE_PI, (leaf) => new PiChatView(leaf, this));

    this.addRibbonIcon('bot', 'Pi Agent: 打开面板', () => this.activateView());

    this.addCommand({ id: 'open-panel', name: '打开 Pi Agent 面板', callback: () => this.activateView() });
    this.addCommand({ id: 'new-chat', name: '新建对话', callback: () => { this.newConversation(); this.activateView(); } });
    this.addCommand({ id: 'ask-note', name: '把当前笔记发给 Pi', callback: () => this.askActiveNote() });

    this.addSettingTab(new PiSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on('file-open', () => this.syncViews()));
  }

  onunload() {
    this.abort();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_PI);
  }

  /* ---- settings & conversation persistence ---- */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.serializeSettings());
    this.syncViews();
  }

  /** Persist the transcript. Coalesced: only whitelisted fields ever hit disk. */
  persist() {
    if (this._persistQueued) return;
    this._persistQueued = true;
    setTimeout(() => {
      this._persistQueued = false;
      try { this.saveData(this.serializeSettings()); } catch (e) { /* ignore transient write errors */ }
    }, 120);
  }

  /** Immediate, non-coalesced write (used for structural changes + migrations). */
  persistNow() {
    this.settings.__version = DATA_VERSION;
    try { return this.saveData(this.serializeSettings()); } catch (e) { return null; }
  }

  serializeSettings() {
    const out = {};
    for (const k of Object.keys(this.settings)) {
      if (k === '__conversations') continue;
      if (k.startsWith('__')) continue;
      out[k] = this.settings[k];
    }
    out.__version = DATA_VERSION;
    out.__activeConversation = { code: this.activeIds.code, study: this.activeIds.study };
    out.__conversations = this.conversationsStore.map((c) => ({
      id: c.id,
      name: c.name,
      mode: c.mode || 'code',
      piSessionId: c.piSessionId,
      created: c.created,
      messages: (c.messages || []).map((m) => m.role === 'user'
        ? { role: 'user', text: m.text, ts: m.ts }
        : {
            role: 'assistant',
            text: m.text || '',
            thinking: m.thinking || '',
            ts: m.ts,
            tools: (m.tools || []).map((t) => ({
              name: t.name,
              args: t.args || null,
              result: typeof t.result === 'string' ? t.result : '',
              isError: !!t.isError,
              status: t.status || 'done',
              callId: t.callId,
              diffText: t.diffText || '',
            })),
          }),
    }));
    return out;
  }

  _defaultConvName(mode) {
    return mode === 'study' ? '学习会话' : '编程会话';
  }

  _blankConversation(name, mode) {
    return {
      id: uuid(), name: name || this._defaultConvName(mode || this.settings.mode),
      mode: mode || this.settings.mode || 'code',
      piSessionId: uuid(), messages: [], created: Date.now(),
    };
  }

  /** Conversations belonging to one mode. The panel only ever shows the active mode. */
  conversationsFor(mode) {
    const m = mode || this.settings.mode;
    return this.conversationsStore.filter((c) => (c.mode || 'code') === m)
      .sort((a, b) => (b.created || 0) - (a.created || 0));
  }

  conversations() {
    return this.conversationsFor(this.settings.mode);
  }

  get conversation() {
    let c = this.conversationsStore.find((x) => x.id === this.conversationId);
    if (!c || (c.mode || 'code') !== this.settings.mode) {
      const list = this.conversationsFor(this.settings.mode);
      c = list[0] || null;
      if (!c) {
        c = this._blankConversation(null, this.settings.mode);
        this.conversationsStore.push(c);
      }
      this.conversationId = c.id;
      this.activeIds[this.settings.mode] = c.id;
    }
    return c;
  }

  commitMessage(msg) {
    delete msg._live;
    this.conversation.messages.push(msg);
    return msg;
  }

  _trackView(v) { this.views.push(v); v.refreshHeader(); }
  _untrackView(v) { this.views = this.views.filter((x) => x !== v); }
  syncViews() { for (const v of this.views) { try { v.refreshHeader(); } catch (e) {} } }

  /* ---- conversation ops ---- */

  newConversation() {
    const mode = this.settings.mode;
    const c = this._blankConversation(null, mode);
    this.conversationsStore.push(c);
    this.conversationId = c.id;
    this.activeIds[mode] = c.id;
    this.persistNow();
    this.syncViews();
    for (const v of this.views) { v.live = null; v._liveEl = null; v.renderTranscript(); }
  }

  openConversation(id) {
    const c = this.conversationsStore.find((x) => x.id === id);
    if (c) this.activeIds[c.mode || 'code'] = id;
    this.conversationId = id;
    this.persist();
    for (const v of this.views) { v.live = null; v._liveEl = null; v.renderTranscript(); }
  }

  deleteConversation(id) {
    const doomed = this.conversationsStore.find((c) => c.id === id);
    const mode = (doomed && doomed.mode) || this.settings.mode;
    this.conversationsStore = this.conversationsStore.filter((c) => c.id !== id);
    // Always keep one conversation per mode so the panel never lands on an empty mode.
    if (!this.conversationsStore.some((c) => (c.mode || 'code') === mode)) {
      this.conversationsStore.push(this._blankConversation(null, mode));
    }
    const list = this.conversationsFor(mode);
    this.activeIds[mode] = (list.find((c) => c.id === this.conversationId) || list[0]).id;
    if (this.settings.mode === mode) this.conversationId = this.activeIds[mode];
    this.persistNow();
    for (const v of this.views) { v.live = null; v._liveEl = null; v.renderTranscript(); }
  }

  pushUserMessage(text) {
    const msg = { role: 'user', text: String(text), ts: Date.now() };
    this.conversation.messages.push(msg);
    const conv = this.conversation;
    if (/^(对话 \d+|新对话|编程会话|学习会话)$/.test(conv.name || '')) {
      conv.name = String(text).replace(/\s+/g, ' ').trim().slice(0, 24) || conv.name;
    }
    this.persist();
    return msg;
  }

  activeNotePath() {
    const f = this.app.workspace.getActiveFile();
    return f ? f.path : '';
  }

  /** thinking 级别随模式走（学习默认更深）。 */
  activeThinking() {
    return this.settings.mode === 'study'
      ? (this.settings.studyThinking || 'high')
      : this.settings.thinking;
  }

  /* ---- labels ---- */

  modelLabel() {
    if (this.settings.mode === 'study') {
      const m = this.settings.studyModel || this.settings.model;
      const p = this.settings.studyModel ? this.settings.provider : this.settings.provider;
      const base = (p && m) ? p + '/' + m : (m || 'pi default');
      return '🎓 ' + base;
    }
    const { provider, model } = this.settings;
    if (provider && model) return provider + '/' + model;
    if (model) return model;
    return 'pi default';
  }

  cwdLabel() {
    const c = this.resolveCwd();
    return (this.settings.mode === 'study' ? '🎓 ' : '') + (path.basename(c) || c);
  }

  resolveCwd() {
    if (this.settings.mode === 'study' && this.settings.studyCwd) return this.settings.studyCwd;
    if (this.settings.cwd === 'custom' && this.settings.customCwd) return this.settings.customCwd;
    try {
      const base = this.app.vault.adapter.getBasePath ? this.app.vault.adapter.getBasePath() : null;
      if (base) return base;
    } catch (e) {}
    return process.cwd();
  }

  vaultBasePath() {
    try {
      const base = this.app.vault.adapter.getBasePath ? this.app.vault.adapter.getBasePath() : null;
      if (base) return base;
    } catch (e) {}
    return process.cwd();
  }

  /* ---- study profile (isolated人格) ---- */

  studyDir() {
    return this.settings.studyDir || studyProfile.defaultStudyDir(this.vaultBasePath());
  }

  /** 创建/修复隔离的学习 profile。不会写 ~/.pi/agent 下的任何东西。 */
  setupStudyProfile(opts) {
    const o = opts || {};
    let info;
    try {
      info = studyProfile.setupStudyProfile({
        studyDir: this.studyDir(),
        agentDir: studyProfile.homeAgentDir(),
        vaultBase: this.vaultBasePath(),
        provider: this.settings.studyModel ? this.settings.provider : '',
        model: this.settings.studyModel || '',
        thinking: this.settings.studyThinking || 'high',
        config: this.studyConfig(),
      });
    } catch (e) {
      this.studyProfileInfo = { error: e.message };
      if (!o.quiet) new Notice('学习 profile 创建失败: ' + e.message);
      return null;
    }
    this.studyProfileInfo = info;
    this.settings.studyProfileSetUp = true;
    this.settings.studyResolved = info.config;   // 供设置页回显检测结果
    if (!o.quiet) {
      const made = info.created.length ? '新建 ' + info.created.length + ' 项' : '已是最新';
      new Notice(`学习 profile：${made}\n${info.dir}`);
    }
    this.persist();
    return info;
  }

  /**
   * Assemble the StudyConfig from settings + preset. Empty fields fall through to the
   * preset, so a user only has to fill in what differs.
   */
  studyConfig() {
    const s = this.settings;
    const raw = {
      preset: s.studyPreset,
      goal: s.studyGoal || undefined,
      noteRoots: (s.studyNoteRoots && s.studyNoteRoots.length) ? s.studyNoteRoots : undefined,
      mistakeBook: s.studyMistakeBook || undefined,
      template: s.studyTemplate || undefined,
      dailyLog: s.studyDailyLog || undefined,
      statusField: s.studyStatusField || undefined,
      statusValues: (s.studyStatusValues && s.studyStatusValues.length) ? s.studyStatusValues : undefined,
      lang: s.studyLanguage || undefined,
    };
    return studyProfile.resolveConfig(raw);
  }

  /**
   * Delete the generated persona files and rebuild them from the current config.
   * Only touches files this plugin generated (AGENTS.md + the known skill names), so a
   * user's own files and settings.json survive.
   */
  regenerateStudyPersona() {
    const dir = this.studyDir();
    try {
      const agents = path.join(dir, 'AGENTS.md');
      if (fs.existsSync(agents)) fs.unlinkSync(agents);
      for (const name of studyProfile.STUDY_SKILL_NAMES) {
        const f = path.join(dir, 'skills', name, 'SKILL.md');
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    } catch (e) {
      new Notice('重新生成失败: ' + e.message);
      return;
    }
    const info = this.setupStudyProfile({ quiet: true });
    new Notice(info ? '学习人格已按当前配置重新生成' : '重新生成失败');
    this.persist();
  }

  setMode(mode) {
    if (mode !== 'code' && mode !== 'study') return;
    if (this.proc) { new Notice('有任务运行中，先中止再切换模式'); return; }
    this.settings.mode = mode;
    this.conversationId = this.activeIds[mode] || null;
    this.settings.studyProfileSetUp = this.settings.studyProfileSetUp || false;
    if (mode === 'study') this.setupStudyProfile({ quiet: true });
    this.persistNow();
    for (const v of this.views) { v.live = null; v._liveEl = null; v.renderTranscript(); v.renderSidebar(); v.refreshHeader(); }
  }

  /* ---- backend command ---- */

  buildCommand(prompt) {
    const s = this.settings;
    const conv = this.conversation;
    if (s.backend === 'pi') {
      const args = ['--mode', 'json', '-p', '--session-id', conv.piSessionId];
      if (s.mode === 'study') {
        // 学习模式：显式传入隔离目录，双保险（即使环境变量被外层覆盖也生效）。
        args.push('--session-dir', this.studySessionDir());
        if (s.allowedTools) args.push('--tools', s.allowedTools);
        if (s.studyThinking) args.push('--thinking', s.studyThinking);
        if (s.studyModel) args.push('--model', s.studyModel);
        if (s.appendSystemPrompt) args.push('--append-system-prompt', s.appendSystemPrompt);
        if (conv.name && !/^(对话 \d+|新对话|编程会话|学习会话)$/.test(conv.name)) args.push('--name', conv.name);
      } else {
        if (s.provider) args.push('--provider', s.provider);
        if (s.model) args.push('--model', s.model);
        if (s.thinking) args.push('--thinking', s.thinking);
        if (s.allowedTools) args.push('--tools', s.allowedTools);
        if (s.appendSystemPrompt) args.push('--append-system-prompt', s.appendSystemPrompt);
        if (conv.name && !/^(对话 \d+|新对话|编程会话|学习会话)$/.test(conv.name)) args.push('--name', conv.name);
      }
      // 学习模式：只加载隔离 profile 里自己的 skills，忽略 ~/.pi/agent/skills
      if (s.mode === 'study') {
        const skillsDir = path.join(this.studyDir(), 'skills');
        if (s.studySkills && fs.existsSync(skillsDir)) {
          args.push('--no-skills', '--skill', skillsDir);
        } else {
          args.push('--no-skills');
        }
      }
      args.push(prompt);
      return { bin: s.piBin || 'pi', args, json: true, prompt };
    }
    if (s.backend === 'claude') {
      return { bin: s.claudeBin || 'claude', args: ['-p', prompt], json: false, prompt };
    }
    if (s.backend === 'codex') {
      return { bin: s.codexBin || 'codex', args: ['exec', '--skip-git-repo-check', prompt], json: false, prompt };
    }
    const parts = (s.customCommand || '').split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    return { bin: parts[0], args: parts.slice(1).concat([prompt]), json: false, prompt };
  }

  studySessionDir() {
    return path.join(this.studyDir(), 'sessions');
  }

  /**
   * PATH fixes appended *after* the inherited PATH (so the user's own shell setup wins),
   * plus the directory of a piBin given as an absolute path.
   *
   * Study mode additionally redirects pi's config + session dirs to the isolated
   * profile, which is what keeps study context out of the daily pi entirely.
   */
  childEnv() {
    const env = Object.assign({}, process.env);
    const parts = [];
    if (env.PATH) parts.push(env.PATH);
    const extra = [];
    if (this.settings.piBin && this.settings.piBin.includes('/')) extra.push(path.dirname(this.settings.piBin));
    if (this.settings.extraPath) extra.push(this.settings.extraPath);
    extra.push(path.join(os.homedir(), '.local', 'bin'));
    extra.push('/opt/homebrew/bin', '/usr/local/bin');
    for (const p of extra) {
      if (p && p !== '.' && !parts.includes(p)) parts.push(p);
    }
    env.PATH = parts.join(path.delimiter || ':');

    if (this.settings.mode === 'study') {
      // 学习人格藏在独立目录：AGENTS.md / skills / sessions 都不进日常 pi 的视野。
      const dir = this.studyDir();
      env.PI_CODING_AGENT_DIR = dir;
      env.PI_CODING_AGENT_SESSION_DIR = this.studySessionDir();
      env.PI_STUDY_IN_PROFILE = '1';
    }
    return env;
  }

  async send(text) {
    if (this.proc) { new Notice('已有运行中的任务，请先中止'); return; }
    const prompt = String(text);
    this.pushUserMessage(prompt);
    for (const view of this.views) view.renderTranscript();

    const cmd = this.buildCommand(prompt);
    if (!cmd) { new Notice('未配置命令'); return; }

    if (this.settings.requireApproval) {
      const ok = await new Promise((resolve) => {
        new ApprovalModal(this.app, {
          tools: this.settings.allowedTools,
          model: this.modelLabel(),
          cwd: this.resolveCwd(),
          prompt,
        }, resolve).open();
      });
      if (!ok) { for (const v of this.views) v.setStatus('已取消'); return; }
    }

    this.runCommand(cmd);
  }

  /**
   * Only the primary view drives the state machine; other views re-render from the
   * committed transcript. Without this, two open panels would each push the same
   * assistant message into the shared conversation.
   */
  _dispatch(ev) {
    const primary = this.views[0];
    if (primary) {
      try { primary.handleEvent(ev); } catch (e) { /* one bad event must not kill the stream */ }
    }
    if (ev.type === 'turn_end' || ev.type === 'message_end' || ev.type === 'agent_settled' || ev.type === 'agent_end') {
      for (const v of this.views.slice(1)) { try { v.live = null; v.renderTranscript(); } catch (e) {} }
    }
  }

  runCommand(cmd) {
    const cwd = this.resolveCwd();
    for (const v of this.views) { v.setBusy(true); v.setStatus('启动中…'); v._beginTurn(); }

    let child;
    try {
      child = spawn(cmd.bin, cmd.args, { cwd, env: this.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      for (const v of this.views) { v.setBusy(false); v.setStatus('启动失败: ' + e.message); }
      new Notice('无法启动 ' + cmd.bin + ': ' + e.message);
      return;
    }
    this.proc = child;
    const started = Date.now();

    let stderrBuf = '';
    let aborted = false;

    if (cmd.json) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const ev = safeJson(line);
        if (!ev || !ev.type) return;
        this._dispatch(ev);
      });
      // A stray non-JSON line (extension banner, warning) must never break the stream.
      rl.on('error', () => {});
    } else {
      // Plain-text backends: stream raw stdout into one assistant message.
      child.stdout.on('data', (buf) => {
        const text = buf.toString();
        const primary = this.views[0];
        if (!primary) return;
        if (!primary.live) primary._beginTurn();
        primary.live.text += text;
        primary._ensureLiveEl();
        primary._streamFlush();
      });
    }

    child.stderr.on('data', (buf) => { stderrBuf += buf.toString(); });

    child.on('error', (err) => {
      this.proc = null;
      for (const v of this.views) { v.setBusy(false); v.setStatus('错误: ' + err.message); }
      new Notice('Pi Agent: ' + err.message);
    });

    child.on('close', (code) => {
      this.proc = null;
      aborted = theAbortFlag(this);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const primary = this.views[0];
      if (primary && primary.live) primary._commitLive(null);
      for (const v of this.views) {
        v.live = null;
        v._finalizeTurn();
        v.setBusy(false);
        v.setStatus(aborted ? ('已中止 · ' + secs + 's')
          : code === 0 ? ('完成 · ' + secs + 's')
          : ('退出码 ' + code + ' · ' + secs + 's'));
      }      if (!aborted && code !== 0 && stderrBuf.trim()) {
        const msg = this.commitMessage({
          role: 'assistant',
          text: '```\n' + stderrBuf.trim().slice(0, 4000) + '\n```',
          thinking: '', tools: [], ts: Date.now(),
        });
        for (const v of this.views) v.renderMessage(msg);
      }
      this.persist();
    });
  }

  abort() {
    if (!this.proc) return;
    this._aborted = true;
    const child = this.proc;
    try { child.kill('SIGTERM'); } catch (e) {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 1500);
    this.proc = null;
    for (const v of this.views) {
      v.setBusy(false);
      v.setStatus('已中止');
    }
    const primary = this.views[0];
    if (primary && primary.live) primary._commitLive(null);
    for (const v of this.views.slice(1)) { v.live = null; v.renderTranscript(); }
    this.persist();
  }

  async askActiveNote() {
    const f = this.app.workspace.getActiveFile();
    if (!f) { new Notice('没有打开的笔记'); return; }
    await this.activateView();
    for (const v of this.views) {
      v.inputEl.value = '@' + quoteRef(f.path) + ' ';
      v.inputEl.focus();
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PI)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_PI, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}

/** Read+reset the one-shot abort flag (kept out of the class to survive close races). */
function theAbortFlag(plugin) {
  const v = !!plugin._aborted;
  plugin._aborted = false;
  return v;
}

module.exports = PiAgentPlugin;
module.exports.PiChatView = PiChatView;
module.exports.migrateConversations = migrateConversations;
module.exports.lineDiff = lineDiff;
