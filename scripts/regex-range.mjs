/**
 * Checks the minesweeper's number-range regex.
 *
 * The tool's whole promise is that a lit item is one you meant to buy, so the
 * pattern has to match every price in the band and nothing outside it — a range
 * that quietly lets 100 through when you asked for 1-20 is exactly the landmine
 * it is supposed to hide. Both directions are checked, and twice: anchored, and
 * embedded in the real search term, because a loose pattern there could match
 * the "1" inside "100" and leak through the second way while passing the first.
 *
 * Run: node scripts/regex-range.mjs [exhaustive limit] [random pairs]
 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'node_modules', '.regex-range-test');
const LIMIT = Number(process.argv[2] ?? 60);
const RANDOM_PAIRS = Number(process.argv[3] ?? 3000);
const MAX_PRICE = 9999;

await mkdir(tmp, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/app/tools/minesweeper/regex-range.ts')],
  outfile: path.join(tmp, 'regex-range.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'warning',
});
const { regexRange } = await import(pathToFileURL(path.join(tmp, 'regex-range.mjs')).href);

let failures = 0;
const fail = (message) => {
  if (++failures <= 20) console.error('  ✗ ' + message);
};

/** Every number the pattern is asked about, on both sides of the boundaries. */
function candidates(min, max, extra) {
  const values = new Set(extra);
  for (const anchor of [min, max]) {
    for (let d = -3; d <= 3; d++) if (anchor + d >= 0) values.add(anchor + d);
  }
  for (const anchor of [min, max]) {
    values.add(anchor * 10);
    values.add(anchor * 10 + 9);
    values.add(Math.floor(anchor / 10));
  }
  return values;
}

function check(min, max, extra) {
  const source = regexRange(min, max);
  const anchored = new RegExp(`^(?:${source})$`);
  // How the tool actually spends it: one quoted stash-search term.
  const embedded = new RegExp(`~b/o ${source} chaos`);

  for (const value of candidates(min, max, extra)) {
    const want = value >= min && value <= max;
    if (anchored.test(String(value)) !== want) {
      fail(`${min}-${max} → /${source}/ ${want ? 'misses' : 'matches'} ${value}`);
    }
    if (embedded.test(`~b/o ${value} chaos`) !== want) {
      fail(`${min}-${max} → /${source}/ ${want ? 'misses' : 'matches'} "~b/o ${value} chaos"`);
    }
  }
}

console.log(`exhaustive: every 1 ≤ min ≤ max ≤ ${LIMIT}`);
const dense = [];
for (let v = 0; v <= LIMIT * 10 + 9; v++) dense.push(v);
for (let min = 1; min <= LIMIT; min++) {
  for (let max = min; max <= LIMIT; max++) check(min, max, dense);
}

console.log(`random:     ${RANDOM_PAIRS} pairs in 1..${MAX_PRICE}`);
// Fixed seed: a failure has to be reproducible from the command line alone.
let seed = 0x9e3779b9;
const rand = (n) => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return 1 + (seed % n);
};
for (let i = 0; i < RANDOM_PAIRS; i++) {
  const a = rand(MAX_PRICE);
  const b = rand(MAX_PRICE);
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  const extra = [0, 1, min - 1, max + 1, MAX_PRICE, MAX_PRICE + 1];
  for (let k = 0; k < 60; k++) extra.push(rand(MAX_PRICE * 2));
  check(min, max, extra);
}

console.log('edge cases: single values, adjacent pairs, whole decades');
for (const [min, max] of [
  [1, 1],
  [7, 7],
  [1, 2],
  [9, 10],
  [1, 9],
  [1, 10],
  [10, 99],
  [1, 999],
  [1, MAX_PRICE],
  [100, 100],
  [999, 1000],
  [MAX_PRICE, MAX_PRICE],
]) {
  check(min, max, dense);
}

// The shapes the port is expected to produce, as the original library did.
console.log('shape:      known patterns');
for (const [min, max, want] of [
  [1, 1, '1'],
  [1, 2, '(1|2)'],
  [1, 20, '([1-9]|1\\d|20)'],
  [1, 999, '([1-9]|[1-9]\\d{1,2})'],
  [10, 99, '(1\\d|[2-9]\\d)'],
]) {
  const got = regexRange(min, max);
  if (got !== want) fail(`${min}-${max} → ${got}, expected ${want}`);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall ranges match exactly their own numbers');
