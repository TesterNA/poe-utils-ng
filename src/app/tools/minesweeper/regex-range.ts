/**
 * Compiles an integer range into a regex alternation that matches exactly the
 * numbers in it — `1..20` becomes `([1-9]|1\d|20)`.
 *
 * A range cannot be written as a character class the moment it crosses a digit
 * boundary, so it is cut at every "…999" and "…000" inside it. Each piece then
 * has a fixed number of digits and turns into one pattern digit by digit:
 * positions that agree are copied, positions that differ become a class, and a
 * position free to be anything becomes `\d`. Neighbouring pieces that produce
 * the same pattern and differ only in how many digits are free are folded into
 * a single `{n,m}` quantifier rather than two alternatives.
 *
 * Ported from to-regex-range (MIT, Jon Schlinkert), narrowed to what the stash
 * search needs — non-negative integers, no zero padding — so the output is the
 * same string the original produced. `scripts/regex-range.mjs` checks it.
 */

/** One alternative of the finished pattern. */
interface Piece {
  /** the digit pattern with no quantifier, e.g. `1\d` */
  pattern: string;
  /** free-digit counts folded into one quantifier: `[1]` → ``, `[1,2]` → `{1,2}` */
  count: number[];
  /** pattern plus its quantifier — what actually goes into the alternation */
  text: string;
}

/** Regex source matching every integer between `min` and `max` and no other. */
export function regexRange(min: number, max: number): string {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  if (a === b) return String(a);
  if (b - a === 1) return `(${a}|${b})`;
  return `(${splitToPatterns(a, b).join('|')})`;
}

function splitToPatterns(min: number, max: number): string[] {
  const pieces: Piece[] = [];
  let start = min;
  let prev: Piece | undefined;

  for (const stop of splitToRanges(min, max)) {
    const { pattern, count } = rangeToPattern(String(start), String(stop));
    start = stop + 1;

    // 10-99 and 100-999 are both `[1-9]\d`, once with one free digit and once
    // with two, so they collapse into `[1-9]\d{1,2}`.
    if (prev && prev.pattern === pattern && count.length === 1) {
      if (prev.count.length > 1) prev.count.pop();
      prev.count.push(count[0]);
      prev.text = prev.pattern + quantifier(prev.count);
      continue;
    }

    const piece: Piece = { pattern, count, text: pattern + quantifier(count) };
    pieces.push(piece);
    prev = piece;
  }

  return pieces.map((piece) => piece.text);
}

/**
 * The end of each digit-aligned chunk of `[min, max]`: the "…999" reachable
 * from below, the "…000 minus one" reachable from above, and `max` itself.
 */
function splitToRanges(min: number, max: number): number[] {
  const stops = new Set<number>([max]);

  let nines = 1;
  let stop = countNines(min, nines);
  while (min <= stop && stop <= max) {
    stops.add(stop);
    stop = countNines(min, ++nines);
  }

  let zeros = 1;
  stop = countZeros(max + 1, zeros) - 1;
  while (min < stop && stop <= max) {
    stops.add(stop);
    stop = countZeros(max + 1, ++zeros) - 1;
  }

  return [...stops].sort((x, y) => x - y);
}

/** One pattern for a chunk whose ends have the same number of digits. */
function rangeToPattern(start: string, stop: string): { pattern: string; count: number[] } {
  if (start === stop) return { pattern: start, count: [] };

  let pattern = '';
  let free = 0;
  for (let i = 0; i < start.length; i++) {
    const from = start[i];
    const to = stop[i];
    if (from === to) pattern += from;
    else if (from !== '0' || to !== '9') pattern += charClass(from, to);
    else free++;
  }
  if (free) pattern += '\\d';

  return { pattern, count: [free] };
}

function charClass(from: string, to: string): string {
  return `[${from}${Number(to) - Number(from) === 1 ? '' : '-'}${to}]`;
}

function quantifier(count: number[]): string {
  const [start = 0, stop] = count;
  if (stop || start > 1) return `{${start}${stop ? ',' + stop : ''}}`;
  return '';
}

/** `min` with its last `len` digits replaced by nines: 1234, 2 → 1299. */
function countNines(min: number, len: number): number {
  return Number(String(min).slice(0, -len) + '9'.repeat(len));
}

/** `value` rounded down to a multiple of 10^zeros. */
function countZeros(value: number, zeros: number): number {
  return value - (value % 10 ** zeros);
}
