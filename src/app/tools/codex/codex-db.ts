/**
 * The Codex on IndexedDB.
 *
 * IndexedDB rather than localStorage, and this is the one place in the project
 * where that is the right way round. The saved atlas builds are a name and a
 * fifty-five character code; a Codex holds screenshots, and the screenshots in
 * the documents this replaces run 160–200 KB each. localStorage is about 5 MB
 * for the whole origin and it is *shared* with those libraries, so eight
 * screenshots from one evening's testing would take the site's storage with
 * them — and base64 would add a third on top of that. Blobs go in as Blobs.
 *
 * Everything is read back through codex-schema.ts, which drops what it cannot
 * read and refuses what a newer build wrote. Nothing here trusts the database:
 * it is a file on someone's disk that other tabs, other versions and the
 * browser's own eviction have all had a turn with.
 *
 * The store version below is for *structure* — new stores, new indexes. The
 * shape of a record is versioned separately and migrated on read, because a
 * failed `onupgradeneeded` takes the whole database with it while a failed read
 * takes one row.
 */
import type { AssetMeta, CodexBundle, Doc, Entry, Page, SavedView } from './codex-types';
import {
  base64ToBlob,
  blobToBase64,
  type CodexDriver,
  type NewAsset,
  type StorageUse,
  type StoreName,
} from './codex-driver';
import {
  BUNDLE_VERSION,
  newId,
  packBundle,
  readAll,
  readAssetMeta,
  readDoc,
  readEntry,
  readPage,
  readView,
  SCHEMA,
} from './codex-schema';

const DB_NAME = 'poe_codex';
const DB_VERSION = 1;

/** Where the bytes of an image live; its metadata is a row of its own. */
const BLOBS = 'blobs';
const ASSETS = 'assets';

interface BlobRow {
  id: string;
  blob: Blob;
}

export class CodexUnavailable extends Error {}

export class LocalDriver implements CodexDriver {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;

  async open(): Promise<void> {
    await this.handle();
  }

  private handle(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;
    if (typeof indexedDB === 'undefined') {
      // Private windows and locked-down profiles. Say so once; the page shows
      // it rather than failing on every read.
      return Promise.reject(new CodexUnavailable('This browser is not letting the site store anything.'));
    }
    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => upgrade(request.result, request.transaction);
      request.onsuccess = () => {
        const db = request.result;
        // Another tab opened a newer version: close rather than hold it back.
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(new CodexUnavailable(message(request.error)));
      request.onblocked = () =>
        reject(new CodexUnavailable('Another tab has an older version of the Codex open.'));
    });
    this.opening
      .then((db) => {
        this.db = db;
      })
      .catch(() => undefined)
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  // --- reads ------------------------------------------------------------------

  async docs(): Promise<Doc[]> {
    return live(readAll(await this.all('docs'), readDoc));
  }

  async pages(docId?: string): Promise<Page[]> {
    const pages = live(readAll(await this.all('pages'), readPage));
    return docId ? pages.filter((page) => page.docId === docId) : pages;
  }

  async entries(): Promise<Entry[]> {
    return live(readAll(await this.all('entries'), readEntry));
  }

  async views(): Promise<SavedView[]> {
    return live(readAll(await this.all('views'), readView));
  }

  async assets(): Promise<AssetMeta[]> {
    return live(readAll(await this.all(ASSETS), readAssetMeta));
  }

  async asset(id: string): Promise<Blob | null> {
    const row = await this.get<BlobRow>(BLOBS, id);
    return row?.blob instanceof Blob ? row.blob : null;
  }

  // --- writes -----------------------------------------------------------------

  putDoc(doc: Doc): Promise<void> {
    return this.put('docs', doc);
  }

  putPage(page: Page): Promise<void> {
    return this.put('pages', page);
  }

  putEntry(entry: Entry): Promise<void> {
    return this.put('entries', entry);
  }

  putView(view: SavedView): Promise<void> {
    return this.put('views', view);
  }

  async putAsset(blob: Blob, meta: NewAsset): Promise<AssetMeta> {
    const record: AssetMeta = {
      v: SCHEMA,
      id: newId(),
      type: meta.type || blob.type || 'application/octet-stream',
      w: meta.w,
      h: meta.h,
      bytes: blob.size,
      createdAt: Date.now(),
    };
    const db = await this.handle();
    await run(db, [ASSETS, BLOBS], 'readwrite', (tx) => {
      tx.objectStore(ASSETS).put(record);
      tx.objectStore(BLOBS).put({ id: record.id, blob } satisfies BlobRow);
    });
    return record;
  }

  /**
   * A tombstone, not an erase — see the note in codex-driver.ts. The bytes of a
   * deleted image go immediately, though: they are the expensive part and they
   * are not what a sync argues about.
   */
  async remove(store: StoreName, id: string): Promise<void> {
    const db = await this.handle();
    await run(db, [store], 'readwrite', (tx) => {
      const objects = tx.objectStore(store);
      const request = objects.get(id);
      request.onsuccess = () => {
        const record = request.result as Record<string, unknown> | undefined;
        if (!record) return;
        objects.put({ ...record, deletedAt: Date.now(), updatedAt: Date.now() });
      };
    });
  }

