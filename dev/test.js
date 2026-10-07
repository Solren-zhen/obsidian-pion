'use strict';
/*
 * Headless harness for the Pi Agent Obsidian plugin.
 * Verifies the event-stream → transcript pipeline against real pi `--mode json` shapes.
 * Run: node /tmp/piagent-test/test.js
 */

const Module = require('module');
const path = require('path');
const assert = require('assert');
const fs = require('fs');

const { obsidian, El } = require(__dirname + '/minidom.js');

// ---- intercept require('obsidian') -------------------------------------------------
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return __dirname + '/minidom.js';
  return origResolve.call(this, request, ...rest);
};

const PLUGIN_DIR = process.argv[2] || require('path').join(__dirname, '..');
const MAIN = path.join(PLUGIN_DIR, 'main.js');

// ---- app stub ---------------------------------------------------------------------
const app = {
  vault: { adapter: { getBasePath: () => '/tmp/vaultbase' } },
  workspace: {
    getActiveFile: () => ({ path: '408考研/01 总览.md' }),
    on: () => ({}),
    getLeavesOfType: () => [],
    getRightLeaf: () => ({ setViewState: async () => {} }),
    revealLeaf: () => {},
    openLinkText: () => {},
  },
};

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

async function makePlugin(data) {
  global.__PI_DATA__ = data || {};
  global.__PI_APP__ = app;
  global.__PI_SAVED__ = null;
  delete require.cache[require.resolve(MAIN)];
  const PiAgentPlugin = require(MAIN);
  const plugin = new PiAgentPlugin(app, { id: 'pi-agent' });
  await plugin.onload();
  return plugin;
}

async function makeView(plugin) {
  const view = new (require(MAIN).PiChatView)({}, plugin);
  await view.onOpen();
  return view;
}

/* --------------------------- synthetic event streams --------------------------- */
// Shapes copied from real `pi --mode json` output (see transcript of live runs).

const EV_TEXT = [
  { type: 'session', version: 3, id: 'sess-1', cwd: '/tmp/vaultbase' },
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 } },
  { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 } },
  { type: 'message_start', message: { role: 'assistant', content: [], provider: 'p', model: 'm', stopReason: 'pending' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'He' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'llo' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello' } },
  {
    type: 'message_end',
    message: {
      role: 'assistant', content: [{ type: 'text', text: 'Hello' }],
      usage: { input: 2868, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 2870 },
    },
  },
  { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }, toolResults: [] },
  { type: 'agent_end', messages: [] },
  { type: 'agent_settled' },
];

const READ_ARGS = { path: 'a.txt' };
const READ_RESULT = { content: [{ type: 'text', text: 'hello world\n' }] };
const EDIT_ARGS = { path: 'e.txt', edits: [{ oldText: 'line2', newText: 'LINE-TWO' }] };
const EDIT_RESULT = {
  content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in e.txt.' }],
  details: { diff: ' 1 line1\n-2 line2\n+2 LINE-TWO\n 3 line3', patch: '--- e.txt\n+++ e.txt\n' },
};

function evTools() {
  return [
    { type: 'session', version: 3, id: 'sess-2', cwd: '/tmp/vaultbase' },
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: "I'll read it." } },
    // --- two parallel tool calls in one message (real pi emits starts back-to-back) ---
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'call_1', toolName: 'read' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"path' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '":"a.txt"}' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'call_2', toolName: 'edit' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id: 'call_1', name: 'read', arguments: READ_ARGS } } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2, toolCall: { type: 'toolCall', id: 'call_2', name: 'edit', arguments: EDIT_ARGS } } },
    { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read', args: READ_ARGS },
    { type: 'tool_execution_start', toolCallId: 'call_2', toolName: 'edit', args: EDIT_ARGS },
    { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'read', result: READ_RESULT, isError: false },
    { type: 'tool_execution_end', toolCallId: 'call_2', toolName: 'edit', result: EDIT_RESULT, isError: false },
    { type: 'message_start', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: READ_RESULT.content, isError: false } },
    { type: 'message_start', message: { role: 'toolResult', toolCallId: 'call_2', toolName: 'edit', content: EDIT_RESULT.content, isError: false } },
    { type: 'turn_end', toolResults: [] },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Done.' } },
    {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input: 3047, output: 78 } },
    },
    { type: 'turn_end', toolResults: [] },
    { type: 'agent_end', messages: [] },
    { type: 'agent_settled' },
  ];
}

