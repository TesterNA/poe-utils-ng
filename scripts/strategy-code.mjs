/**
 * Checks the strategy share code, the rules it enforces, and the item data it
 * names.
 *
 * The code has to be exact for the same reason the atlas one does: it is the
 * only representation of a strategy, so whatever goes in has to come back item
 * for item. The interesting part is the atlas plan riding inside it — that is
 * copied through as raw bytes rather than re-encoded, so an old atlas code must
 * come out of a strategy exactly as it went in, format digit and all.
 *
 * The data check is the other half. Share codes name items by `code`, so a
 * duplicate or a renumbering would silently repoint every strategy ever
 * written; that is worth a test rather than a convention.
 *
 * Run: node scripts/strategy-code.mjs
 */
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'node_modules', '.strategy-test');

globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');

await mkdir(tmp, { recursive: true });
async function load(entry, name) {
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(tmp, name),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'warning',
  });
  return import(pathToFileURL(path.join(tmp, name)).href);
}

const { encodeStrategy, decodeStrategy, peekStrategy } = await load(
  'src/app/tools/strategy/strategy-code.ts',
  'strategy-code.mjs',
);
const { validate, addPick, removePick, slotsUsed } = await load(
  'src/app/tools/strategy/strategy-plan.ts',
  'strategy-plan.mjs',
);
const { compareVersions, unavailableReason } = await load(
  'src/app/tools/strategy/strategy-items.ts',
  'strategy-items.mjs',
);

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- the shipped data ---------------------------------------------------------

const dataFile = path.join(root, 'public/assets/strategy/items.json');
const data = JSON.parse(readFileSync(dataFile, 'utf8'));
const items = data.items;

const codes = new Set(items.map((i) => i.code));
const ids = new Set(items.map((i) => i.id));
check(`${items.length} items, every share code distinct`, codes.size === items.length);
check('every id distinct', ids.size === items.length);
check(
  'every item has a name, a group, a limit of at least one and a type',
  items.every(
    (i) =>
      i.name &&
      i.group &&
      Number.isInteger(i.limit) &&
      i.limit >= 1 &&
      (i.type === 'scarab' || i.type === 'allflame'),
  ),
);
const missingIcons = items.filter(
  (i) => i.icon && !existsSync(path.join(root, 'public/assets/strategy/icons', i.icon)),
);
check(
  'every named icon is actually there',
  missingIcons.length === 0,
  missingIcons.map((i) => i.icon).join(', '),
);
check(
  'nothing claims to be removed before it was added',
  items.every((i) => !i.since || !i.removedIn || compareVersions(i.since, i.removedIn) < 0),
);

// --- versions -----------------------------------------------------------------

check('3.29 sorts after 3.9, not before', compareVersions('3.29', '3.9') > 0);
check('equal versions compare equal', compareVersions('3.29', '3.29') === 0);

const live = { code: 1, name: 'Live', limit: 5, removedIn: null };
const gone = { code: 2, name: 'Gone', limit: 2, removedIn: '3.30' };
const future = { code: 3, name: 'Future', limit: 2, since: '3.31', removedIn: null };
check('an item still in the game is available', unavailableReason(live, '3.29') === null);
check('an item is available in the version before it was removed', unavailableReason(gone, '3.29') === null);
check('an item is gone in the version that removed it', unavailableReason(gone, '3.30') === 'removed in 3.30');
check('and in every version after', unavailableReason(gone, '3.31') === 'removed in 3.30');
check('an item added later is not available yet', unavailableReason(future, '3.29') === 'added in 3.31');
check('and is once its version arrives', unavailableReason(future, '3.31') === null);

// --- the rules ----------------------------------------------------------------

const catalogue = { byCode: new Map([live, gone, future].map((i) => [i.code, i])) };
const rules = (picks, version = '3.29', blockers = []) =>
  validate({ picks, catalogue, gameVersion: version, blockers }).map((issue) => issue.text);

