/**
 * How an entry reads on screen.
 *
 * Shared rather than copied because the same card shows up in the library, on a
 * page, and inside a live query block; three copies of "what goes in the grey
 * line" is three chances for the same entry to describe itself differently
 * depending on where you happened to be looking at it.
 */
import type { Entry } from './codex-types';
import { pointsOf } from './codex-query';
import { perHourLabel, runTotals } from './codex-metrics';

/** Where the ↗ goes, when there is anywhere to go. */
export function urlOf(entry: Entry): string {
  if (entry.data.k === 'link') return entry.data.url;
  // Not the picture: a card already shows that, and a link that only reopens
  // what is on screen is a link nobody presses.
  if (entry.data.k === 'atlas') return entry.data.src.url ?? '';
  if (entry.data.k === 'image') return entry.data.imageUrl ?? '';
  if (entry.data.k === 'build') return entry.data.links[0]?.url ?? '';
  return '';
}

/**
 * What section an entry belongs under, and the first word of its grey line.
 *
 * Links grouped by `kind` would all land in a bucket called "link", which is
 * the pile again. What differs between them is what they are for — a PoB, a
 * video, a filter — which is the heading the source documents write by hand.
 */
export function typeOf(entry: Entry): string {
  if (entry.data.k === 'link') return entry.data.role ?? 'link';
  return entry.kind;
}

function roleLabel(role: string): string {
  return role === 'pob' ? 'PoB' : role;
}

/** The grey line: what it is, where it points, and anything measured about it. */
export function subtitleOf(entry: Entry): string {
  const bits: string[] = [roleLabel(typeOf(entry))];
  if (entry.data.k === 'link') {
    if (entry.data.host) bits.push(entry.data.host);
    if (entry.data.filter?.stage) bits.push(entry.data.filter.stage);
  }
  if (entry.data.k === 'strategy') {
    const src = entry.data.src;
    const slots = src.snapshot?.slots ?? src.picks?.reduce((sum, pick) => sum + pick.count, 0) ?? 0;
    if (slots) bits.push(`${slots}/5 slots`);
    if (src.map) bits.push(src.map);
  }
  if (entry.league) bits.push(entry.league);
  const points = pointsOf(entry);
  if (points) bits.push(`${points} pts`);
  const rate = perHourLabel(runTotals(entry.runs));
  if (rate) bits.push(rate);
  if (entry.status && entry.status !== 'live') bits.push(entry.status);
  return bits.join(' · ');
}

export function excerptOf(entry: Entry): string {
  const body = entry.body.trim().replace(/\s+/g, ' ');
  return body.length > 160 ? `${body.slice(0, 160)}…` : body;
}

/** "1 entry", "2 entries" — a count that reads wrong is a count nobody trusts. */
export function count(n: number, word: string): string {
  if (n === 1) return `1 ${word}`;
  return `${n} ${word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;
}

/** "3 days ago" reads better than a date nobody wrote down. */
export function when(at: number): string {
  if (!at) return '';
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}

export function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const value = bytes / (1024 * 1024);
  return value < 100 ? `${value.toFixed(1)} MB` : `${Math.round(value)} MB`;
}

/**
 * How much of an entry a machine can read, as a few marks on the card.
 *
 * The documents this replaces are full of half-written strategies — a scarab
 * line, an imgur link, no tree — and that is fine: writing one down in three
 * seconds is worth more than a complete record nobody writes. So this is an
 * invitation and never a requirement. It says what is *there*, which is also
 * what says what a search will and will not find: scarabs picked from the
 * catalogue answer `scarab:cloister`, a sentence about scarabs does not.
 */
export interface Mark {
  label: string;
  on: boolean;
}

export function completeness(entry: Entry): Mark[] {
  const data = entry.data;
  if (data.k === 'atlas') {
    return [
      { label: 'our tree code', on: !!data.src.code },
      { label: 'a link out', on: !!data.src.url },
      {
        label: 'a picture',
        on: !!(data.src.snapshot?.thumbId || data.src.assetId || data.src.imageUrl),
      },
      { label: 'notes', on: entry.body.trim().length > 0 },
    ];
  }
  if (data.k === 'strategy') {
    const src = data.src;
    // Our strategy code always exists once it has been saved from the tool, and
    // it carries a tree only if one was attached — so the code is no evidence
    // of a tree, and what it read off that tree is.
    const tree = !!(
      src.atlas?.code ||
      src.atlas?.url ||
      src.atlas?.imageUrl ||
      (src.snapshot?.points ?? 0) > 0 ||
      src.snapshot?.keystones.length
    );
    return [
      { label: 'a tree', on: tree },
      { label: 'scarabs from the catalogue', on: !!(src.snapshot?.picks.length || src.picks?.length) },
      { label: 'measured', on: !!entry.runs?.length },
      { label: 'notes', on: entry.body.trim().length > 0 },
    ];
  }
  return [];
}
