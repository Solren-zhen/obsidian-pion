'use strict';
/*
 * E2E: prove study mode actually loads the learning persona from the isolated profile,
 * and that the daily pi config/session store is untouched by study runs.
 * Consumes tokens (real model calls).
 */
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'obsidian' ? __dirname + '/minidom.js' : orig.call(this, r, ...a);
};
const { spawn } = require('child_process');
const readline = require('readline');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const MAIN = path.join(__dirname, '..', 'main.js');
// Resolve the vault by walking up from this file until we pass a `.obsidian` directory,
// which is the vault root's marker. Overridable with PI_VAULT for other setups.
function findVault() {
  if (process.env.PI_VAULT) return process.env.PI_VAULT;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (path.basename(dir) === '.obsidian') return path.dirname(dir);
  }
  return process.cwd();
}
const VAULT = findVault();

function run(cmd, env, cwd) {
  return new Promise((res) => {
    const c = spawn(cmd.bin, cmd.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    readline.createInterface({ input: c.stdout }).on('line', (l) => {
      let e; try { e = JSON.parse(l); } catch (x) { return; }
      if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') out += e.assistantMessageEvent.delta;
      if (e.type === 'session') out += '';
    });
    c.stderr.on('data', (b) => { err += b; });
    c.on('close', (code) => res({ code, out, err }));
  });
}

(async () => {
  const app = {
    vault: { adapter: { getBasePath: () => VAULT } },
    workspace: { getActiveFile: () => ({ path: '408考研/00-开始这里/00-首页.md' }), on: () => ({}) },
  };
  global.__PI_APP__ = app;
  global.__PI_DATA__ = { mode: 'study' };
  delete require.cache[require.resolve(MAIN)];
  const P = require(MAIN);
  const plugin = new P(app, {});
  await plugin.onload();

  const studyDir = plugin.studyDir();
  console.log('study profile:', studyDir);
  assert.ok(fs.existsSync(path.join(studyDir, 'AGENTS.md')), 'study AGENTS.md exists');

  // Snapshot the daily pi state BEFORE the study run.
  const dailySessions = path.join(os.homedir(), '.pi', 'agent', 'sessions');
  const before = fs.existsSync(dailySessions) ? fs.readdirSync(dailySessions).sort() : [];
  const dailyAgentsPath = path.join(os.homedir(), '.pi', 'agent', 'AGENTS.md');
  const dailyAgentsBefore = fs.existsSync(dailyAgentsPath) ? fs.readFileSync(dailyAgentsPath, 'utf8') : null;
  console.log('daily sessions before:', before.length);

  plugin.setMode('study');
  plugin.pushUserMessage('用一句话说明你是谁、你的职责是什么。不要客套。');
  const cmd = plugin.buildCommand(plugin.conversation.messages[0].text);
  console.log('spawning:', cmd.bin, cmd.args.slice(0, 6).join(' '), '...');

  const r = await run(cmd, plugin.childEnv(), plugin.resolveCwd());
  console.log('\nexit code:', r.code);
  if (r.err.trim()) console.log('stderr:', r.err.trim().slice(0, 300));
  console.log('answer:', JSON.stringify(r.out.trim().slice(0, 400)));

  const after = fs.readdirSync(dailySessions).sort();
  console.log('\ndaily sessions after:', after.length);
  const studySessions = fs.readdirSync(path.join(studyDir, 'sessions'));
  console.log('study sessions written:', studySessions.length);

  assert.strictEqual(r.code, 0, 'study run should exit 0');
  assert.ok(r.out.trim().length > 0, 'should produce an answer');
  // The persona is loaded from the isolated profile, so it must describe itself as a learning coach.
  const a = r.out;
  const coachish = /学习|教练|考研|出题|复习|笔记/.test(a);
  assert.ok(coachish, 'answer should reflect the learning-coach persona, got: ' + a.slice(0, 200));
  assert.deepStrictEqual(after, before, 'daily pi session dir must be untouched by study mode');
  const dailyAgentsAfter = fs.existsSync(dailyAgentsPath) ? fs.readFileSync(dailyAgentsPath, 'utf8') : null;
  assert.strictEqual(dailyAgentsAfter, dailyAgentsBefore, 'daily pi AGENTS.md must be untouched');
  // The daily profile must never contain the study persona.
  if (dailyAgentsAfter) assert.ok(!dailyAgentsAfter.includes('学习教练'), 'study persona must not leak into daily config');
  assert.ok(studySessions.length > 0, 'study session file should be written to the isolated dir');

  console.log('\nE2E STUDY OK');
  console.log('  - learning persona loaded from isolated profile');
  console.log('  - study session written to isolated dir (' + studySessions.length + ' file(s))');
  console.log('  - daily pi sessions untouched (' + before.length + ' -> ' + after.length + ')');
})().catch((e) => { console.error('E2E STUDY FAILED:', e.message); process.exit(1); });
