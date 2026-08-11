/**
 * The Codex, in memory.
 *
 * One read at startup, then everything is a signal. The whole library is a few
 * thousand small records at worst, and holding it means search, filters and
 * backlinks are plain array work rather than a query language over IndexedDB —
 * which is the difference between a filter that feels instant and one that
 * flickers.
 *
 * Writes go to the driver first and to the signal after. The other way round
 * shows a save that did not happen, and quota is exactly the kind of failure
 * that arrives without warning once screenshots are involved.
 */
import { computed, Injectable, signal } from '@angular/core';
import { DEFAULT_TREE_VERSION, findTreeVersion } from '../atlas/tree-versions';
import type { Doc, Entry, EntryData, EntryKind, Page, PageLayout, SavedView } from './codex-types';
import type { CodexDriver, NewAsset, StorageUse, StoreName } from './codex-driver';
import { LocalDriver } from './codex-db';
import { newDoc, newEntry, newPage, newView, normaliseTags } from './codex-schema';
import { placedIds, tagCounts } from './codex-query';
import { fitWithin, prepareImage, THUMB_MAX } from './codex-image';

@Injectable({ providedIn: 'root' })
export class CodexStore {
  /**
   * Local for now. When there is an account this becomes a choice between two
   * implementations of the same interface, and nothing below this line changes.
   */
  private readonly driver: CodexDriver = new LocalDriver();

  readonly ready = signal(false);
  readonly error = signal('');
  readonly docs = signal<Doc[]>([]);
  readonly pages = signal<Page[]>([]);
  readonly entries = signal<Entry[]>([]);
  readonly views = signal<SavedView[]>([]);
  readonly assetCount = signal(0);
  readonly usage = signal<StorageUse | null>(null);

  /**
   * What a new doc's league starts as. The atlas dataset is the only place in
   * the app that knows which league this build is for, and a prefilled field
   * that is wrong once a year beats an empty one that is wrong every time.
   */
  readonly currentLeague = computed(() => findTreeVersion(DEFAULT_TREE_VERSION)?.label ?? '');

  /** Which entries sit on a page — what `is:orphan` and the Inbox are read off. */
  readonly placed = computed(() => placedIds(this.pages()));

