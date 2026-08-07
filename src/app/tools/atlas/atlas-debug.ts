import type { Tree } from './tree-types';

/**
 * Console handle for diagnosing "why does it think N points?" reports.
 *
 * Attached as `window.atlasDebug` in every build, not just development, because
 * the interesting states are the ones people hit on the deployed site. It reads
 * live state and never mutates anything.
 */
export interface AtlasDebugBuild {
  name: string;
  /** what the library row shows */
  storedPoints: number;
  /** what the code actually works out to now, or null if it cannot be read */
  actualPoints: number | null;
  treeVersion: number;
  codeVersion: number | null;
  codeChars: number;
}

export interface AtlasDebugState {
  mode: string;
  builds: AtlasDebugBuild[];
  allocated: Set<number>;
  targets: Set<number>;
  excluded: Set<number>;
  route: Set<number>;
  basePoints: number;
  bonusPoints: number;
  status: string;
  notice: string;
}

export interface AtlasDebugApi {
  /** Human-readable dump, printed and returned as a string. */
  report(): string;
  /** Everything as plain data, for pasting into a bug report. */
  dump(): unknown;
  /** Puts dump() on the clipboard as JSON. */
  copy(): Promise<string>;
  /** Allocated nodes as {id, name, kind}. */
  nodes(): Array<{ id: string; name: string; kind: string }>;
}

interface Described {
  id: string;
  name: string;
  kind: string;
  costsPoint: boolean;
}

function describe(tree: Tree, set: Set<number>): Described[] {
  return [...set].map((idx) => {
    const node = tree.nodes[idx];
    return { id: node.id, name: node.name, kind: node.kind, costsPoint: node.costsPoint };
  });
}

function countByKind(items: Described[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.kind] = (out[item.kind] ?? 0) + 1;
  return out;
}

export function createAtlasDebug(tree: Tree, read: () => AtlasDebugState): AtlasDebugApi {
  const dump = () => {
    const state = read();
    const allocated = describe(tree, state.allocated);
    const route = describe(tree, state.route);
    return {
      mode: state.mode,
      points: {
        allocated: allocated.filter((n) => n.costsPoint).length,
        nodesIncludingFree: state.allocated.size,
        base: state.basePoints,
        granted: state.bonusPoints,
        limit: state.basePoints + state.bonusPoints,
      },
      counts: {
        route: state.route.size,
        targets: state.targets.size,
        blocked: state.excluded.size,
      },
      allocatedByKind: countByKind(allocated),
      // Gateways are the usual suspect for an off-by-one against the game: the
      // pair is modelled as two nodes joined by an edge, so a route crossing one
      // is charged twice here.
      gateways: allocated.filter((n) => n.kind === 'wormhole'),
      status: state.status,
      notice: state.notice,
      builds: state.builds,
      // A row whose stored number disagrees with its code is the thing to look
      // at when a saved build shows the wrong point count.
      buildsDisagreeing: state.builds.filter(
        (b) => b.actualPoints !== null && b.actualPoints !== b.storedPoints,
      ),
      allocated,
      route,
      targets: describe(tree, state.targets),
      blocked: describe(tree, state.excluded),
      allocatedIds: [...state.allocated].map((i) => tree.nodes[i].id),
    };
  };

  const report = () => {
    const d = dump();
    const kinds = Object.entries(d.allocatedByKind)
      .map(([kind, n]) => `${kind} ${n}`)
      .join(', ');
    const lines = [
      'Atlas Selector debug',
      `mode          ${d.mode}`,
      `allocated     ${d.points.allocated} points across ${d.points.nodesIncludingFree} nodes ` +
        `(limit ${d.points.limit} = base ${d.points.base} + granted ${d.points.granted})`,
      `route         ${d.counts.route}`,
      `targets       ${d.counts.targets}`,
      `blocked       ${d.counts.blocked}`,
      `by kind       ${kinds || '-'}`,
      `gateways      ${
        d.gateways.length
          ? d.gateways.map((g) => `${g.name} (${g.id})`).join(', ')
          : 'none'
      }`,
      `status        ${d.status}`,
      `notice        ${d.notice || '-'}`,
      `builds        ${
        d.builds.length
          ? d.builds
              .map(
                (b) =>
                  `${b.name}: shows ${b.storedPoints}` +
                  (b.actualPoints === null
                    ? ' (code unreadable here)'
                    : b.actualPoints === b.storedPoints
                      ? ''
                      : ` but code says ${b.actualPoints}`) +
                  ` [tree ${b.treeVersion}, code AT${b.codeVersion ?? '?'}]`,
              )
              .join('\n              ')
          : 'none'
      }`,
      '',
      'allocated ids:',
      d.allocatedIds.join(','),
      '',
      'Run atlasDebug.copy() to put the full dump on your clipboard.',
    ];
    const text = lines.join('\n');
    console.log(text);
    return text;
  };

  return {
    report,
    dump,
    nodes: () => describe(tree, read().allocated),
    copy: async () => {
      const json = JSON.stringify(dump(), null, 2);
      try {
        await navigator.clipboard.writeText(json);
        console.log('atlasDebug: copied to clipboard');
      } catch {
        console.log('atlasDebug: clipboard blocked, here is the dump instead');
        console.log(json);
      }
      return json;
    },
  };
}
