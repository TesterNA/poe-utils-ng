/* What the tree on screen actually does, mechanic by mechanic.
 *
 * A hundred allocated nodes is a hundred lines of "3% increased Scarabs found
 * in your Maps", and reading them one at a time tells you nothing. The summary
 * adds up the ones that say the same thing and files each under the mechanic it
 * belongs to, which is the form you would write a strategy in.
 *
 * Two things make that harder than grouping strings:
 *
 * 1. Which number to add. "Tier 1-15 Maps found have 5% chance to become 1 tier
 *    higher" has three numbers and only the middle one is yours. The parameter
 *    is found from the data: across the whole tree, the number that differs
 *    between nodes with the same wording is the one that varies, and the rest
 *    are part of the sentence.
 *
 * 2. What the total reads as. Once a chance reaches 100% the game stops
 *    printing a percentage — "Your Maps have +100% chance to contain Niko"
 *    becomes "Your Maps contain Niko" — but only for the modifiers where GGG
 *    wrote a second wording. "chance for your Maps to attract Beyond Demons"
 *    has one wording and simply climbs past 100%. That is a fact about the
 *    game, not something to infer from the English, so it is looked up in
 *    stat-rules.json, generated from GGG's own stat descriptions by
 *    scripts/fetch-atlas-stats.mjs.
 *
 * Anything the rules do not cover — a mechanic newer than the export — still
 * gets added up, in the wording the tree already gave it. That is the same
 * answer minus the rewrite, which beats giving up and listing the modifier
 * seven times over.
 */
import type { Tree, TreeNode } from './tree-types';

// ---------------------------------------------------------------- rules ----

export interface RuleVariant {
  /** Bounds are in the units the number is printed in, and inclusive. */
  min?: number;
  max?: number;
  /** Multiplier from the base wording's units to this one's. */
  factor?: number;
  /** The value is written with an explicit sign. */
  sign?: boolean;
  /** The value is not written at all — this is the "it just happens" wording. */
  drop?: boolean;
  text: string;
}

/** One wording of a stat, as it appears in the tree. */
export interface RuleMatch {
  /** The template, in this file's tokenisation. */
  text: string;
  /** Which number on the line is the value. */
  slot: number;
  /**
   * What that number has to be multiplied by to join the stat's running total.
   * "25% less Damage" and "20% more Damage" are one stat at -25 and +20, so one
   * of the two wordings counts backwards.
   */
  factor?: number;
}

export interface StatRule {
  id: string;
  match: RuleMatch[];
  variants: RuleVariant[];
}

export interface StatRuleFile {
  version: string;
  source: string;
  rules: StatRule[];
}

// ------------------------------------------------------------- tokenising --

/**
 * Deliberately dumb, and matched character for character by the generator: a
 * run of digits is a number and a sign is never part of one. That keeps
 * `Tier 1-15` two numbers around a dash, which is how it reads, rather than
 * `1` and `-15`, which is not.
 */
const NUMBER = /\d+(?:\.\d+)?/g;

/** `[ContainsAbyss|Abysses]` is a link with a target and a label. */
export function stripMarkup(text: string): string {
  return text.replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$2').replace(/\[([^\]]+)\]/g, '$1');
}

export function statTemplate(text: string): string {
  return stripMarkup(text).replace(NUMBER, '#');
}

function statNumbers(text: string): number[] {
  return (stripMarkup(text).match(NUMBER) ?? []).map(Number);
}

/**
 * Puts values back into a template, one per `#`, in order. A sign already in
 * the wording is dropped when the total went the other way, so a run of
 * "+10% chance" that nets out negative reads "-5%" rather than "+-5%".
 */
function fill(template: string, values: readonly number[]): string {
  let i = 0;
  return template.replace(/(\+?)#/g, (_, plus: string) => {
    const value = values[i++] ?? 0;
    return `${value < 0 ? '' : plus}${format(value)}`;
  });
}

