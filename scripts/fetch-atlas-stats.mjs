/**
 * Rebuilds public/assets/atlas/<version>/stat-rules.json — the table that lets
 * the Atlas summary say "Your Maps contain Niko" once the chance reaches 100%.
 *
 *   node scripts/fetch-atlas-stats.mjs 3.29
 *
 * Adding up the same modifier across the tree is arithmetic the tool can do on
 * its own. Knowing that *this* modifier reads differently once it reaches 100%
 * and *that* one simply keeps climbing is not — it is a fact about the game.
 * GGG's stat descriptions carry it: one stat has several wordings, each with a
 * range it applies over.
 *
 *   map_master_mission_niko_%_chance   1-99  "Your Maps have +{0}% chance to contain Niko"
 *                                      100+  "Your Maps contain Niko"
 *   map_beyond_rules_chance_%          1+    "{0}% chance for your Maps to attract Beyond Demons"
 *
 * The Beyond one has a single wording, which is why it just goes past 100%.
 * Guessing that rule from the English would get it wrong in both directions, so
 * it is looked up rather than inferred.
 *
 * The descriptions come from RePoE, an export of the game files:
 * https://github.com/lvlvllvlvllvlvl/RePoE — the atlas set alone is 12 MB and
 * covers every stat in the game, so it is filtered down here to the handful the
 * tree actually uses and where the wording can change at all. What ships is a
 * few kilobytes.
 *
 * A stat the export does not know (a mechanic newer than the export) is simply
 * absent from the file, and the summary falls back to adding the numbers up in
 * the wording the tree already gave it. That is the same answer for everything
 * except the threshold rewrite, so missing data costs precision, not function.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE =
  'https://raw.githubusercontent.com/lvlvllvlvllvlvl/RePoE/master/RePoE/data/stat_translations/atlas.json';

/**
 * How a stat's raw value becomes the number you read. Only the handlers that
 * scale a value are listed; anything else means the thresholds cannot be put
 * into the same units as the printed number, so the stat is skipped rather
 * than guessed at.
 */
const SCALE = {
  negate: -1,
  divide_by_two_0dp: 1 / 2,
  divide_by_four: 1 / 4,
  divide_by_ten_0dp: 1 / 10,
  divide_by_ten_1dp: 1 / 10,
  divide_by_ten_1dp_if_required: 1 / 10,
  divide_by_twenty_then_double_0dp: 1 / 10,
  divide_by_fifteen_0dp: 1 / 15,
  divide_by_fifty: 1 / 50,
  divide_by_one_hundred: 1 / 100,
  divide_by_one_hundred_2dp: 1 / 100,
  divide_by_one_hundred_2dp_if_required: 1 / 100,
  divide_by_one_hundred_and_negate: -1 / 100,
  divide_by_one_thousand: 1 / 1000,
  milliseconds_to_seconds: 1 / 1000,
  milliseconds_to_seconds_0dp: 1 / 1000,
  milliseconds_to_seconds_1dp: 1 / 1000,
  milliseconds_to_seconds_2dp: 1 / 1000,
  milliseconds_to_seconds_2dp_if_required: 1 / 1000,
  deciseconds_to_seconds: 1 / 10,
  per_minute_to_per_second: 1 / 60,
  per_minute_to_per_second_0dp: 1 / 60,
  per_minute_to_per_second_1dp: 1 / 60,
  per_minute_to_per_second_2dp: 1 / 60,
  per_minute_to_per_second_2dp_if_required: 1 / 60,
  multiply_by_four: 4,
  times_twenty: 20,
  times_one_point_five: 1.5,
  '30%_of_value': 0.3,
  '60%_of_value': 0.6,
};

// --- text -----------------------------------------------------------------

/**
 * `[ContainsAbyss|Abysses]` is a link with a target and a label; the tree ships
 * the raw markup and the game shows the label.
 */
function stripMarkup(text) {
  return text
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$2')
    .replace(/\[([^\]]+)\]/g, '$1');
}

/**
 * The tokenizer the runtime uses, kept deliberately dumb so both sides agree:
 * a run of digits is a number, and a sign is never part of one. That keeps
 * `Tier 1-15` two numbers around a dash rather than `1` and `-15`, which is
 * what it looks like on screen.
 */
const NUMBER = /\d+(?:\.\d+)?/g;

function template(text) {
  return text.replace(NUMBER, '#');
}

