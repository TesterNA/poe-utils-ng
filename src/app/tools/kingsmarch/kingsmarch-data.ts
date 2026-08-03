/**
 * Kingsmarch shipping reference data.
 *
 * Shipment values are per unit, from the "Table of rewards" on the PoE wiki
 * (https://www.poewiki.net/wiki/Kingsmarch). Ores and bars are the same five
 * minerals — a bar is worth roughly 4x its ore — and the five crops sit on
 * their own value ladder.
 */

export type ResourceGroup = 'ore' | 'bar' | 'crop';

export interface ResourceDef {
  /** stable key, used for storage and as the row identity */
  id: string;
  name: string;
  group: ResourceGroup;
  /** shipment value of one unit */
  value: number;
}

export const RESOURCES: ResourceDef[] = [
  { id: 'crimson-ore', name: 'Crimson Iron Ore', group: 'ore', value: 4 },
  { id: 'orichalcum-ore', name: 'Orichalcum Ore', group: 'ore', value: 5 },
  { id: 'amber-ore', name: 'Petrified Amber Ore', group: 'ore', value: 7 },
  { id: 'bismuth-ore', name: 'Bismuth Ore', group: 'ore', value: 12 },
  { id: 'verisium-ore', name: 'Verisium Ore', group: 'ore', value: 22 },

  { id: 'crimson-bar', name: 'Crimson Iron Bar', group: 'bar', value: 16 },
  { id: 'orichalcum-bar', name: 'Orichalcum Bar', group: 'bar', value: 22 },
  { id: 'amber-bar', name: 'Petrified Amber Bar', group: 'bar', value: 30 },
  { id: 'bismuth-bar', name: 'Bismuth Bar', group: 'bar', value: 50 },
  { id: 'verisium-bar', name: 'Verisium Bar', group: 'bar', value: 90 },

  { id: 'wheat', name: 'Wheat', group: 'crop', value: 12 },
  { id: 'corn', name: 'Corn', group: 'crop', value: 15 },
  { id: 'pumpkin', name: 'Pumpkin', group: 'crop', value: 18 },
  { id: 'orgourd', name: 'Orgourd', group: 'crop', value: 21 },
  { id: 'zanthimum', name: 'Blue Zanthimum', group: 'crop', value: 24 },
];

export const GROUP_LABEL: Record<ResourceGroup, string> = {
  ore: 'Ores',
  bar: 'Bars',
  crop: 'Crops',
};

/** What each group buys, shown as the group's caption. */
export const GROUP_NOTE: Record<ResourceGroup, string> = {
  ore: 'Currency · 4 → 22 per unit',
  bar: 'Currency · smelted ore, ~4x the value',
  crop: 'Equipment · 12 → 24 per unit',
};

/** A shipment is refused below this, and capped above the max. */
export const MIN_SHIPMENT = 50_000;
export const MAX_SHIPMENT = 50_000_000;

/**
 * How reluctant we are to spend a resource. Only the ordering matters — the
 * solver spends the lowest weight first and treats `never` as absent stock.
 */
export type Priority = 'first' | 'prefer' | 'normal' | 'last' | 'never';

export const PRIORITY_WEIGHT: Record<Priority, number> = {
  first: 1,
  prefer: 3,
  normal: 10,
  last: 40,
  never: 0, // unused; `never` resources are dropped before solving
};

export interface PriorityOption {
  value: Priority;
  label: string;
}

export const PRIORITY_OPTIONS: PriorityOption[] = [
  { value: 'first', label: 'Spend first' },
  { value: 'prefer', label: 'Prefer' },
  { value: 'normal', label: 'Normal' },
  { value: 'last', label: 'Spend last' },
  { value: 'never', label: "Don't ship" },
];

/**
 * Port quota ("Favoured Resource") bonus, in tenths. A quota multiplies both
 * the resource's contribution to shipment value and how much of it counts
 * towards the quota, and the game rolls it between +20% and +100% in steps
 * of 10%.
 */
export interface BonusOption {
  value: number;
  label: string;
}

export const BONUS_OPTIONS: BonusOption[] = [
  { value: 0, label: '—' },
  { value: 2, label: '+20%' },
  { value: 3, label: '+30%' },
  { value: 4, label: '+40%' },
  { value: 5, label: '+50%' },
  { value: 6, label: '+60%' },
  { value: 7, label: '+70%' },
  { value: 8, label: '+80%' },
  { value: 9, label: '+90%' },
  { value: 10, label: '+100%' },
];

/**
 * Thaumaturgic Dust tops a shipment up 1:1 while it stays under the value of
 * the real goods, and with heavy diminishing returns past that:
 *
 *   dust <= base   →  total = base + dust
 *   dust >  base   →  total = base * (1 + sqrt(dust / base))
 */
export function totalWithDust(base: number, dust: number): number {
  if (base <= 0) return 0;
  if (dust <= base) return base + dust;
  return base * (1 + Math.sqrt(dust / base));
}

/**
 * Inverse of {@link totalWithDust}: the value the real goods have to carry so
 * that `dust` lifts the shipment to `total`.
 *
 * In the linear half that is just `total - dust`. Past it, solving
 * `total = base + sqrt(dust * base)` for `sqrt(base)` gives
 * `sqrt(base) = (sqrt(dust + 4*total) - sqrt(dust)) / 2`.
 */
export function baseForTotal(total: number, dust: number): number {
  if (total <= 0) return 0;
  if (dust <= 0) return total;
  if (dust <= total / 2) return total - dust;
  const root = (Math.sqrt(dust + 4 * total) - Math.sqrt(dust)) / 2;
  return root * root;
}
