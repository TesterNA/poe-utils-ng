/**
 * How short can a share code get without a backend?
 *
 * Measures the current encoding against the alternatives on real plans, so the
 * decision is made on numbers rather than intuition. Run with a code to measure
 * that exact plan, otherwise it uses generated ones.
 *
 * Run: node scripts/share-size.mjs [AT1:code]
 */
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(await readFile(path.join(root, 'public/assets/atlas/3.29/tree.json'), 'utf8'));

const ids = Object.keys(raw.nodes);
const allocatable = ids
  .filter((id) => !raw.nodes[id].isMastery && id !== 'root')
  .sort((a, b) => Number(a) - Number(b));
const positionOf = new Map(allocatable.map((id, i) => [id, i]));
const N = allocatable.length;

// the real adjacency, so a plan can be encoded as decisions along a walk
const nodeIndex = new Map(ids.map((id, i) => [id, i]));
const nodeCount = ids.length;
const rootIdx = nodeIndex.get('root');
const nb = ids.map(() => new Set());
for (const id of ids) {
  const a = nodeIndex.get(id);
  for (const t of [...(raw.nodes[id].out ?? []), ...(raw.nodes[id].in ?? [])]) {
    const b = nodeIndex.get(t);
    if (b === undefined) continue;
    nb[a].add(b);
    nb[b].add(a);
  }
}
const offsets = new Int32Array(nodeCount + 1);
for (let i = 0; i < nodeCount; i++) offsets[i + 1] = offsets[i] + nb[i].size;
const adjacency = new Int32Array(offsets[nodeCount]);
for (let i = 0; i < nodeCount; i++) adjacency.set([...nb[i]], offsets[i]);
const posOfNode = new Int32Array(nodeCount).fill(-1);
ids.forEach((id, i) => {
  const p = positionOf.get(id);
  if (p !== undefined) posOfNode[i] = p;
});

// --- encodings ---------------------------------------------------------------

function varint(out, value) {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/** what ships today: count + gaps between sorted positions */
function gapEncode(positions) {
  const out = [];
  const sorted = [...positions].sort((a, b) => a - b);
  varint(out, sorted.length);
  let prev = 0;
  for (const p of sorted) {
    varint(out, p - prev);
    prev = p;
  }
  return out;
}

/** one bit per allocatable node — flat cost, wins once the set is dense */
function bitsetEncode(positions) {
  const bytes = new Uint8Array(Math.ceil(N / 8));
  for (const p of positions) bytes[p >> 3] |= 1 << (p & 7);
  return [...bytes];
}

/** positions expressed as indices into another section, for subsets */
function relativeEncode(positions, basis) {
  const order = [...basis].sort((a, b) => a - b);
  const rank = new Map(order.map((p, i) => [p, i]));
  const inside = [];
  const outside = [];
  for (const p of positions) {
    const r = rank.get(p);
    if (r === undefined) outside.push(p);
    else inside.push(r);
  }
  return [...gapEncode(inside), ...gapEncode(outside)];
}

const b64 = (bytes) => Buffer.from(Uint8Array.from(bytes)).toString('base64url');
const deflate = (bytes) => [...deflateRawSync(Buffer.from(Uint8Array.from(bytes)), { level: 9 })];

/**
 * The allocated set is always a connected subtree hanging off the Atlas centre,
 * which is far more information than "an arbitrary subset". Walk the real graph
 * from the centre and emit one bit per node the walk first reaches from an
 * already-included node: "in the plan or not". The decoder repeats the same walk
 * and reads the same bits, so nothing but those decisions has to be stored.
 */
function connectedEncode(positions) {
  const inPlan = new Set(positions);
  const decided = new Uint8Array(nodeCount);
  const bits = [];
  decided[rootIdx] = 1;
  const queue = [rootIdx];
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    for (let e = offsets[v]; e < offsets[v + 1]; e++) {
      const u = adjacency[e];
      if (decided[u]) continue;
      decided[u] = 1;
      const pos = posOfNode[u];
      const included = pos >= 0 && inPlan.has(pos);
      bits.push(included ? 1 : 0);
      if (included) queue.push(u);
    }
  }
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => {
    if (bit) bytes[i >> 3] |= 1 << (i & 7);
  });
  return [...bytes];
}

