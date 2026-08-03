/**
 * Picks which goods make up a Kingsmarch shipment.
 *
 * The question is "which units of my stock add up to exactly the shipment
 * value I want, spending the resources I care least about" — a bounded
 * knapsack where the item weight *is* the shipment value, every unit has to
 * be paid for in value, and the objective is a per-resource preference.
 *
 * Note that the total value spent is fixed by the target: any exact hit ships
 * the same amount of value. Priorities therefore only decide the *mix*, which
 * is why the cost of a unit is `value x weight` — cost per point of shipment
 * value, so a Verisium Bar and 22 Crimson Iron Ore cost the same at the same
 * priority.
 *
 * Targets run to tens of millions, so a DP over the whole target is out. It is
 * solved in two passes instead:
 *
 * 1. **Bulk** — spend whole resources in priority order until only `WINDOW`
 *    value is left to cover. With a linear cost this prefix is exactly what
 *    the LP relaxation would do, so nothing is given away by fixing it.
 * 2. **Exact** — a min-cost bounded knapsack over what is left, on the
 *    remaining stock. The window is far wider than the largest unit (90), so
 *    the tail always has room to land on the target.
 */

export type MatchMode = 'nearest' | 'atLeast' | 'atMost';

export interface SolverItem {
  key: string;
  /** shipment value of one unit, as a positive integer */
  value: number;
  /** how many units are on hand */
  stock: number;
  /** relative reluctance to spend it; the lowest weight is spent first */
  weight: number;
}

export interface SolverResult {
  /** units to ship, keyed the same as the input */
  units: Record<string, number>;
  /** shipment value those units add up to */
  total: number;
  exact: boolean;
  /** the whole stock is not worth the target */
  short: boolean;
}

/**
 * Value left for the exact pass. Big enough that the tail can always be made
 * to land exactly (unit values top out at 90), small enough that the DP is a
 * fraction of a millisecond.
 */
const WINDOW = 40_000;

/**
 * Value per resource the bulk pass refuses to spend, so the exact pass always
 * has fine-grained goods left to adjust with.
 *
 * Without it the bulk pass happily drains every cheap resource and hands the
 * tail a set whose values share a factor — ship out all the ore and what is
 * left is 90/12/15/18/21/24, every one of them a multiple of three, and two
 * targets in three become unreachable. The reserve is spent by the exact pass
 * like anything else, cheapest first, so priorities are unaffected.
 */
const RESERVE = 2_000;

export function solveShipment(items: SolverItem[], target: number, mode: MatchMode): SolverResult {
  const units: Record<string, number> = {};
  for (const item of items) units[item.key] = 0;

  const usable = items.filter((item) => item.value > 0 && item.stock > 0);
  if (target <= 0 || usable.length === 0) {
    return { units, total: 0, exact: target <= 0, short: target > 0 };
  }

  const capacity = usable.reduce((sum, item) => sum + item.value * item.stock, 0);
  if (capacity <= target) {
    // Nothing to choose between: even the whole warehouse only just reaches it.
    for (const item of usable) units[item.key] = item.stock;
    return { units, total: capacity, exact: capacity === target, short: capacity < target };
  }

  // 1 — bulk. Sorting is stable, so resources sharing a priority keep the
  // order they were handed to us in.
  const order = [...usable].sort((a, b) => a.weight - b.weight);
  const bulk = new Map<string, number>();
  let filled = 0;
  for (const item of order) {
    const reserve = Math.min(item.stock, Math.ceil(RESERVE / item.value));
    const spendable = item.stock - reserve;
    const room = target - WINDOW - filled;
    if (spendable <= 0 || room < item.value) continue;
    const take = Math.min(spendable, Math.floor(room / item.value));
    bulk.set(item.key, take);
    filled += take * item.value;
  }

  // Because `capacity > target`, the bulk pass always leaves at least one
  // resource with stock to spare, so the residual stays inside the window
  // plus whatever was reserved.
  const residual = target - filled;
  const rest = usable
    .map((item) => ({ ...item, stock: item.stock - (bulk.get(item.key) ?? 0) }))
    .filter((item) => item.stock > 0);

  if (rest.length === 0) {
    // Unreachable — `capacity > target` guarantees leftovers — but the exact
    // pass below has nothing to work with if it ever happens.
    for (const [key, take] of bulk) units[key] += take;
    return { units, total: filled, exact: filled === target, short: false };
  }

  const maxValue = rest.reduce((max, item) => Math.max(max, item.value), 0);
  const span = mode === 'atMost' ? residual : residual + maxValue;

  // 2 — exact.
  const { cost, choices } = fillExactly(rest, span);
  const landing = pickLanding(cost, residual, span, mode);

  for (const [key, take] of bulk) units[key] += take;
  let left = landing;
  for (let i = rest.length - 1; i >= 0; i--) {
    const take = choices[i][left];
    if (take > 0) {
      units[rest[i].key] += take;
      left -= take * rest[i].value;
    }
  }

  const total = filled + landing;
  return { units, total, exact: total === target, short: false };
}

