'use strict';

/**
 * Consistency check between manifest.json, package.json and versions.json.
 *
 * Obsidian's release tooling expects a release tag to match `manifest.json.version`,
 * and `versions.json` to map that version to `minAppVersion`. Silently drifting here
 * produces confusing release failures, so CI enforces it.
 *
 * Also validates the fields Obsidian requires in a manifest.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const problems = [];
const notes = [];

function read(file) {
  const p = path.join(ROOT, file);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    problems.push(`${file}: cannot read/parse (${e.message})`);
    return null;
  }
}

const manifest = read('manifest.json');
const pkg = read('package.json');
const versions = read('versions.json');

if (manifest) {
  // Required by Obsidian.
  for (const field of ['id', 'name', 'version', 'minAppVersion', 'description', 'author', 'isDesktopOnly']) {
    if (manifest[field] === undefined || manifest[field] === '') {
      problems.push(`manifest.json: missing required field "${field}"`);
    }
  }

  if (typeof manifest.id !== 'string' || !/^[a-z0-9-]+$/.test(manifest.id)) {
    problems.push(`manifest.json: "id" must be lowercase letters, digits and dashes (got ${JSON.stringify(manifest.id)})`);
  }
  if (typeof manifest.name === 'string' && /obsidian/i.test(manifest.name)) {
    problems.push('manifest.json: "name" must not contain "Obsidian" (registry rule)');
  }
  if (typeof manifest.description === 'string' && /obsidian/i.test(manifest.description)) {
    notes.push('manifest.json: description mentions "Obsidian" — allowed, but a plain description reads better');
  }
  if (typeof manifest.version === 'string' && !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    problems.push(`manifest.json: version must be x.y.z (got ${manifest.version})`);
  }

  // version must be published to the download host used by Obsidian
  if (manifest.version && !fs.existsSync(path.join(ROOT, 'main.js'))) {
    problems.push('main.js is missing — Obsidian loads this file at runtime');
  }
}

if (manifest && pkg && manifest.version !== pkg.version) {
  problems.push(`version mismatch: manifest.json=${manifest.version} package.json=${pkg.version}`);
}

if (manifest && versions) {
  const v = manifest.version;
  if (!(v in versions)) {
    problems.push(`versions.json: missing entry for current version ${v}`);
  }
  if (v in versions && versions[v] !== manifest.minAppVersion) {
    problems.push(`versions.json["${v}"]=${versions[v]} but manifest.minAppVersion=${manifest.minAppVersion}`);
  }
}

console.log('manifest:', manifest ? `${manifest.id}@${manifest.version} (min app ${manifest.minAppVersion})` : '(unreadable)');
console.log('package :', pkg ? `${pkg.name}@${pkg.version} license=${pkg.license}` : '(unreadable)');
console.log('versions:', versions ? Object.keys(versions).join(', ') : '(unreadable)');
for (const n of notes) console.log('note -', n);

if (problems.length) {
  console.error('\nFAILED:');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('\nmanifest OK');