  // --- the whole thing --------------------------------------------------------

  async bundle(): Promise<CodexBundle> {
    const [docs, pages, entries, views, metas] = await Promise.all([
      this.docs(),
      this.pages(),
      this.entries(),
      this.views(),
      this.assets(),
    ]);
    const assets: CodexBundle['assets'] = [];
    for (const meta of metas) {
      const blob = await this.asset(meta.id);
      if (blob) assets.push({ meta, data: await blobToBase64(blob) });
    }
    // Tombstones stay out: a bundle is what you have, not the history of what
    // you stopped having. Sync is the thing that needs deletes to travel.
    return packBundle({ docs, pages, entries, views, assets });
  }

  async restore(bundle: CodexBundle): Promise<void> {
    if (bundle.v > BUNDLE_VERSION) throw new Error('That file was written by a newer version.');
    await this.merge('docs', bundle.docs);
    await this.merge('pages', bundle.pages);
    await this.merge('entries', bundle.entries);
    await this.merge('views', bundle.views);
    for (const asset of bundle.assets) {
      const db = await this.handle();
      await run(db, [ASSETS, BLOBS], 'readwrite', (tx) => {
        tx.objectStore(ASSETS).put(asset.meta);
        tx.objectStore(BLOBS).put({
          id: asset.meta.id,
          blob: base64ToBlob(asset.data, asset.meta.type),
        } satisfies BlobRow);
      });
    }
  }

  async usage(): Promise<StorageUse | null> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    try {
      const { usage, quota } = await navigator.storage.estimate();
      if (usage === undefined || quota === undefined) return null;
      return { used: usage, quota };
    } catch {
      return null;
    }
  }

  // --- plumbing ---------------------------------------------------------------

  private async all(store: string): Promise<unknown[]> {
    const db = await this.handle();
    let out: unknown[] = [];
    await run(db, [store], 'readonly', (tx) => {
      const request = tx.objectStore(store).getAll();
      request.onsuccess = () => {
        out = request.result as unknown[];
      };
    });
    return out;
  }

  private async get<T>(store: string, id: string): Promise<T | null> {
    const db = await this.handle();
    let out: T | null = null;
    await run(db, [store], 'readonly', (tx) => {
      const request = tx.objectStore(store).get(id);
      request.onsuccess = () => {
        out = (request.result as T | undefined) ?? null;
      };
    });
    return out;
  }

  private async put(store: string, record: { id: string }): Promise<void> {
    const db = await this.handle();
    await run(db, [store], 'readwrite', (tx) => {
      tx.objectStore(store).put(record);
    });
  }

  /** Same id, later `updatedAt` wins — the rule the account sync already uses. */
  private async merge(store: StoreName, records: { id: string; updatedAt: number }[]): Promise<void> {
    if (!records.length) return;
    const db = await this.handle();
    await run(db, [store], 'readwrite', (tx) => {
      const objects = tx.objectStore(store);
      for (const record of records) {
        const request = objects.get(record.id);
        request.onsuccess = () => {
          const existing = request.result as { updatedAt?: number } | undefined;
          if (existing && (existing.updatedAt ?? 0) >= record.updatedAt) return;
          objects.put(record);
        };
      }
    });
  }
}

function upgrade(db: IDBDatabase, tx: IDBTransaction | null): void {
  if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('pages')) {
    const pages = db.createObjectStore('pages', { keyPath: 'id' });
    // The one query that is a real query: a doc's pages.
    pages.createIndex('docId', 'docId', { unique: false });
  } else if (tx) {
    const pages = tx.objectStore('pages');
    if (!pages.indexNames.contains('docId')) pages.createIndex('docId', 'docId', { unique: false });
  }
  if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('views')) db.createObjectStore('views', { keyPath: 'id' });
  if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: 'id' });
  if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' });
}

/**
 * One transaction, resolved when it commits rather than when the last request
 * answers. A request that succeeds inside a transaction that then aborts —
 * quota, most likely — has not written anything, and resolving early would
 * report a save that did not happen.
 */
function run(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (err) {
      reject(new CodexUnavailable(message(err)));
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(new CodexUnavailable(message(tx.error)));
    tx.onerror = () => reject(new CodexUnavailable(message(tx.error)));
    try {
      work(tx);
    } catch (err) {
      tx.abort();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function live<T extends { deletedAt?: number }>(records: T[]): T[] {
  return records.filter((record) => !record.deletedAt);
}

function message(error: unknown): string {
  if (error instanceof DOMException) {
    return error.name === 'QuotaExceededError'
      ? 'There is no room left in this browser for the Codex.'
      : `${error.name}: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'Storage refused.';
}
