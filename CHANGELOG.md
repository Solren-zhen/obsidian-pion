# Changelog

All notable changes to Pion are documented here. This project follows
[Semantic Versioning](https://semver.org/) and
[Conventional Commits](https://www.conventionalcommits.org/).

## [0.6.0]

Fixes two defects that broke whole surfaces (source build, settings tab), completes the
wired-but-dead selection-attachment feature, stops the panel from getting slower the longer
it is used, and upgrades the pi backend to the long-lived RPC transport with per-tool
approval.

### Added

- **A quiet welcome screen.** The empty state is now the official pi logo (extracted from
  PI-Desktop.app, dark/light variants, embedded as data URLs in styles.css so the three-
  file release keeps working), a mode-aware serif title, and three plain-text action
  shortcuts — deliberately spare after feedback that the first version read as
  template-generated: no tagline, no keybinding hint, no pill chips, no gradient block.
- **Deterministic review scheduling (study mode).** The toolbar gains a 复习清单 button:
  the plugin scans note frontmatter (via Obsidian's in-memory metadataCache — no fs, no
  external processes) for entries at the weak end of the 掌握度 values, sorts them
  weakness-first then staleness-first, and puts a ready-to-send review prompt with the
  top 15 (linked, with days-since-touched and a per-status tally) into the input box.
  Scheduling moves from LLM guesswork to code; the agent just teaches.
- **One-click study log export (study mode).** A second toolbar button appends the
  current conversation as a timestamped section (turns trimmed, plus the current weak
  spots) to a dated 学习记录 note under the configured 日志/计划目录, creating the folder
  and file as needed — learning results finally land in the vault instead of only
  data.json. Both features are study-mode-only buttons and write exclusively inside the
  vault; nothing in `~/.pi` is touched.
- **RPC transport (new default for the pi backend).** One long-lived `pi --mode rpc` child
  per conversation replaces the one-shot `--mode json -p` spawn. This unlocks what a
  request/response CLI never could: messages sent while a run is in flight are delivered as
  `steer` (redirect the current turn) or `follow_up` (queue until it ends) instead of being
  refused with "已有运行中的任务"; Stop is a graceful `abort` command that keeps the turn as
  history instead of a SIGTERM kill (SIGKILL only after 1.4s without cooperation); retries
  surface in the status bar (`连接重试中 (n/N)…`) instead of happening invisibly; and
  `queue_update` events show pending-message counts. The child is bound to (mode,
  conversation) and restarts on switches; closing stdin shuts it down gracefully. The old
  transport remains selectable as 传输方式 → json.
- **Per-tool approval in RPC mode.** pi itself never asks before running a tool. The plugin
  now materialises a small extension (`pi-approve.js`, fixed content) into its own directory
  and loads it with `-e`: tools matching the new 工具审批 setting (default `bash,write,edit`,
  `*` = all, empty = off) route through `ctx.ui.confirm`, which under RPC surfaces as an
  `extension_ui_request` and is answered by a native Obsidian allow/deny modal. Notification
  requests are surfaced as Notices; unsupported dialog methods (select/input/editor) are
  answered with `cancelled`.
- **`dev/arch-rpc.html`** — the plugin↔pi RPC interaction sequence as a standalone,
  theme-switchable SVG document.
- dev/test.js gains an RPC transport suite: hand-written LF framing (pi's docs forbid
  readline — U+2028/U+2029 are legal inside JSON strings), plus a mock pi child covering
  response matching, event forwarding, failure rejection, unknown commands, the
  approval round-trip and graceful shutdown.

### Fixed

- **User bubbles collapsed to one character per line when a selection quote was present.**
  Regression of the 0.5.4 disease, introduced with the selection quote tag: its summary is
  `white-space: nowrap` (whole-path min-content) inside the user row's flex line, so
  flex-shrink squeezed the bubble — whose min-content is one CJK char — to one character
  per line. The quote now owns a full line (`flex: 1 1 100%; min-width: 0`, so the
  ellipsis actually engages) and the user row wraps. Verified by rendering a long-path
  quote beside a CJK question in the shipped styles.css.
- **Typing Chinese could fire the message mid-composition.** The input's keydown handler
  sent on every bare Enter — including the one that confirms an IME candidate (pinyin
  selection), so a half-typed sentence went out as a message, and the Escape that cancels
  a composition could abort a running task. Composition events (`isComposing`, plus
  Chrome's keyCode 229 pre-composition quirk) are now ignored; covered by a regression
  test firing both kinds of synthetic events at the real handler.
- **A stale dead proxy hijacked every request.** With proxy env vars pointing at a proxy
  app that is not running (rebooted machine, proxy off), every pi request died with
  "Connection error." regardless of the model or key. `send()` now probes the configured
  proxy endpoint once per minute (pure TCP connect, 800ms budget) and strips the stale
  variables from the child environment when nothing is listening, falling back to a direct
  connection — silently, by user decision: the fallback just works and a per-session
  reminder that the proxy app is off was noise. Verified end-to-end against real pi
  with a dead-port proxy injected.
- **The long-lived child kept a baked-in snapshot of proxy state.** The RPC child inherits
  its environment once, so a proxy that came up or went down *after* spawn left it talking
  to a proxy that no longer exists (or bypassing one it now needs) until the conversation
  changed — the intermittent "偶尔 connect error" pattern. Connection errors now trigger a
  forced re-probe; when proxy state has flipped relative to what the child was spawned
  with, the session is reset (after `agent_settled`) so the next send starts with fresh
  environment. Matching proxy state reports the residual failure as network/relay-side.
- **Selection attachment never fired for reading-mode users.** Two compounding causes:
  `readSelection()` only looked at the CodeMirror editor (absent in reading mode), and the
  DOM-selection fallback read at *send* time — but clicking the panel's input textarea
  clears the reading view's DOM selection, so the send-time read was always empty. The
  plugin now snapshots the selection on `selectionchange` (throttled, panel-internal
  selections ignored) and resolves it in three steps: editor selection (with line
  numbers) → live DOM selection → cached selection (10-minute freshness window). The user
  bubble's 「引用」 tag is a collapsible quote showing what was actually sent.
- **JSONL framing could split a record mid-string.** The json transport parsed stdout with
  Node's `readline`, which treats U+2028/U+2029 as line breaks even though both are legal
  inside JSON strings — a reply containing one would silently derail the stream. Both
  transports now share a hand-written LF splitter (CR tolerated) that is unit-tested
  against those characters byte-by-byte.
- **Switching conversations mid-run corrupted transcripts.** `openConversation` /
  `newConversation` / `setMode` were allowed while a task was running; events then landed
  in whatever conversation was active when they arrived. All three now require stopping the
  run first (the RPC key binding would have masked this in the new transport, but the
  one-shot mode had the bug outright).
- **A failed request looked like "nothing happens".** When pi cannot reach its provider
  (dead proxy, quota, expired key), pi 1.x emits an empty assistant `message_end` with
  `errorMessage` set — and the panel dropped that message silently, so sending a message
  appeared to do nothing at all (observed in the wild: the system proxy env vars pointed
  at 127.0.0.1:7897 while the proxy app was not running, so every pi request died with
  `Connection error.`). The error is now rendered as a ⚠️ reply bubble, and a turn that
  ends with no assistant message at all reports "完成但无回复" in the status bar instead
  of a plain "完成". A user-initiated abort (`stopReason: "aborted"`) is kept silent — it
  is not an error.

- **`src/main.js` did not parse.** A lost-edit during the selection work removed the
  `activeThinking()` method header and left its body dangling after `describeSelection()`,
  a `SyntaxError` on load — the source could not build and the running plugin was frozen
  at the last good bundle. The method header is restored.
- **The settings tab crashed halfway down.** The two thinking-level dropdowns were built
  as `[…].forEach((o) => d.addOption(o, o)).setValue(…)`, but `Array.forEach` returns
  `undefined`, so the chain threw `TypeError: Cannot read properties of undefined
  (reading 'setValue')` while rendering. Everything below "思考级别" — tools, working
  directory, the entire study-mode block, session data — never rendered. The dropdowns
  are now built with a plain loop.
- **Long thinking could not stay collapsed.** `setAttribute('open', 'x')` still expands a
  `<details>` (`open` is a boolean attribute), so thinking longer than 600 chars was
  force-expanded instead of folded. Now removed when it should stay collapsed.
- **Cancelling the approval dialog left the message behind.** The user turn was pushed
  before the confirmation modal, so "取消" kept the draft in the transcript while the
  agent never saw it — resending duplicated it. The draft is now retracted on cancel (and
  on a missing command), and conversation naming follows the first message that was
  actually sent.
- **Detached message DOM was pinned for the whole session.** `renderTranscript` rebuilt
  the list but left `_el`/`_card` pointers on the message objects (which outlive the
  list), so every rebuild leaked the previous DOM tree. References are now released
  before rebuild and on view close.
- **Text fields in settings rebuilt the tab on every keystroke.** 学习 profile 目录 /
  学习模型 / 学习工作目录 called `this.display()` from `onChange`, losing focus after
  every character. The rebuilds are gone, and text inputs persist through a debounced
  `saveSettingsSoon()` instead of a full `data.json` write per keystroke.

- **Selection attachment is now actually reachable.** The in-progress `attachSelection`
  work had no caller: `submit()` never passed a selection. With the setting on (default),
  sending a question from the panel attaches the active editor's selection as a labelled
  context block before the question, the user bubble shows a clickable 「引用
  path:lines」 tag for what was attached, and the selection is persisted with the message
  (migration preserves it; the stored copy is truncated to the same 4000-char cap as the
  prompt block).

### Changed

- **Streaming re-renders less aggressively on long replies.** Each flush re-renders the
  whole accumulated reply, so a fixed 70 ms interval turned into continuous full-document
  markdown work as replies grew. The interval now widens with the reply length (70 ms →
  180 ms → 400 ms); the trailing flush still renders the final text in full.
- **Auto-scroll no longer fights the reader.** Streaming pinned the list to the bottom on
  every flush, yanking the user back down while scrolling up. The list now follows only
  when already near the bottom; explicit events (send, session switch) still force it.
- **Sending a message appends one bubble instead of rebuilding the transcript.** With a
  long history, every send re-rendered every message through `MarkdownRenderer`. Only
  truncation-driven rebuilds (history cap) and the empty-state transition rebuild now.
- **data.json growth is capped.** Tool results are persisted truncated to 4000 chars and
  thinking to 16000 (together they were ~88% of a 449KB data.json measured in the wild —
  a single `bash` result was 26KB). The live panel keeps full text; only the persisted
  copy is capped, so existing data slims down on the next save.

[0.6.0]: https://github.com/Solren-zhen/obsidian-pion/releases/tag/0.6.0

## [0.5.4]

Fixes the actual cause of the "one character per line" reply collapse. 0.5.3 addressed the
wrong element and did not resolve the visible defect.

### Fixed

- **Assistant replies collapsed to one character per line once a tool ran.** The assistant
  message row (`.pi-msg-assistant`) is a flex row that holds the avatar, the reply bubble
  and — inserted by `_ensureToolCard` into the same row — the `.pi-tool-cards` group. That
  group inherits `min-width: auto`, and its children are wide by construction
  (`.pi-diff-line` is `white-space: pre`, `.pi-tool-arg` is `white-space: nowrap`), so it
  claimed 556px inside a 326px row and squeezed the bubble to 0px. With no width left, the
  CJK reply wrapped after every single character. The tool group now takes a full line of its
  own (`flex: 1 1 100%`, `min-width: 0` on it and on `.pi-tool-card`), so the reply keeps the
  full row width and tool cards sit below it.
- Verified by measuring the real DOM with the shipped `styles.css` plus Obsidian's core
  `app.css` and the active theme: `.pi-md` width inside a 380px pane went from **0px**
  (collapsed) to **336px** (full row width) with the fix applied.

[0.5.4]: https://github.com/Solren-zhen/obsidian-pion/releases/tag/0.5.4

## [0.5.3]

Fixes a rendering defect where assistant replies in a narrow pane could collapse to
roughly one character per line, and hardens the streaming path against a crash.

### Fixed

- **Reply column could collapse to one character per line.** The assistant bubble and its
  markdown body had no explicit `min-width: 0` / `max-width: 100%` in the flex chain from
  `.pi-body` down to `.pi-md`. In a narrow leaf, a wide child (a long code block, a table)
  raised the container's min-content width, and for CJK text that floor is about one
  character — so every line wrapped after a single glyph. The whole chain now declares its
  sizing explicitly, and wide content (code blocks, tables, images) scrolls or shrinks
  inside the bubble instead of forcing the column down.
- **Streaming could abort on the first thinking token.** `_flushStream` passed
  `m._bubbleEl` to `_renderAssistantBody`, but `m._bubbleEl` was never assigned. When the
  first delta was a thinking token, this threw a `TypeError` that aborted the rest of the
  flush, freezing the visible reply mid-stream. `renderMessage` now records the bubble, and
  the flush guards against a missing bubble instead of throwing.

[0.5.3]: https://github.com/Solren-zhen/obsidian-pion/releases/tag/0.5.3

## [0.5.2]

Clears the last actionable item from the directory review. No shipped code changed.

### Added

- **`package-lock.json`**, so the directory's *build verification* check can run. It reported
  "no JavaScript lockfile was found" and, without one, dependency resolution cannot be
  reproduced. The plugin has zero dependencies, so the lockfile only records the project's own
  metadata — but the check's reasoning is sound, and the file makes the zero-dependency claim
  machine-verifiable.
- Reproducibility is now asserted rather than assumed: building from a clean directory that
  contains only `package.json`, `package-lock.json`, `src/` and `dev/build.js` produces a
  `main.js` that is **byte-for-byte identical** to the committed one.

### Changed

- Both workflows install with `npm ci` instead of skipping installation. `npm ci` fails when
  `package.json` and `package-lock.json` disagree, which keeps the lockfile honest.

[0.5.2]: https://github.com/Solren-zhen/obsidian-pion/releases/tag/0.5.2

## [0.5.1]

Addresses the first directory review. No functional regressions and no API changes.

### Added

- **Release workflow with build-provenance attestations.** Tagging a version now builds and
  publishes the release in CI and attests `main.js` and `styles.css`, so their provenance can
  be verified with `gh attestation verify main.js --repo Solren-zhen/obsidian-pion`. The
  workflow also refuses to publish when the tag, `manifest.json` and `versions.json` disagree,
  or when any of the three shippable files is missing.
- Study/coding isolation tests now assert that `code` mode does not redirect to the study
  profile, and that the credential symlinks never contain copied key material.
- Submission-hygiene tests: no `!important` declarations, no `innerHTML`, no `console` logging,
  no `eval`/`Function`, clipboard is write-only, README disclosures present, release assets
  attested.

### Changed

- **Removed the CSS `important` flag** flagged by the directory's CSS lint. The visibility
  helper now uses an intentionally doubled class (`.pi-hidden.pi-hidden`, specificity
  `0,3,0`) instead, which still outranks every component rule that sets `display` while
  leaving themes able to override it deliberately.
- **Copy button** now reports failure instead of silently doing nothing, and no longer
  swallows promise rejections.
- README disclosures cover clipboard behaviour and release provenance verification.

[0.5.1]: https://github.com/Solren-zhen/obsidian-pion/releases/tag/0.5.1

## [0.5.0] — first public release

### Added

- **Study mode** — a configurable learning coach that runs in a fully isolated pi profile.
  Persona, skills and session history live in `<vault>/.obsidian/pi-study`; pi is redirected
  there with `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`. Credentials are
  symlinked back to `~/.pi/agent`, so study mode costs the daily coding setup zero context.
- **Five study skills** — `quiz-me`, `review-notes`, `teach-concept`, `make-cards`,
  `study-plan`. Each is behavioural (retrieval before explanation, hint before reveal, one
  question at a time, verify after explaining, always write results back to notes).
- **Study presets** — `general`, `kaoyan408`, `language`, `programming`. Goal, note folders,
  mistake book, template, mastery field/values and persona language are all overridable;
  card separators are auto-detected from obsidian-spaced-repetition. Generated files are
  never overwritten, so hand edits survive upgrades.
- **Coding mode UI** — streaming text with a caret, collapsible thinking, tool cards grouped
  per turn and keyed by `callId`, real unified diffs from `result.details.diff`, per-mode
  conversation lists, `@`-mentions with automatic quoting, token/cache usage, `Esc` to abort,
  and an optional send-time confirmation.
- **Multiple backends** — `pi` (full streaming + tool cards), plus text-mode `claude`,
  `codex` and custom commands.
- **Verification tooling** — 62 offline assertions replaying captured real pi event streams
  through a hand-rolled DOM stub (no Obsidian, no network, no dependencies),
  `dev/check-manifest.js` for release consistency, and `dev/check-privacy.js` to keep
  personal data and secrets out of published files.

### Fixed

- **Packaging: released plugin failed to load.** Obsidian installs only `main.js`,
  `manifest.json` and `styles.css`, but `main.js` required a sibling module at load time.
  That worked in a development vault and broke for everyone installing from the community
  directory. `src/study-profile.js` is now inlined into a self-contained bundle by
  `dev/build.js`, and a test loads the built artifact from a directory containing only the
  three shipped files.
- Tool cards were matched by array position instead of `toolCallId`, so parallel tool calls
  in one assistant message cross-wired their args and results.
- Edit diffs were reconstructed from stale field names instead of using pi's authoritative
  `result.details.diff`.
- Persistence wrote live DOM references into `data.json`; serialisation is now whitelisted.
- Two open panels both committed the same assistant message, duplicating it.
- Thinking text arriving before any text produced no thinking card.
- The throttled render flush ran before the authoritative `message_end` text was applied, so
  a committed bubble could keep a stale partial frame.

[0.5.0]: https://github.com/Solren-zhen/obsidian-pion/releases/tag/0.5.0