/** Totals of whole numbers stay whole; a tenth of a percent stays a tenth. */
function format(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// ------------------------------------------------------------ mechanics ----

/**
 * Keywords for the nodes that sit in a wheel with no mastery at its centre —
 * the generic Scarab, Map and item-quantity clusters, and the keystones. First
 * match wins, so the specific mechanics come before the catch-alls. The names
 * are the ones the masteries use, so both routes land in the same section.
 */
const KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['The Searing Exarch', ['Searing Exarch']],
  ['The Eater of Worlds', ['Eater of Worlds']],
  ['The Shaper and Elder', ['Shaper', 'Elder']],
  ['Conquerors', ['Conqueror', 'Sirus']],
  ['Map Bosses', ['Maven', 'Map Boss', 'Atlas Bosses', 'Atlas Boss']],
  ['Abyss', ['Abyss', 'Pit']],
  ['Breach', ['Breach', 'Ailith']],
  ['Legion', ['Legion', 'Timeless Splinter']],
  ['Ritual', ['Ritual', 'Favour']],
  ['Harvest', ['Harvest', 'Sacred Grove', 'Plant']],
  ['Blight', ['Blight', 'Cassia', 'Oil']],
  ['Ultimatum', ['Ultimatum']],
  ['Delirium', ['Delirium', 'Delirious', 'Simulacrum']],
  ['Mercenaries', ['Mercenar', 'Trarthan', 'Rucksack']],
  ['Settlers of Kalguur', ['Ore Deposit', 'Kalguuran']],
  ['Heist', ['Heist', 'Smuggler', "Rogue's Marker", 'Contract', 'Blueprint']],
  ['Vaal Side Areas', ['Vaal Side Area']],
  ['Torment', ['Torment', 'Possessed']],
  ['Divination Cards', ['Divination Card']],
  ['Rogue Exiles', ['Rogue Exile', 'Anarchy']],
  ['Strongboxes', ['Strongbox', 'Ambush']],
  ['Shrines', ['Shrine', 'Domination']],
  ['Essence', ['Essence', 'Imprisoned']],
  ['Beyond', ['Beyond']],
  ['Incursion', ['Incursion', 'Alva', 'Architect']],
  ['Delve', ['Delve', 'Niko', 'Sulphite']],
  ['Betrayal', ['Betrayal', 'Syndicate', 'Jun']],
  ['Bestiary', ['Bestiary', 'Einhar', 'Beast']],
  ['Expedition', ['Expedition', 'Runic', 'Logbook', 'Artifact']],
  ['Synthesis', ['Synthesis', 'Synthesised']],
  ['Atlas Memories', ['Memory', 'Memories']],
  ['Scarabs', ['Scarab']],
  ['Maps', ['Map', 'Quantity of Items', 'Rarity of Items', 'Pack Size']],
];

/** Sections come out in this order; anything unlisted lands before Misc. */
const ORDER: readonly string[] = [
  'Maps',
  'Map Bosses',
  'Scarabs',
  'The Searing Exarch',
  'The Eater of Worlds',
  'The Shaper and Elder',
  'Conquerors',
  'Atlas Memories',
  'Settlers of Kalguur',
  'Mercenaries',
  'Expedition',
  'Ritual',
  'Heist',
  'Harvest',
  'Delirium',
  'Ultimatum',
  'Blight',
  'Legion',
  'Synthesis',
  'Betrayal',
  'Delve',
  'Incursion',
  'Bestiary',
  'Abyss',
  'Breach',
  'Essence',
  'Torment',
  'Beyond',
  'Strongboxes',
  'Rogue Exiles',
  'Shrines',
  'Divination Cards',
  'Vaal Side Areas',
  'Labyrinth',
  'Misc',
];

const MISC = 'Misc';

// ----------------------------------------------------------------- index ---

interface TemplateInfo {
  /** Which numbers on the line are values rather than wording. */
  slots: number[];
  rule: StatRule | null;
  /** Rule-backed wordings carry exactly one value; this is where it sits. */
  slot: number;
  factor: number;
}

const UNKNOWN: TemplateInfo = { slots: [], rule: null, slot: 0, factor: 1 };

/**
 * Everything about a tree that does not depend on what is allocated: which
 * numbers vary, which mechanic each node belongs to, which rule applies. Built
 * once when the tree loads.
 */
export class StatIndex {
  private readonly templates = new Map<string, TemplateInfo>();
  private readonly mechanics: string[];
  /** Cluster centres, by mechanic — the mastery icons in the middle of a wheel. */
  readonly centresByMechanic = new Map<string, number[]>();

