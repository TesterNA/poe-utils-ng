/**
 * Taking the facts off a tree while the tree is in memory.
 *
 * A card has to say what a strategy *is* — a hundred and thirty points, these
 * keystones, this much Legion — without loading anything. The atlas dataset is
 * 1.5 MB of tree and about 4 MB of sprite sheets, so a list of twenty cards
 * cannot each go and ask; and a card that says nothing until it has is a card
 * you scroll past.
 *
 * So the facts are taken once, at the moment of saving, when the tree is
 * already loaded because the save came from the atlas or strategy tool. The
 * code stays the source of truth: the snapshot is what the card reads, and
 * "open" goes to the real thing.
 */
import type { Summary } from '../atlas/summary';
import type { Tree } from '../atlas/tree-types';
import { summariseTree } from '../strategy/strategy-plan';
import type { ItemCatalogue } from '../strategy/strategy-items';
import { ICON_BASE } from '../strategy/strategy-items';
import type { Pick } from '../strategy/strategy-plan';
import type { AtlasSnapshot, StrategySnapshot } from './codex-types';

/** How many mechanic lines a card can carry before it stops being a card. */
const TOP_MECHANICS = 5;

/**
 * The few lines worth putting on a card, out of a summary that runs to
 * dozens. Groups are already ordered by the summary panel's own idea of
 * importance, and the first line of a group is the one that names it.
 */
export function topMechanics(summary: Summary): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const group of summary.groups) {
    const line = group.lines[0];
    if (!line) continue;
    out.push({ label: group.name, value: line.text });
    if (out.length === TOP_MECHANICS) break;
  }
  return out;
}

export function atlasSnapshot(
  tree: Tree,
  code: string,
  treeVersion: number,
  summary?: Summary,
  thumbId?: string,
): AtlasSnapshot {
  const read = summariseTree(tree, code);
  return {
    treeVersion,
    points: read.points,
    keystones: read.keystones,
    mechanics: summary ? topMechanics(summary) : [],
    ...(thumbId ? { thumbId } : {}),
  };
}

/**
 * A strategy card wants the scarabs by name and icon, not by code: the code is
 * a number that only means something to the strategy tool, and the whole point
 * of the card is that it can be read without opening one.
 */
export function strategySnapshot(
  picks: readonly Pick[],
  catalogue: ItemCatalogue,
  treeVersion: number,
  tree: Tree | null,
  treeCode: string,
  issues: string[],
  atlasThumbId?: string,
): StrategySnapshot {
  const named = picks.map((pick) => {
    const item = catalogue.byCode.get(pick.code);
    return {
      code: pick.code,
      count: pick.count,
      name: item?.name ?? `#${pick.code}`,
      icon: item ? `${ICON_BASE}${item.icon}` : '',
    };
  });
  let points = 0;
  let keystones: string[] = [];
  if (tree && treeCode) {
    try {
      const read = summariseTree(tree, treeCode);
      points = read.points;
      keystones = read.keystones;
    } catch {
      // A code this build cannot read is not a reason to refuse the save; the
      // card simply says less, and the code is still there to open.
    }
  }
  return {
    treeVersion,
    slots: picks.reduce((total, pick) => total + pick.count, 0),
    picks: named,
    points,
    keystones,
    ...(atlasThumbId ? { atlasThumbId } : {}),
    issues,
  };
}
