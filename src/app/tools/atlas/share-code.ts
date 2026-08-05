/**
 * Share codes for an atlas plan.
 *
 * Shape: `AT<formatVersion>:<base64url>`, e.g. `AT1:AQBkAQIDBQ`. The prefix
 * makes the string recognisable and lets the reader reject a format it does not
 * understand before touching the bytes; the tree version lives in the payload,
 * so a code always says which dataset it was built against and can never be
 * silently applied to a different one.
 *
 * Payload:
 *   u8      tree version
 *   u8      flags — bit 0: the plan was made in targets mode
 *   section allocated
 *   section targets
 *   section blocked
 *
 * A section is a varint count followed by that many varints: ascending node
 * positions stored as gaps from the previous one. Positions are the node's
 * place in the tree's `shareOrder` (allocatable nodes sorted by id), which is
 * fixed for a given tree version. Gaps are small, so a 130 node plan lands in
 * roughly 190 characters instead of the ~900 a list of raw ids would take.
 */
import type { Tree } from './tree-types';

export const SHARE_FORMAT_VERSION = 1;
const PREFIX = 'AT';

export interface AtlasPlan {
  treeVersion: number;
  targetsMode: boolean;
  /** node ids, not positions — callers deal in the tree's own ids */
  allocated: string[];
  targets: string[];
  blocked: string[];
}

export class ShareCodeError extends Error {}

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

// --- base64url ---------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch {
    throw new ShareCodeError('not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- sections ----------------------------------------------------------------

function writeSection(out: number[], positions: number[]): void {
  const sorted = [...positions].sort((a, b) => a - b);
  writeVarint(out, sorted.length);
  let previous = 0;
  for (const position of sorted) {
    writeVarint(out, position - previous);
    previous = position;
  }
}

function readSection(bytes: Uint8Array, cursor: { at: number }, limit: number): number[] {
  const count = readVarint(bytes, cursor);
  if (count > limit) throw new ShareCodeError('section claims more nodes than the tree has');
  const positions: number[] = [];
  let previous = 0;
  for (let i = 0; i < count; i++) {
    previous += readVarint(bytes, cursor);
    if (previous >= limit) throw new ShareCodeError('code refers to a node outside the tree');
    positions.push(previous);
  }
  return positions;
}

// --- api ---------------------------------------------------------------------

export function encodePlan(tree: Tree, plan: AtlasPlan): string {
  const positionOf = (id: string): number | null => {
    const node = tree.byId.get(id);
    if (!node) return null;
    const position = tree.shareIndex[node.idx];
    return position >= 0 ? position : null;
  };
  const positions = (ids: string[]) =>
    ids.map(positionOf).filter((p): p is number => p !== null);

  const out: number[] = [plan.treeVersion & 0xff, plan.targetsMode ? 1 : 0];
  writeSection(out, positions(plan.allocated));
  writeSection(out, positions(plan.targets));
  writeSection(out, positions(plan.blocked));
  return `${PREFIX}${SHARE_FORMAT_VERSION}:${toBase64Url(Uint8Array.from(out))}`;
}

/**
 * Reads the tree version and mode without needing that tree to be loaded, so a
 * caller can fetch the right dataset before decoding the rest.
 */
export function peekPlan(code: string): { formatVersion: number; treeVersion: number } {
  const trimmed = code.trim();
  const match = /^AT(\d+):([A-Za-z0-9\-_]+)$/.exec(trimmed);
  if (!match) throw new ShareCodeError('this does not look like an atlas code');
  const formatVersion = Number(match[1]);
  if (formatVersion !== SHARE_FORMAT_VERSION) {
    throw new ShareCodeError(
      `code is format ${formatVersion}, this tool reads ${SHARE_FORMAT_VERSION}`,
    );
  }
  const bytes = fromBase64Url(match[2]);
  if (bytes.length < 2) throw new ShareCodeError('code is too short');
  return { formatVersion, treeVersion: bytes[0] };
}

export function decodePlan(code: string, tree: Tree): AtlasPlan {
  const { treeVersion } = peekPlan(code);
  const bytes = fromBase64Url(code.trim().split(':')[1]);
  const cursor = { at: 2 };
  const flags = bytes[1];
  const limit = tree.shareOrder.length;

  const ids = (positions: number[]) => positions.map((p) => tree.nodes[tree.shareOrder[p]].id);
  const plan: AtlasPlan = {
    treeVersion,
    targetsMode: (flags & 1) !== 0,
    allocated: ids(readSection(bytes, cursor, limit)),
    targets: ids(readSection(bytes, cursor, limit)),
    blocked: ids(readSection(bytes, cursor, limit)),
  };
  return plan;
}