/** Character offsets of each number token, in order. */
function numberSpans(text) {
  const spans = [];
  for (const match of text.matchAll(NUMBER)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

const WHITESPACE = /\s+/g;

/** Matching ignores how a line happens to be wrapped; display does not. */
function collapse(text) {
  return text.replace(WHITESPACE, ' ');
}

function loose(text) {
  return collapse(text).trim();
}

// --- translations ---------------------------------------------------------

/**
 * A translation's `string` is a literal with `{0}` where the value goes, so it
 * becomes a regex directly: everything outside the placeholder has to match
 * character for character. Doing it this way rather than by blanking every
 * number is what keeps `Tier 1-15 Maps found have {0}% chance` from matching
 * anything that merely has three numbers in the same places.
 */
function variantMatcher(variant) {
  const placeholders = [...variant.string.matchAll(/\{(\d+)(?::[^}]*)?\}/g)];
  if (placeholders.length !== 1 || placeholders[0][1] !== '0') return null;
  const [before, after] = variant.string.split(placeholders[0][0]);
  // Collapsed but not trimmed: the space in "Maps have {0}%" belongs to the
  // pattern, and losing it makes every such wording fail to match.
  const escape = (s) => collapse(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    // The sign is part of the printed value, not of the surrounding text: a
    // `+#` format writes "+20" where a plain one writes "20".
    regex: new RegExp(`^${escape(before)}([+-]?\\d+(?:\\.\\d+)?)${escape(after)}$`),
    // Which number on the line is the value. Everything before the placeholder
    // is wording, so counting its numbers gives the position directly — and it
    // is counted the way the runtime counts, so the two agree.
    slot: numberSpans(loose(before)).length,
  };
}

/** True when the wording changes somewhere in the stat's range. */
function hasAlternateWording(entry) {
  const texts = new Set((entry.English ?? []).map((v) => v.string));
  return texts.size > 1;
}

function scaleOf(handlers) {
  let scale = 1;
  for (const handler of handlers ?? []) {
    if (!(handler in SCALE)) return null;
    scale *= SCALE[handler];
  }
  return scale;
}

/** A bound in raw stat units, expressed in the units the reader sees. */
function bound(value, scale) {
  if (value === null || value === undefined) return null;
  return value * scale;
}

// --- main -----------------------------------------------------------------

async function loadTranslations(source) {
  if (existsSync(source)) return JSON.parse(readFileSync(source, 'utf8'));
  const res = await fetch(source);
  if (!res.ok) throw new Error(`${source}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    console.error('usage: node scripts/fetch-atlas-stats.mjs <tree version>   e.g. 3.29');
    process.exit(1);
  }
  const dir = path.join(root, 'public', 'assets', 'atlas', version);
  const treeFile = path.join(dir, 'tree.json');
  if (!existsSync(treeFile)) throw new Error(`No tree data at ${treeFile}`);

  const tree = JSON.parse(readFileSync(treeFile, 'utf8'));
  const stats = new Set();
  for (const node of Object.values(tree.nodes)) {
    for (const stat of node.stats ?? []) {
      const text = stripMarkup(stat);
      if (text.trim()) stats.add(text);
    }
  }

  const translations = await loadTranslations(process.argv[3] ?? SOURCE);

  // Only single-id translations are usable: a line that renders two stats at
  // once cannot be traced back to one of them from the text alone, and adding
  // it up would mean adding up the wrong thing.
  const candidates = [];
  for (const entry of translations) {
    if (entry.hidden) continue;
    if ((entry.ids ?? []).length !== 1) continue;
    if (!hasAlternateWording(entry)) continue;
    const variants = [];
    let usable = true;
    for (const variant of entry.English ?? []) {
      const scale = scaleOf(variant.index_handlers?.[0]);
      if (scale === null || scale === 0) {
        usable = false;
        break;
      }
      variants.push({ variant, scale, matcher: variantMatcher(variant) });
    }
    if (!usable) continue;
    if (!variants.some((v) => v.matcher)) continue;
    candidates.push({ id: entry.ids[0], variants });
  }

  const rules = new Map();
  const matchedStats = new Map();

  for (const stat of stats) {
    const text = loose(stat);
    for (const candidate of candidates) {
      const base = candidate.variants.find((v) => v.matcher && v.matcher.regex.test(text));
      if (!base) continue;

      // The first wording found for a stat sets the units the total is kept in.
      // Another wording of the same stat can be the same number the other way
      // round — "25% less Damage" and "20% more Damage" are one stat at -25 and
      // +20 — so each is recorded with what it has to be multiplied by to join
      // the running total rather than fight it.
      const rule = rules.get(candidate.id) ?? {
        id: candidate.id,
        match: [],
        baseScale: base.scale,
        variants: candidate.variants.map(({ variant, scale }) => {
          // Thresholds in the units the number is printed in, so the runtime
          // compares them against the sum it just worked out.
          const a = bound(variant.condition?.[0]?.min, base.scale);
          const b = bound(variant.condition?.[0]?.max, base.scale);
          // Reading a stat backwards turns its range around too: "1 and up"
          // becomes "-1 and down", open end and all. Swapping only when both
          // ends are set would leave a one-sided range pointing the wrong way,
          // and every "faster"/"slower" pair is one-sided at both ends.
          const [min, max] = base.scale < 0 ? [b, a] : [a, b];
          return {
            ...(min !== null ? { min } : {}),
            ...(max !== null ? { max } : {}),
            // A wording of its own may scale differently — "reduced" is the
            // same stat negated — so the value is converted on the way out.
            ...(scale !== base.scale ? { factor: scale / base.scale } : {}),
            ...(variant.format?.[0] === '+#' ? { sign: true } : {}),
            ...(variant.format?.[0] === 'ignore' ? { drop: true } : {}),
            text: variant.string,
          };
        }),
      };
      const key = template(stat);
      if (!rule.match.some((m) => m.text === key)) {
        const factor = rule.baseScale / base.scale;
        rule.match.push({
          text: key,
          slot: base.matcher.slot,
          ...(factor !== 1 ? { factor } : {}),
        });
      }
      rules.set(candidate.id, rule);
      matchedStats.set(stat, candidate.id);
      break;
    }
  }

  // baseScale was only needed while the wordings were being collected.
  const out = [...rules.values()]
    .map(({ baseScale, ...rule }) => rule)
    .sort((a, b) => a.id.localeCompare(b.id));
  const outFile = path.join(dir, 'stat-rules.json');
  writeFileSync(outFile, `${JSON.stringify({ version, source: SOURCE, rules: out }, null, 1)}\n`);

  const guaranteed = out.filter((r) => r.variants.some((v) => v.drop)).length;
  console.log(
    `${outFile}: ${out.length} rules over ${matchedStats.size} of ${stats.size} tree modifiers ` +
      `(${guaranteed} of them rewrite once the value is high enough)`,
  );
}

await main();
