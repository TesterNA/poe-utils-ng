/**
 * Checks the Atlas summary against the real tree and the real rule file.
 *
 * The summary's job is to say something true about a hundred nodes at once, so
 * what is checked is that nothing is lost or invented: every modifier line on
 * every allocated node lands in exactly one bucket, the numbers that come out
 * are the numbers that went in, and the wording only changes where GGG's stat
 * descriptions say it changes.
 *
 * Run: node scripts/atlas-summary.mjs
 */
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'node_modules', '.summary-test');
const VERSION = '3.29';

await mkdir(tmp, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/app/tools/atlas/summary.ts')],
  outfile: path.join(tmp, 'summary.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'warning',
});
await build({
  entryPoints: [path.join(root, 'src/app/tools/atlas/tree-loader.ts')],
  outfile: path.join(tmp, 'tree-loader.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'warning',
});

const { StatIndex, summarise, statTemplate, stripMarkup } = await import(
  pathToFileURL(path.join(tmp, 'summary.mjs')).href
);
const { buildTree } = await import(pathToFileURL(path.join(tmp, 'tree-loader.mjs')).href);

const assets = path.join(root, 'public/assets/atlas', VERSION);
const tree = buildTree(JSON.parse(await readFile(path.join(assets, 'tree.json'), 'utf8')));
const ruleFile = JSON.parse(await readFile(path.join(assets, 'stat-rules.json'), 'utf8'));
const index = new StatIndex(tree, ruleFile.rules);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
}

const NUMBER = /\d+(?:\.\d+)?/g;
const modifierKinds = new Set(['normal', 'notable', 'keystone']);
const byId = (id) => tree.byId.get(String(id));

// --- 1 · nothing is dropped ---------------------------------------------------
// Every modifier line of every allocated node has to be represented. Keystones
// are shown whole rather than summed, so they are counted on their own side.

const everything = tree.nodes.filter((n) => n.allocatable).map((n) => n.idx);
const whole = summarise(tree, index, everything);

let expectedLines = 0;
let expectedKeystones = 0;
for (const idx of everything) {
  const node = tree.nodes[idx];
  if (!modifierKinds.has(node.kind)) continue;
  if (node.kind === 'keystone') {
    expectedKeystones++;
    continue;
  }
  expectedLines += node.stats.filter((s) => s.trim()).length;
}
check('every modifier line is accounted for', whole.sourceLines === expectedLines,
  `${whole.sourceLines} summarised, ${expectedLines} on the tree`);
check('every keystone is listed', whole.keystones.length === expectedKeystones,
  `${whole.keystones.length} listed, ${expectedKeystones} allocated`);
check('the whole tree collapses to far fewer lines',
  whole.groups.reduce((n, g) => n + g.lines.length, 0) < expectedLines / 2);
check('node counts match the tree',
  whole.counts.notable === tree.nodes.filter((n) => n.kind === 'notable').length &&
    whole.counts.keystone === tree.nodes.filter((n) => n.kind === 'keystone').length);

// --- 2 · the arithmetic ------------------------------------------------------
// A wording used by many nodes must come out as the total, not as one of them.

function sumOf(template, slot) {
  let total = 0;
  let nodes = 0;
  for (const node of tree.nodes) {
    if (!modifierKinds.has(node.kind)) continue;
    for (const stat of node.stats) {
      if (statTemplate(stat) !== template) continue;
      total += Number((stripMarkup(stat).match(NUMBER) ?? [])[slot]);
      nodes++;
    }
  }
  return { total, nodes };
}

const scarabs = '#% increased Scarabs found in your Maps';
const scarabSum = sumOf(scarabs, 0);
const scarabLine = whole.groups
  .flatMap((g) => g.lines)
  .find((l) => l.text.endsWith('increased Scarabs found in your Maps'));
check('a repeated modifier is added up', scarabLine?.text === `${scarabSum.total}% increased Scarabs found in your Maps`,
  `got ${JSON.stringify(scarabLine?.text)}, expected ${scarabSum.total}% over ${scarabSum.nodes} nodes`);

