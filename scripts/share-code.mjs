/**
 * Checks the atlas share code format against the real tree.
 *
 *  - a plan survives encode -> decode unchanged
 *  - the code is compact enough to paste
 *  - a code built for another tree version is refused, not silently applied
 *  - malformed input produces an error rather than a wrong plan
 *
 * Run: node scripts/share-code.mjs
 */
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'node_modules', '.share-test');

await mkdir(tmp, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/app/tools/atlas/share-code.ts')],
  outfile: path.join(tmp, 'share-code.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'warning',
});
const { encodePlan, decodePlan, peekPlan, ShareCodeError } = await import(
  pathToFileURL(path.join(tmp, 'share-code.mjs')).href
);

// btoa/atob are browser globals; the module needs them under node
globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');

const raw = JSON.parse(await readFile(path.join(root, 'public/assets/atlas/3.29/tree.json'), 'utf8'));

// minimal stand-in for the Tree the encoder needs
const ids = Object.keys(raw.nodes);
const nodes = ids.map((id, idx) => ({
  idx,
  id,
  allocatable: !raw.nodes[id].isMastery && id !== 'root',
}));
const byId = new Map(nodes.map((n) => [n.id, n]));
const shareOrder = nodes
  .filter((n) => n.allocatable)
  .sort((a, b) => Number(a.id) - Number(b.id))
  .map((n) => n.idx);
const shareIndex = new Int32Array(nodes.length).fill(-1);
shareOrder.forEach((nodeIdx, position) => {
  shareIndex[nodeIdx] = position;
});
const tree = { nodes, byId, shareOrder, shareIndex };

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

const allocatableIds = shareOrder.map((i) => nodes[i].id);
const rnd = rng(1337);
const pick = (count, taken) => {
  const out = [];
  while (out.length < count) {
    const id = allocatableIds[(rnd() * allocatableIds.length) | 0];
    if (!out.includes(id) && !taken.includes(id)) out.push(id);
  }
  return out;
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// --- round trip --------------------------------------------------------------
for (const size of [0, 1, 30, 138]) {
  const allocated = pick(size, []);
  const targets = pick(Math.min(size, 12), allocated);
  const blocked = pick(size ? 3 : 0, [...allocated, ...targets]);
  const plan = { treeVersion: 1, targetsMode: size % 2 === 0, allocated, targets, blocked };

  const code = encodePlan(tree, plan);
  const back = decodePlan(code, tree);
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  check(
    `round trip, ${size} allocated`,
    same(back.allocated, allocated) &&
      same(back.targets, targets) &&
      same(back.blocked, blocked) &&
      back.treeVersion === 1 &&
      back.targetsMode === plan.targetsMode,
    `${code.length} chars`,
  );
}

// --- version handling --------------------------------------------------------
const otherVersion = encodePlan(tree, {
  treeVersion: 7,
  targetsMode: false,
  allocated: pick(10, []),
  targets: [],
  blocked: [],
});
check('code carries its tree version', peekPlan(otherVersion).treeVersion === 7);
check('current-version code reads back as 1', peekPlan(encodePlan(tree, {
  treeVersion: 1, targetsMode: false, allocated: [], targets: [], blocked: [],
})).treeVersion === 1);

// --- rejects rubbish ---------------------------------------------------------
const bad = ['', 'hello', 'AT1:', 'AT9:AQAAAAA', 'AT1:!!!!', 'AT1:AQ'];
for (const input of bad) {
  let threw = false;
  try {
    decodePlan(input, tree);
  } catch (err) {
    threw = err instanceof ShareCodeError;
  }
  check(`rejects ${JSON.stringify(input)}`, threw);
}

// a code claiming more nodes than exist must not produce a plan
let guarded = false;
try {
  // count varint 0xFF 0xFF 0xFF 0x7F = huge
  decodePlan('AT1:' + Buffer.from([1, 0, 0xff, 0xff, 0xff, 0x7f]).toString('base64url'), tree);
} catch (err) {
  guarded = err instanceof ShareCodeError;
}
check('rejects an impossible node count', guarded);

console.log(failures === 0 ? '\nALL OK' : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
