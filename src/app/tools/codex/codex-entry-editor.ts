/**
 * Editing one entry, wherever it was opened from.
 *
 * It keeps its own copy and hands it back on save, so nothing is written to the
 * library until you say so and cancelling really is cancelling. The entry it
 * was opened with is the entry it saves — a page holds a reference, so an edit
 * made from a page is an edit everywhere the entry appears, which is the whole
 * reason pages do not own their contents.
 */
import { Component, effect, inject, input, output, signal } from '@angular/core';
import { CodexAssetImg } from './codex-asset-img';
import { CodexStore } from './codex-store';
import { imagesIn } from './codex-image';
import type { AtlasSource, Entry, EntryKind } from './codex-types';
import { hostOf, parseTagInput } from './codex-schema';

/** An image host means a picture; anything else is a link to somebody's tool. */
function place(url: string): AtlasSource {
  return /imgur\.com|ibb\.co|\.(png|jpe?g|webp|gif)($|\?)/i.test(url)
    ? { imageUrl: url }
    : { url };
}

/** Whatever this entry already points at, whichever slot it happens to be in. */
function anyUrl(entry: Entry): string {
  const data = entry.data;
  if (data.k === 'link') return data.url;
  if (data.k === 'atlas') return data.src.url ?? data.src.imageUrl ?? '';
  if (data.k === 'strategy') return data.src.atlas?.url ?? data.src.atlas?.imageUrl ?? '';
  if (data.k === 'image') return data.imageUrl ?? '';
  if (data.k === 'build') return data.links[0]?.url ?? '';
  return '';
}

