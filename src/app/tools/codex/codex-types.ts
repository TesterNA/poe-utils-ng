/**
 * What a Codex is made of.
 *
 * Two layers, and keeping them apart is the whole design. An **entry** is a
 * thing you wrote down — a link, a note, a strategy, a screenshot. A **page**
 * only arranges entries it does not own. So the same filter link can sit on
 * this league's doc and on the permanent one, be edited in one place, and
 * deleting the page never deletes what was on it. That is the one thing a
 * spreadsheet cannot do, and it is why this is not a spreadsheet.
 *
 * Nothing here is required beyond a title. The docs this replaces are full of
 * half-written strategies — a scarab line and an imgur link and no tree — and a
 * model that demands a complete record turns a three second note into a form.
 * An atlas can therefore be our own share code, somebody else's planner link, a
 * screenshot, or all three at once; see `AtlasSource`.
 *
 * Every stored record carries `v`, the schema version it was written under.
 * Migration happens on read (codex-schema.ts), not in an IndexedDB upgrade: a
 * bad upgrade transaction takes the whole database with it, and a read-time
 * migration can be tested in node without a browser.
 */

export type Game = 'poe1' | 'poe2';

export type EntryKind =
  | 'link'
  | 'note'
  | 'checklist'
  | 'image'
  | 'table'
  | 'atlas'
  | 'strategy'
  | 'build';

/** What a link is *for*. Guessed from the host on paste, always overridable. */
export type LinkRole =
  | 'pob'
  | 'video'
  | 'guide'
  | 'atlas'
  | 'filter'
  | 'profile'
  | 'doc'
  | 'tool'
  | 'stream'
  | 'image'
  | 'other';

/**
 * A loot filter, taken apart. There are three of these per league in one of the
 * source docs and a whole sheet of them in another — profiles to subscribe to,
 * a sound pack that has to be unzipped separately, and the instructions without
 * which none of it works. `saveState` is what tells a levelling filter from an
 * endgame one, so it is a field rather than a fragment of a URL.
 */
export interface FilterInfo {
  site: 'filterblade' | 'poe-profile' | 'other';
  profile?: string;
  saveState?: string;
  stage?: 'leveling' | 'early' | 'mapping' | 'endgame';
  /** the archive of sounds, which lives somewhere else entirely */
  soundsUrl?: string;
  game?: Game;
}

/**
 * Everything needed to draw an atlas card without loading the atlas.
 *
 * `tree.json` is 1.5 MB and the sprite sheets are another 4 MB, so a list of
 * twenty strategies cannot each ask the tree what they contain. The answer is
 * taken once, at save time, when the tree is already in memory because the save
 * came from the atlas tool.
 */
export interface AtlasSnapshot {
  treeVersion: number;
  points: number;
  keystones: string[];
  /** from summary.ts: "Legion +240%", "Scarabs +45%" — the few that matter */
  mechanics: { label: string; value: string }[];
  /** asset id of a thumbnail drawn once by the renderer */
  thumbId?: string;
}

export interface StrategySnapshot {
  treeVersion: number;
  slots: number;
  picks: { code: number; count: number; name: string; icon: string }[];
  points: number;
  keystones: string[];
  atlasThumbId?: string;
  /** what the validator said when it was saved — "Scarab of X removed in 3.29" */
  issues: string[];
}

/**
 * An atlas tree, however the person happens to have it.
 *
 * Nobody is going to redraw a streamer's tree in our editor just to write down
 * "he ran this". So a planner link and an imgur screenshot are first class, and
 * a card can hold a screenshot *and* our code — that is what upgrading one
 * looks like, and both are worth showing while it happens.
 *
 * At least one field must be set; an atlas card with nothing in it is not an
 * atlas card.
 */
export interface AtlasSource {
  /** our `AT…` code — the only form that makes the card live */
  code?: string;
  snapshot?: AtlasSnapshot;
  /** somebody else's tree: poeplanner, poeqol, anything */
  url?: string;
  /** a screenshot we hold */
  assetId?: string;
  /** a screenshot somebody else holds: imgur, ibb */
  imageUrl?: string;
}

/**
 * A strategy, at whatever resolution it was written down.
 *
 * With our `ST…` code everything below it is already inside the code and is
 * left empty. Without one it degrades the way the source docs actually read: a
 * tree that is a screenshot, scarabs as a sentence, a map roll as a sentence.
 */
export interface StrategySource {
  code?: string;
  snapshot?: StrategySnapshot;
  /** the tree on its own, when there is no strategy code to hold it */
  atlas?: AtlasSource;
  /** scarabs picked from our catalogue — icons, counts, slot arithmetic */
  picks?: { code: number; count: number }[];
  /** ...or as written: "2 доп легиона и 1 офицер" */
  picksText?: string;
  /** "8-mod Dunes, 41%+ packsize" */
  map?: string;
  /** "legion astrolabe", "кидаем астралябу брича" */
  astrolabe?: string;
}

