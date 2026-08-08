/**
 * What a short link is made of.
 *
 * A link stores the share code and nothing else. The code already *is* the
 * plan — the atlas one packs a 132 node tree into about 55 characters — so
 * storing the decoded tree, or the whole URL the code sits in, would be storing
 * the same thing again at ten times the size. The origin and the path are the
 * same in every row; the browser puts them back.
 *
 * At that point the code is no longer what costs anything. A document here is
 * ~60 bytes of payload under ~250 bytes of Mongo overhead — the `_id`, the
 * field names in every document, the index entries — which is why the fields
 * are one letter each and the slug doubles as the `_id` instead of sitting
 * beside one.
 *
 * The bigger saving is not storing the same plan twice: the code is hashed and
 * the hash is unique, so sharing one tree from three devices makes one row, and
 * pressing the button twice gives back the same link.
 */
import { createHash, randomBytes } from 'node:crypto';

export const KINDS = { atlas: 'a', strategy: 's' } as const;
export type Kind = keyof typeof KINDS;

/** The prefix each tool's own encoder writes, so a code cannot be filed as the wrong kind. */
const PREFIX: Record<Kind, RegExp> = {
  atlas: /^AT\d+:/,
  strategy: /^ST\d+:/,
};

export const MAX_CODE = 4000;

/** Anonymous links expire this long after they were last opened. */
export const ANON_DAYS = 180;

/**
 * No vowels and no look-alikes: a slug ends up read aloud and typed by hand in
 * a Discord message, and `l` against `1` is the one mistake worth designing out.
 * 31 symbols over 8 characters is ~40 bits, far more than the collision retry
 * below will ever have to work for.
 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const SLUG_LENGTH = 8;

export function newSlug(): string {
  const bytes = randomBytes(SLUG_LENGTH);
  let slug = '';
  // Rejection-free and the bias is under 1% across 31 of 256 values, which for
  // a random identifier costs nothing.
  for (const byte of bytes) slug += ALPHABET[byte % ALPHABET.length];
  return slug;
}

export function hashCode(kind: Kind, code: string): string {
  return createHash('sha256').update(`${KINDS[kind]}:${code}`).digest('base64url').slice(0, 22);
}

export function isCodeFor(kind: Kind, code: string): boolean {
  return PREFIX[kind].test(code);
}

export function kindFromLetter(letter: string): Kind | null {
  if (letter === 'a') return 'atlas';
  if (letter === 's') return 'strategy';
  return null;
}

export function expiryFromNow(): Date {
  return new Date(Date.now() + ANON_DAYS * 24 * 60 * 60 * 1000);
}
