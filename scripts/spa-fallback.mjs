/**
 * GitHub Pages serves static files only — it knows nothing about the Angular
 * router, so opening /poe-utils-ng/atlas directly (or refreshing it) would 404.
 * Pages does fall back to 404.html for unknown paths, so shipping a copy of
 * index.html under that name makes deep links boot the app, which then routes
 * client-side as usual.
 *
 * Run automatically by `npm run github-build`.
 */
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'dist', 'poe-utils-ng', 'browser');
const index = path.join(dir, 'index.html');

if (!existsSync(index)) {
  console.error(`spa-fallback: ${index} not found — did the build run?`);
  process.exit(1);
}

copyFileSync(index, path.join(dir, '404.html'));
console.log('spa-fallback: wrote 404.html');