  /** Every tag in use and how many carry it, for the list you filter by clicking. */
  readonly tags = computed(() =>
    [...tagCounts(this.entries())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );

  private loading: Promise<void> | null = null;

  /** Safe to call from every component that needs the Codex; the read happens once. */
  load(): Promise<void> {
    if (this.ready() || this.loading) return this.loading ?? Promise.resolve();
    this.loading = this.read().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async read(): Promise<void> {
    try {
      await this.driver.open();
      const [docs, pages, entries, views, assets, usage] = await Promise.all([
        this.driver.docs(),
        this.driver.pages(),
        this.driver.entries(),
        this.driver.views(),
        this.driver.assets(),
        this.driver.usage(),
      ]);
      this.docs.set(sortDocs(docs));
      this.pages.set(pages);
      this.entries.set(entries);
      this.views.set(views);
      this.assetCount.set(assets.length);
      this.usage.set(usage);
      this.ready.set(true);
      this.error.set('');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'The Codex could not be opened.');
    }
  }

  async createDoc(title: string, league: string): Promise<Doc | null> {
    const named = title.trim();
    if (!named) return null;
    const doc = newDoc(named, league);
    if (!(await this.write(() => this.driver.putDoc(doc)))) return null;
    this.docs.update((docs) => sortDocs([...docs, doc]));
    void this.refreshUsage();
    return doc;
  }

  async saveDoc(doc: Doc): Promise<boolean> {
    const next: Doc = { ...doc, updatedAt: Date.now() };
    if (!(await this.write(() => this.driver.putDoc(next)))) return false;
    this.docs.update((docs) => sortDocs(docs.map((d) => (d.id === next.id ? next : d))));
    return true;
  }

  /**
   * Capture writes several entries at once — a pasted list is a list — so the
   * signal is set once at the end rather than per entry, and a failure part way
   * through keeps what did get written instead of pretending none of it did.
   */
  async addEntries(items: { kind: EntryKind; title: string; data: EntryData; body?: string }[]): Promise<Entry[]> {
    const written: Entry[] = [];
    // The list is newest first, so a pasted list stamped line by line comes out
    // upside down, and one shared timestamp leaves the order to whatever
    // IndexedDB hands back. So the batch is stamped a millisecond apart with
    // the first line newest: the milliseconds inside one paste are not data,
    // but the order somebody wrote the list in is.
    const at = Date.now();
    for (const [index, item] of items.entries()) {
      const entry = {
        ...newEntry(item.kind, item.title, item.data),
        createdAt: at - index,
        updatedAt: at - index,
      };
      if (item.body) entry.body = item.body;
      if (!(await this.write(() => this.driver.putEntry(entry)))) break;
      written.push(entry);
    }
    if (written.length) {
      this.entries.update((entries) => [...written, ...entries]);
      void this.refreshUsage();
    }
    return written;
  }

  /**
   * Saving under a name that is already taken replaces it, which is what
   * "save" means everywhere else in this app — the atlas and strategy
   * libraries both work that way, and this is the button next to them.
   */
  async keepNamed(
    kind: EntryKind,
    title: string,
    data: EntryData,
    extra: Partial<Entry> = {},
  ): Promise<Entry | null> {
    const named = title.trim();
    if (!named) return null;
    const existing = this.entries().find(
      (entry) => entry.kind === kind && entry.title.toLowerCase() === named.toLowerCase(),
    );
    const entry: Entry = existing
      ? { ...existing, ...extra, title: named, data, updatedAt: Date.now() }
      : { ...newEntry(kind, named, data), ...extra };
    if (!(await this.write(() => this.driver.putEntry(entry)))) return null;
    this.entries.update((entries) =>
      existing ? entries.map((e) => (e.id === entry.id ? entry : e)) : [entry, ...entries],
    );
    void this.refreshUsage();
    return entry;
  }

  async saveEntry(entry: Entry): Promise<boolean> {
    const next: Entry = { ...entry, tags: normaliseTags(entry.tags), updatedAt: Date.now() };
    if (!(await this.write(() => this.driver.putEntry(next)))) return false;
    this.entries.update((entries) => entries.map((e) => (e.id === next.id ? next : e)));
    return true;
  }

  async createPage(docId: string, title: string, parentId: string | null = null): Promise<Page | null> {
    const named = title.trim();
    if (!named) return null;
    const siblings = this.pages().filter((page) => page.docId === docId && page.parentId === parentId);
    const page = newPage(docId, named, siblings.length);
    page.parentId = parentId;
    if (!(await this.write(() => this.driver.putPage(page)))) return null;
    this.pages.update((pages) => [...pages, page]);
    return page;
  }

  async savePage(page: Page): Promise<boolean> {
    const next: Page = { ...page, updatedAt: Date.now() };
    if (!(await this.write(() => this.driver.putPage(next)))) return false;
    this.pages.update((pages) => pages.map((p) => (p.id === next.id ? next : p)));
    return true;
  }

  async addView(name: string, query: string, layout: PageLayout): Promise<SavedView | null> {
    const named = name.trim();
    if (!named) return null;
    const view = newView(named, query, layout);
    if (!(await this.write(() => this.driver.putView(view)))) return null;
    this.views.update((views) => [...views, view]);
    return view;
  }

  async remove(store: StoreName, id: string): Promise<boolean> {
    if (!(await this.write(() => this.driver.remove(store, id)))) return false;
    const drop = <T extends { id: string }>(list: T[]) => list.filter((item) => item.id !== id);
    if (store === 'docs') this.docs.update(drop);
    if (store === 'pages') {
      // A subpage without its parent is unreachable, so it goes too. The
      // entries on either are untouched: a page never owned them.
      const children = this.pages().filter((page) => page.parentId === id);
      for (const child of children) await this.write(() => this.driver.remove('pages', child.id));
      this.pages.update((pages) => pages.filter((page) => page.id !== id && page.parentId !== id));
    }
    if (store === 'entries') this.entries.update(drop);
    if (store === 'views') this.views.update(drop);
    void this.refreshUsage();
    return true;
  }

  /**
   * A pasted or dropped picture: shrunk, converted, and stored twice — the
   * full one for the lightbox and a small one for the cards. See
   * codex-image.ts for why nothing is kept as it arrived.
   */
  async addImage(source: Blob): Promise<{ assetId: string; thumbId: string; w: number; h: number } | null> {
    const prepared = await prepareImage(source);
    if (!prepared) {
      this.error.set('That file could not be read as an image.');
      return null;
    }
    const assetId = await this.addAsset(prepared.full, {
      type: 'image/webp',
      w: prepared.w,
      h: prepared.h,
    });
    if (!assetId) return null;
    const thumbSize = fitWithin(prepared.w, prepared.h, THUMB_MAX);
    const thumbId = await this.addAsset(prepared.thumb, {
      type: 'image/webp',
      w: thumbSize.w,
      h: thumbSize.h,
    });
    if (!thumbId) return null;
    return { assetId, thumbId, w: prepared.w, h: prepared.h };
  }

  /**
   * What the lightbox is showing, if anything. It lives here because the card
   * that opens one and the overlay that draws it are in different components,
   * and the alternative is threading an event through every list on the page.
   */
  readonly lightbox = signal<{ assetId?: string; url?: string; title: string } | null>(null);

  /** Stores an image and hands back its id, or null when the write failed. */
  async addAsset(blob: Blob, meta: NewAsset): Promise<string | null> {
    try {
      const asset = await this.driver.putAsset(blob, meta);
      this.assetCount.update((n) => n + 1);
      void this.refreshUsage();
      return asset.id;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'That image could not be stored.');
      return null;
    }
  }

  /**
   * An object URL per asset, made once and kept.
   *
   * They are only released when the tab goes, which is the right trade here: a
   * Codex holds tens of images, not thousands, and revoking one that a card is
   * still showing turns it into a broken picture with no way back.
   */
  private readonly urls = new Map<string, string>();

  async assetUrl(id: string): Promise<string> {
    const known = this.urls.get(id);
    if (known) return known;
    const blob = await this.driver.asset(id);
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    this.urls.set(id, url);
    return url;
  }

  private async refreshUsage(): Promise<void> {
    this.usage.set(await this.driver.usage());
  }

  /** Every write funnels through here so a failure is reported once, not eight times. */
  private async write(work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      this.error.set('');
      return true;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'That could not be saved.');
      return false;
    }
  }
}

/** Newest first: the doc you are in the middle of is the one you want. */
function sortDocs(docs: Doc[]): Doc[] {
  return [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
}
