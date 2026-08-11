/**
 * Moving blocks around a page.
 *
 * A page is a list of blocks, except that one kind of block — `columns` — holds
 * lists of its own, because both source documents fall into two columns by hand
 * within a few rows of starting. So a position on a page is not an index, it is
 * a path: `[3]` is the fourth block, `[3, 1, 0]` is the first block in the
 * second column of the fourth block. One level deep and no further, which is
 * what `readPage` enforces on the way in.
 *
 * Everything here is pure and returns new arrays. Dragging a block is the one
 * interaction where getting it wrong loses work rather than just looking wrong —
 * a drop that silently deletes what it was carrying is indistinguishable from a
 * page that ate your notes — so it is tested rather than eyeballed.
 */
import type { Block } from './codex-types';

/** `[i]` for a top-level block, `[i, column, j]` for one inside a columns block. */
export type BlockPath = readonly number[];

type ColumnsBlock = Extract<Block, { t: 'columns' }>;

function isColumns(block: Block | undefined): block is ColumnsBlock {
  return !!block && block.t === 'columns';
}

function valid(path: BlockPath): boolean {
  return (path.length === 1 || path.length === 3) && path.every((n) => Number.isInteger(n) && n >= 0);
}

/** The list a path points into, or null when the path does not lead anywhere. */
export function containerAt(blocks: readonly Block[], path: BlockPath): readonly Block[] | null {
  if (!valid(path)) return null;
  if (path.length === 1) return blocks;
  const parent = blocks[path[0]];
  if (!isColumns(parent)) return null;
  return parent.cols[path[1]] ?? null;
}

export function blockAt(blocks: readonly Block[], path: BlockPath): Block | null {
  const list = containerAt(blocks, path);
  return list?.[path[path.length - 1]] ?? null;
}

/** Replaces the list a path points into, leaving everything else alone. */
function mapContainer(
  blocks: readonly Block[],
  path: BlockPath,
  fn: (list: readonly Block[]) => Block[],
): Block[] {
  if (!valid(path)) return [...blocks];
  if (path.length === 1) return fn(blocks);
  const [outer, column] = path;
  const parent = blocks[outer];
  if (!isColumns(parent)) return [...blocks];
  if (!parent.cols[column]) return [...blocks];
  const cols = parent.cols.map((col, index) => (index === column ? fn(col) : col));
  return blocks.map((block, index) => (index === outer ? { ...parent, cols } : block));
}

/** Inserts at the path's last index; an index past the end appends. */
export function insertBlock(blocks: readonly Block[], path: BlockPath, block: Block): Block[] {
  const at = path[path.length - 1];
  return mapContainer(blocks, path, (list) => {
    const next = [...list];
    next.splice(Math.min(Math.max(at, 0), next.length), 0, block);
    return next;
  });
}

export function removeBlock(blocks: readonly Block[], path: BlockPath): Block[] {
  const at = path[path.length - 1];
  return mapContainer(blocks, path, (list) => {
    if (at < 0 || at >= list.length) return [...list];
    const next = [...list];
    next.splice(at, 1);
    return next;
  });
}

export function updateBlock(blocks: readonly Block[], path: BlockPath, block: Block): Block[] {
  const at = path[path.length - 1];
  return mapContainer(blocks, path, (list) =>
    list.map((existing, index) => (index === at ? block : existing)),
  );
}

/**
 * Drag and drop, including from one column into the other.
 *
 * Taking the block out before putting it back is what makes a move within one
 * list shift by one when it travels downwards, so the target index is adjusted
 * for that rather than being left to look like an off-by-one nobody can explain.
 * A columns block cannot be dropped inside itself, which would take the page
 * with it.
 */
export function moveBlock(blocks: readonly Block[], from: BlockPath, to: BlockPath): Block[] {
  if (!valid(from) || !valid(to)) return [...blocks];
  const moving = blockAt(blocks, from);
  if (!moving) return [...blocks];
  if (isColumns(moving) && to.length === 3 && to[0] === from[0]) return [...blocks];

  const sameList = from.length === to.length && from.slice(0, -1).every((n, i) => n === to[i]);
  const target = to[to.length - 1];
  const without = removeBlock(blocks, from);
  const shifted = sameList && target > from[from.length - 1] ? target - 1 : target;
  return insertBlock(without, [...to.slice(0, -1), shifted], moving);
}

/** One step up or down inside whatever list the block is already in. */
export function nudgeBlock(blocks: readonly Block[], path: BlockPath, delta: -1 | 1): Block[] {
  const at = path[path.length - 1];
  const list = containerAt(blocks, path);
  if (!list) return [...blocks];
  const target = at + delta;
  if (target < 0 || target >= list.length) return [...blocks];
  return moveBlock(blocks, path, [...path.slice(0, -1), target + (delta > 0 ? 1 : 0)]);
}
