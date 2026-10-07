/* End-to-end: real `pi` process → plugin's buildCommand argv → view.handleEvent → transcript. */
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { return r === 'obsidian' ? __dirname + '/minidom.js' : orig.call(this, r, ...a); };
const { spawn } = require('child_process');
const readline = require('readline');
const assert = require('assert');
const path = require('path');
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
const app = {
  vault: { adapter: { getBasePath: () => VAULT } },
  workspace: { getActiveFile: () => ({ path: 'wiki/README.md' }), on: () => ({}) },
};
global.__PI_APP__ = app; global.__PI_DATA__ = { allowedTools: 'read', provider: '', model: '' };

(async () => {
  const P = require(MAIN);
  const plugin = new P(app, {});
  await plugin.onload();
  plugin.settings.allowedTools = 'read';
  const view = new P.PiChatView({}, plugin);
  await view.onOpen();

  plugin.pushUserMessage('List the files in the wiki folder, then read 未命名.md if it exists. One short sentence.');
  view.renderTranscript();

  const cmd = plugin.buildCommand(plugin.conversation.messages[0].text);
  cmd.args[cmd.args.length - 1] = 'Use the read tool only. Reply with exactly: OK';
  console.log('spawning:', cmd.bin, cmd.args.slice(0, 8).join(' '), '...');

  const child = spawn(cmd.bin, cmd.args, { cwd: plugin.resolveCwd(), env: plugin.childEnv(), stdio: ['ignore','pipe','pipe'] });
  let n = 0, err = '';
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let ev; try { ev = JSON.parse(line); } catch (e) { return; }
    n++;
    try { view.handleEvent(ev); } catch (e) { console.log('  !! handleEvent threw on', ev.type, e.message); }
  });
  child.stderr.on('data', (b) => { err += b; });
  const code = await new Promise((r) => child.on('close', r));
  if (view.live) view._commitLive(null);

  console.log('\n-- real pi exited with code', code, '| events:', n, '| stderr:', err.trim().slice(0, 200) || '(none)');
  const msgs = plugin.conversation.messages;
  console.log('-- transcript:');
  for (const m of msgs) {
    if (m.role === 'user') console.log('   [user]', JSON.stringify(m.text));
    else {
      console.log('   [assistant] text=' + JSON.stringify((m.text||'').slice(0, 120)));
      if (m.thinking) console.log('       thinking: ' + m.thinking.length + ' chars');
      for (const t of m.tools) console.log('       tool:', t.name, JSON.stringify(t.args), t.isError ? 'ERROR' : 'ok', '| result', JSON.stringify(String(t.result).slice(0,60)));
    }
  }
  assert.strictEqual(code, 0, 'pi exited non-zero');
  assert.ok(n > 3, 'expected a real event stream');
  assert.ok(msgs.length >= 2, 'user + assistant committed');
  assert.strictEqual(msgs[msgs.length-1].role, 'assistant');
  assert.ok(!msgs.some(m => m.role === 'tool'), 'no top-level tool messages');
  assert.ok(plugin.conversation.piSessionId && plugin.conversation.piSessionId.length > 8, 'session id captured');
  console.log('\nE2E OK — real pi output rendered into the transcript without errors.');
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
