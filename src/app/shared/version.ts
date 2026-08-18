/**
 * The site's version history — the one place a release is written down.
 *
 * Everything that wants to know what is running reads it from here: the debug
 * page renders the whole list, `APP_VERSION` is the top entry's number, and
 * `scripts/version-check.mjs` holds package.json to the same number so the two
 * cannot quietly drift apart.
 *
 * Newest first. A release is added at the top: bump the minor for a new tool or
 * a feature you would tell someone about, the patch for fixes and polish. Dates
 * are ISO, because a site read from several countries should not make anyone
 * guess whether 08-09 is August or September.
 */
export interface Release {
  /** `major.minor.patch` — must match package.json for the newest entry */
  version: string;
  /** ISO `YYYY-MM-DD`, the day the work landed */
  date: string;
  /** one short line per change, in the words a user would use */
  changes: string[];
}

export const RELEASES: Release[] = [
  {
    version: '1.5.0',
    date: '2026-08-18',
    changes: [
      'Version history, and a debug page that shows it',
      'Atlas share codes follow the mode you are in, not a stale route',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-08-12',
    changes: [
      'New tool: Codex — a library of entries with tags, search and pages',
      'Codex compares runs and shows what a strategy actually paid',
      'Codex cards draw the atlas tree itself instead of a screenshot of one',
      'Defense: a Tailoring Orb scales the rolls, not the total',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-08-09',
    changes: [
      'Accounts: saved builds and strategies follow you between browsers',
      'Share links got short',
      'The site put on glass, and the menu moved to the top on narrow screens',
      'Atlas: search answers on the tree, and the tooltip counts what a click would add',
      'Atlas: what the tree grants, added up per mechanic',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-08-07',
    changes: [
      'Lucky: a third roll, for both directions at once',
      'Strategy: a tab for the map device, and a build selector that shows what is attached',
      'Minesweeper: a stash search that hides landmines, with number ranges',
      'Atlas: the free junction beside the centre stopped costing a point',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-08-05',
    changes: [
      'New tool: Kingsmarch Shipment — plan a shipment against a target value',
      'Atlas: a local library of saved builds, plus versioned import/export',
      'Atlas: share codes carry the finished tree, at half the length',
      'EXP: PoE 1 level 95+ penalty applied, and PoE 2 gaps flagged instead of guessed',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-08-01',
    changes: [
      'The Angular rewrite of poe-utils, with every old tool carried over',
      'New tool: Atlas Selector — a solver that plans a route through the tree',
      'Chromatic: column sorting restored',
    ],
  },
];

/** What is running: the newest release's number and the day it landed. */
export const APP_VERSION = RELEASES[0].version;
export const APP_DATE = RELEASES[0].date;
