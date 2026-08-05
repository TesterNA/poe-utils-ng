/**
 * Does the node tie-break actually change what filler the route picks, and does
 * it ever cost a point to do so?
 *
 * The solver minimises point count; among trees of that same size it is free to
 * pick any. The penalty table breaks those ties towards nodes worth having. This
 * compares solving with and without it: costs must be identical, and the chosen
 * filler should shift away from gateways and keystones.
 *
 * Run: node scripts/node-priority.mjs [targetCount] [instances]
 */
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'node_modules', '.solver-bench');
const TARGETS = Number(process.argv[2] ?? 8);
const INSTANCES = Number(process.argv[3] ?? 8);

await mkdir(tmp, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/app/tools/atlas/steiner.ts')],
  outfile: path.join(tmp, 'steiner.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'warning',
});
const { solveSteiner } = await import(pathToFileURL(path.join(tmp, 'steiner.mjs')).href);

const raw = JSON.parse(await readFile(path.join(root, 'public/assets/atlas/3.29/tree.json'), 'utf8'));

const ids = Object.keys(raw.nodes);
const index = new Map(ids.map((id, i) => [id, i]));
const nb = ids.map(() => new Set());
for (const id of ids) {
  const a = index.get(id);
  for (const t of [...(raw.nodes[id].out ?? []), ...(raw.nodes[id].in ?? [])]) {
    const b = index.get(t);
    if (b === undefined) continue;
    nb[a].add(b);
    nb[b].add(a);
  }
}
const offsets = new Int32Array(ids.length + 1);
for (let i = 0; i < ids.length; i++) offsets[i + 1] = offsets[i] + nb[i].size;
const adjacency = new Int32Array(offsets[ids.length]);
for (let i = 0; i < ids.length; i++) adjacency.set([...nb[i]], offsets[i]);
const g = { n: ids.length, offsets, adjacency };
const rootIdx = index.get('root');

const kindOf = (i) => {
  const n = raw.nodes[ids[i]];
  if (ids[i] === 'root') return 'root';
  if (n.isMastery) return 'mastery';
  if (n.isWormhole) return 'wormhole';
  if (n.isKeystone) return 'keystone';
  if (n.isNotable) return 'notable';
  return 'normal';
};
// must mirror KIND_PENALTY in atlas.ts
const KIND_PENALTY = { wormhole: 8, keystone: 4, normal: 1, notable: 0 };
const penalties = Int32Array.from(ids.map((_, i) => KIND_PENALTY[kindOf(i)] ?? 0));

const notables = ids
  .map((id, i) => (raw.nodes[id].isNotable ? i : -1))
  .filter((i) => i >= 0 && nb[i].size > 0);

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

/** Counts filler only — the targets themselves are forced either way. */
function filler(nodes, terminals) {
  const forced = new Set(terminals);
  const out = { wormhole: 0, keystone: 0, normal: 0, notable: 0 };
  for (const v of nodes) {
    if (forced.has(v)) continue;
    const kind = kindOf(v);
    if (kind in out) out[kind]++;
  }
  return out;
}

const rnd = rng(90210);
let costChanged = 0;
const before = { wormhole: 0, keystone: 0, normal: 0, notable: 0 };
const after = { wormhole: 0, keystone: 0, normal: 0, notable: 0 };

console.log(`${TARGETS} targets, ${INSTANCES} instances\n`);

for (let run = 0; run < INSTANCES; run++) {
  const picked = [];
  while (picked.length < TARGETS) {
    const cand = notables[(rnd() * notables.length) | 0];
    if (!picked.includes(cand)) picked.push(cand);
  }
  const terminals = [rootIdx, ...picked];
  const opts = { heuristicMs: 350, exactMs: 8000 };

  const plain = solveSteiner(g, terminals, opts);
  const ranked = solveSteiner(g, terminals, { ...opts, penalties });

  const a = filler(plain.nodes, terminals);
  const b = filler(ranked.nodes, terminals);
  for (const key of Object.keys(before)) {
    before[key] += a[key];
    after[key] += b[key];
  }
  if (plain.cost !== ranked.cost) costChanged++;

  console.log(
    `#${run + 1}: ${plain.cost} pts -> ${ranked.cost} pts · ` +
      `gateways ${a.wormhole}->${b.wormhole} · keystones ${a.keystone}->${b.keystone} · ` +
      `notables ${a.notable}->${b.notable}`,
  );
}

console.log(`\nfiller totals  before: ${JSON.stringify(before)}`);
console.log(`               after:  ${JSON.stringify(after)}`);
console.log(
  costChanged === 0
    ? '\nOK — point count identical in every instance'
    : `\nFAIL — cost changed in ${costChanged} instance(s); the tie-break must never do that`,
);
process.exit(costChanged === 0 ? 0 : 1);
