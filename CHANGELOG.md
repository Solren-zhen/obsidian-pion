# Changelog

All notable changes to Pion are documented here. This project follows
[Semantic Versioning](https://semver.org/) and
[Conventional Commits](https://www.conventionalcommits.org/).

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
