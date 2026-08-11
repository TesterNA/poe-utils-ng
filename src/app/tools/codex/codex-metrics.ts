/**
 * What a strategy actually paid.
 *
 * In the documents this replaces, this arithmetic is a sentence — "профит 14 в
 * час минус замаз 2д = 12 в час" — or a screenshot of a loot tracker, which is
 * a number rendered as pixels. Neither can be sorted, averaged, or compared
 * with the strategy on the next row, which is why one of those documents exists
 * as a whole separate spreadsheet of screenshots.
 *
 * Held as numbers it is four lines of division. `net` and per-hour are always
 * derived and never stored: two copies of the same sum are two chances for them
 * to disagree, and the one on screen would be the stale one.
 */
import type { Run } from './codex-types';

export interface RunTotals {
  runs: number;
  minutes: number;
  maps: number;
  investDiv: number;
  revenueDiv: number;
  netDiv: number;
  /** divines an hour, net of what it cost to set up; 0 when nothing was timed */
  perHour: number;
}

export function runTotals(runs: readonly Run[] | undefined): RunTotals {
  const totals: RunTotals = {
    runs: 0,
    minutes: 0,
    maps: 0,
    investDiv: 0,
    revenueDiv: 0,
    netDiv: 0,
    perHour: 0,
  };
  for (const run of runs ?? []) {
    totals.runs++;
    totals.minutes += run.minutes;
    totals.maps += run.maps ?? 0;
    totals.investDiv += run.investDiv;
    totals.revenueDiv += run.revenueDiv;
  }
  totals.netDiv = totals.revenueDiv - totals.investDiv;
  // Several runs are one long run: pooling the hours weights the long ones,
  // which is what "this strategy makes X an hour" means. Averaging each run's
  // own rate would let a lucky ten minutes outvote a measured two hours.
  totals.perHour = totals.minutes > 0 ? (totals.netDiv * 60) / totals.minutes : 0;
  return totals;
}

/** "12.4 div/h", or nothing at all when nobody has measured it. */
export function perHourLabel(totals: RunTotals): string {
  if (!totals.runs || !totals.minutes) return '';
  const value = totals.perHour;
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} div/h`;
}
