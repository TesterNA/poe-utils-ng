/**
 * Reading stored records back, and keeping old ones readable.
 *
 * Everything here is pure — no IndexedDB, no Angular — so `npm run test:codex`
 * can run it in node. That is deliberate: the storage layer is a few dozen
 * lines of request plumbing that either works or throws, while *this* is where
 * data quietly goes missing, and only one of the two can be tested cheaply.
 *
 * Two rules the whole file follows:
 *
 * **A malformed record is dropped, never repaired into nonsense.** One bad row
 * must not hide the rest, which is the same posture the atlas and strategy
 * libraries already take with localStorage.
 *
 * **A record from a newer build is refused rather than mangled.** It stays in
 * the database untouched — reads here are non-destructive and writes only
 * happen when you edit something — so opening the same Codex in an older tab
 * hides those entries for that session instead of destroying them.
 */
import type {
  AssetMeta,
  AtlasSource,
  Block,
  CodexBundle,
  Doc,
  Entry,
  EntryData,
  EntryKind,
  Game,
  LinkRole,
  Page,
  PageLayout,
  Run,
  SavedView,
  StrategySource,
} from './codex-types';

/** Bumped whenever a stored shape changes; every bump needs a migration below. */
export const SCHEMA = 1;

/** Bundles carry their own number: the file outlives any one build. */
export const BUNDLE_VERSION = 1;

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// --- tags ---------------------------------------------------------------------

/**
 * Tags are matched, counted and autocompleted, so two spellings of one tag are
 * two tags and the mistake is invisible. `#Legion `, `legion` and `Legion` all
 * become `legion`, and `Day 1` becomes `day-1`.
 *
 * The length cap is not paranoia: tags will arrive by pasting whole spreadsheet
 * columns, and one runaway cell should not become a tag nobody can ever click.
 */
const MAX_TAG = 40;

export function normaliseTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._/-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_TAG);
}

/** Order is the order they were written in; duplicates fold into the first. */
export function normaliseTags(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const tag = normaliseTag(value);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// --- small readers ------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === 'string');
}

function optional<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

const GAMES = ['poe1', 'poe2'] as const;
const STATUSES = ['live', 'dead', 'tbc', 'draft'] as const;
const LAYOUTS = ['list', 'cards', 'table', 'board'] as const;
const GROUP_BY = ['tag', 'league', 'status', 'kind', 'none'] as const;
const ROLES = [
  'pob',
  'video',
  'guide',
  'atlas',
  'filter',
  'profile',
  'doc',
  'tool',
  'stream',
  'image',
  'other',
] as const;
const KINDS: readonly EntryKind[] = [
  'link',
  'note',
  'checklist',
  'image',
  'table',
  'atlas',
  'strategy',
  'build',
];

/** A record is only worth reading if it can be found again and written back. */
function identity(raw: Rec): { id: string; createdAt: number; updatedAt: number } | null {
  const id = str(raw['id']).trim();
  if (!id) return null;
  const updatedAt = num(raw['updatedAt']);
  return { id, createdAt: num(raw['createdAt'], updatedAt), updatedAt };
}

// --- entry data ---------------------------------------------------------------

function readAtlasSource(raw: unknown): AtlasSource | null {
  if (!isRec(raw)) return null;
  const src: AtlasSource = {};
  if (str(raw['code'])) src.code = str(raw['code']);
  if (str(raw['url'])) src.url = str(raw['url']);
  if (str(raw['assetId'])) src.assetId = str(raw['assetId']);
  if (str(raw['imageUrl'])) src.imageUrl = str(raw['imageUrl']);
  const snapshot = raw['snapshot'];
  if (isRec(snapshot)) {
    src.snapshot = {
      treeVersion: num(snapshot['treeVersion']),
      points: num(snapshot['points']),
      keystones: strings(snapshot['keystones']),
      mechanics: list(snapshot['mechanics'])
        .filter(isRec)
        .map((m) => ({ label: str(m['label']), value: str(m['value']) })),
      ...(str(snapshot['thumbId']) ? { thumbId: str(snapshot['thumbId']) } : {}),
    };
  }
  // An atlas card that names no tree at all is not an atlas card. Everything
  // else about it is optional on purpose.
  return src.code || src.url || src.assetId || src.imageUrl ? src : null;
}

function readPicks(raw: unknown): { code: number; count: number }[] {
  return list(raw)
    .filter(isRec)
    .map((p) => ({ code: num(p['code'], -1), count: num(p['count']) }))
    .filter((p) => p.code >= 0 && p.count > 0);
}

