/**
 * What the Voyage board will and will not accept.
 *
 * A Voyage is nine Charts on a 3x3 board. Every Chart carries a Chart Shape —
 * one of five — and the shape says how many Connections it has, never which
 * way they point: a Chart is turned freely as it is placed, so a Corner is any
 * of the four bends and a Junction any of the four tees.
 *
 *   End       one Connection
 *   Corner    two, at a right angle
 *   Straight  two, opposite each other
 *   Junction  three
 *   Crossing  four
 *
 * The rule the game states is about Connections, not about routes: "All
 * Connections of every placed Chart must lead to either the edge of the board
 * or to another Connection". A Connection pointing off the board is therefore
 * free, and the only thing that can go wrong is a Connection pointing at a
 * neighbour that has no Connection pointing back. Read as a board, that means
 * each of the twelve seams between neighbouring cells is either open on both
 * sides or closed on both sides.
 *
 * Whether the nine areas must also form a single route is not in that text —
 * a Voyage starts in the bottom-left Chart, which suggests they must, and the
 * exilekit planner requires it, but the wording does not say so. Both readings
 * are implemented and the caller picks; see `Policy`.
 *
 * What every consumer here actually wants is not a board but a recipe: how
 * many of each shape a valid board eats. `recipes()` enumerates every recipe
 * that can be built, each with one board that proves it.
 */

/** Connection directions, as bits, so a Chart's Connections are one number. */
export const NORTH = 1;
export const EAST = 2;
export const SOUTH = 4;
export const WEST = 8;

const OPPOSITE: Record<number, number> = {
  [NORTH]: SOUTH,
  [EAST]: WEST,
  [SOUTH]: NORTH,
  [WEST]: EAST,
};

export const CELLS = 9;
/** Where a Voyage begins, and the cell the board is read from. */
export const START_CELL = 6;

export type Shape = 'end' | 'corner' | 'straight' | 'junction' | 'crossing';

export const SHAPES: readonly Shape[] = ['end', 'corner', 'straight', 'junction', 'crossing'];

export const SHAPE_LABEL: Record<Shape, string> = {
  end: 'End',
  corner: 'Corner',
  straight: 'Straight',
  junction: 'Junction',
  crossing: 'Crossing',
};

/** How many Connections each shape has — the number shown on the item. */
export const SHAPE_CONNECTIONS: Record<Shape, number> = {
  end: 1,
  corner: 2,
  straight: 2,
  junction: 3,
  crossing: 4,
};

/** One turn of each shape, for drawing it outside a board. */
export const SHAPE_GLYPH: Record<Shape, number> = {
  end: NORTH,
  corner: NORTH | EAST,
  straight: NORTH | SOUTH,
  junction: WEST | NORTH | EAST,
  crossing: NORTH | EAST | SOUTH | WEST,
};

/** Counts per shape, in `SHAPES` order. */
export type Counts = readonly number[];

/** The Connections of the Chart in each of the nine cells, already turned. */
export type Board = readonly number[];

export interface Recipe {
  /** how many of each shape this board uses, in `SHAPES` order */
  counts: Counts;
  /** the same numbers as one integer, for use as a map key */
  key: number;
  /** a board that spends exactly those Charts */
  board: Board;
}

/**
 * `connected` also demands the nine areas hang together as one route, so
 * every area can be reached from the starting Chart. `open` asks only what
 * the stated rule asks.
 */
export type Policy = 'connected' | 'open';

export function shapeOf(connections: number): Shape | null {
  switch (connections) {
    case 0:
      return null;
    case NORTH | SOUTH:
    case EAST | WEST:
      return 'straight';
    default:
      break;
  }

  switch (bitCount(connections)) {
    case 1:
      return 'end';
    case 2:
      return 'corner';
    case 3:
      return 'junction';
    case 4:
      return 'crossing';
    default:
      return null;
  }
}

/** The directions that leave the board from this cell, and so are always fine. */
export function edgeDirections(cell: number): number {
  const row = Math.floor(cell / 3);
  const column = cell % 3;

  return (
    (row === 0 ? NORTH : 0) |
    (row === 2 ? SOUTH : 0) |
    (column === 0 ? WEST : 0) |
    (column === 2 ? EAST : 0)
  );
}

/** The cell one step away, or `null` when that step leaves the board. */
export function neighbour(cell: number, direction: number): number | null {
  const row = Math.floor(cell / 3);
  const column = cell % 3;

  if (direction === NORTH) return row === 0 ? null : cell - 3;
  if (direction === SOUTH) return row === 2 ? null : cell + 3;
  if (direction === WEST) return column === 0 ? null : cell - 1;
  if (direction === EAST) return column === 2 ? null : cell + 1;

  return null;
}