// --- plans to measure --------------------------------------------------------

const argCode = process.argv[2];
const plans = [];

if (argCode) {
  // decode with the current format so the real plan can be measured
  const payload = Buffer.from(argCode.trim().split(':')[1] ?? '', 'base64url');
  let at = 2;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = payload[at++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };
  const readSection = () => {
    const count = readVarint();
    const out = [];
    let prev = 0;
    for (let i = 0; i < count; i++) {
      prev += readVarint();
      out.push(prev);
    }
    return out;
  };
  plans.push({
    label: 'your code',
    allocated: readSection(),
    targets: readSection(),
    blocked: readSection(),
  });
}

const rnd = (() => {
  let s = 20260805;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
})();
const pick = (n) => {
  const out = new Set();
  while (out.size < n) out.add((rnd() * N) | 0);
  return [...out];
};
for (const n of [20, 60, 138]) {
  plans.push({ label: `${n} allocated`, allocated: pick(n), targets: pick(Math.min(n, 30)), blocked: [] });
}

// --- report ------------------------------------------------------------------

console.log(`${N} allocatable nodes\n`);
const row = (label, chars, note = '') =>
  console.log(`  ${label.padEnd(34)} ${String(chars).padStart(5)} chars${note ? '   ' + note : ''}`);

for (const plan of plans) {
  console.log(
    `${plan.label}: ${plan.allocated.length} allocated, ` +
      `${plan.targets.length} targets, ${plan.blocked.length} blocked`,
  );

  const header = [1, 0];
  const current = [...header, ...gapEncode(plan.allocated), ...gapEncode(plan.targets), ...gapEncode(plan.blocked)];
  const bitset = [...header, ...bitsetEncode(plan.allocated), ...gapEncode(plan.targets), ...gapEncode(plan.blocked)];
  const relative = [
    ...header,
    ...gapEncode(plan.allocated),
    ...relativeEncode(plan.targets, plan.allocated),
    ...relativeEncode(plan.blocked, plan.allocated),
  ];
  const best = relative.length < bitset.length ? relative : bitset;

  row('current (gap varints)', b64(current).length + 4);
  row('bitset for allocated', b64(bitset).length + 4);
  row('targets relative to allocated', b64(relative).length + 4);
  row('current + deflate', b64(deflate(current)).length + 4);
  row('bitset + deflate', b64(deflate(bitset)).length + 4);
  row('relative + deflate', b64(deflate(relative)).length + 4);
  const connected = [
    ...header,
    ...connectedEncode(plan.allocated),
    ...gapEncode(plan.targets),
    ...gapEncode(plan.blocked),
  ];
  // targets are usually a subset of the allocated tree: one bit each over that
  // set beats a position per target
  const insideMask = (positions, basis) => {
    const order = [...basis].sort((a, b) => a - b);
    const rank = new Map(order.map((p, i) => [p, i]));
    const bytes = new Uint8Array(Math.ceil(order.length / 8));
    const outside = [];
    for (const p of positions) {
      const r = rank.get(p);
      if (r === undefined) outside.push(p);
      else bytes[r >> 3] |= 1 << (r & 7);
    }
    return [...(order.length ? bytes : []), ...gapEncode(outside)];
  };
  const connectedPlus = [
    ...header,
    ...connectedEncode(plan.allocated),
    ...insideMask(plan.targets, plan.allocated),
    ...insideMask(plan.blocked, plan.allocated),
  ];
  row('connected walk (allocated)', b64(connected).length + 4);
  row('connected walk + target mask', b64(connectedPlus).length + 4);
  row('connected walk + deflate', b64(deflate(connected)).length + 4);
  row('best of the above', Math.min(b64(deflate(best)).length, b64(best).length, b64(connected).length, b64(deflate(connected)).length) + 4);
  console.log();
}
