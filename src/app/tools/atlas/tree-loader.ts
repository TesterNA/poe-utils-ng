import type { Edge, GroupInfo, NodeKind, RawTree, Tree, TreeNode } from './tree-types';
import { DEFAULT_TREE_VERSION, findTreeVersion } from './tree-versions';

/**
 * GGG's tree layout does not space nodes evenly on the 16- and 40-slot orbits;
 * both use a fixed table of angles. Every other orbit is uniform.
 */
const ANGLES_16 = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];
const ANGLES_40 = [
  0, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170, 180, 190,
  200, 210, 220, 225, 230, 240, 250, 260, 270, 280, 290, 300, 310, 315, 320, 330, 340, 350,
];

function orbitAngle(skillsPerOrbit: number[], orbit: number, index: number): number {
  const n = skillsPerOrbit[orbit] ?? 1;
  if (n === 16) return (ANGLES_16[index % 16] * Math.PI) / 180;
  if (n === 40) return (ANGLES_40[index % 40] * Math.PI) / 180;
  return (2 * Math.PI * (index % n)) / n;
}

/** Frame half-width in tree units, used for hit-testing and drawing. */
const RADIUS: Record<NodeKind, number> = {
  normal: 51,
  notable: 76,
  keystone: 109,
  wormhole: 145,
  mastery: 113,
  root: 200,
};

/**
 * A few nodes hand out atlas points of their own — Unwavering Vision grants 20.
 * Read from the stat text so a new league's wording or a second such node is
 * picked up without touching the code.
 */
const GRANTS_POINTS = /Grants (\d+) Atlas Passive Skill Points?/i;

function pointsGranted(stats: string[]): number {
  for (const stat of stats) {
    const match = GRANTS_POINTS.exec(stat);
    if (match) return Number(match[1]);
  }
  return 0;
}

function kindOf(id: string, raw: RawTree['nodes'][string]): NodeKind {
  if (id === 'root') return 'root';
  if (raw.isMastery) return 'mastery';
  if (raw.isWormhole) return 'wormhole';
  if (raw.isKeystone) return 'keystone';
  if (raw.isNotable) return 'notable';
  return 'normal';
}

