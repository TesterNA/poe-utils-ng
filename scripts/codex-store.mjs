/**
 * Checks what the Codex does with a stored record it did not just write.
 *
 * Everything the Codex holds passes through codex-schema.ts twice — once
 * leaving IndexedDB and once leaving an exported file — and that is the only
 * place where data can go missing quietly. A reader that is too strict drops a
 * doc somebody wrote; one that is too lax puts half an entry on screen with
 * fields that are not what they claim. Neither shows up as an error, which is
 * why they are tested rather than trusted.
 *
 * The migration chain gets its own check for the same reason. A record from a
 * newer build must be refused rather than read with the old rules and written
 * back missing the fields this build has never heard of.
 *
 * Run: node scripts/codex-store.mjs
 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'node_modules', '.codex-test');

await mkdir(tmp, { recursive: true });
async function load(name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({
    entryPoints: [path.join(root, 'src/app/tools/codex', `${name}.ts`)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'warning',
  });
  return import(pathToFileURL(outfile).href);
}

const schema = await load('codex-schema');
const query = await load('codex-query');
const capture = await load('codex-capture');
const metrics = await load('codex-metrics');
const blocks = await load('codex-blocks');
const format = await load('codex-format');
const image = await load('codex-image');
const {
  SCHEMA,
  BUNDLE_VERSION,
  hostOf,
  migrate,
  newDoc,
  newEntry,
  newId,
  normaliseTag,
  normaliseTags,
  packBundle,
  parseTagInput,
  readAll,
  readBundle,
  readDoc,
  readEntry,
  readPage,
} = schema;

let failures = 0;

/** Key order is not part of a record. Array order is, so arrays are left alone. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function check(what, got, want) {
  const a = JSON.stringify(stable(got));
  const b = JSON.stringify(stable(want));
  if (a === b) return;
  failures++;
  console.error(`FAIL ${what}\n  got  ${a}\n  want ${b}`);
}

const stamp = { createdAt: 1, updatedAt: 2 };
const entry = (extra) => ({ v: SCHEMA, id: 'e1', kind: 'note', data: { k: 'note' }, ...stamp, ...extra });

// --- tags ---------------------------------------------------------------------
// Two spellings of one tag are two tags, and the mistake is invisible on screen.

check('tag: hash and case', normaliseTag('#Legion'), 'legion');
check('tag: spaces become dashes', normaliseTag('  Day 1  '), 'day-1');
check('tag: punctuation goes', normaliseTag('T16.5 maps!'), 't16.5-maps');
check('tag: cyrillic survives', normaliseTag('Абисс'), 'абисс');
check('tag: nothing left is nothing', normaliseTag('###'), '');
check('tag: long ones are cut', normaliseTag('x'.repeat(80)).length, 40);
check('tags: dedupe keeps first order', normaliseTags(['Breach', '#breach', 'legion']), [
  'breach',
  'legion',
]);
check('tags: junk is skipped', normaliseTags(['ok', 3, null, '', '#']), ['ok']);

// What somebody types into the tag field. A comma anywhere means commas are the
// separator, because that is the only way a tag can hold a space.
check('tag input: spaces separate', parseTagInput('worb leveling Day'), ['worb', 'leveling', 'day']);
check('tag input: a comma changes its mind', parseTagInput('день 1, легион'), ['день-1', 'легион']);
check('tag input: nothing is nothing', parseTagInput('   '), []);

// --- what a reader keeps and what it drops ------------------------------------

check('entry: an id is not optional', readEntry(entry({ id: '  ' })), null);
check('entry: an unknown kind is refused', readEntry(entry({ kind: 'wormhole' })), null);
check('entry: defaults are filled', readEntry(entry()), {
  v: SCHEMA,
  id: 'e1',
  createdAt: 1,
  updatedAt: 2,
  kind: 'note',
  title: '',
  body: '',
  tags: [],
  refs: [],
  data: { k: 'note' },
});
check(
  'entry: createdAt falls back to updatedAt rather than 1970',
  readEntry({ v: SCHEMA, id: 'e1', kind: 'note', data: { k: 'note' }, updatedAt: 99 })?.createdAt,
  99,
);
check(
  'entry: a status nobody defined is dropped, not kept',
  readEntry(entry({ status: 'probably' }))?.status,
  undefined,
);
check(
  'entry: difficulty stays inside its scale',
  readEntry(entry({ difficulty: 7 }))?.difficulty,
  undefined,
);

// One bad row must not hide the rest — the same posture the atlas library takes.
check(
  'list: a broken record does not take the good ones with it',
  readAll([entry({ id: 'a' }), { nonsense: true }, entry({ id: 'b' })], readEntry).map((e) => e.id),
  ['a', 'b'],
);

// --- links --------------------------------------------------------------------

check('link: no url, no link', readEntry(entry({ kind: 'link', data: { k: 'link' } })), null);
check(
  'link: the host is worked out when it was not stored',
  readEntry(entry({ kind: 'link', data: { k: 'link', url: 'https://www.pobb.in/abc' } }))?.data,
  { k: 'link', url: 'https://www.pobb.in/abc', host: 'pobb.in' },
);
check('host: something that is not a url', hostOf('not a url'), '');
check(
  'link: a filter keeps the saveState that tells it apart',
  readEntry(
    entry({
      kind: 'link',
      data: {
        k: 'link',
        url: 'https://www.filterblade.xyz/?profile=madaraxgod&saveState=HX7QO7AP9JFK22',
        role: 'filter',
        filter: { site: 'filterblade', profile: 'madaraxgod', saveState: 'HX7QO7AP9JFK22', stage: 'mapping' },
      },
    }),
  )?.data.filter,
  { site: 'filterblade', profile: 'madaraxgod', saveState: 'HX7QO7AP9JFK22', stage: 'mapping' },
);

// --- atlas and strategy, at whatever resolution they were written -------------
// The point of the feature: somebody else's planner link and an imgur
// screenshot are as valid as our own share code, and one card may hold both.

const atlasEntry = (src) => entry({ kind: 'atlas', data: { k: 'atlas', src } });
check('atlas: an empty source is not an atlas', readEntry(atlasEntry({})), null);
check('atlas: a foreign planner link is enough', readEntry(atlasEntry({ url: 'https://poeplanner.com/a/6gTh' }))?.data.src, {
  url: 'https://poeplanner.com/a/6gTh',
});
check('atlas: a screenshot is enough', readEntry(atlasEntry({ imageUrl: 'https://imgur.com/qfs4oTE' }))?.data.src, {
  imageUrl: 'https://imgur.com/qfs4oTE',
});
check(
  'atlas: a screenshot and our code live together',
  readEntry(atlasEntry({ code: 'AT3:AQKK', imageUrl: 'https://imgur.com/qfs4oTE' }))?.data.src,
  { code: 'AT3:AQKK', imageUrl: 'https://imgur.com/qfs4oTE' },
);

check(
  'strategy: scarabs as a sentence are kept as a sentence',
  readEntry(
    entry({
      kind: 'strategy',
      data: { k: 'strategy', src: { picksText: '2 доп легиона и 1 офицер', map: '8 мод Dunes' } },
    }),
  )?.data.src,
  { picksText: '2 доп легиона и 1 офицер', map: '8 мод Dunes' },
);
check(
  'strategy: picks without a count are not picks',
  readEntry(
    entry({
      kind: 'strategy',
      data: { k: 'strategy', src: { picks: [{ code: 12, count: 2 }, { code: 13, count: 0 }] } },
    }),
  )?.data.src.picks,
  [{ code: 12, count: 2 }],
);
check(
  'strategy: named and not yet worked out is a strategy',
  readEntry(entry({ kind: 'strategy', title: 'Abyss?', data: { k: 'strategy', src: {} } }))?.title,
  'Abyss?',
);

// --- docs and pages -----------------------------------------------------------

check('doc: new docs are private', newDoc('League 3.29', '3.29').visibility, 'private');
check('doc: the league is optional', newDoc('Evergreen', '   ').league, undefined);
check(
  'doc: anything unreadable in visibility means private',
  readDoc({ v: SCHEMA, id: 'd1', title: 'x', visibility: 'public', ...stamp })?.visibility,
  'private',
);
check(
  'doc: published stays published',
  readDoc({ v: SCHEMA, id: 'd1', title: 'x', visibility: 'link', slug: 'k7mfrp2q', ...stamp })?.slug,
  'k7mfrp2q',
);

const page = (extra) => ({ v: SCHEMA, id: 'p1', docId: 'd1', title: 'Farming', ...stamp, ...extra });
check('page: a page without a doc is nothing', readPage(page({ docId: '' })), null);
check(
  'page: unknown blocks are dropped, known ones stay',
  readPage(page({ blocks: [{ t: 'entry', id: 'e1' }, { t: 'seance' }, { t: 'divider' }] }))?.blocks,
  [{ t: 'entry', id: 'e1' }, { t: 'divider' }],
);
check(
  'page: columns nest once and no further',
  readPage(
    page({
      blocks: [
        {
          t: 'columns',
          cols: [[{ t: 'text', md: 'left' }, { t: 'columns', cols: [] }], [{ t: 'text', md: 'right' }]],
        },
      ],
    }),
  )?.blocks[0].cols,
  [[{ t: 'text', md: 'left' }], [{ t: 'text', md: 'right' }]],
);

// --- migration ----------------------------------------------------------------

check('migrate: the current version passes through', migrate({ v: SCHEMA, id: 'x' })?.v, SCHEMA);
check('migrate: no version means the first one', migrate({ id: 'x' })?.v, SCHEMA);
check('migrate: a record from a newer build is refused', migrate({ v: SCHEMA + 1, id: 'x' }), null);
check('migrate: an entry from the future is not half-read', readEntry(entry({ v: SCHEMA + 1 })), null);

// The chain has to be complete or a bump silently starts dropping old records.
const gaps = [];
for (let from = 1; from < SCHEMA; from++) {
  if (!migrate({ v: from, id: 'x' })) gaps.push(from);
}
check('migrate: every version can reach the current one', gaps, []);

// --- bundles ------------------------------------------------------------------

const bundle = packBundle(
  {
    docs: [newDoc('3.29', '3.29')],
    pages: [],
    entries: [
      newEntry('link', 'Filter', {
        k: 'link',
        url: 'https://www.filterblade.xyz/?profile=x',
        host: 'filterblade.xyz',
        role: 'filter',
      }),
    ],
    views: [],
    assets: [
      {
        meta: { v: SCHEMA, id: 'a1', type: 'image/webp', w: 4, h: 4, bytes: 3, createdAt: 5 },
        data: 'AAAA',
      },
    ],
  },
  7,
);
check('bundle: round trip', readBundle(JSON.parse(JSON.stringify(bundle))), bundle);
check('bundle: a newer file is refused whole', readBundle({ ...bundle, v: BUNDLE_VERSION + 1 }), null);
check(
  'bundle: a file that lost a record still gives back the rest',
  readBundle({ ...bundle, entries: [...bundle.entries, { id: '' }] }).entries.length,
  1,
);
check(
  'bundle: an asset without its bytes is not an asset',
  readBundle({ ...bundle, assets: [{ meta: bundle.assets[0].meta }] }).assets,
  [],
);

// --- ids ----------------------------------------------------------------------

const madeIds = new Set(Array.from({ length: 2000 }, () => newId()));
check('ids: two thousand of them are two thousand', madeIds.size, 2000);

// --- capture ------------------------------------------------------------------
// This is how a Codex fills up, and it is reading lines written by somebody who
// was not thinking about us. All of the shapes below are copied from the three
// documents the feature was designed against.

const { capture: grab, captureOne, filterInfoOf, noteBody, roleOf } = capture;

check('capture: a label and a link split at the colon', captureOne('ендгейм поба: https://pobb.in/cd6A9tg8QjrJ'), {
  kind: 'link',
  title: 'ендгейм поба',
  data: { k: 'link', url: 'https://pobb.in/cd6A9tg8QjrJ', host: 'pobb.in', role: 'pob' },
});
check(
  'capture: no label, so the link names itself',
  captureOne('https://pobb.in/cd6A9tg8QjrJ').title,
  'pobb.in/cd6A9tg8QjrJ',
);
check(
  'capture: a full stop after a link is punctuation, not path',
  captureOne('see https://poe.ninja/poe1/pob/930ab.').data.url,
  'https://poe.ninja/poe1/pob/930ab',
);
check('capture: no link at all is a note', captureOne('помыть посуду').kind, 'note');
check(
  'capture: a list is a list',
  grab(
    [
      'Левелинг поба: https://pobb.in/Lt3xXcXzAp10',
      'Видос по билду: https://www.youtube.com/watch?v=--XDhqSlwPA',
      'Атлас https://imgur.com/a/ESqXHhf',
    ].join('\n'),
  ).map((item) => `${item.title}|${item.data.role}`),
  ['Левелинг поба|pob', 'Видос по билду|video', 'Атлас|image'],
);
check(
  'capture: a paragraph with no links is one note, not four',
  grab('день4\nбегал легион\nпрофит 14 в час').length,
  1,
);
check(
  'capture: and it keeps the rest as the note',
  noteBody('день4\nЛегион висп немезис\nскарабы: 2 легион'),
  'Легион висп немезис\nскарабы: 2 легион',
);

check('role: poe.ninja is a PoB or a profile by path', roleOf('https://poe.ninja/poe1/pob/930ab'), 'pob');
check(
  'role: ...and a profile the other way',
  roleOf('https://poe.ninja/poe1/profile/Niko1963-4012/character/Kankar_VenomGyre'),
  'profile',
);
check(
  'role: pathofexile.com splits the same way',
  roleOf('https://www.pathofexile.com/account/view-profile/Madara-2149/item-filters'),
  'filter',
);
check('role: an unknown site is left alone', roleOf('https://example.com/x'), undefined);

check(
  'filter: the saveState is what tells two of them apart',
  filterInfoOf(
    'https://www.filterblade.xyz/?profile=madaraxgod&saveState=F1MGCRL8A9YRHM&isPreset=false&game=Poe1',
    'madara endgame mapping',
  ),
  { site: 'filterblade', profile: 'madaraxgod', saveState: 'F1MGCRL8A9YRHM', stage: 'endgame', game: 'poe1' },
);
check(
  'filter: a profile to subscribe to is a filter too',
  filterInfoOf('https://www.pathofexile.com/account/view-profile/Madara-2149/item-filters'),
  { site: 'poe-profile', profile: 'Madara-2149' },
);

// --- the query ----------------------------------------------------------------

const { parseQuery, runQuery, toggleTerm, placedIds } = query;

const made = (id, extra = {}) => ({
  ...newEntry(extra.kind ?? 'note', extra.title ?? id, extra.data ?? { k: 'note' }),
  id,
  tags: extra.tags ?? [],
  updatedAt: extra.updatedAt ?? 1,
  createdAt: 1,
  ...(extra.league ? { league: extra.league } : {}),
  ...(extra.game ? { game: extra.game } : {}),
  ...(extra.status ? { status: extra.status } : {}),
  ...(extra.runs ? { runs: extra.runs } : {}),
  ...(extra.body ? { body: extra.body } : {}),
});

const strategy = (id, src, extra = {}) =>
  made(id, { kind: 'strategy', data: { k: 'strategy', src }, ...extra });

const library = [
  made('note1', { title: 'Legion notes', tags: ['legion', 'day-1'], body: 'run dunes', updatedAt: 5 }),
  made('link1', {
    kind: 'link',
    title: 'Endgame filter',
    data: {
      k: 'link',
      url: 'https://www.filterblade.xyz/?profile=x&saveState=y',
      host: 'filterblade.xyz',
      role: 'filter',
      filter: { site: 'filterblade', stage: 'endgame' },
    },
    updatedAt: 4,
  }),
  strategy(
    'strat1',
    { picksText: '5x Cloister', map: '8-mod Dunes' },
    { title: 'Cloister farm', tags: ['legion'], league: '3.29', updatedAt: 3, runs: [{ id: 'r', at: 0, minutes: 60, investDiv: 2, revenueDiv: 14 }] },
  ),
  strategy(
    'strat2',
    { snapshot: { treeVersion: 1, slots: 4, picks: [{ code: 1, count: 2, name: 'Breach Scarab of Splintering', icon: '' }], points: 132, keystones: ['Wandering Path'], issues: [] } },
    { title: 'Breach', league: '3.28', updatedAt: 2, status: 'dead' },
  ),
  made('poe2', { title: 'PoE2 filter', game: 'poe2', tags: ['filters'], updatedAt: 1 }),
  made('loose', { title: 'Boss rush', updatedAt: 0 }),
];

const ids = (q, ctx) => runQuery(library, parseQuery(q), ctx).map((entry) => entry.id);

check('query: nothing asked, everything answered — except the dead', ids(''), [
  'note1',
  'link1',
  'strat1',
  'poe2',
  'loose',
]);
check('query: dead comes back the moment you ask about it', ids('status:dead'), ['strat2']);
check('query: a word looks everywhere readable', ids('dunes'), ['note1', 'strat1']);
check('query: a tag is exact', ids('#legion'), ['note1', 'strat1']);
check('query: negation drops', ids('#legion -kind:strategy'), ['note1']);
check('query: kind', ids('kind:strategy'), ['strat1']);
check('query: role', ids('role:filter'), ['link1']);
check('query: stage', ids('stage:endgame'), ['link1']);
check('query: league', ids('league:3.29'), ['strat1']);
check('query: poe1 means "not marked poe2"', ids('game:poe1').includes('poe2'), false);
check('query: poe2 is explicit', ids('game:poe2'), ['poe2']);
check('query: scarabs by name, whether written or picked', ids('scarab:cloister'), ['strat1']);
check('query: and inside a snapshot', ids('scarab:splintering status:dead'), ['strat2']);
check('query: keystones', ids('node:"wandering path" status:dead'), ['strat2']);
check('query: has:runs', ids('has:runs'), ['strat1']);
check('query: is:untagged', ids('is:untagged'), ['link1', 'loose']);
check(
  'query: sort by what it paid',
  runQuery(library, parseQuery('kind:strategy sort:perhour'), {}).map((e) => e.id),
  ['strat1'],
);
check('query: sort by title reads A to Z', ids('sort:title'), ['loose', 'strat1', 'link1', 'note1', 'poe2']);
check(
  'query: a phrase is one term',
  ids('"legion notes"'),
  ['note1'],
);
check(
  'query: a word with a colon we do not know is a word',
  ids('filterblade.xyz'),
  ['link1'],
);

// The Inbox: captured and not filed. Without pages that is "untagged", and it
// narrows by itself once pages exist rather than needing a second definition.
const pages = [
  {
    id: 'p1',
    docId: 'd1',
    blocks: [{ t: 'entry', id: 'link1' }, { t: 'columns', cols: [[{ t: 'entry', id: 'note1' }]] }],
  },
];
check('pages: entry ids are found inside columns too', [...placedIds(pages)].sort(), ['link1', 'note1']);
check('query: is:inbox is untagged and unplaced', ids('is:inbox', { placed: placedIds(pages) }), ['loose']);
check('query: is:orphan is just unplaced', ids('is:orphan', { placed: placedIds(pages) }), ['strat1', 'poe2', 'loose']);

check('toggle: adds a term', toggleTerm('kind:strategy', 'tag:legion'), 'kind:strategy tag:legion');
check('toggle: and takes the same one away', toggleTerm('kind:strategy tag:legion', 'tag:legion'), 'kind:strategy');

// --- measurements -------------------------------------------------------------
// The whole reason one of the source documents is a separate spreadsheet of
// screenshots: numbers in a cell cannot be divided by an hour.

const { runTotals, perHourLabel, div, duration, runsLabel } = metrics;
check('runs: nothing measured is not zero divines an hour, it is nothing', perHourLabel(runTotals([])), '');
check(
  'runs: net over hours',
  runTotals([{ id: 'a', at: 0, minutes: 60, investDiv: 2, revenueDiv: 14 }]).perHour,
  12,
);
check(
  'runs: several runs pool, so a lucky ten minutes cannot outvote two hours',
  runTotals([
    { id: 'a', at: 0, minutes: 10, investDiv: 0, revenueDiv: 10 },
    { id: 'b', at: 0, minutes: 120, investDiv: 0, revenueDiv: 20 },
  ]).perHour,
  (30 * 60) / 130,
);
// Past ten divines an hour the tenth is noise; below it, it is the difference
// between a strategy worth running and one that is not.
check(
  'runs: a small rate keeps its tenth',
  perHourLabel(runTotals([{ id: 'a', at: 0, minutes: 60, investDiv: 0, revenueDiv: 4.44 }])),
  '4.4 div/h',
);
check(
  'runs: a large one does not',
  perHourLabel(runTotals([{ id: 'a', at: 0, minutes: 60, investDiv: 0, revenueDiv: 12.44 }])),
  '12 div/h',
);

// --- blocks on a page ---------------------------------------------------------
// Dragging is the one interaction where a mistake loses work rather than just
// looking wrong: a drop that quietly drops what it was carrying is
// indistinguishable from a page that ate your notes.

const { blockAt, insertBlock, moveBlock, nudgeBlock, removeBlock, updateBlock } = blocks;

const e = (id) => ({ t: 'entry', id });
const sheet = [e('a'), e('b'), { t: 'columns', cols: [[e('c')], [e('d'), e('e')]] }];
const flat = (list) =>
  list
    .map((b) => (b.t === 'columns' ? `[${b.cols.map((c) => flat(c)).join('|')}]` : (b.id ?? b.t)))
    .join(',');

check('blocks: read a top-level path', blockAt(sheet, [1]).id, 'b');
check('blocks: read into a column', blockAt(sheet, [2, 1, 0]).id, 'd');
check('blocks: a path into a block that is not columns leads nowhere', blockAt(sheet, [0, 0, 0]), null);

check('blocks: insert at the top', flat(insertBlock(sheet, [0], e('z'))), 'z,a,b,[c|d,e]');
check('blocks: insert into a column', flat(insertBlock(sheet, [2, 0, 1], e('z'))), 'a,b,[c,z|d,e]');
check('blocks: remove', flat(removeBlock(sheet, [1])), 'a,[c|d,e]');
check('blocks: remove takes a columns block with its contents', flat(removeBlock(sheet, [2])), 'a,b');
check('blocks: update replaces in place', flat(updateBlock(sheet, [1], e('B'))), 'a,B,[c|d,e]');

// Taking the block out before putting it back is what makes a downward move
// land one short, so the index is adjusted rather than left as an off-by-one.
check('blocks: move down lands where it was dropped', flat(moveBlock(sheet, [0], [2])), 'b,a,[c|d,e]');
check('blocks: move up', flat(moveBlock(sheet, [1], [0])), 'b,a,[c|d,e]');
check('blocks: move from one column to the other', flat(moveBlock(sheet, [2, 0, 0], [2, 1, 0])), 'a,b,[|c,d,e]');
check('blocks: move out of a column onto the sheet', flat(moveBlock(sheet, [2, 1, 1], [0])), 'e,a,b,[c|d]');
check('blocks: a columns block cannot be dropped inside itself', flat(moveBlock(sheet, [2], [2, 0, 0])), flat(sheet));
check('blocks: a path that leads nowhere changes nothing', flat(moveBlock(sheet, [9], [0])), flat(sheet));

check('blocks: nudge down', flat(nudgeBlock(sheet, [0], 1)), 'b,a,[c|d,e]');
check('blocks: nudge up', flat(nudgeBlock(sheet, [1], -1)), 'b,a,[c|d,e]');
check('blocks: nudge past the end does nothing', flat(nudgeBlock(sheet, [2], 1)), flat(sheet));
check('blocks: nudge inside a column', flat(nudgeBlock(sheet, [2, 1, 0], 1)), 'a,b,[c|e,d]');
check('blocks: the page it was given is never touched', flat(sheet), 'a,b,[c|d,e]');

// --- what a paste turns into ---------------------------------------------------
// Our own codes and links are the point of the whole feature: a card that can
// say what a tree costs, against a spreadsheet where the atlas is an imgur
// screenshot nobody can open.

check(
  'capture: our own atlas link becomes a tree, not a link',
  captureOne('Cloister: https://poe-utils.example/atlas?c=AT3:AQKKApndluC4YRIx'),
  {
    kind: 'atlas',
    title: 'Cloister',
    data: { k: 'atlas', src: { code: 'AT3:AQKKApndluC4YRIx' } },
  },
);
check(
  'capture: and our own strategy link',
  captureOne('https://poe-utils.example/strategy?s=ST1:AQKKApndluC4YRIx').data,
  { k: 'strategy', src: { code: 'ST1:AQKKApndluC4YRIx' } },
);
check(
  'capture: a bare code pasted out of the tool next door',
  captureOne('день 4 легион: AT3:AQKKApndluC4YRIx'),
  { kind: 'atlas', title: 'день 4 легион', data: { k: 'atlas', src: { code: 'AT3:AQKKApndluC4YRIx' } } },
);
check(
  'capture: somebody else\'s tree is still a tree',
  captureOne('Starter Atlas (47 Points): https://poeplanner.com/a/669h'),
  {
    kind: 'atlas',
    title: 'Starter Atlas (47 Points)',
    data: { k: 'atlas', src: { url: 'https://poeplanner.com/a/669h' } },
  },
);
// A bare code holds no URL, and "does this paste contain a link" is not the
// same question as "was anything recognised" — the first one turned pasted
// share codes into notes.
check(
  'capture: a pasted code survives the whole paste, not just captureOne',
  grab('Легіон висп немезис: ST1:AQACKgEsAQA').map((item) => item.kind + ':' + item.title),
  ['strategy:Легіон висп немезис'],
);
check(
  'capture: a paste with nothing in it is still one note',
  grab('день4\nбегал легион\nпрофит 14 в час').length,
  1,
);

check(
  'capture: a short link is left alone, because the slug means nothing here',
  captureOne('https://poe-utils.example/s/k7mfrp2q').kind,
  'link',
);

// --- what a card can say -------------------------------------------------------

const { completeness, subtitleOf, typeOf, urlOf } = format;

const strategyEntry = (src, extra = {}) => ({
  ...newEntry('strategy', 'Cloister', { k: 'strategy', src }),
  ...extra,
});

check(
  'card: an atlas that is only a screenshot says so',
  completeness(newEntry('atlas', 'x', { k: 'atlas', src: { imageUrl: 'https://imgur.com/a/x' } })).map(
    (mark) => `${mark.label}:${mark.on ? 1 : 0}`,
  ),
  ['our tree code:0', 'a link out:0', 'a picture:1', 'notes:0'],
);
check(
  'card: scarabs written as a sentence are not scarabs a search can find',
  completeness(strategyEntry({ picksText: '5x Cloister' })).find((m) => m.label.startsWith('scarabs'))
    .on,
  false,
);
check(
  'card: scarabs picked from the catalogue are',
  completeness(strategyEntry({ picks: [{ code: 1, count: 5 }] })).find((m) =>
    m.label.startsWith('scarabs'),
  ).on,
  true,
);
// A strategy code exists as soon as one is saved, whether or not a tree was
// ever attached, so the code is no evidence of a tree — what was read off the
// tree is.
check(
  'card: a saved strategy with no tree does not claim one',
  completeness(strategyEntry({ code: 'ST1:AQACKgEsAQA', snapshot: { treeVersion: 1, slots: 2, picks: [], points: 0, keystones: [], issues: [] } })).find(
    (m) => m.label === 'a tree',
  ).on,
  false,
);
check(
  'card: one with a screenshot of somebody else\'s tree does',
  completeness(strategyEntry({ atlas: { imageUrl: 'https://imgur.com/a/x' } })).find(
    (m) => m.label === 'a tree',
  ).on,
  true,
);

check(
  'card: a strategy reads as slots, maps and what it paid',
  subtitleOf(
    strategyEntry(
      { picks: [{ code: 1, count: 5 }], map: '8-mod Dunes' },
      { league: '3.29', runs: [{ id: 'r', at: 0, minutes: 60, investDiv: 2, revenueDiv: 14 }] },
    ),
  ),
  'strategy · 5/5 slots · 8-mod Dunes · 3.29 · 12 div/h',
);
check(
  'card: an atlas points at the planner, not at its own picture',
  urlOf(newEntry('atlas', 'x', { k: 'atlas', src: { imageUrl: 'https://imgur.com/a/x' } })),
  '',
);
check(
  'card: a link is filed by what it is for, not by being a link',
  typeOf(newEntry('link', 'x', { k: 'link', url: 'https://pobb.in/x', host: 'pobb.in', role: 'pob' })),
  'pob',
);

// --- screenshots ---------------------------------------------------------------
// One of the three source documents is nothing but screenshots of a loot
// tracker, at 160-200 KB each, because a spreadsheet has nowhere to put the
// numbers in them. Keeping them as they arrive is what fills a browser's
// storage in one evening.

const { fitWithin, imageTitle, FULL_MAX, THUMB_MAX } = image;

check('image: a big screenshot comes down to the long side', fitWithin(2560, 1440, FULL_MAX), {
  w: 1600,
  h: 900,
});
check('image: a tall one is measured the same way', fitWithin(1440, 2560, FULL_MAX), {
  w: 900,
  h: 1600,
});
check('image: a small one is left alone rather than blown up', fitWithin(200, 120, FULL_MAX), {
  w: 200,
  h: 120,
});
check('image: thumbnails are cut to 320', fitWithin(1600, 900, THUMB_MAX), { w: 320, h: 180 });
check('image: nothing rounds to zero', fitWithin(2000, 3, THUMB_MAX), { w: 320, h: 1 });
check(
  'image: the file name is the title, without the extension',
  imageTitle('Screenshot_2026-08-11_233015.png'),
  'Screenshot 2026 08 11 233015',
);
check('image: something with no name still gets one', imageTitle('.png'), 'Screenshot');

// --- per map, and what a run reads as -------------------------------------------
// The captions in the screenshot document compare in two different units —
// "3.17 div investment" and ".29 div per map investment" — and only one of them
// can be set beside another strategy.

check(
  'runs: per map, when the maps were counted',
  (() => {
    const t = runTotals([{ id: 'a', at: 0, minutes: 55, maps: 10, investDiv: 3, revenueDiv: 16 }]);
    return [t.investPerMap.toFixed(2), t.netPerMap.toFixed(2)];
  })(),
  ['0.30', '1.30'],
);
check(
  'runs: and not at all when they were not',
  runTotals([{ id: 'a', at: 0, minutes: 55, investDiv: 3, revenueDiv: 16 }]).netPerMap,
  0,
);
check('runs: a duration reads in hours once it has one', duration(250), '4h 10m');
check('runs: and in minutes before that', duration(35), '35m');
check('runs: nothing measured has no duration', duration(0), '');
check('runs: divines keep their pennies while they matter', [div(0.29), div(2.4), div(16.4)], [
  '0.29 div',
  '2.4 div',
  '16 div',
]);
check(
  'runs: the line a card carries',
  runsLabel(
    runTotals([
      { id: 'a', at: 0, minutes: 55, maps: 10, investDiv: 3, revenueDiv: 16 },
      { id: 'b', at: 0, minutes: 60, maps: 11, investDiv: 2, revenueDiv: 14 },
    ]),
  ),
  '2 runs · 1h 55m · 21 maps · +25 div net · 13 div/h',
);
check('runs: nothing measured says nothing', runsLabel(runTotals([])), '');

console.log(
  failures ? `\n${failures} failed` : 'codex schema, capture, query, measurements, blocks, cards and images: all checks passed',
);
process.exit(failures ? 1 : 0);
