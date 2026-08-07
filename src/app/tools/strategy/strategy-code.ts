/**
 * Share codes for a strategy.
 *
 * Shape: `ST<formatVersion>:<base64url>`, the same arrangement the atlas codes
 * use, and for the same reasons — the prefix makes the string recognisable and
 * lets a reader reject a format it does not understand before touching the
 * bytes, and the dataset a code was built against lives in the payload so it
 * can never be silently applied to a different one.
 *
 * Payload (format 1):
 *   u8      atlas tree version
 *   u8      the format of the atlas code carried inside, 0 when no tree
 *   varint  length, then that many bytes -- only when the byte above is not 0
 *   varint  pick count, then per pick: varint item code, varint copies
 *   varint  length, then that many bytes of utf8 notes
 *
 * The atlas plan travels as the raw bytes out of its own code rather than as
 * the code's text: base64 of base64 would cost a third more for nothing, and
 * re-encoding through a decode would quietly upgrade an old atlas code to the
 * current format and change what the tree meant. Items travel as the catalogue
 * `code`, which the scraper assigns once and never reuses, so a code written a
 * league ago still names the same scarabs.
 */
import { fromBase64Url, ShareCodeError, toBase64Url, unwrapCode, wrapCode } from '../atlas/share-code';
import type { Pick, Strategy } from './strategy-plan';

export const STRATEGY_FORMAT_VERSION = 1;
const READABLE_FORMATS = new Set([1]);
const PREFIX = 'ST';

/** Long enough for any real note, short enough that a bad code cannot claim a gigabyte. */
const MAX_NOTES = 4000;
const MAX_PICKS = 64;

// --- varint ------------------------------------------------------------------

function writeVarint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function readVarint(bytes: Uint8Array, cursor: { at: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (cursor.at >= bytes.length) throw new ShareCodeError('code ends mid-number');
    const byte = bytes[cursor.at++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
    if (shift > 28) throw new ShareCodeError('number too large');
  }
}

function writeBytes(out: number[], bytes: Uint8Array): void {
  writeVarint(out, bytes.length);
  for (const byte of bytes) out.push(byte);
}

function readBytes(bytes: Uint8Array, cursor: { at: number }, limit: number): Uint8Array {
  const length = readVarint(bytes, cursor);
  if (length > limit) throw new ShareCodeError('code claims more data than it holds');
  if (cursor.at + length > bytes.length) throw new ShareCodeError('code ends early');
  const slice = bytes.subarray(cursor.at, cursor.at + length);
  cursor.at += length;
  return slice;
}

// --- api ---------------------------------------------------------------------

export function encodeStrategy(strategy: Strategy): string {
  const out: number[] = [strategy.treeVersion & 0xff];

  if (strategy.treeCode) {
    // A tree that cannot be taken apart is dropped rather than failing the
    // whole code: the picks and the notes are still worth sharing.
    try {
      const { formatVersion, payload } = unwrapCode(strategy.treeCode);
      out.push(formatVersion & 0xff);
      writeBytes(out, payload);
    } catch {
      out.push(0);
    }
  } else {
    out.push(0);
  }

  writeVarint(out, strategy.picks.length);
  for (const pick of strategy.picks) {
    writeVarint(out, pick.code);
    writeVarint(out, pick.count);
  }

  writeBytes(out, new TextEncoder().encode(strategy.notes.slice(0, MAX_NOTES)));
  return `${PREFIX}${STRATEGY_FORMAT_VERSION}:${toBase64Url(Uint8Array.from(out))}`;
}

/**
 * Reads the tree version without decoding the rest, so a caller can fetch the
 * right atlas dataset — or refuse the code by name — before going further.
 */
export function peekStrategy(code: string): { formatVersion: number; treeVersion: number } {
  const match = /^ST(\d+):([A-Za-z0-9\-_]+)$/.exec(code.trim());
  if (!match) throw new ShareCodeError('this does not look like a strategy code');
  const formatVersion = Number(match[1]);
  if (!READABLE_FORMATS.has(formatVersion)) {
    throw new ShareCodeError(
      `code is format ${formatVersion}, this tool reads ${[...READABLE_FORMATS].join(' and ')}`,
    );
  }
  const bytes = fromBase64Url(match[2]);
  if (bytes.length < 3) throw new ShareCodeError('code is too short');
  return { formatVersion, treeVersion: bytes[0] };
}

export function decodeStrategy(code: string): Strategy {
  peekStrategy(code);
  const bytes = fromBase64Url(code.trim().split(':')[1]);
  const cursor = { at: 0 };

  const treeVersion = bytes[cursor.at++];
  const atlasFormat = bytes[cursor.at++];
  const treeCode = atlasFormat
    ? wrapCode(atlasFormat, readBytes(bytes, cursor, bytes.length))
    : '';

  const pickCount = readVarint(bytes, cursor);
  if (pickCount > MAX_PICKS) throw new ShareCodeError('code claims an impossible number of items');
  const picks: Pick[] = [];
  for (let i = 0; i < pickCount; i++) {
    const itemCode = readVarint(bytes, cursor);
    const count = readVarint(bytes, cursor);
    // Zero copies is not a state the editor can produce, so it is corruption
    // rather than an empty pick worth keeping.
    if (count === 0) throw new ShareCodeError('code holds an item with no copies');
    picks.push({ code: itemCode, count });
  }

  const notes = new TextDecoder().decode(readBytes(bytes, cursor, MAX_NOTES));
  return { treeVersion, treeCode, picks, notes };
}
