/**
 * The Codex — one place for the links, notes, builds, atlases and strategies
 * that otherwise live in a spreadsheet.
 *
 * Two halves. The **library** is everything you kept, flat and searchable; the
 * search box, the tag list and the saved views are three ways of asking it the
 * same question, and all three write into the same query string, so what you
 * learn by clicking is what you can then type.
 *
 * A **page** is an arrangement of things the library already holds. It owns
 * nothing: the same entry can sit on this league's page and on the permanent
 * one, edited from either. That is the difference between this and the
 * documents it replaces, where having a link in two places means pasting it
 * twice and letting the two drift apart.
 */
import { Component, computed, inject, signal } from '@angular/core';
import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';
import { CodexStore } from './codex-store';
import { CodexPage } from './codex-page';
import { CodexEntryCard } from './codex-entry-card';
import { CodexEntryEditor } from './codex-entry-editor';
import { CodexAssetImg } from './codex-asset-img';
import { capture, noteBody } from './codex-capture';
import { imageTitle, imagesIn } from './codex-image';
import { parseQuery, runQuery, toggleTerm } from './codex-query';
import { count, mb, typeOf, when } from './codex-format';
import type { Doc, Entry, Page, PageLayout } from './codex-types';

const LAYOUT_KEY = 'poe_codex_layout';
const GROUP_KEY = 'poe_codex_group';

export type GroupKey = 'none' | 'type' | 'tag' | 'league' | 'status';
const GROUPS: GroupKey[] = ['type', 'tag', 'league', 'status', 'none'];

/** The shortcuts along the top of the list: the questions asked most often. */
const QUICK: { label: string; query: string; title: string }[] = [
  { label: 'All', query: '', title: 'Everything that is not dead' },
  { label: 'Inbox', query: 'is:inbox', title: 'Captured and not filed anywhere yet' },
  { label: 'Strategies', query: 'kind:strategy sort:perhour', title: 'Best measured first' },
  { label: 'Builds', query: 'kind:build', title: 'Builds and their PoBs' },
  { label: 'Filters', query: 'role:filter', title: 'Loot filters' },
  { label: 'Atlases', query: 'kind:atlas', title: 'Trees, ours and everybody else’s' },
  { label: 'Measured', query: 'has:runs sort:perhour', title: 'Anything somebody timed' },
  { label: 'Dead', query: 'status:dead', title: 'Kept, and out of the way' },
];

@Component({
  selector: 'app-codex',
  imports: [PoeCard, ToolPage, CodexPage, CodexEntryCard, CodexEntryEditor, CodexAssetImg],
  templateUrl: './codex.html',
})
export class Codex {
  readonly store = inject(CodexStore);
  readonly quick = QUICK;
  readonly groupKeys = GROUPS;

  // --- docs and pages ----------------------------------------------------------
  readonly title = signal('');
  readonly league = signal('');
  readonly busy = signal(false);
  readonly docs = this.store.docs;

  /** Empty means the library is on screen; a page id means that page is. */
  readonly openPage = signal('');
  readonly page = computed(() => this.store.pages().find((p) => p.id === this.openPage()) ?? null);

  // --- capture -----------------------------------------------------------------
  readonly captureText = signal('');
  readonly captureMessage = signal('');
  readonly over = signal(false);

  // --- the library -------------------------------------------------------------
  readonly query = signal('');
  readonly layout = signal<PageLayout>(readLayout());
  readonly group = signal<GroupKey>(readGroup());
  readonly viewName = signal('');

  readonly results = computed(() =>
    runQuery(this.store.entries(), parseQuery(this.query()), { placed: this.store.placed() }),
  );