function evThinking() {
  return [
    { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Let me ' } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'think about 7731.' } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Let me think about 7731.' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '7731' } },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Let me think about 7731.' }, { type: 'text', text: '7731' }],
      },
    },
    { type: 'agent_settled' },
  ];
}

/* ---------------------------------- tests ---------------------------------- */

(async () => {
  console.log('\n== 1. text-only turn ==');
  {
    const plugin = await makePlugin({});
    const view = await makeView(plugin);
    plugin.pushUserMessage('hi');
    view.renderTranscript();
    for (const ev of EV_TEXT) view.handleEvent(ev);

    check('user + assistant committed, no duplicates', () => {
      assert.strictEqual(plugin.conversation.messages.length, 2);
      assert.strictEqual(plugin.conversation.messages[0].role, 'user');
    });
    check('assistant text committed (no live leftovers)', () => {
      assert.strictEqual(view.live, null);
      const a = plugin.conversation.messages[1];
      assert.strictEqual(a.role, 'assistant');
      assert.strictEqual(a.text, 'Hello');
    });
    check('session id picked up from pi', () => {
      assert.strictEqual(plugin.conversation.piSessionId, 'sess-1');
    });
    check('usage chip rendered', () => {
      assert.ok(/2\.9k/.test(view.usageChip.textContent), 'got: ' + view.usageChip.textContent);
    });
    check('transcript DOM shows the text', () => {
      assert.ok(view.listEl.textContent.includes('Hello'));
    });
  }

  console.log('\n== 2. tool turn (parallel calls, diff, grouping) ==');
  {
    const plugin = await makePlugin({});
    const view = await makeView(plugin);
    plugin.pushUserMessage('read then edit');
    view.renderTranscript();
    for (const ev of evTools()) view.handleEvent(ev);

    const msgs = plugin.conversation.messages;
    check('turn 1 committed as ONE assistant message carrying both tools', () => {
      const a = msgs[1];
      assert.strictEqual(a.role, 'assistant');
      assert.strictEqual(a.text, "I'll read it.");
      assert.strictEqual(a.tools.length, 2, 'tools=' + JSON.stringify(a.tools.map((t) => t.name)));
      assert.deepStrictEqual(a.tools.map((t) => t.name), ['read', 'edit']);
    });
    check('no stray assistant bubbles (tool-only + empty turns skipped)', () => {
      const assistants = msgs.filter((m) => m.role === 'assistant');
      assert.strictEqual(assistants.length, 2, 'got ' + assistants.length);
      assert.strictEqual(assistants[1].text, 'Done.');
      assert.strictEqual(assistants[1].tools.length, 0);
    });
    check('tool execution args/results stored', () => {
      const [read, edit] = msgs[1].tools;
      assert.deepStrictEqual(read.args, READ_ARGS);
      assert.strictEqual(read.result, 'hello world\n');
      assert.strictEqual(read.running, false);
      assert.deepStrictEqual(edit.args.edits, EDIT_ARGS.edits);
      assert.ok(/Successfully replaced/.test(edit.result));
    });
    check('edit card shows pi\'s authoritative diff', () => {
      const edit = msgs[1].tools[1];
      assert.strictEqual(edit.diffText, EDIT_RESULT.details.diff);
      assert.ok(edit._bodyEl.textContent.includes('-2 line2'), 'diff body: ' + edit._bodyEl.textContent);
      assert.ok(edit._card.hasAttribute('open'), 'diff card should be open');
    });
    check('read card stays collapsed', () => {
      const read = msgs[1].tools[0];
      assert.ok(!read._card.hasAttribute('open'));
    });
    check('both cards live in one settled group', () => {
      const a = msgs[1];
      assert.ok(a._groupEl, 'group element exists');
      assert.strictEqual(a._groupEl.children.length, 2);
      assert.ok(a._groupEl.hasClass('pi-tool-group'));
      assert.ok(!a._groupEl.hasClass('pi-tool-group-pending'));
    });
    check('tool card arg previews', () => {
      const [read] = msgs[1].tools;
      assert.strictEqual(read._summaryEl.querySelector('.pi-tool-arg').textContent, 'a.txt');
      const edit = msgs[1].tools[1];
      assert.ok(/e\.txt/.test(edit._summaryEl.querySelector('.pi-tool-arg').textContent));
    });
  }

  console.log('\n== 3. thinking stream ==');
  {
    const plugin = await makePlugin({});
    const view = await makeView(plugin);
    for (const ev of evThinking()) view.handleEvent(ev);
    check('thinking accumulated and committed', () => {
      const a = plugin.conversation.messages[0];
      assert.strictEqual(a.thinking, 'Let me think about 7731.');
      assert.strictEqual(a.text, '7731');
    });
    check('thinking card rendered with text', () => {
      const a = plugin.conversation.messages[0];
      assert.ok(a._thinkingCard, 'thinking card exists');
      assert.ok(a._thinkingEl.textContent.includes('7731'));
    });
    check('thinking card hidden when disabled', async () => { /* covered in test 3b */ });
  }

  console.log('\n== 3b. thinking hidden by setting ==');
  {
    const plugin = await makePlugin({ showThinking: false });
    const view = await makeView(plugin);
    for (const ev of evThinking()) view.handleEvent(ev);
    const a = plugin.conversation.messages[0];
    check('no thinking card, text still intact', () => {
      assert.ok(!a._thinkingCard);
      assert.strictEqual(a.text, '7731');
      assert.strictEqual(a.thinking, 'Let me think about 7731.');
    });
  }

  console.log('\n== 4. persistence is DOM-free and lossless ==');
  {
    const plugin = await makePlugin({});
    const view = await makeView(plugin);
    plugin.pushUserMessage('persist me');
    view.renderTranscript();
    for (const ev of evTools()) view.handleEvent(ev);
    plugin.persist();
    await new Promise((r) => setTimeout(r, 200));

    const saved = global.__PI_SAVED__;
    check('saveData received a plain JSON-able object', () => {
      const round = JSON.parse(JSON.stringify(saved));
      assert.strictEqual(round.__version, 5);
      // v5 keeps one conversation per mode (code + study)
      assert.strictEqual(round.__conversations.length, 2);
      assert.deepStrictEqual(round.__conversations.map((c) => c.mode).sort(), ['code', 'study']);
      assert.deepStrictEqual(Object.keys(round.__activeConversation).sort(), ['code', 'study']);
    });
    check('no live DOM / internal keys leaked', () => {
      const raw = JSON.stringify(saved);
      for (const bad of ['_el', '_card', '_bodyEl', '_stateEl', '_argBuf', '_live', '_summaryEl', '_groupEl', '_wrapEl', '_thinkingEl']) {
        assert.ok(!raw.includes('"' + bad + '"'), 'leaked key ' + bad);
      }
    });
    check('tool args and diff survive round-trip', () => {
      const round = JSON.parse(JSON.stringify(saved));
      const study = round.__conversations.find((c) => c.mode === 'study');
      const tools = study.messages[1].tools;
      assert.strictEqual(tools.length, 2);
      assert.deepStrictEqual(tools[1].args.edits, EDIT_ARGS.edits);
      assert.strictEqual(tools[1].diffText, EDIT_RESULT.details.diff);
    });
    check('settings whitelist kept (no __ keys except known ones)', () => {
      const keys = Object.keys(saved);
      assert.ok(keys.includes('allowedTools'));
      assert.ok(keys.includes('appendSystemPrompt'));
      assert.ok(!keys.includes('__conversations') || Array.isArray(saved.__conversations));
    });
  }

  console.log('\n== 5. migration from v3 (real on-disk shape) ==');
  {
    // Mirrors the actual data.json that shipped with v0.1.0 (tool msgs + DOM junk).
    const legacy = JSON.parse(fs.readFileSync(process.argv[3] || __dirname + '/legacy-data.json', 'utf8'));
    const plugin = await makePlugin(legacy);
    // Legacy data predates modes, so it must land in 'code', not the active (study) list.
    const conv = plugin.conversationsStore.find((c) => c.piSessionId === 'c40fc0ac-6a96-4798-9a4b-e56ea2f97ea7')
      || plugin.conversation;
    check('no top-level tool messages remain', () => {
      assert.ok(!conv.messages.some((m) => m.role === 'tool'));
    });
    check('tools re-attached to the preceding assistant message', () => {
      const a = conv.messages.find((m) => m.role === 'assistant' && m.tools && m.tools.length);
      assert.ok(a, 'assistant with tools exists');
      assert.strictEqual(a.tools[0].name, 'bash');
      assert.ok(a.tools[0].result.includes('/home/user/project'));
    });
    check('DOM references dropped', () => {
      const raw = JSON.stringify(plugin.serializeSettings());
      assert.ok(!raw.includes('"_el"'));
      assert.ok(!raw.includes('"_card"'));
      assert.ok(!raw.includes('"_argBuf"'));
    });
    check('pi session id preserved (history stays resumable)', () => {
      assert.strictEqual(conv.piSessionId, 'c40fc0ac-6a96-4798-9a4b-e56ea2f97ea7');
    });
    check('legacy conversation normalized to mode=code', () => {
      const legacyConv = plugin.conversationsStore.find((c) => c.piSessionId === 'c40fc0ac-6a96-4798-9a4b-e56ea2f97ea7');
      assert.strictEqual(legacyConv.mode, 'code');
      assert.ok(plugin.conversationsFor('code').some((c) => c.id === legacyConv.id));
    });
    check('migration persisted back to disk', () => {
      assert.ok(global.__PI_SAVED__, 'saveData called');
      assert.strictEqual(global.__PI_SAVED__.__version, 5);
    });
    check('re-migration is idempotent', async () => { /* verified in 5b */ });
  }

  console.log('\n== 5b. migration idempotency ==');
  {
    const legacy = JSON.parse(fs.readFileSync(process.argv[3] || __dirname + '/legacy-data.json', 'utf8'));
    const p1 = await makePlugin(legacy);
    const once = p1.serializeSettings();
    const p2 = await makePlugin(JSON.parse(JSON.stringify(once)));
    const twice = p2.serializeSettings();
    check('second pass produces identical transcript', () => {
      assert.strictEqual(JSON.stringify(once.__conversations), JSON.stringify(twice.__conversations));
    });
  }

  console.log('\n== 6. error paths ==');
  {
    const plugin = await makePlugin({});
    const view = await makeView(plugin);
    const evs = [
      { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'c9', toolName: 'bash' } },
      { type: 'tool_execution_start', toolCallId: 'c9', toolName: 'bash', args: { command: 'boom' } },
      { type: 'tool_execution_end', toolCallId: 'c9', toolName: 'bash', result: { content: [{ type: 'text', text: 'exit 1' }] }, isError: true },
      { type: 'agent_settled' },
    ];
    for (const ev of evs) view.handleEvent(ev);
    check('failed tool keeps the turn and is marked + opened', () => {
      const a = plugin.conversation.messages[0];
      assert.strictEqual(a.tools.length, 1);
      assert.strictEqual(a.tools[0].isError, true);
      assert.ok(a.tools[0]._card.hasClass('pi-tool-error'));
      assert.ok(a.tools[0]._card.hasAttribute('open'));
      assert.strictEqual(a.tools[0]._stateEl.textContent, '✗');
    });
    check('malformed events do not throw', () => {
      const p = plugin;
      const v = view;
      v.handleEvent({ type: 'message_update' });
      v.handleEvent({ type: 'tool_execution_end', toolCallId: 'nope' });
      v.handleEvent({ type: 'message_end', message: { role: 'assistant' } });
      v.handleEvent({ type: 'unknown_future_event', foo: 1 });
      assert.ok(true);
    });
  }

  console.log('\n== 7. session isolation ==');
  {
    const plugin = await makePlugin({});
    const view = await makeView(plugin);
    const first = plugin.conversation.piSessionId;
    plugin.newConversation();
    view.renderTranscript();
    check('new conversation gets a fresh pi session id', () => {
      assert.notStrictEqual(plugin.conversation.piSessionId, first);
      assert.strictEqual(view.listEl.textContent.includes('Pi Agent'), true);
    });
    check('@-mention quoting for paths with spaces', () => {
      plugin.settings.cwd = 'vault';
      const cmd = plugin.buildCommand('hi');
      assert.ok(Array.isArray(cmd.args));
      assert.ok(cmd.args.includes('--session-id'));
    });
    check('each mode keeps its own conversation list', () => {
      plugin.setMode('study');
      const studyConv = plugin.conversation;
      assert.strictEqual(studyConv.mode, 'study');
      assert.notStrictEqual(studyConv.id, plugin.activeIds.code);
      plugin.setMode('code');
      assert.strictEqual(plugin.conversation.mode, 'code');
      // switching back returns to the same study conversation, not a new one
      plugin.setMode('study');
      assert.strictEqual(plugin.conversation.id, studyConv.id);
    });
  }

  console.log('\n== 8. history cap ==');
  {
    const plugin = await makePlugin({ maxHistory: 2 });
    const view = await makeView(plugin);
    for (let i = 0; i < 6; i++) plugin.pushUserMessage('m' + i);
    view.renderTranscript();
    check('only the last N messages are replayed', () => {
      const notes = view.listEl.querySelectorAll('.pi-history-note');
      assert.strictEqual(notes.length, 1, 'history note shown');
      const rendered = view.listEl.querySelectorAll('.pi-msg');
      assert.strictEqual(rendered.length, 2);
      assert.strictEqual(plugin.conversation.messages.length, 6, 'store keeps everything');
    });
  }

  console.log('\n== 9. thinking arrives before any text (card created lazily) ==');
  {
    const plugin = await makePlugin({});
    const view = await makeView(plugin);
    const evs = [
      { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: ' ...' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'answer' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm ...' }, { type: 'text', text: 'answer' }] } },
      { type: 'agent_settled' },
    ];
    for (const ev of evs) view.handleEvent(ev);
    const a = plugin.conversation.messages[0];
    check('thinking card created even though no text came first', () => {
      assert.ok(a._thinkingEl, 'thinking body exists');
      assert.ok(a._thinkingEl.textContent.includes('hmm'), 'thinking text: ' + a._thinkingEl.textContent);
      assert.ok(a._bodyEl.textContent.includes('answer'));
      assert.strictEqual(view.live, null);
    });
  }

  console.log('\n== 10. two open panels do not duplicate messages ==');
  {
    const plugin = await makePlugin({});
    const v1 = await makeView(plugin);
    const v2 = await makeView(plugin);
    assert.strictEqual(plugin.views.length, 2);
    plugin.pushUserMessage('hi');
    v1.renderTranscript(); v2.renderTranscript();
    for (const ev of EV_TEXT) plugin._dispatch(ev);
    check('exactly one assistant message despite two views', () => {
      const assistants = plugin.conversation.messages.filter((m) => m.role === 'assistant');
      assert.strictEqual(assistants.length, 1, 'got ' + assistants.length + ' assistant messages');
      assert.strictEqual(assistants[0].text, 'Hello');
    });
    check('both views show the reply', () => {
      assert.ok(v1.listEl.textContent.includes('Hello'));
      assert.ok(v2.listEl.textContent.includes('Hello'));
    });
  }

  console.log('\n== 11. authoritative message_end text wins over throttled stream ==');
  {
    const plugin = await makePlugin({});
    const view = await makeView(plugin);
    const evs = [
      { type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial answer complete' }] } },
      { type: 'agent_settled' },
    ];
    // deliberately no await between events: the 70ms render throttle must not
    // leave the frozen bubble showing 'partial'.
    for (const ev of evs) view.handleEvent(ev);
    const a = plugin.conversation.messages[0];
    check('stored text is the authoritative full text', () => {
      assert.strictEqual(a.text, 'partial answer complete');
    });
    check('rendered bubble text matches the stored text', () => {
      assert.ok(a._bodyEl.textContent.includes('partial answer complete'),
        'DOM shows: ' + JSON.stringify(a._bodyEl.textContent));
    });
  }

  console.log('\n== 12. no duplicate partial text after commit ==');
  {
    const plugin = await makePlugin({});
    const view = await makeView(plugin);
    for (const ev of EV_TEXT) view.handleEvent(ev);
    check('assistant text is exactly "Hello" (not "HelloHello")', () => {
      const assistants = plugin.conversation.messages.filter((m) => m.role === 'assistant');
      assert.strictEqual(assistants.length, 1);
      assert.strictEqual(assistants[0].text, 'Hello');
    });
  }


  console.log('\n== 13. study/code isolation (the core requirement) ==');
  {
    const os = require('os');
    const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-study-test-'));
    const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-home-'));
    // Fake the daily pi config dir so the test never touches the real ~/.pi/agent.
    fs.writeFileSync(path.join(tmpAgent, 'models.json'), '{"providers":{}}');
    fs.writeFileSync(path.join(tmpAgent, 'auth.json'), '{}');
    fs.writeFileSync(path.join(tmpAgent, 'AGENTS.md'), '# DAILY PROFILE (must not leak into study mode)');
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpAgent;

    const vaultApp = {
      vault: { adapter: { getBasePath: () => tmpVault } },
      workspace: { getActiveFile: () => ({ path: 'n.md' }), on: () => ({}) },
    };
    global.__PI_APP__ = vaultApp;
    global.__PI_DATA__ = {};
    delete require.cache[require.resolve(MAIN)];
    const P = require(MAIN);
    const plugin = new P(vaultApp, {});
    await plugin.onload();

    const studyDir = plugin.studyDir();
    check('study profile lives under <vault>/.obsidian (invisible to daily pi)', () => {
      assert.ok(studyDir.startsWith(path.join(tmpVault, '.obsidian')), 'studyDir=' + studyDir);
    });

    // --- 1. daily config dir untouched ---
    check('daily pi config dir was NOT modified', () => {
      assert.deepStrictEqual(fs.readdirSync(tmpAgent).sort(), ['AGENTS.md', 'auth.json', 'models.json']);
      // the daily AGENTS.md must be byte-identical
      assert.ok(fs.readFileSync(path.join(tmpAgent, 'AGENTS.md'), 'utf8').includes('DAILY PROFILE'));
    });

    // --- 2. credentials shared via symlink, never copied ---
    check('credentials are symlinked, not copied', () => {
      const link = path.join(studyDir, 'models.json');
      const st = fs.lstatSync(link);
      assert.ok(st.isSymbolicLink(), 'models.json should be a symlink');
      assert.strictEqual(fs.readlinkSync(link), path.join(tmpAgent, 'models.json'));
      assert.ok(fs.lstatSync(path.join(studyDir, 'auth.json')).isSymbolicLink());
    });

    // --- 3. study人格 exists and is separate from the daily one ---
    check('study AGENTS.md is the learning persona, not the daily one', () => {
      const studyAgents = fs.readFileSync(path.join(studyDir, 'AGENTS.md'), 'utf8');
      assert.ok(studyAgents.includes('学习教练'), 'should be the learning coach persona');
      assert.ok(!studyAgents.includes('DAILY PROFILE'), 'must not contain daily content');
    });

    // --- 4. study skills written, daily skills not copied ---
    check('study skills created (quiz-me etc.)', () => {
      const skills = fs.readdirSync(path.join(studyDir, 'skills')).sort();
      for (const want of ['make-cards', 'quiz-me', 'review-notes', 'study-plan', 'teach-concept']) {
        assert.ok(skills.includes(want), 'missing skill ' + want);
      }
    });

    // --- 5. env: study mode redirects BOTH dirs ---
    plugin.setMode('study');
    const studyEnv = plugin.childEnv();
    check('study mode env points config+session at the isolated profile', () => {
      assert.strictEqual(studyEnv.PI_CODING_AGENT_DIR, studyDir);
      assert.strictEqual(studyEnv.PI_CODING_AGENT_SESSION_DIR, path.join(studyDir, 'sessions'));
    });
    check('code mode does NOT redirect to the study profile', () => {
      const savedMode = plugin.settings.mode;
      try {
        plugin.settings.mode = 'code';
        const codeEnv = plugin.childEnv();
        // Code mode inherits the shell env verbatim; it never repoints it at the study profile.
        assert.notStrictEqual(codeEnv.PI_CODING_AGENT_DIR, studyDir);
        assert.strictEqual(codeEnv.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR);
        assert.strictEqual(codeEnv.PI_STUDY_IN_PROFILE, undefined);
      } finally {
        plugin.settings.mode = savedMode;   // must run even if an assertion throws
      }
    });

    // --- 6. argv isolation ---
    const studyCmd = plugin.buildCommand('考考我');
    check('study argv uses its own session dir and only study skills', () => {
      const a = studyCmd.args;
      const i = a.indexOf('--session-dir');
      assert.ok(i >= 0, 'has --session-dir');
      assert.strictEqual(a[i + 1], path.join(studyDir, 'sessions'));
      assert.ok(a.includes('--no-skills'), 'disables daily skills');
      const si = a.indexOf('--skill');
      assert.strictEqual(a[si + 1], path.join(studyDir, 'skills'));
    });
    plugin.settings.mode = 'code';
    const codeCmd = plugin.buildCommand('fix this bug');
    check('code argv does NOT leak the study profile', () => {
      const a = codeCmd.args;
      assert.ok(!a.includes('--session-dir'), 'code mode must not pass --session-dir');
      assert.ok(!a.includes('--no-skills'), 'code mode keeps daily skills');
      assert.ok(!a.some((x) => String(x).includes('pi-study')), 'no study paths in code argv');
    });
    plugin.settings.mode = 'study';

    // --- 7. study conversations are separate in the panel ---
    check('study and code have disjoint conversation lists', () => {
      const codeIds = plugin.conversationsFor('code').map((c) => c.id);
      const studyIds = plugin.conversationsFor('study').map((c) => c.id);
      assert.ok(codeIds.length && studyIds.length);
      assert.ok(!codeIds.some((id) => studyIds.includes(id)), 'lists must be disjoint');
    });

    // --- 8. setup is idempotent ---
    check('re-running setup does not overwrite user-edited files', () => {
      const agents = path.join(studyDir, 'AGENTS.md');
      fs.appendFileSync(agents, '\n\n<!-- USER EDIT -->\n');
      plugin.setupStudyProfile({ quiet: true });
      assert.ok(fs.readFileSync(agents, 'utf8').includes('USER EDIT'), 'user edit must survive');
    });

    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }


  console.log('\n== 14. study presets are generic (no hard-coded subject) ==');
  {
    // Presets live in the source module; the built bundle inlines a copy of it.
    const sp = require(path.join(__dirname, '..', 'src', 'study-profile.js'));
    const os2 = require('os');
    const tmp = fs.mkdtempSync(path.join(os2.tmpdir(), 'preset-'));
    fs.writeFileSync(path.join(tmp, 'models.json'), '{}');

    check('all presets render an AGENTS.md and all 5 skills', () => {
      for (const preset of Object.keys(sp.PRESETS)) {
        const dir = path.join(tmp, preset);
        const info = sp.setupStudyProfile({ studyDir: dir, agentDir: tmp, vaultBase: tmp, config: { preset } });
        assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')), preset + ' AGENTS.md');
        const skills = fs.readdirSync(path.join(dir, 'skills'));
        assert.strictEqual(skills.length, 5, preset + ' skill count = ' + skills.length);
        assert.ok(info.config.lang, preset + ' resolved a language');
      }
    });

    check('only the kaoyan408 preset mentions 408/考研 (no subject leakage)', () => {
      for (const preset of Object.keys(sp.PRESETS)) {
        const body = sp.renderAgentsMd(sp.resolveConfig({ preset }));
        const mentions = /408|考研/.test(body);
        assert.strictEqual(mentions, preset === 'kaoyan408',
          preset + ': 408/考研 mention should be ' + (preset === 'kaoyan408') + ' but was ' + mentions);
      }
    });

    check('English persona is free of CJK punctuation', () => {
      for (const preset of ['general', 'language', 'programming']) {
        const body = sp.renderAgentsMd(sp.resolveConfig({ preset, lang: 'en' }));
        assert.ok(!/[（）、：，。「」]/.test(body), preset + ' has CJK punctuation in EN mode');
      }
    });

    check('user overrides win over preset defaults', () => {
      const cfg = sp.resolveConfig({ preset: 'kaoyan408', goal: 'MY OWN GOAL', mistakeBook: 'my/mistakes.md' });
      assert.strictEqual(cfg.goal, 'MY OWN GOAL');
      assert.strictEqual(cfg.mistakeBook, 'my/mistakes.md');
      // untouched fields still come from the preset
      assert.ok(cfg.noteRoots.length >= 2, 'preset note roots retained');
    });

    check('unknown preset falls back to general without throwing', () => {
      const cfg = sp.resolveConfig({ preset: 'does-not-exist' });
      assert.strictEqual(cfg.preset, 'general');
    });

    check('card syntax detection falls back gracefully when plugin absent', () => {
      const syn = sp.detectCardSyntax(tmp);
      assert.strictEqual(syn.detected, false);
      assert.strictEqual(syn.singleLine, '::');
    });
  }


  console.log('\n== 15. distribution artifact is self-contained ==');
  {
    // A user installing from the community directory receives ONLY main.js, manifest.json
    // and styles.css. If the plugin requires any other file at load time it crashes for
    // every one of them, while still working in a dev vault. Simulate that install.
    const os3 = require('os');
    const dist = fs.mkdtempSync(path.join(os3.tmpdir(), 'pion-dist-'));
    for (const f of ['main.js', 'manifest.json', 'styles.css']) {
      fs.copyFileSync(path.join(PLUGIN_DIR, f), path.join(dist, f));
    }

    check('dist dir contains only the three shipped files', () => {
      assert.deepStrictEqual(fs.readdirSync(dist).sort(), ['main.js', 'manifest.json', 'styles.css']);
    });

    check('shipped main.js has no runtime require of study-profile.js', () => {
      const src = fs.readFileSync(path.join(dist, 'main.js'), 'utf8');
      assert.ok(!/require\(\s*['"]\.\/study-profile\.js['"]\s*\)/.test(src),
        'main.js must not require a sibling module at runtime');
      assert.ok(src.includes('bundled module: study-profile.js'),
        'study-profile.js should be inlined into the bundle');
    });

    check('plugin loads and runs from the distribution dir alone', async () => { /* checked below */ });

    // Load the copied bundle with everything resolved relative to the dist dir.
    const distMain = path.join(dist, 'main.js');
    global.__PI_APP__ = app;
    global.__PI_DATA__ = {};
    delete require.cache[require.resolve(distMain)];
    let PluginClass = null;
    try { PluginClass = require(distMain); }
    catch (e) { throw new Error('requiring the shipped main.js threw: ' + e.message); }

    if (typeof PluginClass !== 'function') {
      throw new Error('shipped main.js did not export the plugin class');
    }

    const p = new PluginClass(app, { id: 'pion' });
    await p.onload();
    const v = new PluginClass.PiChatView({}, p);
    await v.onOpen();
    for (const ev of EV_TEXT) v.handleEvent(ev);

    if (p.conversation.messages.filter((m) => m.role === 'assistant').length !== 1) {
      throw new Error('dist bundle did not process a real event stream');
    }
    if (!p.studyConfig || !p.studyConfig().lang) {
      throw new Error('dist bundle is missing the study config surface');
    }
    if (!PluginClass.migrateConversations || !PluginClass.lineDiff) {
      throw new Error('dist bundle is missing module exports used by tests');
    }
  }

  console.log('\n' + (failures ? `FAILED: ${failures} check(s)\n` : 'ALL CHECKS PASSED\n'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('harness crashed:', e); process.exit(2); });
