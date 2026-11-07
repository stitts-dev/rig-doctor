#!/usr/bin/env node
// Keeps the desktop app version in one place per release.
//   node scripts/desktop-version.mjs check            fail unless all version files agree
//   node scripts/desktop-version.mjs set <X.Y.Z>      write X.Y.Z into all version files
//   node scripts/desktop-version.mjs set desktop-vX.Y.Z   same, from a release tag
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CRATE = 'rig-doctor-globe';

// Each file: how to read its version and how to replace it, both on raw text so formatting survives.
const files = [
  {
    path: 'package.json',
    re: /^(\s*"version":\s*")([^"]+)(")/m,
  },
  {
    path: 'src-tauri/tauri.conf.json',
    re: /^(\s*"version":\s*")([^"]+)(")/m,
  },
  {
    path: 'src-tauri/Cargo.toml',
    re: /^(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/m,
  },
  {
    path: 'src-tauri/Cargo.lock',
    re: new RegExp(`^(name = "${CRATE}"\\nversion = ")([^"]+)(")`, 'm'),
  },
];

function read(f) {
  const text = readFileSync(join(root, f.path), 'utf8').replace(/\r\n/g, '\n');
  const m = text.match(f.re);
  if (!m) throw new Error(`No version found in desktop/${f.path}`);
  return { text, version: m[2] };
}

function check() {
  const found = files.map((f) => ({ path: f.path, version: read(f).version }));
  for (const f of found) console.log(`${f.version}\tdesktop/${f.path}`);
  const versions = new Set(found.map((f) => f.version));
  if (versions.size !== 1) {
    console.error('Version mismatch. Run: node scripts/desktop-version.mjs set <X.Y.Z>');
    process.exit(1);
  }
  const [v] = versions;
  if (!SEMVER.test(v)) {
    console.error(`Version ${v} is not semver X.Y.Z`);
    process.exit(1);
  }
}

function set(arg) {
  const v = (arg ?? '').replace(/^refs\/tags\//, '').replace(/^desktop-v/, '');
  if (!SEMVER.test(v)) {
    console.error(`"${arg}" is not a semver version or desktop-vX.Y.Z tag`);
    process.exit(1);
  }
  // Windows MSI ProductVersion only accepts numeric X.Y.Z (pre-release must be numeric-only).
  if (v.includes('-') && !/-\d+$/.test(v.split('+')[0])) {
    console.error(`Pre-release "${v}" is not MSI-compatible; use X.Y.Z or X.Y.Z-N with numeric N`);
    process.exit(1);
  }
  for (const f of files) {
    const { text } = read(f);
    writeFileSync(join(root, f.path), text.replace(f.re, `$1${v}$3`));
  }
  check();
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'check') check();
else if (cmd === 'set') set(arg);
else {
  console.error('Usage: desktop-version.mjs check | set <X.Y.Z|desktop-vX.Y.Z>');
  process.exit(2);
}