function readStrategySource(raw: unknown): StrategySource | null {
  if (!isRec(raw)) return null;
  const src: StrategySource = {};
  if (str(raw['code'])) src.code = str(raw['code']);
  const snapshot = raw['snapshot'];
  if (isRec(snapshot)) {
    src.snapshot = {
      treeVersion: num(snapshot['treeVersion']),
      slots: num(snapshot['slots']),
      picks: list(snapshot['picks'])
        .filter(isRec)
        .map((p) => ({
          code: num(p['code']),
          count: num(p['count']),
          name: str(p['name']),
          icon: str(p['icon']),
        })),
      points: num(snapshot['points']),
      keystones: strings(snapshot['keystones']),
      ...(str(snapshot['atlasThumbId']) ? { atlasThumbId: str(snapshot['atlasThumbId']) } : {}),
      issues: strings(snapshot['issues']),
    };
  }
  const atlas = readAtlasSource(raw['atlas']);
  if (atlas) src.atlas = atlas;
  const picks = readPicks(raw['picks']);
  if (picks.length) src.picks = picks;
  if (str(raw['picksText'])) src.picksText = str(raw['picksText']);
  if (str(raw['map'])) src.map = str(raw['map']);
  if (str(raw['astrolabe'])) src.astrolabe = str(raw['astrolabe']);
  // Unlike an atlas, an empty strategy is legitimate: it is the one you have
  // named and not yet worked out, which is how half of them start.
  return src;
}

