import { bfs, UNREACHABLE, walkBack, type Graph } from './graph';

export interface SteinerOptions {
  /** milliseconds spent on randomised construction + local search */
  heuristicMs?: number;
  /** milliseconds the exact Dreyfus–Wagner pass may run before we give up */
  exactMs?: number;
  onProgress?: (phase: string, fraction: number) => void;
  seed?: number;
}

export interface SteinerResult {
  /** every node of the resulting tree, terminals included */
  nodes: number[];
  /** nodes.length - 1 — i.e. how many edges the tree has */
  cost: number;
  /** true when the result is provably minimal */
  optimal: boolean;
  /** terminals that could not be reached at all */
  unreachable: number[];
  ms: number;
  note: string;
}

const INF = 0x3fffffff;

/** Deterministic xorshift32 so identical input always gives identical output. */
function makeRng(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/**
 * Minimum node-count subtree of `g` containing every terminal.
 *
 * Node costs are uniform (every atlas passive costs one point) and a tree with
 * V nodes has V-1 edges, so minimising nodes is exactly the unit-weight Steiner
 * tree problem — which lets us use the classic algorithms unchanged.
 */
export function solveSteiner(
  g: Graph,
  rawTerminals: number[],
  opts: SteinerOptions = {},
): SteinerResult {
  const t0 = now();
  const heuristicMs = opts.heuristicMs ?? 400;
  const exactMs = opts.exactMs ?? 8000;
  const progress = opts.onProgress ?? (() => {});

  const terminals = [...new Set(rawTerminals)];
  if (terminals.length === 0) {
    return { nodes: [], cost: 0, optimal: true, unreachable: [], ms: 0, note: 'empty' };
  }
  if (terminals.length === 1) {
    return {
      nodes: [terminals[0]],
      cost: 0,
      optimal: true,
      unreachable: [],
      ms: now() - t0,
      note: 'single node',
    };
  }

  // --- reachability ---------------------------------------------------------
  const probe = new Int32Array(g.n);
  bfs(g, [terminals[0]], probe);
  const unreachable = terminals.filter((t) => probe[t] === UNREACHABLE);
  const live = terminals.filter((t) => probe[t] !== UNREACHABLE);
  if (live.length <= 1) {
    return {
      nodes: live,
      cost: 0,
      optimal: true,
      unreachable,
      ms: now() - t0,
      note: 'targets are disconnected',
    };
  }

  const k = live.length;
  const dists: Int32Array[] = [];
  const parents: Int32Array[] = [];
  for (let i = 0; i < k; i++) {
    const d = new Int32Array(g.n);
    const p = new Int32Array(g.n);
    bfs(g, [live[i]], d, p);
    dists.push(d);
    parents.push(p);
  }

  // --- construction + local search -----------------------------------------
  progress('searching', 0.05);
  const rng = makeRng(opts.seed ?? 12345);
  let best = shortestPathHeuristic(g, live, dists, parents, 0, rng);
  best = minimiseSet(g, best, live);

  // Nodes that sit "between" many terminals make the best extra Steiner points,
  // so try those first before falling back to random ones near the current tree.
  const ranked = rankSteinerCandidates(g, dists, 80);

  let guides: number[] = [];
  let round = 0;
  const improve = (budgetMs: number, progressCap: number) => {
    const deadline = now() + budgetMs;
    while (now() < deadline) {
      round++;
      const startIdx = round % k;
      let extra: number[] = [];
      if (round % 4 !== 0) {
        const pool = round <= ranked.length ? ranked : neighbourhood(g, best);
        const pick = round <= ranked.length ? ranked[round - 1] : pool[(rng() * pool.length) | 0];
        if (pick !== undefined) extra = [pick];
      }
      const candidate = minimiseSet(
        g,
        shortestPathHeuristic(g, live, dists, parents, startIdx, rng, [...guides, ...extra]),
        live,
      );
      if (candidate.length < best.length) {
        best = candidate;
        guides = [...guides, ...extra].slice(-6);
      }
      if ((round & 15) === 0) {
        progress('searching', Math.min(progressCap, 0.05 + (round / 500) * progressCap));
      }
    }
  };
  improve(heuristicMs, 0.45);

  let optimal = false;
  let note = 'heuristic';

  // --- exact pass -----------------------------------------------------------
  const ub = best.length - 1; // edges
  const allowed = pruneVertices(g, live, dists, ub);
  let allowedCount = 0;
  for (let i = 0; i < g.n; i++) if (allowed[i]) allowedCount++;

  const subsets = 1 << (k - 1);
  const mergeOps = (Math.pow(3, k - 1) / 2) * allowedCount;
  const memory = subsets * allowedCount;
  if (k <= 24 && mergeOps <= 3e9 && memory <= 2e7) {
    progress('exact search', 0.5);
    const exact = dreyfusWagner(g, live, allowed, ub, now() + exactMs, (f) =>
      progress('exact search', 0.5 + f * 0.5),
    );
    if (exact) {
      optimal = true;
      note = 'optimal';
      const cleaned = minimiseSet(g, exact, live);
      if (cleaned.length < best.length) best = cleaned;
    } else {
      note = 'heuristic (exact search ran out of time)';
    }
  } else {
    // No exact pass for this instance — spend that time searching harder instead.
    improve(Math.min(exactMs, heuristicMs * 4), 0.95);
    note = 'heuristic (too many targets for an exact search)';
  }

  progress('done', 1);
  return {
    nodes: best,
    cost: Math.max(0, best.length - 1),
    optimal,
    unreachable,
    ms: now() - t0,
    note,
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** The `limit` nodes with the smallest total distance to every terminal. */
function rankSteinerCandidates(g: Graph, dists: Int32Array[], limit: number): number[] {
  const scored: Array<{ v: number; score: number }> = [];
  for (let v = 0; v < g.n; v++) {
    let sum = 0;
    let ok = true;
    for (const d of dists) {
      if (d[v] === UNREACHABLE) {
        ok = false;
        break;
      }
      sum += d[v];
    }
    if (ok) scored.push({ v, score: sum });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.v);
}

/** Nodes adjacent to (but outside of) the current tree — candidates worth trying. */
function neighbourhood(g: Graph, tree: number[]): number[] {
  const inTree = new Set(tree);
  const out = new Set<number>();
  for (const v of tree) {
    for (let e = g.offsets[v]; e < g.offsets[v + 1]; e++) {
      const u = g.adjacency[e];
      if (!inTree.has(u)) out.add(u);
    }
  }
  return [...out];
}

/**
 * Classic shortest-path heuristic: grow a tree from one terminal, repeatedly
 * attaching the closest terminal that is not connected yet. Ties are broken at
 * random so repeated runs explore different trees.
 */
function shortestPathHeuristic(
  g: Graph,
  terminals: number[],
  dists: Int32Array[],
  parents: Int32Array[],
  startIdx: number,
  rng: () => number,
  guides: number[] = [],
): number[] {
  const tree = new Set<number>();
  const pending = new Set<number>();
  terminals.forEach((t, i) => {
    if (i === startIdx) tree.add(t);
    else pending.add(t);
  });
  for (const gnode of guides) if (!tree.has(gnode)) pending.add(gnode);

  // First hop uses the precomputed single-source data, later hops need a fresh
  // multi-source BFS from the whole tree.
  const dist = new Int32Array(g.n);
  const parent = new Int32Array(g.n);

  while (pending.size) {
    const sources = [...tree];
    if (sources.length === 1 && terminals.includes(sources[0])) {
      const i = terminals.indexOf(sources[0]);
      dist.set(dists[i]);
      parent.set(parents[i]);
    } else {
      bfs(g, sources, dist, parent);
    }
    let bestDist = Infinity;
    const bestTargets: number[] = [];
    for (const t of pending) {
      const d = dist[t];
      if (d === UNREACHABLE) continue;
      if (d < bestDist) {
        bestDist = d;
        bestTargets.length = 0;
        bestTargets.push(t);
      } else if (d === bestDist) {
        bestTargets.push(t);
      }
    }
    if (!bestTargets.length) break; // remaining terminals are unreachable
    const target = bestTargets[(rng() * bestTargets.length) | 0];
    for (const v of walkBack(parent, target)) tree.add(v);
    pending.delete(target);
  }
  return [...tree];
}

/**
 * Drops every node that is not needed: leaves, and any redundant node left over
 * from a cycle in the induced subgraph. Cheap and reliably worth a point or two.
 */
function minimiseSet(g: Graph, nodes: number[], terminals: number[]): number[] {
  const set = new Set(nodes);
  const required = new Set(terminals);
  let changed = true;
  while (changed) {
    changed = false;
    const ordered = [...set].sort((a, b) => degreeIn(g, set, a) - degreeIn(g, set, b));
    for (const v of ordered) {
      if (required.has(v)) continue;
      set.delete(v);
      if (stillConnected(g, set, terminals)) {
        changed = true;
      } else {
        set.add(v);
      }
    }
  }
  return [...set];
}

function degreeIn(g: Graph, set: Set<number>, v: number): number {
  let d = 0;
  for (let e = g.offsets[v]; e < g.offsets[v + 1]; e++) if (set.has(g.adjacency[e])) d++;
  return d;
}

function stillConnected(g: Graph, set: Set<number>, terminals: number[]): boolean {
  for (const t of terminals) if (!set.has(t)) return false;
  const seen = new Set<number>([terminals[0]]);
  const stack = [terminals[0]];
  while (stack.length) {
    const v = stack.pop()!;
    for (let e = g.offsets[v]; e < g.offsets[v + 1]; e++) {
      const u = g.adjacency[e];
      if (set.has(u) && !seen.has(u)) {
        seen.add(u);
        stack.push(u);
      }
    }
  }
  return seen.size === set.size && terminals.every((t) => seen.has(t));
}

/**
 * A node v can only appear in a tree of cost <= ub if, for every pair of
 * terminals a,b, (d(v,a) + d(v,b) + d(a,b)) / 2 <= ub — the three paths inside
 * the tree overlap at most pairwise. Usually cuts the 1000-node graph down to a
 * couple hundred, which is what makes the exact pass affordable.
 */
function pruneVertices(g: Graph, terminals: number[], dists: Int32Array[], ub: number): Uint8Array {
  const k = terminals.length;
  const allowed = new Uint8Array(g.n);
  const pair: number[][] = [];
  for (let i = 0; i < k; i++) {
    pair.push([]);
    for (let j = 0; j < k; j++) pair[i].push(dists[i][terminals[j]]);
  }
  outer: for (let v = 0; v < g.n; v++) {
    for (let i = 0; i < k; i++) {
      const di = dists[i][v];
      if (di === UNREACHABLE || di > ub) continue outer;
      for (let j = i + 1; j < k; j++) {
        const dj = dists[j][v];
        if (dj === UNREACHABLE) continue outer;
        if (Math.ceil((di + dj + pair[i][j]) / 2) > ub) continue outer;
      }
    }
    allowed[v] = 1;
  }
  for (const t of terminals) allowed[t] = 1;
  return allowed;
}

/**
 * Dreyfus–Wagner over the pruned subgraph: dp[S][v] is the cheapest tree that
 * spans terminal subset S plus vertex v. Subsets are merged, then relaxed along
 * edges with a bucket queue (all edges cost 1, so Dial's algorithm applies).
 */
function dreyfusWagner(
  g: Graph,
  terminals: number[],
  allowed: Uint8Array,
  ub: number,
  deadline: number,
  progress: (f: number) => void,
): number[] | null {
  // compact the vertex set
  const local = new Int32Array(g.n).fill(-1);
  const global: number[] = [];
  for (let v = 0; v < g.n; v++) {
    if (allowed[v]) {
      local[v] = global.length;
      global.push(v);
    }
  }
  const m = global.length;
  const off = new Int32Array(m + 1);
  const adjList: number[] = [];
  for (let i = 0; i < m; i++) {
    off[i] = adjList.length;
    const v = global[i];
    for (let e = g.offsets[v]; e < g.offsets[v + 1]; e++) {
      const u = local[g.adjacency[e]];
      if (u >= 0) adjList.push(u);
    }
  }
  off[m] = adjList.length;
  const adj = Int32Array.from(adjList);

  const term = terminals.map((t) => local[t]);
  const k = term.length;
  const T = k - 1; // last terminal is the fixed "extra vertex"
  const root = term[k - 1];
  const FULL = (1 << T) - 1;

  const dp = new Int32Array((FULL + 1) * m).fill(INF);
  for (let i = 0; i < T; i++) dp[(1 << i) * m + term[i]] = 0;

  // Append-only buckets: a vertex may be queued more than once, and the stale
  // check below discards the outdated entries. Linked-list buckets would be
  // cheaper but corrupt themselves when a queued vertex is relaxed again.
  const buckets: number[][] = Array.from({ length: ub + 2 }, () => []);

  let checkCounter = 0;
  for (let S = 1; S <= FULL; S++) {
    const base = S * m;
    const low = S & -S;
    const rest = S ^ low;
    if (rest) {
      for (let sub = (rest - 1) & rest; ; sub = (sub - 1) & rest) {
        const s1 = (sub | low) * m;
        const s2 = (S ^ (sub | low)) * m;
        for (let v = 0; v < m; v++) {
          const a = dp[s1 + v];
          if (a === INF) continue;
          const b = dp[s2 + v];
          if (b === INF) continue;
          const c = a + b;
          if (c < dp[base + v]) dp[base + v] = c;
        }
        if (sub === 0) break;
      }
    }

    // Dial relaxation of dp[S][*] along unit-weight edges
    for (let d = 0; d <= ub + 1; d++) buckets[d].length = 0;
    for (let v = 0; v < m; v++) {
      const d = dp[base + v];
      if (d <= ub) buckets[d].push(v);
    }
    for (let d = 0; d < ub; d++) {
      const bucket = buckets[d];
      const nd = d + 1;
      for (let i = 0; i < bucket.length; i++) {
        const v = bucket[i];
        if (dp[base + v] !== d) continue;
        for (let e = off[v]; e < off[v + 1]; e++) {
          const u = adj[e];
          if (nd < dp[base + u]) {
            dp[base + u] = nd;
            buckets[nd].push(u);
          }
        }
      }
    }

    if ((checkCounter++ & 7) === 0) {
      progress(S / (FULL + 1));
      if (now() > deadline) return null;
    }
  }

  if (dp[FULL * m + root] >= INF) return null;

  // --- reconstruct ----------------------------------------------------------
  const out = new Set<number>();
  const visited = new Set<number>();
  const stack: Array<[number, number]> = [[FULL, root]];
  while (stack.length) {
    const [S, v] = stack.pop()!;
    if (visited.has(S * m + v)) continue;
    visited.add(S * m + v);
    out.add(global[v]);
    const cost = dp[S * m + v];
    if (cost === 0) continue;

    let handled = false;
    const low = S & -S;
    const rest = S ^ low;
    if (rest) {
      for (let sub = (rest - 1) & rest; ; sub = (sub - 1) & rest) {
        const s1 = sub | low;
        const s2 = S ^ s1;
        if (s2 !== 0 && dp[s1 * m + v] + dp[s2 * m + v] === cost) {
          stack.push([s1, v], [s2, v]);
          handled = true;
          break;
        }
        if (sub === 0) break;
      }
    }
    if (handled) continue;

    for (let e = off[v]; e < off[v + 1]; e++) {
      const u = adj[e];
      if (dp[S * m + u] + 1 === cost) {
        stack.push([S, u]);
        handled = true;
        break;
      }
    }
    if (!handled) {
      // dp says this subset is satisfied here; nothing left to expand
      continue;
    }
  }
  return [...out];
}