  /**
   * The results, cut into sections.
   *
   * A flat list of everything is a pile, and a pile is what the spreadsheet
   * already was. This is the cheap half of the answer; the other half is a
   * page, which arranges entries by hand rather than by field.
   */
  readonly groups = computed(() => {
    const key = this.group();
    const results = this.results();
    if (key === 'none') return [{ label: '', entries: results }];

    const buckets = new Map<string, Entry[]>();
    const push = (label: string, entry: Entry) => {
      const bucket = buckets.get(label);
      if (bucket) bucket.push(entry);
      else buckets.set(label, [entry]);
    };
    for (const entry of results) {
      if (key === 'tag') {
        // Under every tag it carries, not just the first. A strategy that is
        // both #legion and #day-1 is an answer to both questions, and hiding it
        // from one of them to avoid seeing it twice is the wrong trade.
        if (!entry.tags.length) push('untagged', entry);
        else for (const tag of entry.tags) push(tag, entry);
      } else if (key === 'type') push(typeOf(entry), entry);
      else if (key === 'league') push(entry.league || 'no league', entry);
      else push(entry.status ?? 'unmarked', entry);
    }
    return [...buckets]
      .map(([label, entries]) => ({ label, entries }))
      .sort((a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label));
  });

  /** Tags of what is on screen, so clicking two in a row narrows rather than guesses. */
  readonly visibleTags = computed(() => {
    const counts = new Map<string, number>();
    for (const entry of this.results()) {
      for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30);
  });

  /** The open editor, and which section it was opened from — see `open`. */
  readonly openEntry = signal('');
  readonly openIn = signal('');

  readonly canCreate = computed(() => this.title().trim().length > 0 && !this.busy());

  constructor() {
    this.league.set(this.store.currentLeague());
    void this.store.load();
  }

  // --- docs and pages ----------------------------------------------------------

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

  async removeDoc(doc: Doc): Promise<void> {
    await this.store.remove('docs', doc.id);
    if (!this.page()) this.openPage.set('');
  }

  /** Top-level pages of a doc, in the order they were made. */
  pagesOf(doc: Doc): Page[] {
    return this.store
      .pages()
      .filter((page) => page.docId === doc.id && !page.parentId)
      .sort((a, b) => a.order - b.order);
  }

  childrenOf(page: Page): Page[] {
    return this.store
      .pages()
      .filter((child) => child.parentId === page.id)
      .sort((a, b) => a.order - b.order);
  }

  /**
   * A new page is named "New page" rather than asking first: the title is one
   * click away at the top of the page you just opened, and a dialog in front of
   * an empty page is a dialog in front of nothing.
   */
  async addPage(doc: Doc, parent: Page | null = null): Promise<void> {
    const page = await this.store.createPage(doc.id, parent ? 'New section' : 'New page', parent?.id ?? null);
    if (page) this.openPage.set(page.id);
  }

  async removePage(page: Page): Promise<void> {
    await this.store.remove('pages', page.id);
    if (this.openPage() === page.id) this.openPage.set('');
  }

  show(page: Page | null): void {
    this.openPage.set(page?.id ?? '');
    this.openEntry.set('');
  }

  // --- capture -----------------------------------------------------------------

  onCapture(event: Event): void {
    this.captureText.set((event.target as HTMLTextAreaElement).value);
  }

  async keep(): Promise<void> {
    const text = this.captureText();
    const items = capture(text);
    if (!items.length) return;
    // A paste with no link in it is one note, and everything after its first
    // line is the note itself rather than a title nobody will read.
    const body = items.length === 1 && items[0].kind === 'note' ? noteBody(text) : '';
    const written = await this.store.addEntries(
      items.map((item, index) => ({ ...item, body: index === 0 ? body : '' })),
    );
    if (!written.length) return;
    this.captureText.set('');
    this.captureMessage.set(
      written.length === 1 ? `Kept "${trim(written[0].title)}".` : `Kept ${written.length} entries.`,
    );
    // One entry alone is almost always worth a tag straight away; a list of
    // thirty is not, and opening the last of them would hide the other
    // twenty-nine.
    if (written.length === 1) this.open(written[0], '');
  }