function readData(kind: EntryKind, raw: unknown): EntryData | null {
  const rec = isRec(raw) ? raw : {};
  switch (kind) {
    case 'link': {
      const url = str(rec['url']).trim();
      if (!url) return null;
      const filter = isRec(rec['filter']) ? (rec['filter'] as Rec) : null;
      return {
        k: 'link',
        url,
        host: str(rec['host']) || hostOf(url),
        ...(optional(rec['role'], ROLES) ? { role: optional(rec['role'], ROLES) as LinkRole } : {}),
        ...(str(rec['assetId']) ? { assetId: str(rec['assetId']) } : {}),
        ...(filter
          ? {
              filter: {
                site:
                  optional(filter['site'], ['filterblade', 'poe-profile', 'other'] as const) ??
                  'other',
                ...(str(filter['profile']) ? { profile: str(filter['profile']) } : {}),
                ...(str(filter['saveState']) ? { saveState: str(filter['saveState']) } : {}),
                ...(optional(filter['stage'], ['leveling', 'early', 'mapping', 'endgame'] as const)
                  ? { stage: filter['stage'] as 'leveling' | 'early' | 'mapping' | 'endgame' }
                  : {}),
                ...(str(filter['soundsUrl']) ? { soundsUrl: str(filter['soundsUrl']) } : {}),
                ...(optional(filter['game'], GAMES) ? { game: filter['game'] as Game } : {}),
              },
            }
          : {}),
      };
    }
    case 'note':
      return { k: 'note' };
    case 'checklist':
      return {
        k: 'checklist',
        items: list(rec['items'])
          .filter(isRec)
          .map((item) => ({ text: str(item['text']), done: bool(item['done']) }))
          .filter((item) => item.text),
      };
    case 'image': {
      const assetId = str(rec['assetId']);
      const imageUrl = str(rec['imageUrl']);
      if (!assetId && !imageUrl) return null;
      return {
        k: 'image',
        ...(assetId ? { assetId } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(num(rec['w']) ? { w: num(rec['w']) } : {}),
        ...(num(rec['h']) ? { h: num(rec['h']) } : {}),
      };
    }
    case 'table':
      return {
        k: 'table',
        columns: strings(rec['columns']),
        rows: list(rec['rows']).map((row) => strings(row)),
      };
    case 'atlas': {
      const src = readAtlasSource(rec['src']);
      if (!src) return null;
      return { k: 'atlas', src, ...(num(rec['points']) ? { points: num(rec['points']) } : {}) };
    }
    case 'strategy': {
      const src = readStrategySource(rec['src']);
      if (!src) return null;
      return { k: 'strategy', src };
    }
    case 'build':
      return {
        k: 'build',
        links: list(rec['links'])
          .filter(isRec)
          .map((link) => ({
            label: str(link['label']),
            url: str(link['url']),
            ...(optional(link['role'], ROLES) ? { role: link['role'] as LinkRole } : {}),
          }))
          .filter((link) => link.url),
        ...(str(rec['ascendancy']) ? { ascendancy: str(rec['ascendancy']) } : {}),
      };
  }
}

/** The bare host, for grouping and for the little grey line under a link. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function readRuns(raw: unknown): Run[] {
  return list(raw)
    .filter(isRec)
    .map((run) => ({
      id: str(run['id']) || newId(),
      at: num(run['at']),
      minutes: num(run['minutes']),
      ...(num(run['maps']) ? { maps: num(run['maps']) } : {}),
      investDiv: num(run['investDiv']),
      revenueDiv: num(run['revenueDiv']),
      ...(str(run['note']) ? { note: str(run['note']) } : {}),
      ...(strings(run['assetIds']).length ? { assetIds: strings(run['assetIds']) } : {}),
    }));
}

// --- records ------------------------------------------------------------------

export function readEntry(raw: unknown): Entry | null {
  if (!isRec(raw)) return null;
  const record = migrate(raw);
  if (!record) return null;
  const who = identity(record);
  if (!who) return null;
  const kind = KINDS.find((k) => k === record['kind']);
  if (!kind) return null;
  const data = readData(kind, record['data']);
  if (!data) return null;
  const runs = readRuns(record['runs']);
  const difficulty = num(record['difficulty']);
  return {
    v: SCHEMA,
    ...who,
    kind,
    title: str(record['title']),
    body: str(record['body']),
    tags: normaliseTags(list(record['tags'])),
    refs: strings(record['refs']),
    ...(str(record['league']) ? { league: str(record['league']) } : {}),
    ...(optional(record['game'], GAMES) ? { game: record['game'] as Game } : {}),
    ...(optional(record['status'], STATUSES)
      ? { status: record['status'] as Entry['status'] }
      : {}),
    ...(difficulty >= 1 && difficulty <= 3 ? { difficulty: difficulty as 1 | 2 | 3 } : {}),
    ...(bool(record['pinned']) ? { pinned: true } : {}),
    data,
    ...(runs.length ? { runs } : {}),
    ...(num(record['deletedAt']) ? { deletedAt: num(record['deletedAt']) } : {}),
  };
}

export function readDoc(raw: unknown): Doc | null {
  if (!isRec(raw)) return null;
  const record = migrate(raw);
  if (!record) return null;
  const who = identity(record);
  if (!who) return null;
  return {
    v: SCHEMA,
    ...who,
    title: str(record['title']),
    ...(str(record['league']) ? { league: str(record['league']) } : {}),
    ...(optional(record['game'], GAMES) ? { game: record['game'] as Game } : {}),
    ...(str(record['description']) ? { description: str(record['description']) } : {}),
    // Anything unreadable means private. Guessing the other way publishes
    // somebody's notes because a field was mistyped.
    visibility: record['visibility'] === 'link' ? 'link' : 'private',
    ...(str(record['slug']) ? { slug: str(record['slug']) } : {}),
    ...(num(record['deletedAt']) ? { deletedAt: num(record['deletedAt']) } : {}),
  };
}

function readBlock(raw: unknown, depth = 0): Block | null {
  if (!isRec(raw)) return null;
  switch (raw['t']) {
    case 'entry': {
      const id = str(raw['id']);
      return id
        ? { t: 'entry', id, ...(raw['size'] === 'full' ? { size: 'full' as const } : {}) }
        : null;
    }
    case 'heading': {
      const level = num(raw['level'], 2);
      return {
        t: 'heading',
        text: str(raw['text']),
        level: (level >= 1 && level <= 3 ? level : 2) as 1 | 2 | 3,
      };
    }
    case 'text':
      return { t: 'text', md: str(raw['md']) };
    case 'divider':
      return { t: 'divider' };
    case 'columns':
      // Columns inside columns is a layout nobody asked for and a recursion
      // nobody bounded, so one level is where it stops.
      if (depth > 0) return null;
      return {
        t: 'columns',
        cols: list(raw['cols']).map((col) =>
          list(col)
            .map((block) => readBlock(block, depth + 1))
            .filter((block): block is Block => block !== null),
        ),
      };
    case 'query':
      return {
        t: 'query',
        q: str(raw['q']),
        layout: optional(raw['layout'], LAYOUTS) ?? 'list',
        ...(str(raw['title']) ? { title: str(raw['title']) } : {}),
      };
    default:
      return null;
  }
}

export function readPage(raw: unknown): Page | null {
  if (!isRec(raw)) return null;
  const record = migrate(raw);
  if (!record) return null;
  const who = identity(record);
  if (!who) return null;
  const docId = str(record['docId']);
  if (!docId) return null;
  return {
    v: SCHEMA,
    ...who,
    docId,
    parentId: str(record['parentId']) || null,
    title: str(record['title']),
    ...(str(record['icon']) ? { icon: str(record['icon']) } : {}),
    order: num(record['order']),
    mode: record['mode'] === 'query' ? 'query' : 'curated',
    blocks: list(record['blocks'])
      .map((block) => readBlock(block))
      .filter((block): block is Block => block !== null),
    ...(str(record['query']) ? { query: str(record['query']) } : {}),
    layout: optional(record['layout'], LAYOUTS) ?? 'list',
    ...(optional(record['groupBy'], GROUP_BY)
      ? { groupBy: record['groupBy'] as Page['groupBy'] }
      : {}),
    ...(num(record['deletedAt']) ? { deletedAt: num(record['deletedAt']) } : {}),
  };
}

export function readView(raw: unknown): SavedView | null {
  if (!isRec(raw)) return null;
  const record = migrate(raw);
  if (!record) return null;
  const who = identity(record);
  if (!who) return null;
  return {
    v: SCHEMA,
    ...who,
    name: str(record['name']),
    query: str(record['query']),
    layout: optional(record['layout'], LAYOUTS) ?? 'list',
    pinned: bool(record['pinned']),
    ...(num(record['deletedAt']) ? { deletedAt: num(record['deletedAt']) } : {}),
  };
}

export function readAssetMeta(raw: unknown): AssetMeta | null {
  if (!isRec(raw)) return null;
  const record = migrate(raw);
  if (!record) return null;
  const id = str(record['id']);
  if (!id) return null;
  return {
    v: SCHEMA,
    id,
    type: str(record['type'], 'image/webp'),
    w: num(record['w']),
    h: num(record['h']),
    bytes: num(record['bytes']),
    createdAt: num(record['createdAt']),
    ...(num(record['deletedAt']) ? { deletedAt: num(record['deletedAt']) } : {}),
  };
}

/** Reads a list, keeping what can be read. One bad row must not hide the rest. */
export function readAll<T>(raw: unknown, read: (item: unknown) => T | null): T[] {
  return list(raw)
    .map(read)
    .filter((item): item is T => item !== null);
}

// --- migration ----------------------------------------------------------------

/**
 * From version n to n+1. `MIGRATIONS[1]` will take a v1 record to v2, and so
 * on; the chain has to be complete, which the test asserts rather than trusting.
 */
const MIGRATIONS: Record<number, (record: Rec) => Rec> = {};

/**
 * Brings a stored record up to the current schema, or refuses it.
 *
 * A record with no `v` is v1 — the first shape that ever existed. A record from
 * the future is refused: reading it with an older set of rules would drop the
 * fields this build does not know about, and the next save would write that
 * loss back.
 */
export function migrate(raw: unknown): Rec | null {
  if (!isRec(raw)) return null;
  let version = num(raw['v'], 1);
  if (version > SCHEMA) return null;
  let record = raw;
  while (version < SCHEMA) {
    const step = MIGRATIONS[version];
    if (!step) return null;
    record = step({ ...record });
    version++;
  }
  return { ...record, v: SCHEMA };
}

// --- new records --------------------------------------------------------------

export function newDoc(title: string, league?: string): Doc {
  const now = Date.now();
  return {
    v: SCHEMA,
    id: newId(),
    title: title.trim(),
    ...(league?.trim() ? { league: league.trim() } : {}),
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  };
}

export function newPage(docId: string, title: string, order: number): Page {
  const now = Date.now();
  return {
    v: SCHEMA,
    id: newId(),
    docId,
    parentId: null,
    title: title.trim(),
    order,
    mode: 'curated',
    blocks: [],
    layout: 'list',
    createdAt: now,
    updatedAt: now,
  };
}

export function newEntry(kind: EntryKind, title: string, data: EntryData): Entry {
  const now = Date.now();
  return {
    v: SCHEMA,
    id: newId(),
    kind,
    title: title.trim(),
    body: '',
    tags: [],
    refs: [],
    data,
    createdAt: now,
    updatedAt: now,
  };
}

export function newView(name: string, query: string, layout: PageLayout = 'list'): SavedView {
  const now = Date.now();
  return {
    v: SCHEMA,
    id: newId(),
    name: name.trim(),
    query,
    layout,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
}

// --- bundles ------------------------------------------------------------------

/**
 * Reading a bundle is reading every record in it, one at a time, dropping what
 * cannot be read. A file that has been through a text editor, a chat client and
 * a copy-paste should give back everything that survived rather than nothing.
 */
export function readBundle(raw: unknown): CodexBundle | null {
  if (!isRec(raw)) return null;
  const version = num(raw['v'], 1);
  if (version > BUNDLE_VERSION) return null;
  return {
    v: BUNDLE_VERSION,
    at: num(raw['at']),
    docs: readAll(raw['docs'], readDoc),
    pages: readAll(raw['pages'], readPage),
    entries: readAll(raw['entries'], readEntry),
    views: readAll(raw['views'], readView),
    assets: list(raw['assets'])
      .filter(isRec)
      .map((asset) => {
        const meta = readAssetMeta(asset['meta']);
        const data = str(asset['data']);
        return meta && data ? { meta, data } : null;
      })
      .filter((asset): asset is { meta: AssetMeta; data: string } => asset !== null),
  };
}

export function packBundle(parts: Omit<CodexBundle, 'v' | 'at'>, at = Date.now()): CodexBundle {
  return { v: BUNDLE_VERSION, at, ...parts };
}
