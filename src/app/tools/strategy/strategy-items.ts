/**
 * The catalogue of things you can load a map device with: every scarab and
 * allflame ember, grouped the way the game names them.
 *
 * The data is scraped from poedb by `scripts/fetch-strategy-items.mjs` into
 * public/assets/strategy/items.json. Two fields there make the catalogue
 * survive a league change:
 *
 *   `code`      the number a share code writes. Assigned once by the scraper
 *               and never reused, so a strategy from an old league keeps naming
 *               the same scarabs however much the list moves around.
 *   `removedIn` the game version an item stopped existing in, filled in by the
 *               next scrape that no longer finds it. The item stays in the
 *               file: a strategy that used it still wants to say so, and saying
 *               "removed in 3.31" is more use than a blank slot.
 *
 * `since` is the mirror of that for items added later. It is absent on
 * everything the first scrape saw, which is honest — those existed at or before
 * the first version we ever looked at, and pinning each to the league it was
 * introduced in would be inventing data the scrape never had.
 */

export type StrategyItemType = 'scarab' | 'allflame';

export interface StrategyItem {
  /** permanent id used by share codes */
  code: number;
  /** poedb slug, stable and readable — what the icon and the wiki are named by */
  id: string;
  name: string;
  type: StrategyItemType;
  /** league mechanic: Breach, Legion, ... or Miscellaneous / Allflame */
  group: string;
  /** how many copies of this exact item one map may take */
  limit: number;
  stats: string[];
  icon: string;
  since?: string;
  removedIn: string | null;
}

export interface ItemGroup {
  name: string;
  type: StrategyItemType;
  items: StrategyItem[];
}

export interface ItemCatalogue {
  /** every game version the data has been scraped against, oldest first */
  versions: string[];
  items: StrategyItem[];
  byCode: Map<number, StrategyItem>;
  groups: ItemGroup[];
}

/** How many scarabs and embers one map device takes, in total. */
export const MAP_DEVICE_SLOTS = 5;

const DATA_URL = 'assets/strategy/items.json';
export const ICON_BASE = 'assets/strategy/icons/';

interface RawCatalogue {
  versions?: string[];
  items?: StrategyItem[];
}

let pending: Promise<ItemCatalogue> | null = null;

/** Fetched once per session; the catalogue is immutable, so it is shared. */
export function loadItems(): Promise<ItemCatalogue> {
  pending ??= fetch(DATA_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`Could not load the scarab list (${res.status})`);
      return res.json() as Promise<RawCatalogue>;
    })
    .then(build)
    .catch((err: unknown) => {
      // A failed fetch must not poison the session — let the next attempt retry.
      pending = null;
      throw err;
    });
  return pending;
}

function build(raw: RawCatalogue): ItemCatalogue {
  const items = raw.items ?? [];
  const byCode = new Map(items.map((item) => [item.code, item]));

  // Scarabs first and alphabetical within a mechanic, which is how the game's
  // own stash tab reads. Allflames are a separate kind of thing, so they sit at
  // the end rather than under M for Miscellaneous.
  const byGroup = new Map<string, ItemGroup>();
  for (const item of items) {
    let group = byGroup.get(item.group);
    if (!group) byGroup.set(item.group, (group = { name: item.group, type: item.type, items: [] }));
    group.items.push(item);
  }
  const groups = [...byGroup.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'scarab' ? -1 : 1;
    // "Miscellaneous" is the leftovers pile, so it goes after the named ones.
    const rank = (g: ItemGroup) => (g.name === 'Miscellaneous' ? 1 : 0);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  return { versions: raw.versions ?? [], items, byCode, groups };
}

// --- availability -------------------------------------------------------------

/** `3.29` against `3.7`: compared segment by segment, not as text. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Why an item cannot be used in `version`, or null when it can. */
export function unavailableReason(item: StrategyItem, version: string): string | null {
  if (item.removedIn && compareVersions(version, item.removedIn) >= 0) {
    return `removed in ${item.removedIn}`;
  }
  if (item.since && compareVersions(version, item.since) < 0) {
    return `added in ${item.since}`;
  }
  return null;
}

export function iconUrl(item: StrategyItem): string {
  return ICON_BASE + item.icon;
}
