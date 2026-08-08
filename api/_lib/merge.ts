/**
 * Reconciling one device's library with the account's.
 *
 * The whole merge lives here, on the server, and the client's part is to send
 * what it has and adopt what comes back. Two implementations of a merge is two
 * chances to disagree about the same pair of libraries, and the disagreement
 * shows up as a build that reappears after you delete it.
 *
 * The rules, in order:
 *
 *   - an entry is identified by its `id`, and the later `savedAt` wins;
 *   - an id in `gone` at or after the entry's `savedAt` means it was deleted,
 *     so it stays deleted. Without tombstones every sync from a device that
 *     still holds the entry would put it back;
 *   - a delete older than the entry loses, because saving under a name you
 *     deleted somewhere else is a new save, not a resurrection;
 *   - two entries with the same name but different ids — the same build saved
 *     separately on two devices — collapse to the newer, which is what saving
 *     over a name means everywhere else in the app.
 */
import { BadRequest } from './http';
import type { LibraryEntry } from './db';

/** Bounds a library so one account cannot fill the cluster. */
const MAX_ENTRIES = 500;
const MAX_NAME = 80;
const MAX_CODE = 4000;
/** Well past any window in which a device could still be holding the entry. */
const MAX_TOMBSTONES = 300;

export function readEntries(value: unknown, field: string): LibraryEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BadRequest(`${field} must be a list.`);
  if (value.length > MAX_ENTRIES) throw new BadRequest(`${field} has too many entries.`);

  return value.map((raw) => {
    if (typeof raw !== 'object' || raw === null) throw new BadRequest(`${field} has a bad entry.`);
    const entry = raw as Record<string, unknown>;
    const id = entry['id'];
    const name = entry['name'];
    const code = entry['code'];
    if (typeof id !== 'string' || !id || id.length > 64) {
      throw new BadRequest(`${field} has an entry with no usable id.`);
    }
    if (typeof name !== 'string' || name.length > MAX_NAME) {
      throw new BadRequest(`${field} has an entry with a bad name.`);
    }
    if (typeof code !== 'string' || !code || code.length > MAX_CODE) {
      throw new BadRequest(`${field} has an entry with a bad code.`);
    }
    const clean: LibraryEntry = { id, name, code, savedAt: number(entry['savedAt']) };
    // Only carried so a list reads without decoding every code; absent is fine.
    if (entry['points'] !== undefined) clean.points = number(entry['points']);
    if (entry['slots'] !== undefined) clean.slots = number(entry['slots']);
    if (entry['treeVersion'] !== undefined) clean.treeVersion = number(entry['treeVersion']);
    return clean;
  });
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function readTombstones(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequest('Deletions must be an object.');
  }
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    if (id.length <= 64) out[id] = number(at);
  }
  return out;
}

export function mergeTombstones(
  mine: Record<string, number>,
  theirs: Record<string, number>,
): Record<string, number> {
  const all: Record<string, number> = { ...mine };
  for (const [id, at] of Object.entries(theirs)) {
    if (!(id in all) || all[id] < at) all[id] = at;
  }
  const ids = Object.keys(all);
  if (ids.length <= MAX_TOMBSTONES) return all;
  // Keep the most recent: the old ones can only matter to a device that has
  // been offline longer than every delete since.
  ids.sort((a, b) => all[b] - all[a]);
  const trimmed: Record<string, number> = {};
  for (const id of ids.slice(0, MAX_TOMBSTONES)) trimmed[id] = all[id];
  return trimmed;
}

export function mergeEntries(
  mine: LibraryEntry[],
  theirs: LibraryEntry[],
  gone: Record<string, number>,
): LibraryEntry[] {
  const byId = new Map<string, LibraryEntry>();
  for (const entry of [...mine, ...theirs]) {
    const seen = byId.get(entry.id);
    if (!seen || seen.savedAt < entry.savedAt) byId.set(entry.id, entry);
  }

  const alive = [...byId.values()].filter((entry) => {
    const deletedAt = gone[entry.id];
    return deletedAt === undefined || deletedAt < entry.savedAt;
  });

  // Same name from two devices: keep the newer, and let the older id fall away.
  const byName = new Map<string, LibraryEntry>();
  for (const entry of alive) {
    const key = entry.name.trim().toLowerCase();
    const seen = byName.get(key);
    if (!seen || seen.savedAt < entry.savedAt) byName.set(key, entry);
  }

  const out = [...byName.values()].sort((a, b) => a.savedAt - b.savedAt);
  // Newest survive a library that somehow grew past the cap.
  return out.length > MAX_ENTRIES ? out.slice(out.length - MAX_ENTRIES) : out;
}
