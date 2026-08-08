/**
 * Compiles the functions the way the platform does and loads each one.
 *
 * Type checking cannot see this class of failure. The functions are compiled
 * per file rather than bundled, and the emitted .js is loaded by Node from a
 * package.json with no `"type": "module"` — so an ESM emit type checks perfectly
 * and then dies on its own first import with "Cannot use import statement
 * outside a module", identically on every route, before any handler runs. That
 * shipped once. It is invisible until something actually requires the output.
 *
 * So this emits into node_modules/ (where the real dependencies resolve from),
 * requires every route, and checks each one exports the HTTP verbs it is
 * supposed to. A file that exports nothing callable is routed and then fails at
 * request time, which looks exactly like the same crash.
 *
 * Run: node scripts/api-load.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'node_modules', '.api-load');

/** Every route, and the verbs it has to answer to. */
const ROUTES = {
  'auth/register': ['POST'],
  'auth/login': ['POST'],
  'auth/logout': ['POST'],
  'auth/me': ['GET'],
  sync: ['GET', 'POST'],
  'links/index': ['POST'],
  'links/[slug]': ['GET'],
};

process.env.SESSION_SECRET ??= 'a-test-secret-that-is-comfortably-long-enough';

rmSync(out, { recursive: true, force: true });
try {
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      path.join(root, 'api', 'tsconfig.json'),
      '--noEmit',
      'false',
      '--outDir',
      out,
    ],
    { stdio: 'inherit' },
  );
} catch {
  console.error('\nthe functions do not compile');
  process.exit(1);
}

const require_ = createRequire(path.join(out, 'placeholder.js'));
let failures = 0;

for (const [route, verbs] of Object.entries(ROUTES)) {
  let loaded;
  try {
    loaded = require_(`./${route}.js`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${route}\n  ${String(err.message).split('\n')[0]}`);
    continue;
  }
  const found = Object.keys(loaded).filter((key) => typeof loaded[key] === 'function');
  const missing = verbs.filter((verb) => !found.includes(verb));
  if (missing.length) {
    failures++;
    console.error(`FAIL ${route}\n  exports ${found.join(', ') || 'nothing callable'}, wanted ${verbs.join(', ')}`);
  }
}

// One real call, to prove the chain from the route through the helpers holds
// together once loaded. `me` is the one that answers without a database.
if (!failures) {
  const { GET } = require_('./auth/me.js');
  const answer = await GET(new Request('https://example.test/api/auth/me'));
  const body = await answer.text();
  if (answer.status !== 200 || body !== '{"user":null}') {
    failures++;
    console.error(`FAIL auth/me does not answer an anonymous caller\n  got ${answer.status} ${body}`);
  }
}

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : 'api functions: every route compiles, loads and exports its verbs');
process.exit(failures ? 1 : 0);
