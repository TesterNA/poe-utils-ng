/**
 * How many Voyages a stack of Charts is worth.
 *
 * Every Voyage eats exactly nine Charts and no Chart is used twice, so the
 * question is a packing one: cover the stack with as many recipes from
 * `voyage-rules` as will fit. Two things make it cheap. The recipes are a
 * fixed, small list — a few hundred sets of five numbers — and every one of
 * them spends nine Charts, so how deep a search has got is fixed by what is
 * left rather than by the path taken. That second point is what lets a state
 * that has been walked once be written off for good.
 *
 * The count that comes back is exact whenever the search finished, and the
 * ceiling (`floor(charts / 9)`) is usually hit at once, so most stacks are
 * proven rather than merely searched.
 *
 * Several searches are run per press, each walking the recipes in a different
 * order. They agree on the number — that part is settled — but they arrange it
 * differently, which is the point: it gives more than one way to spend the
 * same stack.
 */
import { Board, Counts, Recipe, SHAPES } from './voyage-rules';

export interface PlannedVoyage {
  counts: Counts;
  board: Board;
}

export interface Plan {
  voyages: PlannedVoyage[];
  /** Charts the plan does not spend, in `SHAPES` order */
  leftover: number[];
}

export interface PlanResult {
  /** the most Voyages any of the searches built */
  voyages: number;
  /** no arrangement can do better, rather than none was found in time */
  proven: boolean;
  /** distinct ways to reach `voyages`, the plainest first */
  plans: Plan[];
  /** how long the searches took, in milliseconds */
  elapsedMs: number;
}

export interface PlanOptions {
  /** how many differently-ordered searches to run */
  attempts?: number;
  /** wall clock each search may spend before it settles for what it has */
  budgetMs?: number;
}

const DEFAULT_ATTEMPTS = 8;
const DEFAULT_BUDGET_MS = 250;

/** Counts as the solver wants them: whole, never negative, one per shape. */
export function readStock(inventory: Counts): number[] {
  return SHAPES.map((_, index) => Math.max(0, Math.trunc(inventory[index] ?? 0)));
}

/**
 * One search. `attempt` picks the order the recipes are walked in — nought
 * walks them as they come, so the same stash always gives the same first
 * answer, and every other number gives a different arrangement of the same
 * count. This is what a worker runs; several of them run at once.
 */
export function planAttempt(
  inventory: Counts,
  recipes: readonly Recipe[],
  attempt: number,
  budgetMs = DEFAULT_BUDGET_MS,
): Plan {
  const stock = readStock(inventory);
  const affordable = recipes.filter((recipe) =>
    recipe.counts.every((needed, index) => needed <= stock[index]),
  );

  if (affordable.length === 0) return { voyages: [], leftover: stock };

  const order = attempt === 0 ? affordable.slice() : shuffled(affordable, attempt);

  return search(stock, order, Date.now() + budgetMs, 0) ?? { voyages: [], leftover: stock };
}

/**
 * The answers from however many searches were run, as one result: the best
 * count any of them reached, and every distinct arrangement of that count.
 */
export function gatherPlans(
  inventory: Counts,
  found: readonly Plan[],
  elapsedMs: number,
): PlanResult {
  const stock = readStock(inventory);
  const ceiling = Math.floor(sum(stock) / 9);
  const best = found.reduce((most, plan) => Math.max(most, plan.voyages.length), 0);

  const plans: Plan[] = [];
  const seen = new Set<string>();
  for (const plan of found) {
    if (plan.voyages.length !== best || best === 0) continue;

    const fingerprint = plan.voyages
      .map((voyage) => voyage.counts.join(''))
      .sort()
      .join('|');
    if (seen.has(fingerprint)) continue;

    seen.add(fingerprint);
    plans.push(plan);
  }

  if (plans.length === 0) plans.push({ voyages: [], leftover: stock });

  return { voyages: best, proven: best === ceiling, plans, elapsedMs };
}

/** Every search, one after another — the plain way, and what the tests use. */
export function planVoyages(
  inventory: Counts,
  recipes: readonly Recipe[],
  options: PlanOptions = {},
): PlanResult {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const started = Date.now();
  const found: Plan[] = [];

  for (let attempt = 0; attempt < attempts; attempt++) {
    found.push(planAttempt(inventory, recipes, attempt, budgetMs));
  }

  return gatherPlans(inventory, found, Date.now() - started);
}

/**
 * Depth-first over the recipes, never looking back at one already passed, so
 * the same set of Voyages is not built in every order it could be built in.
 *
 * Two things keep it short. A branch is dropped when even filling the rest of
 * the stack perfectly could not beat what is already in hand, and a stack that
 * has been walked from a given point without improving is remembered, because
 * walking it again cannot do better than it did.
 */
function search(
  stock: readonly number[],
  recipes: readonly Recipe[],
  deadline: number,
  floor: number,
): Plan | null {
  const ceiling = Math.floor(sum(stock) / 9);
  const chosen: Recipe[] = [];
  // one below what is already in hand, so a search that only matches the best
  // still hands back its arrangement — a different way to spend the same stack
  let bestDepth = floor - 1;
  let bestChoice: Recipe[] | null = null;
  const exhausted = new Set<string>();
  let ranOut = false;

  const walk = (left: readonly number[], from: number): void => {
    if (bestDepth === ceiling || ranOut) return;
    if (Date.now() > deadline) {
      ranOut = true;
      return;
    }

    // every recipe spends nine Charts, so the depth is fixed by what is left
    if (chosen.length + Math.floor(sum(left) / 9) <= bestDepth) return;

    const state = `${left.join(',')}:${from}`;
    if (exhausted.has(state)) return;

    const depthBefore = bestDepth;
    for (let index = from; index < recipes.length; index++) {
      const recipe = recipes[index];
      if (!recipe.counts.every((needed, shape) => needed <= left[shape])) continue;

      chosen.push(recipe);
      if (chosen.length > bestDepth) {
        bestDepth = chosen.length;
        bestChoice = chosen.slice();
      }
      walk(
        left.map((have, shape) => have - recipe.counts[shape]),
        index,
      );
      chosen.pop();
      if (bestDepth === ceiling || ranOut) return;
    }

    if (bestDepth === depthBefore) exhausted.add(state);
  };

  walk(stock, 0);

  if (bestChoice === null) return null;

  const voyages = (bestChoice as Recipe[]).map((recipe) => ({
    counts: recipe.counts,
    board: recipe.board,
  }));
  const leftover = stock.map(
    (have, shape) => have - voyages.reduce((spent, voyage) => spent + voyage.counts[shape], 0),
  );

  return { voyages, leftover };
}

/**
 * The nearest thing the leftovers are to another Voyage: the recipe that asks
 * for the fewest Charts that are not already there. Nothing when the leftovers
 * would not fill a board even in principle.
 */
export function shortfall(
  leftover: readonly number[],
  recipes: readonly Recipe[],
): { missing: number[]; total: number } | null {
  let best: { missing: number[]; total: number } | null = null;

  for (const recipe of recipes) {
    const missing = recipe.counts.map((needed, shape) => Math.max(0, needed - leftover[shape]));
    const total = sum(missing);
    if (total === 0) continue;
    if (best === null || total < best.total) best = { missing, total };
  }

  return best;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** A shuffle that depends only on the seed, so a plan can be reproduced. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed * 2654435761 + 1);
  const list = items.slice();

  for (let index = list.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [list[index], list[swap]] = [list[swap], list[index]];
  }

  return list;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
