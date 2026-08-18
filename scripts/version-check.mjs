/**
 * Holds the version history to its own rules.
 *
 * The history in `src/app/shared/version.ts` is only worth reading if it is
 * true, and the two ways it goes wrong are quiet ones: package.json is bumped
 * and the list is not (or the reverse), or a release is pasted in above one
 * that is actually newer. Neither breaks a build, so nothing else would catch
 * them — a `/debug` page confidently showing the wrong version is worse than
 * no page at all.
 *
 * Run: node scripts/version-check.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const fail = (message) => {
  failures++;
  console.error('  ✗ ' + message);
};

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const source = await readFile(path.join(root, 'src/app/shared/version.ts'), 'utf8');

// Read the literals out of the source rather than importing it: this file is
// TypeScript, and a regex over two plain fields is cheaper than a build step.
const releases = [...source.matchAll(/version:\s*'([^']+)',\s*\n\s*date:\s*'([^']+)',/g)].map(
  ([, version, date]) => ({ version, date }),
);

if (releases.length === 0) fail('no releases found in version.ts');
console.log(`${releases.length} release(s), newest ${releases[0]?.version} (${releases[0]?.date})`);

if (releases[0] && releases[0].version !== pkg.version) {
  fail(`package.json is ${pkg.version} but the newest release is ${releases[0].version}`);
}

const order = (v) => v.split('.').map(Number);
const seen = new Set();
for (const [i, release] of releases.entries()) {
  if (!/^\d+\.\d+\.\d+$/.test(release.version)) fail(`${release.version} is not major.minor.patch`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(release.date)) {
    fail(`${release.version} has a date that is not ISO: ${release.date}`);
  } else if (Number.isNaN(Date.parse(release.date))) {
    fail(`${release.version} has a date that does not exist: ${release.date}`);
  }
  if (seen.has(release.version)) fail(`${release.version} appears twice`);
  seen.add(release.version);

  const prev = releases[i - 1];
  if (!prev) continue;
  const [a, b] = [order(prev.version), order(release.version)];
  const descends = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
  if (!descends) fail(`${release.version} is not below ${prev.version} — the list runs newest first`);
  // Same-day releases are fine; a later one further down the list is not.
  if (prev.date < release.date) {
    fail(`${release.version} (${release.date}) is dated after ${prev.version} (${prev.date})`);
  }
}

if (failures) {
  console.error(`\n${failures} problem(s).`);
  process.exit(1);
}
console.log('✓ version history is consistent with package.json');
