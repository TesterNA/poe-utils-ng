/**
 * A strategy: an atlas tree, the scarabs and embers you load the map device
 * with, and a note about how to run it.
 *
 * The tree is held as an atlas share code rather than a node list. That keeps
 * the two tools honest with each other — the code already carries which atlas
 * dataset it was built against, so a strategy cannot end up describing a tree
 * from one league and scarabs from another without saying so.
 */
import { decodePlan, ShareCodeError } from '../atlas/share-code';
import { findTreeVersion } from '../atlas/tree-versions';
import type { Tree } from '../atlas/tree-types';
import {
  MAP_DEVICE_SLOTS,
  unavailableReason,
  type ItemCatalogue,
  type StrategyItem,
} from './strategy-items';

/** One kind of item and how many copies of it go in. */
export interface Pick {
  code: number;
  count: number;
}

export interface Strategy {
  /** atlas tree version id — what decides which game version the items are read against */
  treeVersion: number;
  /** an `AT…` code, or empty when no tree is attached yet */
  treeCode: string;
  picks: Pick[];
  notes: string;
}

export function emptyStrategy(treeVersion: number): Strategy {
  return { treeVersion, treeCode: '', picks: [], notes: '' };
}

/** The game version a strategy is judged against, from the tree it is built on. */
export function gameVersionOf(strategy: Strategy): string {
  return findTreeVersion(strategy.treeVersion)?.label ?? '';
}

export function slotsUsed(picks: Pick[]): number {
  return picks.reduce((total, pick) => total + pick.count, 0);
}

// --- editing ------------------------------------------------------------------

/**
 * Adding an item you already have adds a copy rather than a second entry, which
 * is how the map device stacks them.
 */
export function addPick(picks: Pick[], code: number): Pick[] {
  const existing = picks.find((pick) => pick.code === code);
  if (existing) {
    return picks.map((pick) => (pick.code === code ? { ...pick, count: pick.count + 1 } : pick));
  }
  return [...picks, { code, count: 1 }];
}

/** Removes one copy, and the entry itself once the last copy goes. */
export function removePick(picks: Pick[], code: number): Pick[] {
  return picks
    .map((pick) => (pick.code === code ? { ...pick, count: pick.count - 1 } : pick))
    .filter((pick) => pick.count > 0);
}

export function dropPick(picks: Pick[], code: number): Pick[] {
  return picks.filter((pick) => pick.code !== code);
}

// --- the attached tree --------------------------------------------------------

/**
 * Unwavering Vision shuts the map device's fragment slots: with it allocated no
 * scarab or ember can go in at all. Matched on the stat text rather than the
 * node id so the check survives the tree being renumbered between leagues —
 * ids are not stable across GGG's exports, wording largely is.
 */
const BLOCKS_FRAGMENTS = /Maps cannot be modified by Fragments/i;

export interface TreeSummary {
  /**
   * What the tree costs, which is not how many nodes it has: structural
   * junctions are allocatable so routes can run through them, but they are
   * free. Counting nodes instead read one or two points higher than the atlas
   * panel for the very same code.
   */
  points: number;
  keystones: string[];
  /** allocated nodes that stop the map device taking anything */
  blockers: string[];
}

/**
 * Reads an atlas code against a loaded tree. Throws `ShareCodeError` for a code
 * that is malformed or built for another dataset, which the caller shows as-is.
 */
export function summariseTree(tree: Tree, code: string): TreeSummary {
  const plan = decodePlan(code, tree);
  const summary: TreeSummary = { points: 0, keystones: [], blockers: [] };
  for (const id of plan.allocated) {
    const node = tree.byId.get(id);
    if (!node) continue;
    if (node.costsPoint) summary.points++;
    if (node.kind === 'keystone') summary.keystones.push(node.name);
    if (node.stats.some((stat) => BLOCKS_FRAGMENTS.test(stat))) summary.blockers.push(node.name);
  }
  summary.keystones.sort((a, b) => a.localeCompare(b));
  return summary;
}

export function isShareCodeError(err: unknown): err is ShareCodeError {
  return err instanceof ShareCodeError;
}

// --- validation ---------------------------------------------------------------

export interface StrategyIssue {
  level: 'error' | 'warning';
  text: string;
  /** the item it is about, so its row can be flagged too */
  itemCode?: number;
}

export interface ValidationInput {
  picks: Pick[];
  catalogue: ItemCatalogue;
  gameVersion: string;
  /** from `summariseTree`, empty when no tree is attached or it could not be read */
  blockers: string[];
}

/**
 * Everything the game would refuse, in the order it is worth reading: the whole
 * device first, then item by item.
 */
export function validate({
  picks,
  catalogue,
  gameVersion,
  blockers,
}: ValidationInput): StrategyIssue[] {
  const issues: StrategyIssue[] = [];
  const used = slotsUsed(picks);

  if (used > MAP_DEVICE_SLOTS) {
    issues.push({
      level: 'error',
      text: `${used} items in a device that takes ${MAP_DEVICE_SLOTS}. Remove ${used - MAP_DEVICE_SLOTS}.`,
    });
  }

  if (blockers.length && used > 0) {
    issues.push({
      level: 'error',
      text:
        `${blockers.join(' and ')} means your maps cannot be modified by fragments, so none of ` +
        `these can be used. Drop the keystone or drop the items.`,
    });
  }

  for (const pick of picks) {
    const item = catalogue.byCode.get(pick.code);
    if (!item) {
      issues.push({
        level: 'error',
        text: `An item this strategy uses (#${pick.code}) is not in the list this build ships.`,
        itemCode: pick.code,
      });
      continue;
    }
    const gone = gameVersion ? unavailableReason(item, gameVersion) : null;
    if (gone) {
      issues.push({
        level: 'error',
        text: `${item.name} does not exist in ${gameVersion} — ${gone}.`,
        itemCode: item.code,
      });
    }
    if (pick.count > item.limit) {
      issues.push({
        level: 'error',
        text: `${pick.count}× ${item.name}, which is limited to ${item.limit} per map.`,
        itemCode: item.code,
      });
    }
  }

  return issues;
}

/** True when this item cannot take another copy — used to grey out the picker. */
export function atLimit(picks: Pick[], item: StrategyItem): boolean {
  const pick = picks.find((entry) => entry.code === item.code);
  return (pick?.count ?? 0) >= item.limit;
}