@Component({
  selector: 'codex-entry-editor',
  imports: [CodexAssetImg],
  template: `
    @if (draft(); as d) {
      <div class="codex-editor">
        <div class="poe-field">
          <label class="poe-field-label">Title</label>
          <input type="text" [value]="d.title" (input)="patch('title', $event)" />
        </div>
        @if (d.data.k === 'link') {
          <div class="poe-field">
            <label class="poe-field-label">Link</label>
            <input type="text" [value]="d.data.url" (input)="patch('url', $event)" />
          </div>
        }
        @if (d.data.k === 'atlas') {
          <div class="codex-editor-row">
            <div class="poe-field">
              <label class="poe-field-label">Our code</label>
              <input
                type="text"
                placeholder="AT3:… — paste one, or save from the Atlas"
                [value]="d.data.src.code ?? ''"
                (input)="setAtlas('code', $event)"
              />
            </div>
            <div class="poe-field">
              <label class="poe-field-label">Somebody else's tree</label>
              <input
                type="text"
                placeholder="poeplanner.com/a/…"
                [value]="d.data.src.url ?? ''"
                (input)="setAtlas('url', $event)"
              />
            </div>
          </div>
          <div class="poe-field">
            <label class="poe-field-label">A picture of it</label>
            <input
              type="text"
              placeholder="imgur.com/… — which is how the docs do it"
              [value]="d.data.src.imageUrl ?? ''"
              (input)="setAtlas('imageUrl', $event)"
            />
          </div>
        }

        @if (d.data.k === 'strategy') {
          <div class="poe-field">
            <label class="poe-field-label">Our code</label>
            <input
              type="text"
              placeholder="ST1:… — or save from Map Strategy"
              [value]="d.data.src.code ?? ''"
              (input)="setStrategy('code', $event)"
            />
          </div>
          <div class="poe-field">
            <label class="poe-field-label">Scarabs</label>
            <input
              type="text"
              placeholder="2 доп легиона и 1 офицер — as written is fine"
              [value]="d.data.src.picksText ?? ''"
              (input)="setStrategy('picksText', $event)"
            />
          </div>
          <div class="codex-editor-row">
            <div class="poe-field">
              <label class="poe-field-label">Maps</label>
              <input
                type="text"
                placeholder="8-mod Dunes, 41%+ packsize"
                [value]="d.data.src.map ?? ''"
                (input)="setStrategy('map', $event)"
              />
            </div>
            <div class="poe-field">
              <label class="poe-field-label">Astrolabe</label>
              <input
                type="text"
                placeholder="legion"
                [value]="d.data.src.astrolabe ?? ''"
                (input)="setStrategy('astrolabe', $event)"
              />
            </div>
          </div>
          <div class="poe-field">
            <label class="poe-field-label">Its tree — a link or a picture</label>
            <input
              type="text"
              placeholder="poeplanner.com/a/… or imgur.com/…"
              [value]="strategyTree()"
              (input)="setStrategyTree($event)"
            />
          </div>
        }

        @if (d.data.k === 'build') {
          <div class="poe-field">
            <label class="poe-field-label">Ascendancy</label>
            <input
              type="text"
              placeholder="Elementalist"
              [value]="d.data.ascendancy ?? ''"
              (input)="setBuild($event)"
            />
          </div>
          @for (link of d.data.links; track $index; let i = $index) {
            <div class="codex-editor-row">
              <div class="poe-field">
                <label class="poe-field-label">Label</label>
                <input type="text" [value]="link.label" (input)="setLink(i, 'label', $event)" />
              </div>
              <div class="poe-field">
                <label class="poe-field-label">Link</label>
                <input type="text" [value]="link.url" (input)="setLink(i, 'url', $event)" />
              </div>
            </div>
          }
          <button class="poe-btn poe-btn-dim" (click)="addLink()">Add a link</button>
        }

        @if (takesPicture()) {
          <div class="poe-field">
            <label class="poe-field-label">Picture</label>
            <div
              class="codex-drop"
              [class.over]="over()"
              (paste)="onPaste($event)"
              (dragover)="onDragOver($event)"
              (dragleave)="over.set(false)"
              (drop)="onDrop($event)"
              tabindex="0"
            >
              @if (pictureId()) {
                <codex-asset-img class="codex-drop-shot" [assetId]="pictureId()" alt="" />
              }
              <span>
                @if (busy()) {
                  Shrinking it…
                } @else {
                  Click here and paste a screenshot, or drop one on this box.
                }
              </span>
              <input type="file" accept="image/*" (change)="onFile($event)" />
              @if (pictureId()) {
                <button class="poe-btn poe-btn-dim" (click)="clearPicture()">Remove</button>
              }
            </div>
          </div>
        }

        <div class="poe-field">
          <label class="poe-field-label">Notes</label>
          <textarea rows="4" [value]="d.body" (input)="patch('body', $event)"></textarea>
        </div>
        <div class="poe-field">
          <label class="poe-field-label">Tags</label>
          <input
            type="text"
            placeholder="legion worb day-1 — or commas, if a tag has a space"
            [value]="tags()"
            (input)="onTags($event)"
          />
        </div>
        <div class="codex-editor-row">
          <div class="poe-field">
            <label class="poe-field-label">League</label>
            <input type="text" [value]="d.league ?? ''" (input)="patch('league', $event)" />
          </div>
          <div class="poe-field">
            <label class="poe-field-label">Status</label>
            <select [value]="d.status ?? ''" (change)="patch('status', $event)">
              <option value="">—</option>
              <option value="live">live</option>
              <option value="draft">draft</option>
              <option value="tbc">tbc</option>
              <option value="dead">dead</option>
            </select>
          </div>
        </div>
        <div class="codex-editor-actions">
          <button class="poe-btn poe-btn-dim" (click)="save()">Save</button>
          <button class="poe-btn poe-btn-dim" (click)="cancelled.emit()">Cancel</button>
          <button
            class="poe-btn poe-btn-dim"
            [class.on]="d.game === 'poe2'"
            title="Mark this as Path of Exile 2 — it shows up first on the card"
            (click)="togglePoe2()"
          >
            PoE 2
          </button>
          <button class="poe-btn poe-btn-dim" (click)="togglePinned()">
            {{ d.pinned ? 'Unpin' : 'Pin' }}
          </button>
          <button class="poe-btn poe-btn-red" (click)="removed.emit(d)">Delete</button>
        </div>

        <!-- What it is, when the guess was wrong. A poeplanner link is an
             atlas; an imgur screenshot of a tree is an atlas too, and only the
             person who pasted it knows that. -->
        <div class="codex-convert">
          <span>It is really…</span>
          @for (kind of convertible(); track kind) {
            <button type="button" (click)="convert(kind)">{{ kind }}</button>
          }
        </div>
      </div>
    }
  `,
})
export class CodexEntryEditor {
  readonly entry = input.required<Entry>();

