/**
 * The search box, which is the whole point of not being a spreadsheet.
 *
 * A spreadsheet answers "is this string anywhere on this sheet". That is why
 * the documents this replaces are read by scrolling: everything about an entry
 * that is worth filtering on — the league, the mechanic, whether anyone ever
 * measured it — is either prose in a cell or a colour somebody remembers the
 * meaning of.
 *
 * So the query language is small and it is about the fields:
 *
 *   legion                  words, matched across everything readable
 *   "exact phrase"
 *   #legion  tag:legion     a tag
 *   -tag:dead               anything can be negated
 *   kind:strategy           link / note / atlas / strategy / build / ...
 *   role:filter             what a link is for
 *   stage:endgame           which loot filter
 *   league:3.29  game:poe2
 *   status:dead  diff:hard
 *   scarab:cloister         inside a strategy, by name
 *   node:"Wandering Path"   inside a tree, by keystone
 *   has:image has:runs has:code has:pob
 *   is:untagged is:orphan is:inbox is:pinned
 *   sort:updated|created|title|points|perhour
 *
 * Two rules that are not syntax:
 *
 * **A word with an unknown field in front of it is not an error.** `http://x`
 * has a colon in it, and so does half of what gets pasted here. Anything whose
 * field is not on the list above is searched for as text, colon and all.
 *
 * **Dead things stay out unless you ask.** A strategy that stopped working is
 * kept — "dead" is worth knowing — but it is not an answer to a question about
 * what to run tonight. Mention `status:` in any form and the query decides for
 * itself instead.
 */
import type { Entry, EntryKind, LinkRole, Page, Block } from './codex-types';
import { normaliseTag } from './codex-schema';
import { runTotals } from './codex-metrics';

export type SortKey = 'updated' | 'created' | 'title' | 'points' | 'perhour';

export interface QueryTerm {
  /** '' for a bare word or phrase */
  field: string;
  value: string;
  negated: boolean;
}

export interface Query {
  terms: QueryTerm[];
  sort: SortKey;
  /** the query said something about status, so it decides which ones show */
  mentionsStatus: boolean;
}

export interface QueryContext {
  /** entry ids that sit on some page — what `is:orphan` is the absence of */
  placed?: ReadonlySet<string>;
}

const FIELDS = new Set([
  'tag',
  'kind',
  'role',
  'stage',
  'league',
  'game',
  'status',
  'diff',
  'scarab',
  'node',
  'has',
  'is',
  'sort',
]);

const SORTS: SortKey[] = ['updated', 'created', 'title', 'points', 'perhour'];

const DIFFICULTY: Record<string, number> = { easy: 1, medium: 2, hard: 3, '1': 1, '2': 2, '3': 3 };

// --- parsing ------------------------------------------------------------------

