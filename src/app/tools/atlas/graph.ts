/** Plain CSR graph — the only thing the solver (and its worker) needs to know. */
export interface Graph {
  n: number;
  offsets: Int32Array;
  adjacency: Int32Array;
}

export const UNREACHABLE = -1;

/**
 * Unit-weight BFS from one or more sources.
 * `dist` and `parent` are filled in place; `parent` is -1 at sources and unreachable nodes.
 */
export function bfs(
  g: Graph,
  sources: ArrayLike<number>,
  dist: Int32Array,
  parent?: Int32Array,
  blocked?: Uint8Array,
): void {
  dist.fill(UNREACHABLE);
  parent?.fill(-1);
  const queue = new Int32Array(g.n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (dist[s] !== UNREACHABLE) continue;
    dist[s] = 0;
    queue[tail++] = s;
  }
  while (head < tail) {
    const v = queue[head++];
    const d = dist[v] + 1;
    for (let e = g.offsets[v]; e < g.offsets[v + 1]; e++) {
      const u = g.adjacency[e];
      if (dist[u] !== UNREACHABLE) continue;
      if (blocked && blocked[u]) continue;
      dist[u] = d;
      if (parent) parent[u] = v;
      queue[tail++] = u;
    }
  }
}

/**
 * Copy of `g` with every blocked vertex isolated — its edges are dropped in
 * both directions, so nothing can route through it. Indices are unchanged, so
 * every caller keeps working against the same node numbering; a blocked vertex
 * simply becomes unreachable.
 *
 * Doing it once up front is what keeps the solver itself oblivious to
 * exclusions: BFS, pruning and the exact pass all just see a smaller graph.
 */
export function withoutBlocked(g: Graph, blocked: Uint8Array): Graph {
  const offsets = new Int32Array(g.n + 1);
  const kept: number[] = [];
  for (let v = 0; v < g.n; v++) {
    offsets[v] = kept.length;
    if (!blocked[v]) {
      for (let e = g.offsets[v]; e < g.offsets[v + 1]; e++) {
        const u = g.adjacency[e];
        if (!blocked[u]) kept.push(u);
      }
    }
  }
  offsets[g.n] = kept.length;
  return { n: g.n, offsets, adjacency: Int32Array.from(kept) };
}

/** Walks `parent` back from `target` to its BFS source. Returns [source … target]. */
export function walkBack(parent: Int32Array, target: number): number[] {
  const path: number[] = [];
  let v = target;
  while (v !== -1) {
    path.push(v);
    v = parent[v];
  }
  return path.reverse();
}

/** Nodes of `set` that stay connected to `from` using only nodes in `set`. */
export function connectedWithin(g: Graph, set: Set<number>, from: number): Set<number> {
  const out = new Set<number>();
  if (!set.has(from)) return out;
  const stack = [from];
  out.add(from);
  while (stack.length) {
    const v = stack.pop()!;
    for (let e = g.offsets[v]; e < g.offsets[v + 1]; e++) {
      const u = g.adjacency[e];
      if (set.has(u) && !out.has(u)) {
        out.add(u);
        stack.push(u);
      }
    }
  }
  return out;
}