  readonly saved = output<Entry>();
  readonly cancelled = output<void>();
  readonly removed = output<Entry>();

  readonly draft = signal<Entry | null>(null);
  readonly tags = signal('');
  readonly over = signal(false);
  readonly busy = signal(false);

  private readonly store = inject(CodexStore);

  constructor() {
    // Opening a different entry into the same editor replaces the draft rather
    // than editing the previous one under a new title.
    effect(() => {
      const entry = this.entry();
      this.draft.set({ ...entry });
      this.tags.set(entry.tags.join(' '));
    });
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

  onTags(event: Event): void {
    this.tags.set((event.target as HTMLInputElement).value);
  }

  togglePoe2(): void {
    this.draft.update((draft) =>
      draft ? { ...draft, game: draft.game === 'poe2' ? undefined : 'poe2' } : draft,
    );
  }

  togglePinned(): void {
    this.draft.update((draft) => (draft ? { ...draft, pinned: !draft.pinned } : draft));
  }

  // --- what it is ------------------------------------------------------------

  setAtlas(field: 'code' | 'url' | 'imageUrl', event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    this.draft.update((draft) => {
      if (!draft || draft.data.k !== 'atlas') return draft;
      const src = { ...draft.data.src, [field]: value };
      if (!value) delete src[field];
      // The snapshot describes the code it was taken from, so changing the code
      // by hand makes it a description of something else.
      if (field === 'code' && value !== draft.data.src.code) delete src.snapshot;
      return { ...draft, data: { ...draft.data, src } };
    });
  }

  setStrategy(field: 'code' | 'picksText' | 'map' | 'astrolabe', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((draft) => {
      if (!draft || draft.data.k !== 'strategy') return draft;
      const src = { ...draft.data.src, [field]: value };
      if (!value.trim()) delete src[field];
      if (field === 'code' && value !== draft.data.src.code) delete src.snapshot;
      return { ...draft, data: { ...draft.data, src } };
    });
  }

  /** One field for a strategy's tree: a link or a picture, told apart by host. */
  strategyTree(): string {
    const draft = this.draft();
    if (!draft || draft.data.k !== 'strategy') return '';
    const atlas = draft.data.src.atlas;
    return atlas?.url ?? atlas?.imageUrl ?? '';
  }

  setStrategyTree(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    this.draft.update((draft) => {
      if (!draft || draft.data.k !== 'strategy') return draft;
      const src = { ...draft.data.src };
      if (!value) delete src.atlas;
      else src.atlas = { ...(src.atlas ?? {}), ...place(value) };
      return { ...draft, data: { ...draft.data, src } };
    });
  }

  setBuild(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((draft) =>
      draft && draft.data.k === 'build'
        ? { ...draft, data: { ...draft.data, ascendancy: value } }
        : draft,
    );
  }

  setLink(index: number, field: 'label' | 'url', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((draft) => {
      if (!draft || draft.data.k !== 'build') return draft;
      const links = draft.data.links.map((link, i) =>
        i === index ? { ...link, [field]: value } : link,
      );
      return { ...draft, data: { ...draft.data, links } };
    });
  }

  addLink(): void {
    this.draft.update((draft) =>
      draft && draft.data.k === 'build'
        ? { ...draft, data: { ...draft.data, links: [...draft.data.links, { label: '', url: '' }] } }
        : draft,
    );
  }

  convertible(): EntryKind[] {
    const draft = this.draft();
    if (!draft) return [];
    const kinds: EntryKind[] = ['link', 'atlas', 'strategy', 'build', 'note'];
    return kinds.filter((kind) => kind !== draft.kind);
  }

  /**
   * Changing what an entry is, keeping whatever it was pointing at.
   *
   * The host is a good guess and never more than that: half the atlases in the
   * documents this replaces are imgur screenshots, which no rule can tell from
   * a screenshot of anything else. Only the person who pasted it knows.
   */
  convert(kind: EntryKind): void {
    this.draft.update((draft) => {
      if (!draft) return draft;
      const url = anyUrl(draft);
      if (kind === 'atlas') {
        return { ...draft, kind, data: { k: 'atlas' as const, src: url ? place(url) : {} } };
      }
      if (kind === 'strategy') {
        return {
          ...draft,
          kind,
          data: { k: 'strategy' as const, src: url ? { atlas: place(url) } : {} },
        };
      }
      if (kind === 'build') {
        return {
          ...draft,
          kind,
          data: {
            k: 'build' as const,
            links: url ? [{ label: draft.title, url, role: 'pob' as const }] : [],
          },
        };
      }
      if (kind === 'link' && url) {
        return { ...draft, kind, data: { k: 'link' as const, url, host: hostOf(url) } };
      }
      return { ...draft, kind: 'note' as const, data: { k: 'note' as const } };
    });
  }

  // --- a picture ---------------------------------------------------------------

  /**
   * Which entries have somewhere to put one. An atlas keeps a screenshot of a
   * tree — which is how every atlas in the source documents is stored — a
   * strategy keeps one of its tree, and an image entry is nothing else.
   */
  takesPicture(): boolean {
    const kind = this.draft()?.data.k;
    return kind === 'image' || kind === 'atlas' || kind === 'strategy';
  }

  pictureId(): string {
    const data = this.draft()?.data;
    if (!data) return '';
    if (data.k === 'image') return data.thumbId ?? data.assetId ?? '';
    if (data.k === 'atlas') return data.src.assetId ?? '';
    if (data.k === 'strategy') return data.src.atlas?.assetId ?? '';
    return '';
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.over.set(true);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.over.set(false);
    void this.take(imagesIn(event.dataTransfer)[0]);
  }

  onPaste(event: ClipboardEvent): void {
    const image = imagesIn(event.clipboardData)[0];
    if (!image) return;
    event.preventDefault();
    void this.take(image);
  }

  onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.take(input.files?.[0]);
    input.value = '';
  }

