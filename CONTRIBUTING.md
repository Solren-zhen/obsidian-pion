# Contributing

Thanks for helping improve Pion. This document covers the conventions that keep the
plugin reviewable and safe to ship.

## Quick start

```bash
git clone https://github.com/Solren-zhen/obsidian-pion.git
cd obsidian-pion
npm run verify        # syntax check + 57 offline assertions
```

There are **no dependencies and no bundler**. The test harness only uses Node built-ins.

There *is* a build step, and it is load-bearing:

```bash
npm run build     # src/*.js  ->  main.js
```

Edit **`src/main.js`** and **`src/study-profile.js`**. Never edit the generated root
`main.js` — `npm run build` overwrites it.

The build exists because Obsidian only downloads `main.js`, `manifest.json` and
`styles.css` from a release. A plugin that `require()`s a sibling file at load time works in
a dev vault and **crashes for every user who installs it from the community directory**. The
build inlines `src/study-profile.js` into `main.js` inside an IIFE (which also contains the
`fs`/`path`/`os` collisions between the two files). `dev/test.js` section 15 verifies the
shipped artifact loads in a directory containing only those three files.

## Ways to contribute

- **A new study preset** — the highest-value, lowest-risk contribution. See below.
- **A study skill** — a reusable learning action (quiz, explain, plan, …).
- **Event-stream fixes** — if pi changes its JSON event shape and something breaks.
- **Docs** — especially translations.

## Testing

```bash
npm run build         # regenerate main.js (run this after any src/ edit)
npm run check         # node --check on both sources and the bundle
npm test              # 62 offline assertions (no network, no model calls)
npm run e2e           # real pi subprocess (CONSUMES TOKENS)
npm run e2e:study     # real pi in study mode (CONSUMES TOKENS)
```

The offline suite (`dev/test.js`) replays **real captured pi event streams** through the
plugin's state machine using a minimal DOM stub (`dev/minidom.js`). It needs neither
Obsidian nor any npm package. This is deliberate: it makes regressions reproducible.

**Any change to event handling, persistence, or migration must come with an assertion.**
If you fix a bug, add the failing case first.

## Architecture rules

These are load-bearing. `dev/test.js` enforces several of them.

1. **Tools live on the assistant message** — `{ role:'assistant', text, thinking, tools:[] }`.
   Do not reintroduce top-level `{ role:'tool' }` messages.
2. **`message_update` carries only deltas; `message_end` is authoritative.** Always
   overwrite the streamed accumulation with the `message_end` content when committing.
3. **Look tools up by `callId`, never "the last one".** One assistant message may contain
   several parallel tool calls.
4. **Persistence is whitelisted.** `serializeSettings()` strips runtime fields. Never pass
   `this.settings` straight to `saveData` — it contains DOM references and live objects.
5. **Migrations must be idempotent.** `migrateConversations()` runs on every load and must
   produce the same result the second time.
6. **Study mode must not touch the daily pi.** New code in study mode may only write inside
   the isolated profile directory.
7. **The shipped bundle must be self-contained.** If you add a module, add it to
   `dev/build.js`. Anything `require()`d at load time other than Obsidian's own API will
   break the released plugin.

## Adding a study preset

1. Add an entry to `PRESETS` in `study-profile.js`:
   ```js
   mySubject: {
     label: 'My Subject',
     goal: { zh: '…', en: '…' },
     noteRoots: [{ path: 'notes/', desc: { zh: '…', en: '…' } }],
     mistakeBook: 'mistakes.md',
     template: '',
     dailyLog: '',
     statusField: 'status',
     statusValues: ['unknown', 'learning', 'known'],
     language: 'en',   // or null to follow the user
   }
   ```
2. Provide **both** `zh` and `en` for `goal` and `desc` if the preset ships in the default
   set, so the language switch works.
3. Run `npm test`. The preset tests assert that every preset renders an `AGENTS.md` plus all
   five skills, and that subject-specific text (e.g. `408`) does not leak into other presets.

## Adding a study skill

1. Add the name to `STUDY_SKILL_NAMES` in `study-profile.js`.
2. Add a body for it in **both** `SKILLS_ZH` and `SKILLS_EN`.
3. Each body must start with valid frontmatter:
   ```
   ---
   name: <skill-name>
   description: <when to use it — this is what the model matches on>
   ---
   ```
4. Keep skills **behavioural**, not aspirational. "Ask before telling" is a rule;
   "be a helpful tutor" is not.

## Privacy (important)

This repo doubles as a real Obsidian vault during development, so it is easy to commit
private content by accident. CI runs `node dev/check-privacy.js`, which fails on:

- absolute home paths (`/Users/<name>/…`, `/home/<name>/…`, `C:\Users\<name>\…`)
- credential-looking strings (API keys, JWTs, private keys, GitHub tokens)
- a blocklist of maintainer-specific tokens

Use placeholder paths in fixtures (`/home/user/project`) — they are explicitly allowed.
`data.json` holds your own settings and transcripts and is gitignored; keep it that way.

## Commits and releases

- Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Release checklist:
  1. Bump `version` in **both** `manifest.json` and `package.json`.
  2. Add the new version to `versions.json` mapping to `minAppVersion`.
  3. `npm run verify && node dev/check-manifest.js && node dev/check-privacy.js`
  4. Tag `x.y.z` and attach `main.js`, `manifest.json`, `styles.css` to the GitHub release.

## Code style

- Plain CommonJS, ES2019+, `'use strict'`.
- No new dependencies. No bundler. No TypeScript in `main.js`.
- Comments explain **why**, not what. Non-obvious invariants deserve a line.
- `dev/` is developer tooling and is never loaded by Obsidian.