// "Tier 1-15 Maps found have 5% chance to become 1 tier higher" — three numbers
// and only the middle one is yours. The other two are the sentence.
const tierTemplate = 'Tier #-# Maps found have #% chance to become # tier higher';
const tierSum = sumOf(tierTemplate, 2);
const tierLine = whole.groups.flatMap((g) => g.lines).find((l) => /^Tier 1-15 Maps found/.test(l.text));
check('only the varying number is summed',
  tierLine?.text === 'Tier 1-15 Maps found are 1 tier higher' || tierSum.total < 100,
  `got ${JSON.stringify(tierLine?.text)} for a total of ${tierSum.total}`);

// --- 3 · the threshold rewrite ------------------------------------------------
// Reaching 100% changes the wording where GGG wrote a second one, and nowhere
// else. Both halves matter: rewriting the Beyond line would be just as wrong as
// failing to rewrite the Niko one.

function lineFor(nodeIds, test) {
  const idxs = nodeIds.map((id) => byId(id)?.idx).filter((i) => i !== undefined);
  const result = summarise(tree, index, idxs);
  return result.groups.flatMap((g) => g.lines).find((l) => test(l.text));
}

function nodesGranting(match) {
  return tree.nodes
    .filter((n) => modifierKinds.has(n.kind) && n.stats.some((s) => statTemplate(s) === match))
    .map((n) => n.id);
}

const nikoTemplate = 'Your Maps have +#% chance to contain Niko';
const nikoNodes = nodesGranting(nikoTemplate);
check('the tree still has the Niko chance nodes', nikoNodes.length > 0);

// One node on its own is under the threshold and keeps the percentage.
const nikoOne = lineFor(nikoNodes.slice(0, 1), (t) => t.includes('Niko'));
check('below 100% the chance is written as a chance', /^Your Maps have \+\d+% chance to contain Niko$/.test(nikoOne?.text ?? ''),
  `got ${JSON.stringify(nikoOne?.text)}`);

// All of them together clear it, and the modifier becomes a statement.
const nikoAll = lineFor(nikoNodes, (t) => t.includes('Niko'));
const nikoTotal = sumOf(nikoTemplate, 0).total;
check('at 100% the chance becomes a certainty',
  nikoTotal < 100 || nikoAll?.text === 'Your Maps contain Niko',
  `got ${JSON.stringify(nikoAll?.text)} for a total of ${nikoTotal}%`);

const beyondTemplate = '#% chance for your Maps to attract Beyond Demons';
const beyondNodes = nodesGranting(beyondTemplate);
const beyondTotal = sumOf(beyondTemplate, 0).total;
const beyondAll = lineFor(beyondNodes, (t) => t.includes('Beyond Demons'));
check('a modifier with one wording just keeps climbing',
  beyondAll?.text === `${beyondTotal}% chance for your Maps to attract Beyond Demons`,
  `got ${JSON.stringify(beyondAll?.text)}, expected ${beyondTotal}%`);
check('and it really does go past 100%', beyondTotal > 100, `total is ${beyondTotal}%`);

// --- 4 · rules that are not thresholds ---------------------------------------
// The same mechanism reads singular and plural, which is the cheapest possible
// proof that the rule lookup is not hardcoded to the number 100.

const beasts = nodesGranting(
  'Your Maps that contain capturable Beasts contain # additional Yellow Beast',
);
check('the tree still has two of the extra-beast nodes', beasts.length >= 2, `found ${beasts.length}`);
const oneBeast = lineFor(beasts.slice(0, 1), (t) => t.includes('Yellow Beast'));
const twoBeasts = lineFor(beasts.slice(0, 2), (t) => t.includes('Yellow Beast'));
check('one of a thing reads as singular', oneBeast?.text.endsWith('1 additional Yellow Beast'),
  `got ${JSON.stringify(oneBeast?.text)}`);
check('two of a thing reads as plural', twoBeasts?.text.endsWith('2 additional Yellow Beasts'),
  `got ${JSON.stringify(twoBeasts?.text)}`);