/**
 * The rule, applied to a finished board — kept separate from the enumeration
 * below so the two can be checked against each other.
 */
export function isValidBoard(board: Board, policy: Policy): boolean {
  if (board.length !== CELLS || board.some((connections) => shapeOf(connections) === null)) {
    return false;
  }

  for (let cell = 0; cell < CELLS; cell++) {
    for (const direction of [NORTH, EAST, SOUTH, WEST]) {
      if ((board[cell] & direction) === 0) continue;

      const target = neighbour(cell, direction);
      // off the board is a valid destination; a neighbour is one only if it
      // has the Connection facing back
      if (target !== null && (board[target] & OPPOSITE[direction]) === 0) return false;
    }
  }

  return policy === 'open' || isOneRoute(board);
}

/** Every area reachable from the starting Chart. */
function isOneRoute(board: Board): boolean {
  const seen = new Set<number>([START_CELL]);
  const pending = [START_CELL];

  while (pending.length > 0) {
    const cell = pending.pop()!;
    for (const direction of [NORTH, EAST, SOUTH, WEST]) {
      if ((board[cell] & direction) === 0) continue;

      const target = neighbour(cell, direction);
      if (target === null || seen.has(target)) continue;
      // a seam only counts as a route when both sides are open, which a valid
      // board guarantees; checking it here keeps the function honest on its own
      if ((board[target] & OPPOSITE[direction]) === 0) continue;

      seen.add(target);
      pending.push(target);
    }
  }

  return seen.size === CELLS;
}

// ── enumeration ────────────────────────────────────────────────────────────

/** The twelve seams between neighbouring cells, as the pairs they join. */
const SEAMS: ReadonlyArray<{ from: number; to: number; direction: number }> = buildSeams();

function buildSeams(): Array<{ from: number; to: number; direction: number }> {
  const seams: Array<{ from: number; to: number; direction: number }> = [];

  for (let cell = 0; cell < CELLS; cell++) {
    if (cell % 3 < 2) seams.push({ from: cell, to: cell + 1, direction: EAST });
    if (Math.floor(cell / 3) < 2) seams.push({ from: cell, to: cell + 3, direction: SOUTH });
  }

  return seams;
}

/**
 * The eight ways a board can be turned or mirrored, as permutations of the
 * seams. Two boards that differ only by a turn use the same Charts, so only
 * one member of each orbit is worth walking — an eighth of the work.
 */
const SEAM_SYMMETRIES: ReadonlyArray<readonly number[]> = buildSeamSymmetries();

function buildSeamSymmetries(): number[][] {
  const rotate = (cell: number): number => {
    const row = Math.floor(cell / 3);
    const column = cell % 3;
    return column * 3 + (2 - row);
  };
  const mirror = (cell: number): number => {
    const row = Math.floor(cell / 3);
    const column = cell % 3;
    return row * 3 + (2 - column);
  };

  const seamIndex = new Map<string, number>();
  SEAMS.forEach((seam, index) => seamIndex.set(pairKey(seam.from, seam.to), index));

  const cellMaps: number[][] = [];
  let current = Array.from({ length: CELLS }, (_, cell) => cell);
  for (let turn = 0; turn < 4; turn++) {
    cellMaps.push(current);
    cellMaps.push(current.map((cell) => mirror(cell)));
    current = current.map((cell) => rotate(cell));
  }

  return cellMaps.map((cellMap) =>
    SEAMS.map((seam) => seamIndex.get(pairKey(cellMap[seam.from], cellMap[seam.to]))!),
  );
}

function pairKey(left: number, right: number): string {
  return left < right ? `${left}-${right}` : `${right}-${left}`;
}

/** Recipes are the same every time they are asked for, so they are kept. */
const recipeCache = new Map<Policy, Recipe[]>();

/**
 * Every set of nine Charts that can be laid out as a valid Voyage, with a
 * board for each.
 *
 * Walked as: choose which of the twelve seams are open (2^12), which fixes
 * the Connections every cell must have inwards; each cell is then free to
 * add any of its board-edge directions, and whatever that adds up to is the
 * shape that has to go there. The Charts used are counted rather than
 * arranged, so the walk carries a count per shape and keeps the first board
 * to reach each count — 715 counts exist, and most of them are reachable.
 */
