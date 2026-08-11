/**
 * The Codex — one place for the links, notes, builds, atlases and strategies
 * that otherwise live in a spreadsheet.
 *
 * This is the frame: the drawer opens, docs go in and come back after a
 * refresh, and the page says plainly where they are kept and how much room is
 * left. Entries, pages and everything that makes it worth using arrive on top
 * of this; see docs/codex-plan.md.
 */
import { Component, computed, inject, signal } from '@angular/core';
import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';
import { CodexStore } from './codex-store';
import type { Doc } from './codex-types';

@Component({
  selector: 'app-codex',
  imports: [PoeCard, ToolPage],
  templateUrl: './codex.html',
})
export class Codex {
  readonly store = inject(CodexStore);

  readonly title = signal('');
  readonly league = signal('');
  readonly busy = signal(false);

  readonly docs = this.store.docs;
  readonly canCreate = computed(() => this.title().trim().length > 0 && !this.busy());

  constructor() {
    this.league.set(this.store.currentLeague());
    void this.store.load();
  }

  onTitle(event: Event): void {
    this.title.set((event.target as HTMLInputElement).value);
  }

  onLeague(event: Event): void {
    this.league.set((event.target as HTMLInputElement).value);
  }

  async create(): Promise<void> {
    if (!this.canCreate()) return;
    this.busy.set(true);
    const doc = await this.store.createDoc(this.title(), this.league());
    this.busy.set(false);
    if (doc) this.title.set('');
  }

  async remove(doc: Doc): Promise<void> {
    await this.store.remove('docs', doc.id);
  }

  pagesIn(doc: Doc): number {
    return this.store.pages().filter((page) => page.docId === doc.id).length;
  }

  /** "1 entry", "2 entries" — a count that reads wrong is a count nobody trusts. */
  count(n: number, word: string): string {
    if (n === 1) return `1 ${word}`;
    return `${n} ${word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;
  }

  /** "3 days ago" reads better than a date nobody wrote down. */
  when(at: number): string {
    if (!at) return '';
    const days = Math.floor((Date.now() - at) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return new Date(at).toLocaleDateString();
  }

  readonly storageLine = computed(() => {
    const usage = this.store.usage();
    if (!usage) return '';
    return `${mb(usage.used)} used of about ${mb(usage.quota)} this browser offers`;
  });
}

function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const value = bytes / (1024 * 1024);
  return value < 100 ? `${value.toFixed(1)} MB` : `${Math.round(value)} MB`;
}
