/**
 * Share codes for an atlas plan.
 *
 * A code carries the finished tree and nothing else. Targets and blocked nodes
 * are working state for planning your own tree; whoever opens your link wants
 * the result, so they get it as an allocated tree in path mode. If you share
 * while still planning, the route on screen is what travels.
 *
 * Shape: `AT<formatVersion>:<base64url>`. The prefix makes the string
 * recognisable and lets the reader reject a format it does not understand
 * before touching the bytes; the tree version lives in the payload, so a code
 * always says which dataset it was built against and can never be silently
 * applied to a different one.
 *
 * Payload (format 3):
 *   u8   tree version
 *   u8   flags -- bit 1: the tree is stored as a walk
 *   tree
 *
 * The allocated set is never an arbitrary subset: it is always a connected
 * subtree hanging off the Atlas centre. So instead of a position per node it is
 * stored as one bit per decision along a fixed walk of the real graph -- "is
 * this node in the plan?" -- which the decoder replays. On a real 132 node plan
 * that is 46 characters against 178 for a position list, and it beats deflating
 * the position list without needing a compressor. A set that somehow is not
 * connected falls back to a position list (varint count, then gaps between
 * ascending positions in `shareOrder`), and the flag says which was used.
 *
 * Formats 1 and 2 also carried targets and blocked nodes. They still decode, and
 * a code that only ever held targets still opens as targets so old links are not
 * dead ends.
 */
import type { Tree } from './tree-types';

export const SHARE_FORMAT_VERSION = 3;
const READABLE_FORMATS = new Set([1, 2, 3]);
const PREFIX = 'AT';

export interface AtlasPlan {
  treeVersion: number;
  /** node ids, not positions — callers deal in the tree's own ids */
  allocated: string[];
  /** only ever set by a format 1 or 2 code that was shared mid-planning */
  legacyTargets?: string[];
  legacyBlocked?: string[];
}

export interface PlanToShare {
  treeVersion: number;
  /** the finished tree: what you allocated, or the route you are looking at */
  allocated: string[];
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

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
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

export function encodePlan(tree: Tree, plan: PlanToShare): string {
  const allocatedNodes = new Set<number>();
  for (const id of plan.allocated) {
    const node = tree.byId.get(id);
    if (node?.allocatable) allocatedNodes.add(node.idx);
  }
  const walkable = isConnectedToCentre(tree, allocatedNodes);

  const out: number[] = [plan.treeVersion & 0xff, walkable ? 2 : 0];
  if (walkable) {
    writeWalk(out, tree, allocatedNodes);
  } else {
    const positions: number[] = [];
    for (const nodeIdx of allocatedNodes) {
      const position = tree.shareIndex[nodeIdx];
      if (position >= 0) positions.push(position);
    }
    writeSection(out, positions);
  }
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
 * Takes an `AT…` code apart without interpreting the payload. A strategy code
 * carries an atlas plan whole, so it needs the exact bytes and the format that
 * wrapped them — re-encoding through a decode would silently upgrade an old
 * code to the current format and change what the tree meant.
 */
export function unwrapCode(code: string): { formatVersion: number; payload: Uint8Array } {
  const match = /^AT(\d+):([A-Za-z0-9\-_]+)$/.exec(code.trim());
  if (!match) throw new ShareCodeError('this does not look like an atlas code');
  const formatVersion = Number(match[1]);
  if (!READABLE_FORMATS.has(formatVersion)) {
    throw new ShareCodeError(
      `code is format ${formatVersion}, this tool reads ${[...READABLE_FORMATS].join(' and ')}`,
    );
  }
  const payload = fromBase64Url(match[2]);
  if (payload.length < 2) throw new ShareCodeError('code is too short');
  return { formatVersion, payload };
}

export function wrapCode(formatVersion: number, payload: Uint8Array): string {
  return `${PREFIX}${formatVersion}:${toBase64Url(payload)}`;
}

/**
 * Reads the tree version and mode without needing that tree to be loaded, so a
 * caller can fetch the right dataset before decoding the rest.
 */
export function peekPlan(code: string): { formatVersion: number; treeVersion: number } {
  const { formatVersion, payload } = unwrapCode(code);
  return { formatVersion, treeVersion: payload[0] };
}

export function decodePlan(code: string, tree: Tree): AtlasPlan {
  const { formatVersion, treeVersion } = peekPlan(code);
  const bytes = fromBase64Url(code.trim().split(':')[1]);
  const cursor = { at: 2 };
  const flags = bytes[1];
  const limit = tree.shareOrder.length;

  const ids = (positions: number[]) => positions.map((p) => tree.nodes[tree.shareOrder[p]].id);
  const allocated =
    (flags & 2) !== 0
      ? readWalk(bytes, cursor, tree).map((node) => tree.nodes[node].id)
      : ids(readSection(bytes, cursor, limit));

  const plan: AtlasPlan = { treeVersion, allocated };
  if (formatVersion < 3) {
    // Older codes carried the planning state too. It is dropped, except when the
    // code holds nothing else — then it was shared mid-planning and the targets
    // are all there is, so open it that way rather than showing an empty tree.
    const targets = ids(readSection(bytes, cursor, limit));
    const blocked = ids(readSection(bytes, cursor, limit));
    if (allocated.length === 0 && targets.length > 0) {
      plan.legacyTargets = targets;
      plan.legacyBlocked = blocked;
    }
  }
  return plan;
}