/** Splits on spaces, except inside quotes — quotes are how a phrase holds one. */
function tokenise(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
    } else if (!quoted && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function unquote(value: string): string {
  return value.startsWith('"') ? value.replace(/^"|"$/g, '') : value;
}

export function parseQuery(input: string): Query {
  const query: Query = { terms: [], sort: 'updated', mentionsStatus: false };
  for (const token of tokenise(input)) {
    let rest = token;
    const negated = rest.startsWith('-') && rest.length > 1;
    if (negated) rest = rest.slice(1);

    if (rest.startsWith('#') && rest.length > 1) {
      query.terms.push({ field: 'tag', value: normaliseTag(rest), negated });
      continue;
    }

    const colon = rest.indexOf(':');
    const field = colon > 0 ? rest.slice(0, colon).toLowerCase() : '';
    if (field && FIELDS.has(field)) {
      const value = unquote(rest.slice(colon + 1)).toLowerCase();
      if (!value) continue;
      if (field === 'sort') {
        const sort = SORTS.find((key) => key === value);
        if (sort) query.sort = sort;
        continue;
      }
      if (field === 'status') query.mentionsStatus = true;
      query.terms.push({
        field,
        value: field === 'tag' ? normaliseTag(value) : value,
        negated,
      });
      continue;
    }

    // Not a field we know: a word, and it keeps whatever colon it came with.
    const value = unquote(rest).toLowerCase();
    if (value) query.terms.push({ field: '', value, negated });
  }
  return query;
}

// --- what an entry reads as ---------------------------------------------------

/**
 * Everything about an entry that a bare word should find, lower case.
 *
 * Scarab names come from the snapshot rather than the catalogue: the catalogue
 * is a fetch, the snapshot was taken when the strategy was saved, and a search
 * that only works after a download is a search that sometimes does not work.
 */
export function haystack(entry: Entry): string {
  const parts: string[] = [entry.title, entry.body, entry.tags.join(' ')];
  if (entry.league) parts.push(entry.league);
  if (entry.status) parts.push(entry.status);
  const data = entry.data;
  switch (data.k) {
    case 'link':
      parts.push(data.url, data.host, data.role ?? '', data.filter?.profile ?? '', data.filter?.stage ?? '');
      break;
    case 'checklist':
      parts.push(data.items.map((item) => item.text).join(' '));
      break;
    case 'table':
      parts.push(data.columns.join(' '), data.rows.map((row) => row.join(' ')).join(' '));
      break;
    case 'atlas':
      parts.push(data.src.url ?? '', ...(data.src.snapshot?.keystones ?? []));
      break;
    case 'strategy':
      parts.push(
        data.src.picksText ?? '',
        data.src.map ?? '',
        data.src.astrolabe ?? '',
        data.src.atlas?.url ?? '',
        ...(data.src.snapshot?.picks.map((pick) => pick.name) ?? []),
        ...(data.src.snapshot?.keystones ?? []),
        ...(data.src.atlas?.snapshot?.keystones ?? []),
      );
      break;
    case 'build':
      parts.push(data.ascendancy ?? '', data.links.map((link) => `${link.label} ${link.url}`).join(' '));
      break;
    default:
      break;
  }
  return parts.join('  ').toLowerCase();
}

function scarabText(entry: Entry): string {
  if (entry.data.k !== 'strategy') return '';
  const src = entry.data.src;
  return [src.picksText ?? '', ...(src.snapshot?.picks.map((pick) => pick.name) ?? [])]
    .join(' ')
    .toLowerCase();
}

function keystoneText(entry: Entry): string {
  const snapshots =
    entry.data.k === 'atlas'
      ? [entry.data.src.snapshot]
      : entry.data.k === 'strategy'
        ? [entry.data.src.snapshot, entry.data.src.atlas?.snapshot]
        : [];
  return snapshots
    .flatMap((snapshot) => snapshot?.keystones ?? [])
    .join(' ')
    .toLowerCase();
}

export function pointsOf(entry: Entry): number {
  if (entry.data.k === 'atlas') return entry.data.src.snapshot?.points ?? entry.data.points ?? 0;
  if (entry.data.k === 'strategy') {
    return entry.data.src.snapshot?.points ?? entry.data.src.atlas?.snapshot?.points ?? 0;
  }
  return 0;
}

function rolesOf(entry: Entry): string[] {
  if (entry.data.k === 'link') return entry.data.role ? [entry.data.role] : [];
  if (entry.data.k === 'build') {
    const roles = entry.data.links.map((link) => link.role).filter((role): role is LinkRole => !!role);
    // A build is a PoB with things around it, so it answers to role:pob even
    // when nobody labelled the link.
    return roles.length ? roles : ['pob'];
  }
  return [];
}

function has(entry: Entry, what: string): boolean {
  const data = entry.data;
  switch (what) {
    case 'runs':
      return !!entry.runs?.length;
    case 'tags':
      return entry.tags.length > 0;
    case 'note':
      return entry.body.trim().length > 0;
    case 'image':
      return (
        (data.k === 'image' && !!(data.assetId || data.imageUrl)) ||
        (data.k === 'link' && !!data.assetId) ||
        (data.k === 'atlas' && !!(data.src.assetId || data.src.imageUrl)) ||
        (data.k === 'strategy' && !!(data.src.atlas?.assetId || data.src.atlas?.imageUrl))
      );
    case 'code':
      // Ours, as opposed to a link or a screenshot of somebody else's.
      return (
        (data.k === 'atlas' && !!data.src.code) ||
        (data.k === 'strategy' && !!(data.src.code || data.src.atlas?.code))
      );
    case 'atlas':
      return (
        data.k === 'atlas' ||
        (data.k === 'strategy' && !!(data.src.code || data.src.atlas)) ||
        (data.k === 'link' && data.role === 'atlas')
      );
    case 'pob':
      // A build is a PoB with things around it, so it counts whether or not
      // anyone labelled the links inside it.
      return data.k === 'build' || (data.k === 'link' && data.role === 'pob');
    case 'url':
      return (
        (data.k === 'link' && !!data.url) ||
        (data.k === 'build' && data.links.length > 0) ||
        (data.k === 'atlas' && !!data.src.url)
      );
    default:
      return false;
  }
}

function is(entry: Entry, what: string, ctx: QueryContext): boolean {
  switch (what) {
    case 'untagged':
      return entry.tags.length === 0;
    case 'orphan':
      return !ctx.placed?.has(entry.id);
    case 'inbox':
      // Not filed: nobody has tagged it and it is not on a page. Captured
      // things start here and leave by being put somewhere.
      return entry.tags.length === 0 && !ctx.placed?.has(entry.id);
    case 'pinned':
      return entry.pinned === true;
    default:
      return false;
  }
}

function matchesTerm(entry: Entry, term: QueryTerm, text: string, ctx: QueryContext): boolean {
  switch (term.field) {
    case '':
      return text.includes(term.value);
    case 'tag':
      return entry.tags.includes(term.value);
    case 'kind':
      return entry.kind === (term.value as EntryKind);
    case 'role':
      return rolesOf(entry).includes(term.value);
    case 'stage':
      return entry.data.k === 'link' && entry.data.filter?.stage === term.value;
    case 'league':
      return (entry.league ?? '').toLowerCase() === term.value;
    case 'game':
      // Everything here is PoE 1 unless it says otherwise, which is why the
      // marker for PoE 2 is the loud one.
      return term.value === 'poe1' ? (entry.game ?? 'poe1') === 'poe1' : entry.game === term.value;
    case 'status':
      return (entry.status ?? '') === term.value;
    case 'diff':
      return entry.difficulty === DIFFICULTY[term.value];
    case 'scarab':
      return scarabText(entry).includes(term.value);
    case 'node':
      return keystoneText(entry).includes(term.value);
    case 'has':
      return has(entry, term.value);
    case 'is':
      return is(entry, term.value, ctx);
    default:
      return false;
  }
}

export function matches(entry: Entry, query: Query, ctx: QueryContext = {}): boolean {
  const text = haystack(entry);
  for (const term of query.terms) {
    const hit = matchesTerm(entry, term, text, ctx);
    if (hit === term.negated) return false;
  }
  return true;
}

// --- running ------------------------------------------------------------------

function sortValue(entry: Entry, key: SortKey): number | string {
  switch (key) {
    case 'created':
      return entry.createdAt;
    case 'title':
      return entry.title.toLowerCase();
    case 'points':
      return pointsOf(entry);
    case 'perhour':
      return runTotals(entry.runs).perHour;
    default:
      return entry.updatedAt;
  }
}

export function runQuery(entries: readonly Entry[], query: Query, ctx: QueryContext = {}): Entry[] {
  const out = entries.filter(
    (entry) =>
      (query.mentionsStatus || entry.status !== 'dead') && matches(entry, query, ctx),
  );
  const key = query.sort;
  out.sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (typeof left === 'string' || typeof right === 'string') {
      // Titles read A→Z; everything else is a number and reads newest or
      // biggest first, because that is the one you are looking for.
      return String(left).localeCompare(String(right));
    }
    if (left !== right) return right - left;
    return b.updatedAt - a.updatedAt;
  });
  return out;
}

// --- pages --------------------------------------------------------------------

function idsIn(blocks: readonly Block[], into: Set<string>): void {
  for (const block of blocks) {
    if (block.t === 'entry') into.add(block.id);
    if (block.t === 'columns') for (const column of block.cols) idsIn(column, into);
  }
}

/** Every entry that sits on some page — the opposite of `is:orphan`. */
export function placedIds(pages: readonly Page[]): Set<string> {
  const ids = new Set<string>();
  for (const page of pages) idsIn(page.blocks, ids);
  return ids;
}

/** How many entries carry each tag, for the list you filter by clicking. */
export function tagCounts(entries: readonly Entry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

/** Adds a term, or takes it away if it is already there — what clicking a tag does. */
export function toggleTerm(query: string, term: string): string {
  const tokens = tokenise(query);
  const without = tokens.filter((token) => token.toLowerCase() !== term.toLowerCase());
  if (without.length !== tokens.length) return without.join(' ');
  return [...tokens, term].join(' ').trim();
}
