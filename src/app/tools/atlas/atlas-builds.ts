/**
 * Saved atlas builds, kept in localStorage.
 *
 * Deliberately not IndexedDB: a build is a name plus a ~55 character share code,
 * so a hundred of them is a few kilobytes against localStorage's ~5 MB. IndexedDB
 * buys large values, indexes and transactions, none of which apply, and costs an
 * asynchronous API in a component whose state is otherwise synchronous. Nor is it
 * more durable — both live in the same origin storage and are evicted together.
 *
 * Local storage of any kind is not a backup: it is per browser and per device and
 * can be cleared. `exportAll` exists so a library can be moved or kept somewhere
 * real.
 */
export interface SavedBuild {
  id: string;
  name: string;
  /** the share code, which already carries the tree version */
  code: string;
  points: number;
  treeVersion: number;
  savedAt: number;
}

const KEY = 'poe_atlas_builds';

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function isBuild(value: unknown): value is SavedBuild {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Partial<SavedBuild>;
  return (
    typeof b.id === 'string' &&
    typeof b.name === 'string' &&
    typeof b.code === 'string' &&
    typeof b.points === 'number' &&
    typeof b.treeVersion === 'number'
  );
}

export function loadBuilds(): SavedBuild[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop anything malformed rather than letting one bad entry hide the rest.
    return parsed.filter(isBuild).map((b) => ({ ...b, savedAt: b.savedAt ?? 0 }));
  } catch {
    return [];
  }
}

/** Returns false when the write failed — quota, private mode, disabled storage. */
export function storeBuilds(builds: SavedBuild[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(builds));
    return true;
  } catch {
    return false;
  }
}

/** Saving under an existing name replaces it, which is what "save" usually means. */
export function upsertBuild(
  builds: SavedBuild[],
  entry: Omit<SavedBuild, 'id' | 'savedAt'>,
): SavedBuild[] {
  const name = entry.name.trim();
  const existing = builds.find((b) => b.name.toLowerCase() === name.toLowerCase());
  const saved: SavedBuild = {
    ...entry,
    name,
    id: existing?.id ?? newId(),
    savedAt: Date.now(),
  };
  return existing
    ? builds.map((b) => (b.id === existing.id ? saved : b))
    : [...builds, saved];
}

/** One `name<TAB>code` line per build — pasteable anywhere, re-importable. */
export function exportAll(builds: SavedBuild[]): string {
  return builds.map((b) => `${b.name}\t${b.code}`).join('\n');
}

export function importAll(text: string, builds: SavedBuild[]): SavedBuild[] {
  let out = builds;
  for (const line of text.split('\n')) {
    const [name, code] = line.split('\t');
    if (!name?.trim() || !code?.trim()) continue;
    out = upsertBuild(out, {
      name: name.trim(),
      code: code.trim(),
      points: 0,
      treeVersion: 0,
    });
  }
  return out;
}
