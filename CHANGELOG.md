# Changelog

All notable changes to Pion are documented here. This project follows
[Semantic Versioning](https://semver.org/) and
[Conventional Commits](https://www.conventionalcommits.org/).

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