export function buildTree(raw: RawTree): Tree {
  const { skillsPerOrbit, orbitRadii } = raw.constants;

  const ids = Object.keys(raw.nodes);
  const nodes: TreeNode[] = [];
  const byId = new Map<string, TreeNode>();
  const indexOf = new Map<string, number>();

  for (const id of ids) {
    const r = raw.nodes[id];
    const kind = kindOf(id, r);
    const group = raw.groups[String(r.group ?? 0)];
    const orbit = r.orbit ?? 0;
    const orbitIndex = r.orbitIndex ?? 0;
    const angle = orbitAngle(skillsPerOrbit, orbit, orbitIndex);
    const radius = orbitRadii[orbit] ?? 0;
    const idx = nodes.length;

    const stats = r.stats ?? [];
    const node: TreeNode = {
      idx,
      id,
      name: r.name ?? (id === 'root' ? 'Atlas Centre' : id),
      icon: r.icon ?? '',
      stats,
      reminder: r.reminderText ?? [],
      flavour: r.flavourText ?? [],
      kind,
      allocatable: kind !== 'mastery' && kind !== 'root',
      group: r.group ?? 0,
      orbit,
      orbitIndex,
      x: (group?.x ?? 0) + radius * Math.sin(angle),
      y: (group?.y ?? 0) - radius * Math.cos(angle),
      radius: RADIUS[kind],
      grantsPoints: pointsGranted(stats),
      searchText: `${r.name ?? ''}\n${stats.join('\n')}`.toLowerCase(),
    };
    nodes.push(node);
    byId.set(id, node);
    indexOf.set(id, idx);
  }

  // --- edges (undirected, deduplicated) -------------------------------------
  const seen = new Set<number>();
  const edges: Edge[] = [];
  const neighbours: number[][] = nodes.map(() => []);

  const pushEdge = (ai: number, bi: number) => {
    const key = ai < bi ? ai * 100000 + bi : bi * 100000 + ai;
    if (seen.has(key)) return;
    seen.add(key);
    const a = nodes[ai];
    const b = nodes[bi];
    neighbours[ai].push(bi);
    neighbours[bi].push(ai);

    // Nodes sharing a group and orbit are connected by an arc along that orbit.
    let arc = false;
    let cx = 0;
    let cy = 0;
    let r = 0;
    let a0 = 0;
    let a1 = 0;
    let anticlockwise = false;
    if (a.group === b.group && a.orbit === b.orbit && a.orbit > 0) {
      const g = raw.groups[String(a.group)];
      const rad = orbitRadii[a.orbit];
      // canvas angles are measured from +x; tree angles from -y
      const ang0 = orbitAngle(skillsPerOrbit, a.orbit, a.orbitIndex) - Math.PI / 2;
      const ang1 = orbitAngle(skillsPerOrbit, b.orbit, b.orbitIndex) - Math.PI / 2;
      let delta = ang1 - ang0;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      if (Math.abs(delta) < Math.PI * 0.95) {
        arc = true;
        cx = g.x;
        cy = g.y;
        r = rad;
        a0 = ang0;
        a1 = ang0 + delta;
        anticlockwise = delta < 0;
      }
    }
    edges.push({ a: ai, b: bi, arc, cx, cy, r, a0, a1, anticlockwise });
  };

  for (const id of ids) {
    const ai = indexOf.get(id)!;
    const r = raw.nodes[id];
    for (const t of r.out ?? []) {
      const bi = indexOf.get(t);
      if (bi !== undefined) pushEdge(ai, bi);
    }
    for (const t of r.in ?? []) {
      const bi = indexOf.get(t);
      if (bi !== undefined) pushEdge(ai, bi);
    }
  }

  // --- CSR adjacency --------------------------------------------------------
  const offsets = new Int32Array(nodes.length + 1);
  for (let i = 0; i < nodes.length; i++) offsets[i + 1] = offsets[i] + neighbours[i].length;
  const adjacency = new Int32Array(offsets[nodes.length]);
  for (let i = 0; i < nodes.length; i++) {
    adjacency.set(neighbours[i], offsets[i]);
  }

  const groups: GroupInfo[] = [];
  for (const gid of Object.keys(raw.groups)) {
    const g = raw.groups[gid];
    groups.push({ id: Number(gid), x: g.x, y: g.y, background: g.background });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - 200);
    minY = Math.min(minY, n.y - 200);
    maxX = Math.max(maxX, n.x + 200);
    maxY = Math.max(maxY, n.y + 200);
  }

  // Positions for share codes: allocatable nodes in numeric id order. Sorting
  // by id rather than by JSON key order keeps it stable no matter how the file
  // is regenerated or re-serialised.
  const shareOrder = nodes
    .filter((n) => n.allocatable)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((n) => n.idx);
  const shareIndex = new Int32Array(nodes.length).fill(-1);
  shareOrder.forEach((nodeIdx, position) => {
    shareIndex[nodeIdx] = position;
  });

  return {
    raw,
    nodes,
    byId,
    edges,
    offsets,
    adjacency,
    rootIdx: indexOf.get('root') ?? 0,
    shareOrder,
    shareIndex,
    groups,
    bounds: { minX, minY, maxX, maxY },
    totalPoints: raw.points?.totalPoints ?? 138,
  };
}

const ATLAS_ASSET_ROOT = 'assets/atlas/';

/** Folder holding a version's tree data and the sprite sheets that go with it. */
export function atlasAssetBase(versionId: number = DEFAULT_TREE_VERSION): string {
  const version = findTreeVersion(versionId);
  if (!version) throw new Error(`Unknown atlas tree version ${versionId}`);
  return `${ATLAS_ASSET_ROOT}${version.dir}/`;
}

export async function loadTree(versionId: number = DEFAULT_TREE_VERSION): Promise<Tree> {
  const version = findTreeVersion(versionId);
  if (!version) throw new Error(`Unknown atlas tree version ${versionId}`);
  const res = await fetch(`${atlasAssetBase(versionId)}tree.json`);
  if (!res.ok) throw new Error(`Could not load atlas tree ${version.label} (${res.status})`);
  return buildTree((await res.json()) as RawTree);
}
