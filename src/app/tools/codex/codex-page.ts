/**
 * A page: the arrangement, as opposed to the library.
 *
 * Nothing here owns anything. A page holds references, so putting an entry on
 * two pages is putting the same entry in two places — edit it from either and
 * both change, delete the page and the entry stays. That is the one thing the
 * spreadsheets this replaces cannot do: there, the only way to have the filter
 * links on both this league's sheet and the permanent one is to paste them
 * twice and let them drift.
 *
 * A page is arranged by hand (`curated`) or by question (`query`). The second
 * is what a custom group actually is — "strategies for this build, best paid
 * first" stays right when a new strategy is tagged tomorrow, and a hand-made
 * list does not.
 */
import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { CodexStore } from './codex-store';
import { CodexEntryCard } from './codex-entry-card';
import { CodexEntryEditor } from './codex-entry-editor';
import { insertBlock, moveBlock, nudgeBlock, removeBlock, updateBlock, type BlockPath } from './codex-blocks';
import { parseQuery, runQuery } from './codex-query';
import { count } from './codex-format';
import type { Block, Entry, Page, PageLayout } from './codex-types';

@Component({
  selector: 'codex-page',
  imports: [NgTemplateOutlet, CodexEntryCard, CodexEntryEditor],
  templateUrl: './codex-page.html',
})
export class CodexPage {
  readonly page = input.required<Page>();
  private readonly store = inject(CodexStore);

  readonly layouts: PageLayout[] = ['list', 'cards', 'table'];

  /** Which block's "add" menu is open, and where it would insert. */
  readonly adding = signal<BlockPath | null>(null);
  /** Same, for the entry picker, which needs a search of its own. */
  readonly picking = signal<BlockPath | null>(null);
  readonly pickQuery = signal('');
  readonly dragging = signal<BlockPath | null>(null);
  readonly openEntry = signal<string>('');

  readonly byId = computed(() => new Map(this.store.entries().map((entry) => [entry.id, entry])));

  readonly pickResults = computed(() =>
    runQuery(this.store.entries(), parseQuery(this.pickQuery()), {
      placed: this.store.placed(),
    }).slice(0, 40),
  );

  /** For `mode: 'query'` — the page is a saved question, answered every time. */
  readonly queryResults = computed(() =>
    runQuery(this.store.entries(), parseQuery(this.page().query ?? ''), {
      placed: this.store.placed(),
    }),
  );

  entry(id: string): Entry | undefined {
    return this.byId().get(id);
  }

  private samePath(a: BlockPath | null, b: BlockPath): boolean {
    return !!a && a.length === b.length && a.every((n, i) => n === b[i]);
  }

  isAdding(path: BlockPath): boolean {
    return this.samePath(this.adding(), path);
  }

  isPicking(path: BlockPath): boolean {
    return this.samePath(this.picking(), path);
  }

  openAdd(path: BlockPath): void {
    this.picking.set(null);
    this.adding.update((open) => (this.samePath(open, path) ? null : path));
  }

  liveResults(query: string): Entry[] {
    return runQuery(this.store.entries(), parseQuery(query), { placed: this.store.placed() });
  }

  countOf(n: number, word: string): string {
    return count(n, word);
  }

  // --- the page itself ---------------------------------------------------------

  private write(patch: Partial<Page>): void {
    void this.store.savePage({ ...this.page(), ...patch });
  }

  rename(event: Event): void {
    this.write({ title: (event.target as HTMLInputElement).value });
  }

  setMode(mode: Page['mode']): void {
    this.write({ mode });
  }

  setLayout(layout: PageLayout): void {
    this.write({ layout });
  }

  onQuery(event: Event): void {
    this.write({ query: (event.target as HTMLInputElement).value });
  }

  // --- blocks ------------------------------------------------------------------

  private blocks(next: Block[]): void {
    this.write({ blocks: next });
  }

  add(path: BlockPath, block: Block): void {
    this.blocks(insertBlock(this.page().blocks, path, block));
    this.adding.set(null);
    this.picking.set(null);
    this.pickQuery.set('');
  }

  addKind(path: BlockPath, kind: Block['t']): void {
    if (kind === 'entry') {
      this.picking.set(path);
      this.adding.set(null);
      return;
    }
    const block: Block =
      kind === 'heading'
        ? { t: 'heading', text: 'Heading', level: 2 }
        : kind === 'text'
          ? { t: 'text', md: '' }
          : kind === 'columns'
            ? { t: 'columns', cols: [[], []] }
            : kind === 'query'
              ? { t: 'query', q: 'kind:strategy sort:perhour', layout: 'list' }
              : { t: 'divider' };
    this.add(path, block);
  }

  update(path: BlockPath, block: Block): void {
    this.blocks(updateBlock(this.page().blocks, path, block));
  }

  patchText(path: BlockPath, block: Block, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    if (block.t === 'heading') this.update(path, { ...block, text: value });
    if (block.t === 'text') this.update(path, { ...block, md: value });
    if (block.t === 'query') this.update(path, { ...block, q: value });
  }

  remove(path: BlockPath): void {
    this.blocks(removeBlock(this.page().blocks, path));
  }

  nudge(path: BlockPath, delta: -1 | 1): void {
    this.blocks(nudgeBlock(this.page().blocks, path, delta));
  }

  // --- dragging ----------------------------------------------------------------

  dragStart(path: BlockPath): void {
    this.dragging.set(path);
  }

  allowDrop(event: DragEvent): void {
    // Without this the browser refuses the drop and the block springs back,
    // which reads as "it did not work" rather than "this is not a target".
    if (this.dragging()) event.preventDefault();
  }

  drop(path: BlockPath, event: DragEvent): void {
    event.preventDefault();
    const from = this.dragging();
    this.dragging.set(null);
    if (!from) return;
    this.blocks(moveBlock(this.page().blocks, from, path));
  }

  // --- entries on the page ------------------------------------------------------

  onPick(event: Event): void {
    this.pickQuery.set((event.target as HTMLInputElement).value);
  }

  pick(id: string): void {
    const path = this.picking();
    if (path) this.add(path, { t: 'entry', id });
  }

  toggleEntry(id: string): void {
    this.openEntry.update((open) => (open === id ? '' : id));
  }

  async saveEntry(entry: Entry): Promise<void> {
    if (await this.store.saveEntry(entry)) this.openEntry.set('');
  }

  async removeEntry(entry: Entry): Promise<void> {
    if (await this.store.remove('entries', entry.id)) this.openEntry.set('');
  }

  /** Taking an entry off a page is not deleting it — it stays in the library. */
  removeAt(path: BlockPath): void {
    this.remove(path);
  }
}
