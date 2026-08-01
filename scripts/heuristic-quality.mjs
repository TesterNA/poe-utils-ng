/**
 * How good is the heuristic when the exact pass is out of reach?
 *
 * Above ~15 terminals Dreyfus-Wagner is infeasible (3^k), so the solver falls
 * back to a randomised heuristic and labels the answer "≈". This script asks
 * whether that answer is actually leaving points on the table, by comparing the
 * budget the app uses against much longer and differently-seeded searches on the
 * same instance. If far more effort never finds a smaller tree, the app's answer
 * is very likely optimal even though nothing proves it.
 *
 * Run: node scripts/heuristic-quality.mjs [targetCount] [instances]
 */
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'node_modules', '.solver-bench');
const TARGETS = Number(process.argv[2] ?? 29);
const INSTANCES = Number(process.argv[3] ?? 5);

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

const raw = JSON.parse(
  await readFile(path.join(root, 'public/assets/atlas/tree.json'), 'utf8'),
);

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
const notables = ids
  .map((id, i) => (raw.nodes[id].isNotable || raw.nodes[id].isKeystone ? i : -1))
  .filter((i) => i >= 0 && nb[i].size > 0);

/** Error string when `nodes` is not a connected set covering every terminal. */
function treeError(nodes, terminals) {
  const set = new Set(nodes);
  for (const t of terminals) if (!set.has(t)) return `target ${t} is missing`;
  const seen = new Set([nodes[0]]);
  const stack = [nodes[0]];
  while (stack.length) {
    const v = stack.pop();
    for (let e = offsets[v]; e < offsets[v + 1]; e++) {
      const u = adjacency[e];
      if (set.has(u) && !seen.has(u)) {
        seen.add(u);
        stack.push(u);
      }
    }
  }
  return seen.size === set.size ? null : `not connected (${seen.size}/${set.size})`;
}

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

console.log(
  `${TARGETS} targets (notables/keystones), ${INSTANCES} instances — ` +
    `graph ${g.n} nodes, ${adjacency.length / 2} edges\n`,
);

const rnd = rng(4242);
let beaten = 0;
let totalGain = 0;

for (let run = 0; run < INSTANCES; run++) {
  const picked = [];
  while (picked.length < TARGETS) {
    const cand = notables[(rnd() * notables.length) | 0];
    if (!picked.includes(cand)) picked.push(cand);
  }
  const terminals = [rootIdx, ...picked];

  // exactly what the app spends: 700ms build + up to 2800ms improvement
  const app = solveSteiner(g, terminals, { heuristicMs: 700, exactMs: 8000 });

  // same solver, ~17x the time
  const long = solveSteiner(g, terminals, { heuristicMs: 12000, exactMs: 48000 });

  // and five independent seeds at the app's own budget
  let bestSeeded = Infinity;
  for (let s = 0; s < 5; s++) {
    const r = solveSteiner(g, terminals, { heuristicMs: 700, exactMs: 8000, seed: 1000 + s * 7919 });
    bestSeeded = Math.min(bestSeeded, r.cost);
  }

  // A cheaper tree that is not actually a tree would be worthless, so check.
  const invalid = treeError(app.nodes, terminals);
  if (invalid) {
    console.error(`#${run + 1}: INVALID RESULT — ${invalid}`);
    process.exitCode = 1;
  }

  const best = Math.min(long.cost, bestSeeded);
  const gain = app.cost - best;
  if (gain > 0) {
    beaten++;
    totalGain += gain;
  }
  console.log(
    `#${run + 1}: app ${app.cost} pts (${Math.round(app.ms)} ms) · ` +
      `long ${long.cost} · best-of-5-seeds ${bestSeeded} · ` +
      (gain > 0 ? `BEATEN by ${gain}` : 'nothing found better'),
  );
}

console.log(
  `\n${beaten}/${INSTANCES} instances where far more effort found a smaller tree` +
    (beaten ? ` (total ${totalGain} points)` : ''),
);