/**
 * Min-cost bounded knapsack: `cost[v]` is the cheapest way to make exactly `v`
 * out of `items`, or `Infinity` if `v` cannot be made.
 *
 * Each resource is done in one O(span) sweep rather than by splitting its
 * stock into powers of two. Walking the indices of one residue class mod
 * `value`, taking `t` units means reaching back `t` places, so the state is a
 * sliding minimum of `cost[j] - k*unitCost` over the last `stock` places —
 * a monotone deque. `choices[i][v]` records how many units that minimum took,
 * which is what the reconstruction reads back.
 */
function fillExactly(
  items: SolverItem[],
  span: number,
): { cost: Float64Array; choices: Uint16Array[] } {
  const cost = new Float64Array(span + 1).fill(Infinity);
  cost[0] = 0;
  const choices: Uint16Array[] = [];

  // The deque never holds more entries than one residue class has indices.
  const dequeIndex = new Int32Array(span + 2);
  const dequeValue = new Float64Array(span + 2);

  for (const item of items) {
    const choice = new Uint16Array(span + 1);
    choices.push(choice);

    const value = item.value;
    const unitCost = value * item.weight;
    const cap = Math.min(item.stock, Math.floor(span / value));
    if (cap <= 0) continue;

    for (let residue = 0; residue < value && residue <= span; residue++) {
      let head = 0;
      let tail = 0;
      for (let k = 0, j = residue; j <= span; k++, j += value) {
        const candidate = cost[j] - k * unitCost;
        while (tail > head && dequeValue[tail - 1] >= candidate) tail--;
        dequeIndex[tail] = k;
        dequeValue[tail] = candidate;
        tail++;
        while (dequeIndex[head] < k - cap) head++;
        const best = dequeValue[head];
        if (best !== Infinity) {
          cost[j] = best + k * unitCost;
          choice[j] = k - dequeIndex[head];
        }
      }
    }
  }

  return { cost, choices };
}

/** The reachable value closest to `residual` in the direction `mode` asks for. */
function pickLanding(cost: Float64Array, residual: number, span: number, mode: MatchMode): number {
  if (Number.isFinite(cost[residual])) return residual;

  if (mode === 'atMost') {
    for (let v = residual - 1; v > 0; v--) if (Number.isFinite(cost[v])) return v;
    return 0;
  }
  if (mode === 'atLeast') {
    for (let v = residual + 1; v <= span; v++) if (Number.isFinite(cost[v])) return v;
    // Nothing above it is reachable, so settle for the best below.
    for (let v = residual - 1; v > 0; v--) if (Number.isFinite(cost[v])) return v;
    return 0;
  }
  // Nearest, breaking ties towards the overshoot — a shipment that is a few
  // points too big still ships, one that is short may miss a reward threshold.
  for (let step = 1; step <= span; step++) {
    const over = residual + step;
    if (over <= span && Number.isFinite(cost[over])) return over;
    const under = residual - step;
    if (under >= 0 && Number.isFinite(cost[under])) return under;
  }
  return 0;
}
