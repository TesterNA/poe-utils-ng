/**
 * The Codex — one place for the links, notes, builds, atlases and strategies
 * that otherwise live in a spreadsheet.
 *
 * The page is a library and a way through it. Everything captured lands in one
 * flat set of entries; the search box, the tag list and the saved views are
 * three ways of asking the same question, and all three write to the same query
 * string — clicking a tag types `tag:legion` for you, so the thing you learn by
 * clicking is the thing you can then type.
 *
 * Docs are still here at the top. In the next phase they grow pages, and a page
 * arranges these entries without owning them.
 */
import { Component, computed, inject, signal } from '@angular/core';
import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';
import { CodexStore } from './codex-store';
import { capture, noteBody } from './codex-capture';
import { parseQuery, pointsOf, runQuery, toggleTerm } from './codex-query';
import { perHourLabel, runTotals } from './codex-metrics';
import { parseTagInput } from './codex-schema';
import type { Doc, Entry, PageLayout } from './codex-types';

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
  imports: [PoeCard, ToolPage],
  templateUrl: './codex.html',
})
export class Codex {
  readonly store = inject(CodexStore);
  readonly quick = QUICK;

  // --- docs -------------------------------------------------------------------
  readonly title = signal('');
  readonly league = signal('');
  readonly busy = signal(false);
  readonly docs = this.store.docs;

  // --- capture ----------------------------------------------------------------
  readonly captureText = signal('');
  readonly captureMessage = signal('');

  // --- the list ---------------------------------------------------------------
  readonly query = signal('');
  readonly layout = signal<PageLayout>(readLayout());
  readonly viewName = signal('');

  readonly results = computed(() =>
    runQuery(this.store.entries(), parseQuery(this.query()), { placed: this.store.placed() }),
  );

  /**
   * How the results are cut into sections.
   *
   * A flat list of everything is a pile, and a pile is what the spreadsheet
   * already was. Grouping is the cheap half of the answer — the other half is
   * pages, which arrange entries by hand instead of by field.
   */
  readonly group = signal<GroupKey>(readGroup());
  readonly groupKeys = GROUPS;

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

  // --- the open entry ---------------------------------------------------------
  readonly draft = signal<Entry | null>(null);
  readonly draftTags = signal('');
  /** which section the open editor belongs to — see `open` */
  readonly openIn = signal('');

  readonly canCreate = computed(() => this.title().trim().length > 0 && !this.busy());

  constructor() {
    this.league.set(this.store.currentLeague());
    void this.store.load();
  }

  // --- docs -------------------------------------------------------------------

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
  }

  pagesIn(doc: Doc): number {
    return this.store.pages().filter((page) => page.docId === doc.id).length;
  }

  // --- capture ----------------------------------------------------------------

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
    // thirty is not, and opening the last of them would hide the other twenty-nine.
    if (written.length === 1) this.open(written[0]);
  }

  // --- the query --------------------------------------------------------------

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  setQuery(value: string): void {
    this.query.set(value);
  }

  toggle(term: string): void {
    this.query.set(toggleTerm(this.query(), term));
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

  // --- editing ----------------------------------------------------------------

  /**
   * Grouping by tag lists an entry under each of its tags, so the editor is
   * pinned to the section it was opened from — otherwise one click would open
   * the same editor three times down the page.
   */
  open(entry: Entry, section = ''): void {
    if (this.draft()?.id === entry.id && this.openIn() === section) {
      this.close();
      return;
    }
    this.draft.set({ ...entry });
    this.openIn.set(section);
    this.draftTags.set(entry.tags.join(' '));
  }

  close(): void {
    this.draft.set(null);
  }

  patch(field: 'title' | 'body' | 'league' | 'status' | 'url', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.draft.update((draft) => {
      if (!draft) return draft;
      if (field === 'url') {
        return draft.data.k === 'link' ? { ...draft, data: { ...draft.data, url: value } } : draft;
      }
      if (field === 'status') {
        const next = { ...draft };
        if (value) next.status = value as Entry['status'];
        else delete next.status;
        return next;
      }
      return { ...draft, [field]: value };
    });
  }

  onDraftTags(event: Event): void {
    this.draftTags.set((event.target as HTMLInputElement).value);
  }

  togglePoe2(): void {
    this.draft.update((draft) =>
      draft ? { ...draft, game: draft.game === 'poe2' ? undefined : 'poe2' } : draft,
    );
  }

  togglePinned(): void {
    this.draft.update((draft) => (draft ? { ...draft, pinned: !draft.pinned } : draft));
  }

  async saveDraft(): Promise<void> {
    const draft = this.draft();
    if (!draft) return;
    const saved = await this.store.saveEntry({
      ...draft,
      tags: parseTagInput(this.draftTags()),
    });
    if (saved) this.close();
  }

  async removeEntry(entry: Entry): Promise<void> {
    if (await this.store.remove('entries', entry.id)) this.close();
  }

  // --- how an entry reads -----------------------------------------------------

  url(entry: Entry): string {
    if (entry.data.k === 'link') return entry.data.url;
    if (entry.data.k === 'atlas') return entry.data.src.url ?? '';
    return '';
  }

  /** The grey line under a title: what it is, and where it points. */
  subtitle(entry: Entry): string {
    const bits: string[] = [];
    if (entry.data.k === 'link') {
      bits.push(entry.data.role ? roleLabel(entry.data.role) : 'link');
      if (entry.data.host) bits.push(entry.data.host);
      if (entry.data.filter?.stage) bits.push(entry.data.filter.stage);
    } else {
      bits.push(entry.kind);
    }
    if (entry.league) bits.push(entry.league);
    const points = pointsOf(entry);
    if (points) bits.push(`${points} pts`);
    const rate = perHourLabel(runTotals(entry.runs));
    if (rate) bits.push(rate);
    if (entry.status && entry.status !== 'live') bits.push(entry.status);
    return bits.join(' · ');
  }

  excerpt(entry: Entry): string {
    const body = entry.body.trim().replace(/\s+/g, ' ');
    return body.length > 160 ? `${body.slice(0, 160)}…` : body;
  }

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

/**
 * What section an entry belongs under.
 *
 * Grouping links by `kind` would put every one of them in a bucket called
 * "link", which is the pile again. What differs between them is what they are
 * for — a PoB, a video, a filter — and that is the heading the source
 * documents write by hand.
 */
function typeOf(entry: Entry): string {
  if (entry.data.k === 'link') return entry.data.role ?? 'link';
  return entry.kind;
}

function roleLabel(role: string): string {
  return role === 'pob' ? 'PoB' : role;
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

function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const value = bytes / (1024 * 1024);
  return value < 100 ? `${value.toFixed(1)} MB` : `${Math.round(value)} MB`;
}
