/**
 * Checks the rules that decide what a signed-in library looks like after two
 * devices have both had a go at it.
 *
 * Sync is the one place in this project where losing data is easy and silent.
 * A merge that drops an entry looks exactly like a build you forgot to save,
 * and a merge that ignores a delete looks like a build that will not die — the
 * second is the one that actually happens, because absence cannot mean deletion
 * when the other device has simply never heard of the entry. Hence tombstones,
 * and hence this.
 *
 * Passwords and session tokens are checked here too. They are twenty lines of
 * node:crypto rather than a library, which is the right call for what they do
 * and exactly why they need a test: a signature check that accepts everything
 * fails open and nothing on screen would look wrong.
 *
 * Run: node scripts/sync-merge.mjs
 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'node_modules', '.sync-test');

process.env.SESSION_SECRET ??= 'a-test-secret-that-is-comfortably-long-enough';

await mkdir(tmp, { recursive: true });
async function load(name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({
    entryPoints: [path.join(root, 'api/_lib', `${name}.ts`)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['mongodb'],
    logLevel: 'warning',
  });
  return import(pathToFileURL(outfile).href);
}

const { mergeEntries, mergeTombstones, readEntries, readTombstones } = await load('merge');
const session = await load('session');

let failures = 0;
function check(what, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) return;
  failures++;
  console.error(`FAIL ${what}\n  got  ${a}\n  want ${b}`);
}

const entry = (id, name, savedAt, code = `AT3:${id}`) => ({ id, name, code, savedAt });
const names = (list) => list.map((e) => `${e.name}@${e.savedAt}`);

// --- what survives a merge ----------------------------------------------------

check(
  'an entry only one side has is kept',
  names(mergeEntries([entry('a', 'Harvest', 10)], [entry('b', 'Legion', 20)], {})),
  ['Harvest@10', 'Legion@20'],
);

check(
  'the later save of the same entry wins',
  mergeEntries([entry('a', 'Harvest', 10, 'AT3:new')], [entry('a', 'Harvest', 5, 'AT3:old')], {})[0].code,
  'AT3:new',
);

check(
  'the same name saved separately on two devices collapses to the newer',
  names(mergeEntries([entry('a', 'Harvest', 10)], [entry('b', 'harvest', 20)], {})),
  ['harvest@20'],
);

// --- deletion -----------------------------------------------------------------

check(
  'a delete beats an entry a stale device still holds',
  names(mergeEntries([], [entry('a', 'Harvest', 10)], { a: 20 })),
  [],
);

check(
  'saving after the delete beats the delete',
  names(mergeEntries([entry('a', 'Harvest', 30)], [], { a: 20 })),
  ['Harvest@30'],
);

check(
  're-saving the name under a new id comes back',
  names(mergeEntries([entry('b', 'Harvest', 30)], [], { a: 20 })),
  ['Harvest@30'],
);

check('the later of two deletes is the one kept', mergeTombstones({ a: 5 }, { a: 9 }), { a: 9 });
check('a delete the other side has not seen is kept', mergeTombstones({ a: 5 }, { b: 7 }), { a: 5, b: 7 });

{
  // Trimming keeps the recent ones: an old tombstone can only matter to a device
  // that has been away longer than every delete since.
  const many = {};
  for (let i = 0; i < 400; i++) many[`id${i}`] = i;
  const trimmed = mergeTombstones(many, {});
  check('tombstones are capped', Object.keys(trimmed).length, 300);
  check('the oldest are the ones dropped', trimmed['id0'], undefined);
  check('the newest are kept', trimmed['id399'], 399);
}

// --- what the endpoint refuses ------------------------------------------------

function refuses(what, run) {
  try {
    run();
    failures++;
    console.error(`FAIL ${what}\n  got  accepted`);
  } catch {
    /* expected */
  }
}

refuses('a list that is not a list', () => readEntries({ id: 'a' }, 'Builds'));
refuses('an entry with no code', () => readEntries([{ id: 'a', name: 'x' }], 'Builds'));
refuses('an entry with no id', () => readEntries([{ name: 'x', code: 'AT3:a' }], 'Builds'));
refuses('a code long enough to be an attack', () =>
  readEntries([{ id: 'a', name: 'x', code: 'A'.repeat(5000) }], 'Builds'),
);
refuses('more entries than an account can have', () =>
  readEntries(
    Array.from({ length: 501 }, (_, i) => entry(`id${i}`, 'x', 0)),
    'Builds',
  ),
);
check('a missing list is empty, not an error', readEntries(undefined, 'Builds'), []);
check('missing deletions are empty, not an error', readTombstones(undefined), {});

// --- passwords and sessions ---------------------------------------------------

const stored = await session.hashPassword('correct horse battery staple');
check('the right password verifies', await session.verifyPassword('correct horse battery staple', stored), true);
check('a wrong password does not', await session.verifyPassword('correct horse battery stapl', stored), false);
check('two hashes of one password differ', (await session.hashPassword('x')) === (await session.hashPassword('x')), false);
check('a hash of the wrong shape is refused, not crashed on', await session.verifyPassword('x', 'nonsense'), false);

const token = session.issueToken('507f1f77bcf86cd799439011', 'exile@example.com');
check('a token reads back', session.readSession(cookie(token))?.email, 'exile@example.com');
check('a token with a flipped payload is refused', session.readSession(cookie(tamper(token))), null);
check('a token with no signature is refused', session.readSession(cookie(token.split('.')[0])), null);
check('a token signed with another secret is refused', session.readSession(cookie(elsewhere())), null);
check('no cookie is nobody, not an error', session.readSession({ headers: { get: () => null } }), null);

/** Just enough of a Request for readSession, which only ever reads one header. */
function cookie(value) {
  return { headers: { get: (name) => (name === 'cookie' ? `poe_session=${value}` : null) } };
}

/** Rewrites the payload while keeping the original signature. */
function tamper(value) {
  const [payload, signature] = value.split('.');
  const claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claim.email = 'someone@else.com';
  return `${Buffer.from(JSON.stringify(claim)).toString('base64url')}.${signature}`;
}

/** A token that is well formed and signed by a different deployment. */
function elsewhere() {
  const was = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'a-completely-different-secret-of-ample-length';
  const other = session.issueToken('507f1f77bcf86cd799439011', 'exile@example.com');
  process.env.SESSION_SECRET = was;
  return other;
}

console.log(failures ? `\n${failures} failed` : 'sync merge, passwords and sessions: all checks passed');
process.exit(failures ? 1 : 0);
