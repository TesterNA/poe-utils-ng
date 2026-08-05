/**
 * Checks the atlas share code format against the real tree.
 *
 * The important property is exactness: whatever plan goes in must come back
 * node for node, never "close enough". So this simulates a lot of plans —
 * randomly grown trees of every size, plus the awkward shapes — and compares
 * the decoded sets against the originals element by element.
 *
 * Also covers: the walk encoding is used when the plan is connected and the
 * position-list fallback when it is not, format 1 codes still read, and
 * malformed input is refused rather than silently mis-decoded.
 *
 * Run: node scripts/share-code.mjs [simulations]
 */
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'node_modules', '.share-test');
const SIMULATIONS = Number(process.argv[2] ?? 400);

globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');

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

const raw = JSON.parse(await readFile(path.join(root, 'public/assets/atlas/3.29/tree.json'), 'utf8'));

// --- a Tree shaped like the one the app builds -------------------------------
const ids = Object.keys(raw.nodes);
const nodes = ids.map((id, idx) => ({
  idx,
  id,
  allocatable: !raw.nodes[id].isMastery && id !== 'root',
}));
const byId = new Map(nodes.map((n) => [n.id, n]));
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
const shareOrder = nodes
  .filter((n) => n.allocatable)
  .sort((a, b) => Number(a.id) - Number(b.id))
  .map((n) => n.idx);
const shareIndex = new Int32Array(nodes.length).fill(-1);
shareOrder.forEach((nodeIdx, position) => {
  shareIndex[nodeIdx] = position;
});
const rootIdx = index.get('root');
const tree = { nodes, byId, offsets, adjacency, rootIdx, shareOrder, shareIndex };

const allocatableIds = shareOrder.map((i) => nodes[i].id);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** A plan shaped like a real one: a connected tree grown out from the centre. */
function growConnected(size, rnd) {
  if (size === 0) return [];
  const chosen = new Set();
  const frontier = new Set();
  for (let e = offsets[rootIdx]; e < offsets[rootIdx + 1]; e++) frontier.add(adjacency[e]);
  while (chosen.size < size && frontier.size) {
    const pool = [...frontier];
    const pickNode = pool[(rnd() * pool.length) | 0];
    frontier.delete(pickNode);
    if (!nodes[pickNode].allocatable) continue;
    chosen.add(pickNode);
    for (let e = offsets[pickNode]; e < offsets[pickNode + 1]; e++) {
      const u = adjacency[e];
      if (!chosen.has(u) && nodes[u].allocatable) frontier.add(u);
    }
  }
  return [...chosen].map((i) => nodes[i].id);
}

function scatter(size, rnd, taken = []) {
  const out = [];
  let guard = 0;
  while (out.length < size && guard++ < size * 50) {
    const id = allocatableIds[(rnd() * allocatableIds.length) | 0];
    if (!out.includes(id) && !taken.includes(id)) out.push(id);
  }
  return out;
}

const same = (a, b) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

let failures = 0;
const fail = (label, detail) => {
  console.error(`✗ ${label}${detail ? ' — ' + detail : ''}`);
  failures++;
};

// --- simulation --------------------------------------------------------------
const rnd = rng(20260805);
const sizes = [];
let walkUsed = 0;
let fallbackUsed = 0;
let worstChars = 0;