  /**
   * A screenshot on the clipboard.
   *
   * This is how the evidence actually arrives: Print Screen, alt-tab, paste.
   * One of the three source documents is nothing but screenshots of a loot
   * tracker, pasted into a spreadsheet that had nowhere to put the numbers in
   * them — so the box that takes links takes pictures too, and each one becomes
   * an entry that can be tagged, found and put on a page.
   */
  onPaste(event: ClipboardEvent): void {
    const images = imagesIn(event.clipboardData);
    if (!images.length) return;
    event.preventDefault();
    void this.keepImages(images);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.over.set(true);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.over.set(false);
    void this.keepImages(imagesIn(event.dataTransfer));
  }

  onFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.keepImages([...(input.files ?? [])]);
    input.value = '';
  }

  private async keepImages(files: File[]): Promise<void> {
    if (!files.length || this.busy()) return;
    this.busy.set(true);
    let kept = 0;
    for (const file of files) {
      const image = await this.store.addImage(file);
      if (!image) break;
      const entry = await this.store.addEntries([
        {
          kind: 'image',
          title: imageTitle(file.name),
          data: {
            k: 'image',
            assetId: image.assetId,
            thumbId: image.thumbId,
            w: image.w,
            h: image.h,
          },
        },
      ]);
      if (!entry.length) break;
      kept++;
      if (files.length === 1) this.open(entry[0], '');
    }
    this.busy.set(false);
    if (kept) this.captureMessage.set(kept === 1 ? 'Kept the picture.' : `Kept ${kept} pictures.`);
  }

  // --- the query ---------------------------------------------------------------

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  setQuery(value: string): void {
    this.query.set(value);
    this.openPage.set('');
  }

  toggle(term: string): void {
    this.query.set(toggleTerm(this.query(), term));
    this.openPage.set('');
  }

  active(term: string): boolean {
    return this.query().toLowerCase().split(/\s+/).includes(term.toLowerCase());
  }

  setLayout(layout: PageLayout): void {
    this.layout.set(layout);
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // private mode: the list still works, it just forgets how you like it
    }
  }

  setGroup(key: GroupKey): void {
    this.group.set(key);
    try {
      localStorage.setItem(GROUP_KEY, key);
    } catch {
      // see setLayout
    }
  }

  onViewName(event: Event): void {
    this.viewName.set((event.target as HTMLInputElement).value);
  }

  async saveView(): Promise<void> {
    const view = await this.store.addView(this.viewName(), this.query(), this.layout());
    if (view) this.viewName.set('');
  }

  // --- editing -----------------------------------------------------------------

  /**
   * Grouping by tag lists an entry under each of its tags, so the editor is
   * pinned to the section it was opened from — otherwise one click would open
   * the same editor three times down the page.
   */
  open(entry: Entry, section: string): void {
    if (this.openEntry() === entry.id && this.openIn() === section) {
      this.close();
      return;
    }
    this.openEntry.set(entry.id);
    this.openIn.set(section);
  }

  close(): void {
    this.openEntry.set('');
  }

  async saveEntry(entry: Entry): Promise<void> {
    if (await this.store.saveEntry(entry)) this.close();
  }

  async removeEntry(entry: Entry): Promise<void> {
    if (await this.store.remove('entries', entry.id)) this.close();
  }

  // --- reading -----------------------------------------------------------------

  count(n: number, word: string): string {
    return count(n, word);
  }

  when(at: number): string {
    return when(at);
  }

  readonly storageLine = computed(() => {
    const usage = this.store.usage();
    if (!usage) return '';
    return `${mb(usage.used)} used of about ${mb(usage.quota)} this browser offers`;
  });
}

function trim(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function readGroup(): GroupKey {
  try {
    const saved = localStorage.getItem(GROUP_KEY) as GroupKey | null;
    if (saved && GROUPS.includes(saved)) return saved;
  } catch {
    // see setLayout
  }
  return 'type';
}

function readLayout(): PageLayout {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved === 'cards' || saved === 'table' || saved === 'list') return saved;
  } catch {
    // see setLayout
  }
  return 'list';
}
