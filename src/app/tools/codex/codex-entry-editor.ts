/**
 * Editing one entry, wherever it was opened from.
 *
 * It keeps its own copy and hands it back on save, so nothing is written to the
 * library until you say so and cancelling really is cancelling. The entry it
 * was opened with is the entry it saves — a page holds a reference, so an edit
 * made from a page is an edit everywhere the entry appears, which is the whole
 * reason pages do not own their contents.
 */
import { Component, effect, input, output, signal } from '@angular/core';
import type { Entry } from './codex-types';
import { parseTagInput } from './codex-schema';

@Component({
  selector: 'codex-entry-editor',
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

  save(): void {
    const draft = this.draft();
    if (draft) this.saved.emit({ ...draft, tags: parseTagInput(this.tags()) });
  }
}