check('five items is fine', rules([{ code: 1, count: 3 }, { code: 2, count: 2 }]).length === 0);
check(
  'six is not',
  rules([{ code: 1, count: 4 }, { code: 2, count: 2 }]).some((t) => t.includes('takes 5')),
);
check(
  "past an item's own limit is refused even inside five slots",
  rules([{ code: 2, count: 3 }]).some((t) => t.includes('limited to 2')),
);
check(
  'an item the version does not have is refused',
  rules([{ code: 2, count: 1 }], '3.30').some((t) => t.includes('removed in 3.30')),
);
check(
  'Unwavering Vision stops everything',
  rules([{ code: 1, count: 1 }], '3.29', ['Unwavering Vision']).some((t) =>
    t.includes('cannot be modified by fragments'),
  ),
);
check(
  'but an empty device with it is not an error',
  rules([], '3.29', ['Unwavering Vision']).length === 0,
);
check(
  'an item this build has never heard of is called out, not ignored',
  rules([{ code: 999, count: 1 }]).some((t) => t.includes('#999')),
);

check('adding the same item twice stacks it', slotsUsed(addPick(addPick([], 7), 7)) === 2);
check('removing the last copy drops the entry', removePick(addPick([], 7), 7).length === 0);

// --- the code -----------------------------------------------------------------

function roundTrip(label, strategy) {
  const code = encodeStrategy(strategy);
  const back = decodeStrategy(code);
  const same =
    back.treeVersion === strategy.treeVersion &&
    back.treeCode === strategy.treeCode &&
    back.notes === strategy.notes &&
    back.picks.length === strategy.picks.length &&
    back.picks.every((p, i) => p.code === strategy.picks[i].code && p.count === strategy.picks[i].count);
  check(`${label} — ${code.length} chars`, same, JSON.stringify(back));
  return code;
}

roundTrip('empty strategy', { treeVersion: 1, treeCode: '', picks: [], notes: '' });
roundTrip('items only', {
  treeVersion: 1,
  treeCode: '',
  picks: [
    { code: 1, count: 3 },
    { code: 42, count: 2 },
  ],
  notes: '',
});
const full = roundTrip('a real one', {
  treeVersion: 1,
  treeCode: 'AT3:AQJGiRfAEMJEQhEg',
  picks: [
    { code: 12, count: 2 },
    { code: 118, count: 1 },
    { code: 3, count: 2 },
  ],
  notes: 'Run T16 strand, buy the scarabs at the start of the day.',
});
roundTrip('notes with an emoji and a newline', {
  treeVersion: 1,
  treeCode: '',
  picks: [],
  notes: 'делірій\nfirst\n💀',
});
roundTrip('an item code past one byte of varint', {
  treeVersion: 1,
  treeCode: '',
  picks: [{ code: 4000, count: 1 }],
  notes: '',
});

check(
  'an older atlas format comes back with its own digit, not the current one',
  decodeStrategy(
    encodeStrategy({ treeVersion: 1, treeCode: 'AT1:AQAAAAA', picks: [], notes: '' }),
  ).treeCode === 'AT1:AQAAAAA',
);
check(
  'a tree code that cannot be read is dropped rather than failing the whole code',
  decodeStrategy(encodeStrategy({ treeVersion: 1, treeCode: 'nonsense', picks: [], notes: '' }))
    .treeCode === '',
);
check('the tree version can be read without decoding', peekStrategy(full).treeVersion === 1);

const malformed = [
  '',
  'AT3:AQJGiRfAEMJEQhEg',
  'ST1:',
  'ST9:AQAA',
  'ST1:!!!!',
  'ST1:AQ',
  // claims one pick, then ends
  'ST1:AQABAQ',
];
let refused = 0;
for (const code of malformed) {
  try {
    decodeStrategy(code);
    console.log(`  accepted malformed input: ${JSON.stringify(code)}`);
  } catch {
    refused++;
  }
}
check(`refused ${refused} malformed inputs`, refused === malformed.length);

console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
process.exit(failures ? 1 : 0);