// --- 5 · opposite wordings of one stat ---------------------------------------
// "25% faster" and "25% slower" are one stat at +25 and -25. Adding them as two
// positives would report a tree as half a second quicker than it is.

const faster = nodesGranting('Expedition Detonation Chains in your Maps travel #% faster');
const slower = nodesGranting('Expedition Detonation Chains in your Maps travel #% slower');
if (faster.length >= 2 && slower.length >= 1) {
  const chains = (t) => t.includes('Detonation Chains');
  check('one wording on its own reads as itself',
    lineFor(faster.slice(0, 1), chains)?.text.endsWith('travel 25% faster') &&
      lineFor(slower.slice(0, 1), chains)?.text.endsWith('travel 25% slower'));
  check('opposite wordings cancel',
    /travel 0% (faster|slower)$/.test(lineFor([faster[0], slower[0]], chains)?.text ?? ''),
    `got ${JSON.stringify(lineFor([faster[0], slower[0]], chains)?.text)}`);
  check('and the winner keeps its own wording',
    lineFor([faster[0], faster[1], slower[0]], chains)?.text.endsWith('travel 25% faster'),
    `got ${JSON.stringify(lineFor([faster[0], faster[1], slower[0]], chains)?.text)}`);
}

// --- 6 · what the rules do not cover -----------------------------------------
// A mechanic newer than the stat export still has to be added up rather than
// listed one node at a time — this is where poeplanner gives up and prints the
// modifier with an "x7" beside it.

const unknown = tree.nodes.filter(
  (n) => modifierKinds.has(n.kind) && n.stats.some((s) => !index.infoFor(statTemplate(s))?.rule),
);
check('some modifiers are outside the rule file', unknown.length > 0);

const mercTemplate = 'Your Maps have +#% chance to be inhabited by a Mercenary';
const mercNodes = nodesGranting(mercTemplate);
if (mercNodes.length >= 2) {
  const mercTotal = sumOf(mercTemplate, 0).total;
  const merc = lineFor(mercNodes, (t) => t.includes('inhabited by a Mercenary'));
  check('an unknown modifier is still added up',
    merc?.text === `Your Maps have +${mercTotal}% chance to be inhabited by a Mercenary`,
    `got ${JSON.stringify(merc?.text)}, expected +${mercTotal}%`);
}

// --- 7 · mechanics ------------------------------------------------------------
// Every node belongs somewhere, and the cluster centres are what the canvas
// highlights, so they have to be findable by mechanic.

const homeless = tree.nodes.filter(
  (n) => modifierKinds.has(n.kind) && index.mechanicOf(n.idx) === 'Misc',
);
check('almost everything finds a mechanic', homeless.length < tree.nodes.length * 0.05,
  `${homeless.length} nodes fell through to Misc`);
check('mechanics have cluster centres', index.centresByMechanic.size > 20,
  `${index.centresByMechanic.size} mechanics have a mastery`);
for (const [name, centres] of index.centresByMechanic) {
  check(`every centre of ${name} is a mastery`, centres.every((i) => tree.nodes[i].kind === 'mastery'));
}
check('a mechanic with several clusters knows about all of them',
  [...index.centresByMechanic.values()].some((c) => c.length > 1));

// --- 8 · the empty tree -------------------------------------------------------
const nothing = summarise(tree, index, []);
check('an empty tree summarises to nothing',
  nothing.groups.length === 0 && nothing.keystones.length === 0 && nothing.sourceLines === 0);

// --- done ---------------------------------------------------------------------
const groups = whole.groups.map((g) => `${g.name} ${g.lines.length}`).join(', ');
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(
  `atlas summary: ${expectedLines} modifier lines collapse to ` +
    `${whole.groups.reduce((n, g) => n + g.lines.length, 0)} across ${whole.groups.length} mechanics, ` +
    `${ruleFile.rules.length} rules loaded, all checks passed`,
);
console.log(`  ${groups}`);
