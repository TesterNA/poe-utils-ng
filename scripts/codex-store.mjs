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
const outfile = path.join(tmp, 'codex-schema.mjs');
await build({
  entryPoints: [path.join(root, 'src/app/tools/codex/codex-schema.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'warning',
});
const schema = await import(pathToFileURL(outfile).href);
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

const ids = new Set(Array.from({ length: 2000 }, () => newId()));
check('ids: two thousand of them are two thousand', ids.size, 2000);

console.log(failures ? `\n${failures} failed` : 'codex schema, migration and bundles: all checks passed');
process.exit(failures ? 1 : 0);
