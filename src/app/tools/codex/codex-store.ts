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
import type { Doc, Entry, Page, SavedView } from './codex-types';
import type { CodexDriver, StorageUse, StoreName } from './codex-driver';
import { LocalDriver } from './codex-db';
import { newDoc } from './codex-schema';

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

  async remove(store: StoreName, id: string): Promise<boolean> {
    if (!(await this.write(() => this.driver.remove(store, id)))) return false;
    const drop = <T extends { id: string }>(list: T[]) => list.filter((item) => item.id !== id);
    if (store === 'docs') this.docs.update(drop);
    if (store === 'pages') this.pages.update(drop);
    if (store === 'entries') this.entries.update(drop);
    if (store === 'views') this.views.update(drop);
    void this.refreshUsage();
    return true;
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