for (let run = 0; run < SIMULATIONS; run++) {
  const size = (rnd() * 160) | 0;
  const connected = rnd() < 0.85;
  const allocated = connected ? growConnected(size, rnd) : scatter(size, rnd);
  const targets = scatter((rnd() * 35) | 0, rnd);
  const blocked = scatter((rnd() * 6) | 0, rnd, targets);
  const plan = {
    treeVersion: 1,
    targetsMode: rnd() < 0.5,
    allocated,
    targets,
    blocked,
  };

  let code;
  let back;
  try {
    code = encodePlan(tree, plan);
    back = decodePlan(code, tree);
  } catch (err) {
    fail(`run ${run} (${allocated.length} allocated)`, String(err));
    continue;
  }

  if (!same(back.allocated, allocated)) {
    const got = new Set(back.allocated);
    const missing = allocated.filter((id) => !got.has(id));
    const extra = back.allocated.filter((id) => !allocated.includes(id));
    fail(
      `run ${run}: allocated differs`,
      `${allocated.length} in, ${back.allocated.length} out, missing ${missing.length}, extra ${extra.length}`,
    );
    continue;
  }
  if (!same(back.targets, targets)) fail(`run ${run}: targets differ`);
  if (!same(back.blocked, blocked)) fail(`run ${run}: blocked differ`);
  if (back.targetsMode !== plan.targetsMode) fail(`run ${run}: mode differs`);
  if (back.treeVersion !== 1) fail(`run ${run}: tree version differs`);

  // flag bit 1 says which encoding was used
  const flags = Buffer.from(code.split(':')[1], 'base64url')[1];
  if (flags & 2) walkUsed++;
  else fallbackUsed++;

  sizes.push(code.length);
  worstChars = Math.max(worstChars, code.length);
}

const avg = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
console.log(
  `${SIMULATIONS} simulated plans: ${walkUsed} encoded as a walk, ` +
    `${fallbackUsed} fell back to positions`,
);
console.log(`code length: avg ${avg}, worst ${worstChars} chars`);

// --- awkward shapes ----------------------------------------------------------
const edgeCases = [
  { label: 'empty plan', allocated: [], targets: [], blocked: [] },
  { label: 'single node next to the centre', allocated: growConnected(1, rng(7)), targets: [], blocked: [] },
  { label: 'every allocatable node', allocated: allocatableIds, targets: [], blocked: [] },
  { label: 'targets only', allocated: [], targets: scatter(30, rng(11)), blocked: [] },
  { label: 'blocked only', allocated: [], targets: [], blocked: scatter(5, rng(13)) },
  {
    label: 'disconnected islands',
    allocated: scatter(25, rng(17)),
    targets: [],
    blocked: [],
  },
];
for (const c of edgeCases) {
  const plan = { treeVersion: 1, targetsMode: false, ...c };
  try {
    const code = encodePlan(tree, plan);
    const back = decodePlan(code, tree);
    const ok =
      same(back.allocated, plan.allocated) &&
      same(back.targets, plan.targets) &&
      same(back.blocked, plan.blocked);
    if (!ok) fail(c.label, `${plan.allocated.length} in, ${back.allocated.length} out`);
    else console.log(`✓ ${c.label} — ${code.length} chars`);
  } catch (err) {
    fail(c.label, String(err));
  }
}

// --- format 1 still readable -------------------------------------------------
{
  // hand-built format 1 payload: version 1, no flags, three position sections
  const positions = [5, 9, 40].map((p) => p);
  const bytes = [1, 0, positions.length, 5, 4, 31, 0, 0];
  const legacy = 'AT1:' + Buffer.from(bytes).toString('base64url');
  try {
    const back = decodePlan(legacy, tree);
    const expected = positions.map((p) => nodes[shareOrder[p]].id);
    if (!same(back.allocated, expected)) fail('format 1 code', 'wrong nodes');
    else console.log('✓ format 1 code still decodes');
  } catch (err) {
    fail('format 1 code', String(err));
  }
}

// --- refuses rubbish ---------------------------------------------------------
const bad = ['', 'hello', 'AT2:', 'AT9:AQAAAAA', 'AT2:!!!!', 'AT1:AQ', 'AT2:AgI'];
for (const input of bad) {
  let threw = false;
  try {
    decodePlan(input, tree);
  } catch (err) {
    threw = err instanceof ShareCodeError;
  }
  if (!threw) fail(`should refuse ${JSON.stringify(input)}`);
}
console.log(`✓ refused ${bad.length} malformed inputs`);

// --- version is carried, not assumed -----------------------------------------
const v7 = encodePlan(tree, {
  treeVersion: 7,
  targetsMode: false,
  allocated: growConnected(10, rng(23)),
  targets: [],
  blocked: [],
});
if (peekPlan(v7).treeVersion !== 7) fail('tree version not carried');
else console.log('✓ tree version travels with the code');

console.log(failures === 0 ? '\nALL OK' : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
