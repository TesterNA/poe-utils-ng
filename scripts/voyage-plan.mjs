/**
 * Checks the Voyage builder: the boards it believes in, and the plans it packs.
 *
 * Two claims are worth holding to account. The first is that the enumeration
 * in `voyage-rules.ts` is honest — it walks one board out of every eight by
 * skipping turns and mirrors, and it collapses boards that spend the same
 * Charts, so a plain unpruned walk is run here beside it and the two sets of
 * recipes have to match. The second is that the packing is right: every plan
 * it hands back has to be one the stash can actually pay for, and on stashes
 * small enough to brute force, its count has to be the best there is.
 *
 * Run: node scripts/voyage-plan.mjs [random stashes]
 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'node_modules', '.voyage-test');
const RANDOM_STASHES = Number(process.argv[2] ?? 40);

await mkdir(tmp, { recursive: true });
await build({
  entryPoints: [
    path.join(root, 'src/app/tools/voyage/voyage-rules.ts'),
    path.join(root, 'src/app/tools/voyage/voyage-solver.ts'),
  ],
  outdir: tmp,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'warning',
});

const rules = await import(pathToFileURL(path.join(tmp, 'voyage-rules.mjs')).href);
const solver = await import(pathToFileURL(path.join(tmp, 'voyage-solver.mjs')).href);
const { CELLS, SHAPES, isValidBoard, recipes, shapeOf, edgeDirections, countsKey } = rules;
const { planVoyages, shortfall } = solver;

let failures = 0;
const fail = (message) => {
  if (++failures <= 20) console.error('  ✗ ' + message);
};

// ── the recipes ────────────────────────────────────────────────────────────

const NORTH = 1;
const EAST = 2;
const SOUTH = 4;
const WEST = 8;
const OPPOSITE = { [NORTH]: SOUTH, [EAST]: WEST, [SOUTH]: NORTH, [WEST]: EAST };

const seams = [];
for (let cell = 0; cell < 9; cell++) {
  if (cell % 3 < 2) seams.push([cell, cell + 1, EAST]);
  if (cell < 6) seams.push([cell, cell + 3, SOUTH]);
}

/**
 * The same question asked the slow way: every seam set, no symmetry skipped,
 * every combination of cells walked to the end.
 */
function referenceRecipes(policy) {
  const found = new Set();

  for (let mask = 0; mask < 1 << seams.length; mask++) {
    const inward = new Array(9).fill(0);
    const links = Array.from({ length: 9 }, () => []);
    seams.forEach(([from, to, direction], index) => {
      if (((mask >> index) & 1) === 0) return;
      inward[from] |= direction;
      inward[to] |= OPPOSITE[direction];
      links[from].push(to);
      links[to].push(from);
    });

    if (policy === 'connected' && !reachesEverything(links)) continue;

    const choices = [];
    let dead = false;
    for (let cell = 0; cell < 9 && !dead; cell++) {
      const edges = edgeDirections(cell);
      const shapes = new Set();
      for (let extra = edges; ; extra = (extra - 1) & edges) {
        const shape = shapeOf(inward[cell] | extra);
        if (shape !== null) shapes.add(shape);
        if (extra === 0) break;
      }
      if (shapes.size === 0) dead = true;
      choices.push([...shapes]);
    }
    if (dead) continue;

    walk(
      choices,
      0,
      SHAPES.map(() => 0),
      found,
    );
  }

  return found;
}

function walk(choices, index, counts, found) {
  if (index === 9) {
    found.add(counts.join(','));
    return;
  }

  for (const shape of choices[index]) {
    counts[SHAPES.indexOf(shape)]++;
    walk(choices, index + 1, counts, found);
    counts[SHAPES.indexOf(shape)]--;
  }
}

function reachesEverything(links) {
  const seen = new Set([0]);
  const pending = [0];
  while (pending.length > 0) {
    for (const next of links[pending.pop()]) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }

  return seen.size === 9;
}

for (const policy of ['open', 'connected']) {
  const list = recipes(policy);
  const reference = referenceRecipes(policy);

  console.log(`${policy}: ${list.length} recipes (reference ${reference.size})`);

  if (list.length !== reference.size) {
    fail(`${policy}: enumerated ${list.length} recipes, the plain walk found ${reference.size}`);
  }
  for (const recipe of list) {
    if (!reference.has(recipe.counts.join(','))) {
      fail(`${policy}: ${recipe.counts.join(',')} is claimed but the plain walk never built it`);
    }
  }

  const keys = new Set();
  for (const recipe of list) {
    if (recipe.counts.reduce((total, count) => total + count, 0) !== CELLS) {
      fail(`${policy}: ${recipe.counts.join(',')} does not spend nine Charts`);
    }
    if (recipe.key !== countsKey(recipe.counts)) fail(`${policy}: key does not match its counts`);
    if (keys.has(recipe.key)) fail(`${policy}: ${recipe.counts.join(',')} is listed twice`);
    keys.add(recipe.key);

    if (!isValidBoard(recipe.board, policy)) {
      fail(`${policy}: the board proving ${recipe.counts.join(',')} is not valid`);
    }
    const spent = SHAPES.map(() => 0);
    for (const connections of recipe.board) spent[SHAPES.indexOf(shapeOf(connections))]++;
    if (spent.join(',') !== recipe.counts.join(',')) {
      fail(`${policy}: the board for ${recipe.counts.join(',')} spends ${spent.join(',')}`);
    }
  }
}