  constructor(
    private readonly tree: Tree,
    rules: readonly StatRule[] = [],
  ) {
    const byTemplate = new Map<string, TemplateInfo>();
    for (const rule of rules) {
      for (const match of rule.match) {
        byTemplate.set(match.text, {
          rule,
          slots: [match.slot],
          slot: match.slot,
          factor: match.factor ?? 1,
        });
      }
    }

    // Every occurrence of each wording anywhere in the tree, which is far more
    // evidence about what varies than the allocated nodes alone would give.
    const seen = new Map<string, number[][]>();
    for (const node of tree.nodes) {
      if (!countsAsModifier(node)) continue;
      for (const stat of node.stats) {
        if (!stat.trim()) continue;
        const key = statTemplate(stat);
        const rows = seen.get(key);
        if (rows) rows.push(statNumbers(stat));
        else seen.set(key, [statNumbers(stat)]);
      }
    }

    for (const [key, rows] of seen) {
      this.templates.set(
        key,
        byTemplate.get(key) ?? { ...UNKNOWN, slots: parameterSlots(key, rows) },
      );
    }

    // A group's mastery names the mechanic for every node around it.
    const byGroup = new Map<number, string>();
    for (const node of tree.nodes) {
      if (node.kind !== 'mastery' || !node.name) continue;
      byGroup.set(node.group, node.name);
      const centres = this.centresByMechanic.get(node.name);
      if (centres) centres.push(node.idx);
      else this.centresByMechanic.set(node.name, [node.idx]);
    }

    this.mechanics = tree.nodes.map((node) => byGroup.get(node.group) ?? keywordMechanic(node));
  }

  mechanicOf(idx: number): string {
    return this.mechanics[idx] ?? MISC;
  }

  infoFor(template: string): TemplateInfo | undefined {
    return this.templates.get(template);
  }

  /** Every node belonging to a mechanic, cluster centres included. */
  nodesOfMechanic(name: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.mechanics.length; i++) if (this.mechanics[i] === name) out.push(i);
    return out;
  }
}

/**
 * A gateway's "Connects to Mortal Gateway" is a note about the tree's shape,
 * not something the tree grants; the centre and the free junction grant
 * nothing at all.
 */
function countsAsModifier(node: TreeNode): boolean {
  return node.kind === 'normal' || node.kind === 'notable' || node.kind === 'keystone';
}

function keywordMechanic(node: TreeNode): string {
  const text = `${node.name}\n${node.stats.join('\n')}`;
  for (const [name, words] of KEYWORDS) {
    for (const word of words) if (text.includes(word)) return name;
  }
  return MISC;
}

/**
 * Which numbers on a line are the value. A wording used by several nodes gives
 * it away — the number that differs between them is the one being handed out.
 * When every node happens to grant the same amount there is nothing to compare,
 * so it falls back to the numbers written as percentages, and finally to the
 * first one. Getting this wrong on a rule-backed wording is impossible; the
 * rules say outright which slot it is.
 */
function parameterSlots(template: string, rows: number[][]): number[] {
  const width = rows[0]?.length ?? 0;
  if (width <= 1) return width === 1 ? [0] : [];

  const varying: number[] = [];
  for (let i = 0; i < width; i++) {
    if (new Set(rows.map((row) => row[i])).size > 1) varying.push(i);
  }
  if (varying.length) return varying;

  const percent: number[] = [];
  let slot = 0;
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== '#') continue;
    if (template[i + 1] === '%') percent.push(slot);
    slot++;
  }
  return percent.length ? percent : [0];
}

// --------------------------------------------------------------- summary ---

export interface SummaryLine {
  text: string;
  /** Nodes that contributed, so hovering the line can light them up. */
  nodes: number[];
  /** True when GGG's stat descriptions backed the wording. */
  known: boolean;
}

export interface SummaryGroup {
  name: string;
  lines: SummaryLine[];
}

export interface KeystoneView {
  idx: number;
  name: string;
  stats: string[];
}

export interface Summary {
  counts: { normal: number; notable: number; keystone: number; wormhole: number };
  groups: SummaryGroup[];
  keystones: KeystoneView[];
  /** Number of modifier lines before they were added together. */
  sourceLines: number;
}

