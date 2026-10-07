'use strict';

/**
 * Pre-release privacy guard.
 *
 * This repository is a *generic* Obsidian plugin. The development vault, however, is a
 * real personal knowledge base, so it is easy to leak private content into a test fixture
 * or a comment without noticing. This script fails CI when a file that would be published
 * contains personal data or credential-looking strings.
 *
 * Files listed in SKIP_FILES are runtime state that is gitignored anyway.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Never scanned: gitignored runtime state or non-published binaries. */
const SKIP_FILES = new Set(['data.json', '.DS_Store']);

/** Directories never scanned. */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Patterns that must never appear in published files.
 * `why` is shown so a contributor knows what to do.
 *
 * Placeholder home directories (`/home/user`, `/Users/you`, …) are explicitly allowed,
 * so fixtures can show realistic absolute paths without leaking a real one.
 */
const PLACEHOLDER_HOMES = /[\/\\](user|you|youruser|username|runner|example|someone|dev|me|test)[\/\\]/;

const FORBIDDEN = [
  { re: /\/Users\/[A-Za-z0-9._-]+\//, why: 'absolute macOS home path — use a relative or placeholder path' },
  { re: /\/home\/[A-Za-z0-9._-]+\//, why: 'absolute Linux home path — use a relative or placeholder path' },
  { re: /C:\\Users\\[A-Za-z0-9._-]+\\/, why: 'absolute Windows home path — use a relative or placeholder path' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/, why: 'looks like an API key (sk-...)' },
  { re: /\bgho_[A-Za-z0-9]{20,}/, why: 'looks like a GitHub OAuth token' },
  { re: /\bghp_[A-Za-z0-9]{20,}/, why: 'looks like a GitHub personal access token' },
  { re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, why: 'looks like a JWT' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'embedded private key' },
  { re: /\bapi[_-]?key\b\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i, why: 'hard-coded API key' },
];

/**
 * Vault-specific personal tokens. These belong to the maintainer's own notes and must
 * not ship in a public plugin. Contributors: add anything you spot here.
 */
const PERSONAL_TOKENS = [
  '甲状腺',        // maintainer's medical-project folder
  '肺炎分类器',
  'jophy',
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.git')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

const files = walk(ROOT, []);
let failures = 0;
let scanned = 0;

for (const abs of files) {
  const rel = path.relative(ROOT, abs);
  if (SKIP_FILES.has(path.basename(rel))) continue;

  // This script documents the forbidden patterns and personal tokens verbatim, so it
  // would always flag itself. Its content is reviewed by definition.
  if (rel === path.join('dev', 'check-privacy.js')) continue;

  // Skip obviously binary files by extension.
  if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|zip|pdf)$/i.test(rel)) continue;

  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
  scanned++;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const rule of FORBIDDEN) {
      if (!rule.re.test(line)) continue;
      // Allow documented placeholder homes so fixtures stay realistic.
      if ((rule.why.includes('home path')) && PLACEHOLDER_HOMES.test(line)) continue;
      failures++;
      console.error(`✗ ${rel}:${i + 1} — ${rule.why}`);
      console.error(`    ${line.trim().slice(0, 120)}`);
    }

    for (const token of PERSONAL_TOKENS) {
      if (line.includes(token)) {
        failures++;
        console.error(`✗ ${rel}:${i + 1} — personal data "${token}" must not be published`);
        console.error(`    ${line.trim().slice(0, 120)}`);
      }
    }
  }
}

console.log(`scanned ${scanned} files`);

if (failures) {
  console.error(`\nFAILED: ${failures} privacy/secret finding(s). Clean them before releasing.`);
  process.exit(1);
}
console.log('privacy OK — no personal data or secrets found');
