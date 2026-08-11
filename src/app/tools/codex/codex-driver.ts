/**
 * The seam between the Codex and wherever it is kept.
 *
 * Today there is one implementation, `LocalDriver`, on IndexedDB. When this
 * moves to an account the second one is an `HttpDriver` with the same methods,
 * and nothing above this line has to know which it got. That is the reason the
 * interface exists at all — not because two backends are needed now, but
 * because writing the UI against `localStorage`-shaped calls is what makes the
 * move a rewrite instead of a file.
 *
 * Deletes are soft everywhere. Absence cannot mean deletion once two devices
 * are involved — the other one may simply never have heard of the record — so a
 * delete sets `deletedAt` and the record stays until something collects it. The
 * sync already in this project works exactly that way (api/_lib/merge.ts), and
 * arriving there with hard deletes would mean every deleted entry coming back.
 */
import type { AssetMeta, CodexBundle, Doc, Entry, Page, SavedView } from './codex-types';

export type StoreName = 'docs' | 'pages' | 'entries' | 'views';

export interface StorageUse {
  used: number;
  quota: number;
}

export interface NewAsset {
  type: string;
  w: number;
  h: number;
}

export interface CodexDriver {
  /** Called once before anything else; safe to call again. */
  open(): Promise<void>;

  docs(): Promise<Doc[]>;
  putDoc(doc: Doc): Promise<void>;

  /** All pages, or one doc's. */
  pages(docId?: string): Promise<Page[]>;
  putPage(page: Page): Promise<void>;

  entries(): Promise<Entry[]>;
  putEntry(entry: Entry): Promise<void>;

  views(): Promise<SavedView[]>;
  putView(view: SavedView): Promise<void>;

  /** Marks a record deleted. Unknown ids are not an error. */
  remove(store: StoreName, id: string): Promise<void>;

  assets(): Promise<AssetMeta[]>;
  asset(id: string): Promise<Blob | null>;
  putAsset(blob: Blob, meta: NewAsset): Promise<AssetMeta>;

  /** Everything that is not deleted, in one object. */
  bundle(): Promise<CodexBundle>;
  /** Merges a bundle in: same id, later `updatedAt` wins. */
  restore(bundle: CodexBundle): Promise<void>;

  /** What the browser admits to, when it admits to anything. */
  usage(): Promise<StorageUse | null>;
}

// --- bytes --------------------------------------------------------------------

/**
 * Blobs in storage, base64 in a bundle. A bundle is one file somebody saves or
 * sends, and a third more bytes is the right price for it not being a folder.
 *
 * Chunked because `String.fromCharCode(...bytes)` on a 200 KB screenshot is an
 * argument list long enough to throw.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBlob(data: string, type: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}
