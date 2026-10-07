<div align="center">

# Pion

**The Pi coding agent, inside Obsidian — with two fully isolated modes.**

A 🎓 study coach you can configure for any subject, and 💻 your daily coding agent —
sharing credentials, never sharing context.

<sub>Plugin id `pion` · repo `obsidian-pion` · not to be confused with the unrelated `pi-agent`
plugin in the community directory.</sub>

[![CI](https://github.com/Solren-zhen/obsidian-pion/actions/workflows/ci.yml/badge.svg)](https://github.com/Solren-zhen/obsidian-pion/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![No dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

</div>

---

Pion mounts the [pi](https://github.com/earendil-works/pi) coding agent into a side panel.
pi already has tools, sessions, compaction and model configuration — Pion does not
reimplement any of that. It renders pi's output as an Obsidian-native chat UI and adds one
thing pi cannot do on its own: **a second, completely isolated persona for studying.**

## Why two modes

The naive way to build a study agent is to write "you are a tutor" into the project's
`AGENTS.md`. That fails for a subtle reason: pi discovers `AGENTS.md` files by walking up
from the working directory, and loads skills from your global config. **A study persona in
either place is loaded on every daily coding session** — burning context and nudging
behaviour you did not ask for.

Pion instead materialises the study persona in a hidden, vault-local profile and points pi
at it with two environment variables:

```
PI_CODING_AGENT_DIR          -> <vault>/.obsidian/pi-study
PI_CODING_AGENT_SESSION_DIR  -> <vault>/.obsidian/pi-study/sessions
```

Credentials (`models.json`, `auth.json`, `models-store.json`) are **symlinked** back to your
real config, so the persona is isolated while API keys stay shared and are never copied.

**The practical result:** being in study mode costs your coding setup exactly nothing, so
the study agent can stay on without you having to remember to turn it off.

| | 🎓 Study | 💻 Coding |
|---|---|---|
| Persona | Study coach (`AGENTS.md` + 5 skills) | Your existing pi config, untouched |
| Config dir | `<vault>/.obsidian/pi-study` | `~/.pi/agent` |
| Session history | `…/pi-study/sessions` | `~/.pi/agent/sessions` |
| Panel conversations | separate list | separate list |
| Credentials | shared via symlink | as-is |

## What the study coach actually does

It is not a chat window that talks *about* studying. It is built around one failure mode:
LLMs love to explain everything at once, which feels productive and teaches nothing.

The persona is therefore a **behavioural contract**, not role-play:

- **Retrieval before explanation.** Quiz first; only explain after a real attempt.
- **One question at a time.** Never a whole practice paper at once.
- **Hint before reveal.** If you miss it, you get a nudge and a retry — not the answer.
- **Verification after every explanation.** An unchecked explanation did not happen.
- **Something must be written to disk each round**, or nothing was learned.

Questions and explanations follow five **evidence-based principles** — retrieval practice,
spacing, interleaving, concrete examples, dual coding — with at least two required per
interaction. Gaps are written back into your own notes as mistake notes, reusing your
existing frontmatter fields, so the next session has real signal to prioritise with.

### Skills

| Skill | Trigger |
|---|---|
| `quiz-me` | "quiz me", "test me" — interleaved questions from your real notes |
| `review-notes` | "review", "what should I review" — spaced review ordered by weakness |
| `teach-concept` | "explain", "I don't get it" — intuition → definition → example → edge case → check |
| `make-cards` | "make flashcards" — converts notes to spaced-repetition cards |
| `study-plan` | "study plan", "how much is left" — plan from time left and measured mastery |

### Presets

Any subject works; presets give a starting point, and every field can be overridden.

| Preset | For |
|---|---|
| `general` | anything — the coach explores your vault and adapts |
| `kaoyan408` | the Chinese CS postgraduate exam (408 + Maths I) |
| `language` | vocabulary/grammar, JLPT/IELTS style goals |
| `programming` | learning a language or working through exercises |

Presets define the goal, note folders, mistake book, template, mastery field and values, and
the persona language (`zh` / `en`). Card separators are **auto-detected** from your
[obsidian-spaced-repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) config.
Existing generated files are never overwritten, so your edits survive upgrades.

## Coding mode

Your normal pi, rendered in Obsidian:

- Streaming text with a live caret, plus collapsible thinking
- Tool cards grouped per turn, keyed by `callId` so parallel calls never cross wires
- Real unified diffs from `result.details.diff`, opened automatically for edits
- Session management — each conversation keeps its own pi `--session-id`, resumable after restart
- `@`-mention notes (paths with spaces quoted automatically), token/cache usage, `Esc` to abort
- Optional send-time confirmation, and backends for `pi` / `claude` / `codex` / custom commands

## Requirements

- Desktop Obsidian (`isDesktopOnly`)
- A working [pi](https://github.com/earendil-works/pi) install with a configured model
  (`pi --list-models` should list something)

## Install

**Manual** — copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/pion/`, then enable **Pion** in Settings → Community plugins.

**From source**

```bash
git clone https://github.com/Solren-zhen/obsidian-pion.git
cd obsidian-pion
npm run verify      # builds main.js, then runs the checks
```

`main.js` is a **generated bundle** — `npm run build` inlines `src/study-profile.js` into it.
This is required, not optional: Obsidian only downloads `main.js`, `manifest.json` and
`styles.css` from a release, so a plugin that `require()`s a sibling file at load time
would crash for everyone installing from the community directory. There is still **no
bundler and no dependencies**; the build is a ~120-line script whose only job is that
inlining. Edit `src/*.js`, never the generated `main.js`.

## Setup

1. Settings → **Pion**, confirm the pi executable (default `pi`). If it is not on `PATH`, add
   its directory under *PATH additions*.
2. Leave provider/model empty to inherit your pi defaults.
3. Under **Study persona**, pick a preset and fill in only what differs.
4. Click **Set up / repair study profile**, then switch to 🎓 in the panel toolbar.

## Data and privacy

| What | Where | Notes |
|---|---|---|
| Plugin settings + panel transcripts (both modes) | `<vault>/.obsidian/plugins/pion/data.json` | plain JSON, whitelisted fields only |
| Study persona + skills | `<vault>/.obsidian/pi-study/` | generated once, then yours to edit |
| Study session history | `<vault>/.obsidian/pi-study/sessions/` | fully separate from daily use |
| Coding session history | `~/.pi/agent/sessions/` | your daily pi; Pion never writes here in study mode |
| Model credentials | `~/.pi/agent/*.json` | **symlinked, never copied or read** |

### Disclosures

Pion is a front-end for an external program, so a few things are worth stating plainly.

**Files outside your vault.** The plugin symlinks `models.json`, `auth.json` and
`models-store.json` from `~/.pi/agent` into the isolated study profile so you do not have to
configure your API keys twice. A symlink stores only a path — the plugin never copies or
reads credential contents. In **coding** mode your existing pi session history stays in
`~/.pi/agent/sessions`, untouched by study mode.

**It runs another program.** Pion does not call any model API itself. It spawns your local
`pi` executable as a subprocess and streams its JSON events into the panel. Everything about
models, keys, tools and prompts belongs to pi and to your own pi configuration.

**Network use.** The plugin makes no network requests of its own. Requests to your model
provider happen inside `pi`, under its configuration. The plugin sends no telemetry and has
no analytics, ads, or accounts.

**Write access.** Study and coding modes can read and write notes in your vault — that is the
point, since results are written back as mistake notes and flashcards. Destructive commands
are discouraged in the persona, but pi's `bash` tool is powerful: keep **require approval**
on if you want a send-time confirmation, and grant tools deliberately.

**Clipboard.** The only clipboard access is the copy button on a code block. It is triggered
by your click and **writes only** — the clipboard is never read.

**Release provenance.** Release assets carry GitHub build-provenance attestations, so you can
cryptographically verify that `main.js` was built from the tagged source in CI:

```bash
gh attestation verify main.js --repo Solren-zhen/obsidian-pion
```

## Architecture

```
main.js              GENERATED bundle — the only JS file Obsidian installs
src/
  main.js            plugin + chat view + settings + backend bridge + mode isolation
  study-profile.js   preset/config → persona + skills rendering, isolated profile setup
styles.css
dev/                 offline verification tooling (never loaded by Obsidian)
  build.js           inlines src/study-profile.js into main.js (no bundler)
  minidom.js         minimal DOM + Obsidian API stub
  test.js            62 assertions over replayed real pi event streams
  e2e.js             real pi subprocess
  e2e-study.js       study mode: persona loads, daily pi untouched
  check-manifest.js  manifest/versions consistency
  check-privacy.js   blocks personal data and secrets from being published
```

Plain CommonJS, **zero dependencies, no bundler**. Sources are ~1.7k readable lines; the
generated bundle is verified in CI to load standalone (test 15 simulates a fresh install
with only the three shipped files present).

## Development

```bash
npm run build         # regenerate main.js from src/
npm run verify        # build + syntax + 62 offline assertions
npm run e2e           # real pi subprocess (consumes tokens)
npm run e2e:study     # study mode end-to-end (consumes tokens)
```

The offline suite replays **captured real pi event streams** through the state machine with a
hand-rolled DOM stub, so it needs neither Obsidian nor a network — and it runs in CI on Node
18/20/22. It covers parallel tool calls, thinking-before-text, throttled-stream commit
ordering, multi-view duplication, failure paths, persistence purity, migration idempotency,
study/coding isolation, preset genericity and **distribution packaging**. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`dev/README.md`](dev/README.md).

## Acknowledgements

- [pi](https://github.com/earendil-works/pi) — the agent doing the actual work
- [obsidian-spaced-repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) — card
  syntax Pion targets so notes stay reviewable
- [classbuild](https://github.com/jtangen/classbuild) — the formalised set of evidence-based
  learning principles the coach is built around
- [LearnKit](https://github.com/ctrlaltwill/LearnKit) and
  [Mr. Ranedeer](https://github.com/JushBJJ/Mr.-Ranedeer-AI-Tutor) — workflow and
  personalisation inspiration

## License

[MIT](LICENSE)
