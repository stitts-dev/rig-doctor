#!/usr/bin/env node
// Fails when the landing page (site/) points at a local file that does not exist,
// so a page with a broken image, font, script or stylesheet never deploys.
//   node scripts/site-check.mjs
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const html = readFileSync(join(site, 'index.html'), 'utf8');
const css = readFileSync(join(site, 'style.css'), 'utf8');

const refs = [
  ...[...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/\ssrcset="([^"]+)"/g)].flatMap((m) => m[1].split(',').map((c) => c.trim().split(/\s+/)[0])),
  ...[...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]),
];
const local = [...new Set(refs)].filter((r) => r !== './' && !/^(?:[a-z]+:|#|\/\/)/i.test(r));
const missing = local.filter((r) => !existsSync(join(site, r.split(/[?#]/)[0])));

for (const r of local) console.log(`${missing.includes(r) ? 'missing' : 'ok'}\t${r}`);
if (local.length === 0) {
  console.error('No local references found in site/index.html; the check is not reading the page.');
  process.exit(1);
}
if (missing.length) {
  console.error(`${missing.length} local reference(s) missing from site/.`);
  process.exit(1);
}