export type EntryData =
  | {
      k: 'link';
      url: string;
      host: string;
      role?: LinkRole;
      /** a preview image we hold */
      assetId?: string;
      filter?: FilterInfo;
    }
  | { k: 'note' }
  | { k: 'checklist'; items: { text: string; done: boolean }[] }
  | { k: 'image'; assetId?: string; imageUrl?: string; w?: number; h?: number }
  | { k: 'table'; columns: string[]; rows: string[][] }
  | { k: 'atlas'; src: AtlasSource; points?: number }
  | { k: 'strategy'; src: StrategySource }
  | { k: 'build'; links: { label: string; url: string; role?: LinkRole }[]; ascendancy?: string };

/**
 * One measured run.
 *
 * In the source docs this is either a sentence — "профит 14 в час минус замаз
 * 2д" — or a screenshot of a loot tracker, which is a number rendered as
 * pixels. Held as numbers it can be averaged over several runs and sorted
 * against every other strategy, which is the entire reason one of those docs
 * exists as a separate document.
 *
 * `net` and per-hour are derived, never stored: two representations of the same
 * arithmetic are two chances to disagree.
 */
export interface Run {
  id: string;
  at: number;
  minutes: number;
  maps?: number;
  /** what it cost to set up, in divines */
  investDiv: number;
  revenueDiv: number;
  note?: string;
  /** the screenshots that back the numbers up */
  assetIds?: string[];
}

export interface Entry {
  v: number;
  id: string;
  kind: EntryKind;
  title: string;
  /** markdown; the opinion and the notes live here */
  body: string;
  /** normalised: lower case, no leading '#' */
  tags: string[];
  /** ids of related entries; backlinks are read off these */
  refs: string[];
  league?: string;
  game?: Game;
  status?: 'live' | 'dead' | 'tbc' | 'draft';
  /** the EASY / MEDIUM / HARD column one of the docs keeps */
  difficulty?: 1 | 2 | 3;
  pinned?: boolean;
  data: EntryData;
  /** measurements, for the kinds that can be measured */
  runs?: Run[];
  createdAt: number;
  updatedAt: number;
  /** soft delete: absence cannot mean deletion once an account is involved */
  deletedAt?: number;
}

/**
 * A doc.
 *
 * `league` is a field, not a frame: a doc may cover one league, several, or
 * none at all. It is prefilled on creation because that is how these documents
 * usually start, and it is one click to clear.
 */
export interface Doc {
  v: number;
  id: string;
  title: string;
  league?: string;
  game?: Game;
  description?: string;
  /** 'link' means anyone holding it may read it, and nobody but the author may change it */
  visibility: 'private' | 'link';
  /** short-link slug, once published */
  slug?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export type Block =
  | { t: 'entry'; id: string; size?: 'compact' | 'full' }
  | { t: 'heading'; text: string; level: 1 | 2 | 3 }
  | { t: 'text'; md: string }
  | { t: 'divider' }
  /** the two-column layout both source docs fall into by hand */
  | { t: 'columns'; cols: Block[][] }
  /** a live list in the middle of a page — this is what a "custom group" is */
  | { t: 'query'; q: string; layout: PageLayout; title?: string };

export type PageLayout = 'list' | 'cards' | 'table' | 'board';

export interface Page {
  v: number;
  id: string;
  docId: string;
  parentId: string | null;
  title: string;
  icon?: string;
  order: number;
  /** 'curated' is arranged by hand; 'query' is a saved filter that stays current */
  mode: 'curated' | 'query';
  blocks: Block[];
  query?: string;
  layout: PageLayout;
  groupBy?: 'tag' | 'league' | 'status' | 'kind' | 'none';
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/** A search worth keeping: the dynamic half of "custom groups". */
export interface SavedView {
  v: number;
  id: string;
  name: string;
  query: string;
  layout: PageLayout;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/** What is known about a stored image. The bytes live beside it, not in it. */
export interface AssetMeta {
  v: number;
  id: string;
  type: string;
  w: number;
  h: number;
  bytes: number;
  createdAt: number;
  deletedAt?: number;
}

/**
 * Everything, in one JSON — the way out that does not depend on this browser,
 * and the shape a published doc travels in.
 *
 * Images are base64 here and Blobs everywhere else. Inside a single file that
 * somebody saves to disk, a third more bytes is the right trade for not having
 * to ship a folder alongside it.
 */
export interface CodexBundle {
  v: number;
  at: number;
  docs: Doc[];
  pages: Page[];
  entries: Entry[];
  views: SavedView[];
  assets: { meta: AssetMeta; data: string }[];
}