  private async take(file: Blob | undefined): Promise<void> {
    if (!file || this.busy()) return;
    this.busy.set(true);
    const kept = await this.store.addImage(file);
    this.busy.set(false);
    if (!kept) return;
    this.draft.update((draft) => {
      if (!draft) return draft;
      const data = draft.data;
      if (data.k === 'image') {
        return {
          ...draft,
          data: { ...data, assetId: kept.assetId, thumbId: kept.thumbId, w: kept.w, h: kept.h },
        };
      }
      if (data.k === 'atlas') {
        return { ...draft, data: { ...data, src: { ...data.src, assetId: kept.assetId } } };
      }
      if (data.k === 'strategy') {
        const atlas = { ...(data.src.atlas ?? {}), assetId: kept.assetId };
        return { ...draft, data: { ...data, src: { ...data.src, atlas } } };
      }
      return draft;
    });
  }

  /**
   * Takes the picture off the entry. The bytes stay in storage until something
   * collects them — a delete that runs while you are still deciding is a delete
   * that cancel cannot undo.
   */
  clearPicture(): void {
    this.draft.update((draft) => {
      if (!draft) return draft;
      const data = draft.data;
      if (data.k === 'image') {
        const next = { ...data };
        delete next.assetId;
        delete next.thumbId;
        return { ...draft, data: next };
      }
      if (data.k === 'atlas') {
        const src = { ...data.src };
        delete src.assetId;
        return { ...draft, data: { ...data, src } };
      }
      if (data.k === 'strategy' && data.src.atlas) {
        const atlas = { ...data.src.atlas };
        delete atlas.assetId;
        return { ...draft, data: { ...data, src: { ...data.src, atlas } } };
      }
      return draft;
    });
  }

  save(): void {
    const draft = this.draft();
    if (draft) this.saved.emit({ ...draft, tags: parseTagInput(this.tags()) });
  }
}