interface Bucket {
  /** The wording this stat was first met in; what a total is printed as. */
  template: string;
  rule: StatRule | null;
  /** Parameter positions within `template`. */
  slots: number[];
  /** Running totals, in `template`'s layout — literals stay where they were. */
  values: number[];
  nodes: number[];
  mechanics: Map<string, number>;
}

export function summarise(tree: Tree, index: StatIndex, allocated: Iterable<number>): Summary {
  const counts = { normal: 0, notable: 0, keystone: 0, wormhole: 0 };
  const buckets = new Map<string, Bucket>();
  const keystones: KeystoneView[] = [];
  let sourceLines = 0;

  for (const idx of allocated) {
    const node = tree.nodes[idx];
    if (!node) continue;
    if (Object.hasOwn(counts, node.kind)) counts[node.kind as keyof typeof counts]++;
    // Keystones are read whole — they change how maps play, and folding one
    // into a running total would bury it.
    if (node.kind === 'keystone') {
      keystones.push({ idx, name: node.name, stats: node.stats.map(stripMarkup) });
      continue;
    }
    if (!countsAsModifier(node)) continue;

    for (const stat of node.stats) {
      if (!stat.trim()) continue;
      sourceLines++;
      const template = statTemplate(stat);
      const info = index.infoFor(template) ?? UNKNOWN;
      // Wordings of one stat merge — "more" and "less" are the same number with
      // a sign — so a rule-backed line is keyed by the stat rather than by how
      // this particular node happens to word it.
      const key = info.rule ? `#${info.rule.id}` : template;
      const numbers = statNumbers(stat);
      let bucket = buckets.get(key);
      if (!bucket) {
        // Literals are kept as written; the values start from nothing and are
        // added below, this node included.
        const values = numbers.slice();
        for (const slot of info.slots) values[slot] = 0;
        bucket = {
          template,
          rule: info.rule,
          slots: info.slots,
          values,
          nodes: [],
          mechanics: new Map(),
        };
        buckets.set(key, bucket);
      }
      // A node wording the stat the other way round contributes through the
      // first wording's slot, negated if that is what it takes.
      if (info.rule) bucket.values[bucket.slots[0]] += (numbers[info.slot] ?? 0) * info.factor;
      else for (const slot of info.slots) bucket.values[slot] += numbers[slot] ?? 0;
      bucket.nodes.push(idx);
      const mechanic = index.mechanicOf(idx);
      bucket.mechanics.set(mechanic, (bucket.mechanics.get(mechanic) ?? 0) + 1);
    }
  }

  const grouped = new Map<string, SummaryLine[]>();
  for (const bucket of buckets.values()) {
    const mechanic = dominant(bucket.mechanics);
    const lines = grouped.get(mechanic) ?? [];
    lines.push({
      text: render(bucket),
      nodes: [...new Set(bucket.nodes)],
      known: bucket.rule !== null,
    });
    grouped.set(mechanic, lines);
  }

  const groups: SummaryGroup[] = [...grouped.entries()]
    .map(([name, lines]) => ({ name, lines }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

  return { counts, groups, keystones, sourceLines };
}

/** The mechanic most of a line's nodes belong to. */
function dominant(counts: Map<string, number>): string {
  let best = MISC;
  let bestCount = -1;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function rank(name: string): number {
  const at = ORDER.indexOf(name);
  return at < 0 ? ORDER.length - 1 : at;
}

function render(bucket: Bucket): string {
  if (bucket.rule) {
    const value = bucket.values[bucket.slots[0]] ?? 0;
    // The first wording whose range covers the total. GGG orders them so the
    // ordinary one comes first and the special cases carve pieces out of it.
    const variant = bucket.rule.variants.find(
      (v) => (v.min === undefined || value >= v.min) && (v.max === undefined || value <= v.max),
    );
    if (variant) {
      if (variant.drop) return variant.text;
      const shown = value * (variant.factor ?? 1);
      const sign = variant.sign && shown >= 0 ? '+' : '';
      return variant.text.replace(/\{0(?::[^}]*)?\}/g, `${sign}${format(shown)}`);
    }
    // A total that falls outside every range — nought, usually, where one
    // wording covers what is above it and another what is below.
  }
  return fill(bucket.template, bucket.values);
}
