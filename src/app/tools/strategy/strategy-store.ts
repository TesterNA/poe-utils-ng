/**
 * Where strategies live between visits: the one on screen, and the library you
 * saved by name.
 *
 * Both hold the share code rather than the state it came from. A strategy is
 * already defined by its code — the tree, the items and the notes are all in
 * there — so keeping a second representation alongside would only give the two
 * a way to disagree.
 *
 * Same caveat as the atlas library: localStorage is per browser and per device
 * and can be cleared, so `exportAll` is the way out that does not depend on it.
 */

const STATE_KEY = 'poe_strategy_state';
const LIBRARY_KEY = 'poe_strategy_library';

export interface SavedStrategy {
  id: string;
  name: string;
  /** the `ST…` code, which already carries the tree, the items and the notes */
  code: string;
  /** shown in the list so it reads without decoding every entry */
  slots: number;
  points: number;
  savedAt: number;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// --- the strategy on screen ---------------------------------------------------

export function loadState(): string {
  try {
    return localStorage.getItem(STATE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function storeState(code: string): void {
  try {
    localStorage.setItem(STATE_KEY, code);
  } catch {
    // private mode / quota — nothing we can do, the tool still works
  }
}

// --- the library --------------------------------------------------------------

function isSaved(value: unknown): value is SavedStrategy {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<SavedStrategy>;
  return typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.code === 'string';
}

export function loadLibrary(): SavedStrategy[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop anything malformed rather than letting one bad entry hide the rest.
    return parsed.filter(isSaved).map((entry) => ({
      ...entry,
      slots: entry.slots ?? 0,
      points: entry.points ?? 0,
      savedAt: entry.savedAt ?? 0,
    }));
  } catch {
    return [];
  }
}

/** Returns false when the write failed — quota, private mode, disabled storage. */
export function storeLibrary(entries: SavedStrategy[]): boolean {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

/** Saving under an existing name replaces it, which is what "save" usually means. */
export function upsertStrategy(
  entries: SavedStrategy[],
  entry: Omit<SavedStrategy, 'id' | 'savedAt'>,
): SavedStrategy[] {
  const name = entry.name.trim();
  const existing = entries.find((saved) => saved.name.toLowerCase() === name.toLowerCase());
  const saved: SavedStrategy = { ...entry, name, id: existing?.id ?? newId(), savedAt: Date.now() };
  return existing ? entries.map((e) => (e.id === existing.id ? saved : e)) : [...entries, saved];
}

/** One `name<TAB>code` line per strategy — pasteable anywhere, re-importable. */
export function exportAll(entries: SavedStrategy[]): string {
  return entries.map((entry) => `${entry.name}\t${entry.code}`).join('\n');
}

export function importAll(text: string, entries: SavedStrategy[]): SavedStrategy[] {
  let out = entries;
  for (const line of text.split('\n')) {
    const [name, code] = line.split('\t');
    if (!name?.trim() || !code?.trim()) continue;
    out = upsertStrategy(out, { name: name.trim(), code: code.trim(), slots: 0, points: 0 });
  }
  return out;
}