export function recipes(policy: Policy): Recipe[] {
  const cached = recipeCache.get(policy);
  if (cached) return cached;

  const found = new Map<number, Recipe>();

  for (let seams = 0; seams < 1 << SEAMS.length; seams++) {
    if (!isCanonicalSeamSet(seams)) continue;

    const inward = new Array<number>(CELLS).fill(0);
    SEAMS.forEach((seam, index) => {
      if (((seams >> index) & 1) === 0) return;
      inward[seam.from] |= seam.direction;
      inward[seam.to] |= OPPOSITE[seam.direction];
    });

    if (policy === 'connected' && !seamsFormOneRoute(seams)) continue;

    const choices = cellChoices(inward);
    if (choices === null) continue;

    collectCounts(choices, found);
  }

  const list = [...found.values()].sort((left, right) => left.key - right.key);
  recipeCache.set(policy, list);

  return list;
}

/** Skip a seam set unless it is the smallest of its eight turns and mirrors. */
function isCanonicalSeamSet(seams: number): boolean {
  for (const permutation of SEAM_SYMMETRIES) {
    let turned = 0;
    for (let index = 0; index < permutation.length; index++) {
      if (((seams >> index) & 1) !== 0) turned |= 1 << permutation[index];
    }
    if (turned < seams) return false;
  }

  return true;
}

function seamsFormOneRoute(seams: number): boolean {
  const links: number[][] = Array.from({ length: CELLS }, () => []);
  SEAMS.forEach((seam, index) => {
    if (((seams >> index) & 1) === 0) return;
    links[seam.from].push(seam.to);
    links[seam.to].push(seam.from);
  });

  const seen = new Set<number>([0]);
  const pending = [0];
  while (pending.length > 0) {
    const cell = pending.pop()!;
    for (const next of links[cell]) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }

  return seen.size === CELLS;
}

interface CellChoice {
  shape: Shape;
  connections: number;
}

/**
 * What each cell can hold, given the Connections it already owes its
 * neighbours: that set plus any subset of the directions that leave the
 * board. `null` when some cell can hold nothing — a middle cell with no
 * inward Connections has nowhere to point, and no Chart has zero Connections.
 */
function cellChoices(inward: readonly number[]): CellChoice[][] | null {
  const choices: CellChoice[][] = [];

  for (let cell = 0; cell < CELLS; cell++) {
    const edges = edgeDirections(cell);
    const byShape = new Map<Shape, number>();

    for (let extra = edges; ; extra = (extra - 1) & edges) {
      const connections = inward[cell] | extra;
      const shape = shapeOf(connections);
      if (shape !== null) {
        // the plainest turn of a shape wins, so a drawn board carries no more
        // stubs off the board than it has to
        const kept = byShape.get(shape);
        if (kept === undefined || bitCount(connections) < bitCount(kept)) {
          byShape.set(shape, connections);
        }
      }
      if (extra === 0) break;
    }

    if (byShape.size === 0) return null;
    choices.push([...byShape].map(([shape, connections]) => ({ shape, connections })));
  }

  return choices;
}

/** Base used to pack five counts of at most nine into one key. */
const COUNT_BASE = 10;

export function countsKey(counts: Counts): number {
  let key = 0;
  for (let index = SHAPES.length - 1; index >= 0; index--) key = key * COUNT_BASE + counts[index];

  return key;
}

/**
 * Walks the nine cells, carrying a count per shape rather than a list of
 * placements, so boards that spend the same Charts collapse into one state.
 */
function collectCounts(choices: CellChoice[][], found: Map<number, Recipe>): void {
  let states = new Map<number, { counts: number[]; board: number[] }>([
    [0, { counts: SHAPES.map(() => 0), board: [] }],
  ]);

  for (const cellChoices of choices) {
    const next = new Map<number, { counts: number[]; board: number[] }>();

    for (const state of states.values()) {
      for (const choice of cellChoices) {
        const counts = state.counts.slice();
        counts[SHAPES.indexOf(choice.shape)]++;
        const key = countsKey(counts);
        if (next.has(key)) continue;
        next.set(key, { counts, board: [...state.board, choice.connections] });
      }
    }

    states = next;
  }

  for (const [key, state] of states) {
    if (found.has(key)) continue;
    found.set(key, { counts: state.counts, key, board: state.board });
  }
}

function bitCount(value: number): number {
  let count = 0;
  for (let bits = value; bits !== 0; bits &= bits - 1) count++;

  return count;
}