// what the two readings of the rule disagree about: three rows of Straights
// never meet, so they are nine Charts that fill a board but not one route
const nineStraight = (policy) =>
  recipes(policy).some((recipe) => recipe.counts.join(',') === '0,0,9,0,0');
if (!nineStraight('open')) fail('nine Straights should fill a board under the stated rule');
if (nineStraight('connected')) fail('nine Straights should not make one route');

// ── the packing ────────────────────────────────────────────────────────────

/** Every packing, walked to the end, for stashes small enough to allow it. */
function bestByBruteForce(stock, list) {
  const affordable = list.filter((recipe) =>
    recipe.counts.every((needed, shape) => needed <= stock[shape]),
  );
  let best = 0;

  const walkAll = (left, from, depth) => {
    if (depth > best) best = depth;
    for (let index = from; index < affordable.length; index++) {
      const recipe = affordable[index];
      if (!recipe.counts.every((needed, shape) => needed <= left[shape])) continue;
      walkAll(
        left.map((have, shape) => have - recipe.counts[shape]),
        index,
        depth + 1,
      );
    }
  };

  walkAll(stock, 0, 0);

  return best;
}

let seed = 20260819;
const random = (bound) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % bound;
};

for (const policy of ['open', 'connected']) {
  const list = recipes(policy);

  for (let round = 0; round < RANDOM_STASHES; round++) {
    // kept small: the brute force below has to finish
    const stock = SHAPES.map(() => random(8));
    const total = stock.reduce((sum, count) => sum + count, 0);
    const result = planVoyages(stock, list, { attempts: 6, budgetMs: 2000 });
    const label = `${policy} [${stock.join(',')}]`;

    if (result.voyages > Math.floor(total / 9)) {
      fail(`${label}: ${result.voyages} Voyages out of ${total} Charts`);
    }

    const expected = bestByBruteForce(stock, list);
    if (result.voyages !== expected) {
      fail(`${label}: planned ${result.voyages} Voyages, ${expected} were there to be had`);
    }
    if (result.proven && result.voyages !== Math.floor(total / 9)) {
      fail(`${label}: called proven without spending every Chart it could`);
    }

    const fingerprints = new Set();
    for (const plan of result.plans) {
      if (plan.voyages.length !== result.voyages) {
        fail(`${label}: a plan holds ${plan.voyages.length} Voyages, not ${result.voyages}`);
      }

      const spent = SHAPES.map(() => 0);
      for (const voyage of plan.voyages) {
        if (!isValidBoard(voyage.board, policy)) fail(`${label}: a planned board is not valid`);
        voyage.counts.forEach((count, shape) => (spent[shape] += count));
      }

      for (let shape = 0; shape < SHAPES.length; shape++) {
        if (spent[shape] > stock[shape]) {
          fail(`${label}: spends ${spent[shape]} ${SHAPES[shape]} out of ${stock[shape]}`);
        }
        if (plan.leftover[shape] !== stock[shape] - spent[shape]) {
          fail(`${label}: the leftovers do not add up for ${SHAPES[shape]}`);
        }
      }

      const fingerprint = plan.voyages
        .map((voyage) => voyage.counts.join(''))
        .sort()
        .join('|');
      if (fingerprints.has(fingerprint)) fail(`${label}: the same layout is offered twice`);
      fingerprints.add(fingerprint);

      const gap = shortfall(plan.leftover, list);
      if (gap !== null && gap.total === 0) fail(`${label}: a shortfall of nothing was reported`);
    }
  }
}

// a stash that is exactly one board, and a stash that is none
for (const policy of ['open', 'connected']) {
  const list = recipes(policy);
  const one = planVoyages([0, 0, 0, 0, 9], list, { attempts: 3 });
  if (one.voyages !== 1 || !one.proven) fail(`${policy}: nine Crossings should be one Voyage`);

  const none = planVoyages([1, 1, 1, 1, 1], list, { attempts: 3 });
  if (none.voyages !== 0) fail(`${policy}: five Charts cannot fill a board`);
  const gap = shortfall(none.plans[0].leftover, list);
  if (gap === null || gap.total !== 4) {
    fail(`${policy}: five Charts should be four short of a board, not ${gap?.total}`);
  }
}

console.log(failures === 0 ? '✓ voyage builder holds' : `✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
