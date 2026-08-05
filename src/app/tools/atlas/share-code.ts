/**
 * Share codes for an atlas plan.
 *
 * Shape: `AT<formatVersion>:<base64url>`. The prefix makes the string
 * recognisable and lets the reader reject a format it does not understand
 * before touching the bytes; the tree version lives in the payload, so a code
 * always says which dataset it was built against and can never be silently
 * applied to a different one.
 *
 * Payload:
 *   u8      tree version
 *   u8      flags -- bit 0: made in targets mode, bit 1: allocated is a walk
 *   section allocated
 *   section targets
 *   section blocked
 *
 * Targets and blocked nodes are arbitrary subsets, stored as a varint count
 * followed by gaps between ascending node positions (a node place in the
 * tree shareOrder, fixed for a given tree version).
 *
 * The allocated set is not arbitrary: it is always a connected subtree hanging
 * off the Atlas centre. So instead of a position per node it is stored as one
 * bit per decision along a fixed walk of the real graph -- "is this node in the
 * plan?" -- which the decoder replays. Measured on a real 132 node plan that is
 * 98 characters against 231 for a position list, and it beats deflating the
 * position list (179) without needing a compressor. A set that somehow is not
 * connected falls back to the position list, and the flag says which was used.
 *
 * Format 1 codes are still readable; they are the same thing with the allocated
 * set always as a position list.
 */
import type { Tree } from './tree-types';

export const SHARE_FORMAT_VERSION = 2;
const READABLE_FORMATS = new Set([1, 2]);
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

// --- connected walk ----------------------------------------------------------

/**
 * Neighbours in a data-determined order, so encoder and decoder agree without
 * shipping the ordering. Node id rather than internal index, since indices come
 * from JSON key order while ids are the tree own identifiers.
 */
function orderedNeighbours(tree: Tree, node: number): number[] {
  const out: number[] = [];
  for (let e = tree.offsets[node]; e < tree.offsets[node + 1]; e++) out.push(tree.adjacency[e]);
  return out.sort((a, b) => Number(tree.nodes[a].id) - Number(tree.nodes[b].id));
}

/**
 * Walks out from the centre, deciding each node the walk first reaches. Calls
 * `decide` with the node and expects "is it in the plan"; only included nodes
 * are expanded, so the walk covers the plan and its immediate boundary.
 */
function walkFromCentre(tree: Tree, decide: (node: number) => boolean): void {
  const decided = new Uint8Array(tree.nodes.length);
  decided[tree.rootIdx] = 1;
  const queue = [tree.rootIdx];
  for (let head = 0; head < queue.length; head++) {
    for (const u of orderedNeighbours(tree, queue[head])) {
      if (decided[u]) continue;
      decided[u] = 1;
      if (decide(u)) queue.push(u);
    }
  }
}

function writeWalk(out: number[], tree: Tree, allocated: Set<number>): void {
  const bits: number[] = [];
  walkFromCentre(tree, (node) => {
    const included = allocated.has(node);
    bits.push(included ? 1 : 0);
    return included;
  });
  writeVarint(out, bits.length);
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => {
    if (bit) bytes[i >> 3] |= 1 << (i & 7);
  });
  for (const byte of bytes) out.push(byte);
}

function readWalk(bytes: Uint8Array, cursor: { at: number }, tree: Tree): number[] {
  const bitCount = readVarint(bytes, cursor);
  if (bitCount > tree.nodes.length * 8) throw new ShareCodeError('walk is longer than the tree');
  const byteCount = Math.ceil(bitCount / 8);
  if (cursor.at + byteCount > bytes.length) throw new ShareCodeError('code ends mid-walk');
  const start = cursor.at;
  cursor.at += byteCount;

  const nodes: number[] = [];
  let read = 0;
  walkFromCentre(tree, (node) => {
    if (read >= bitCount) return false;
    const bit = (bytes[start + (read >> 3)] >> (read & 7)) & 1;
    read++;
    if (bit) nodes.push(node);
    return bit === 1;
  });
  return nodes;
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

  const allocatedNodes = new Set<number>();
  for (const id of plan.allocated) {
    const node = tree.byId.get(id);
    if (node?.allocatable) allocatedNodes.add(node.idx);
  }
  const walkable = isConnectedToCentre(tree, allocatedNodes);

  const flags = (plan.targetsMode ? 1 : 0) | (walkable ? 2 : 0);
  const out: number[] = [plan.treeVersion & 0xff, flags];
  if (walkable) writeWalk(out, tree, allocatedNodes);
  else writeSection(out, positions(plan.allocated));
  writeSection(out, positions(plan.targets));
  writeSection(out, positions(plan.blocked));
  return `${PREFIX}${SHARE_FORMAT_VERSION}:${toBase64Url(Uint8Array.from(out))}`;
}

/** The walk encoding only reproduces sets reachable from the centre. */
function isConnectedToCentre(tree: Tree, allocated: Set<number>): boolean {
  if (allocated.size === 0) return true;
  let reached = 0;
  walkFromCentre(tree, (node) => {
    const included = allocated.has(node);
    if (included) reached++;
    return included;
  });
  return reached === allocated.size;
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
  if (!READABLE_FORMATS.has(formatVersion)) {
    throw new ShareCodeError(
      `code is format ${formatVersion}, this tool reads ${[...READABLE_FORMATS].join(' and ')}`,
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
  const allocated =
    (flags & 2) !== 0
      ? readWalk(bytes, cursor, tree).map((node) => tree.nodes[node].id)
      : ids(readSection(bytes, cursor, limit));

  return {
    treeVersion,
    targetsMode: (flags & 1) !== 0,
    allocated,
    targets: ids(readSection(bytes, cursor, limit)),
    blocked: ids(readSection(bytes, cursor, limit)),
  };
}
