/**
 * One entry, as a row.
 *
 * The same card is used by the library, by a page that placed the entry, and by
 * a live query block on a page — which is the point of entries being a library
 * rather than page content: it is one thing, shown wherever it earns a place.
 */
import { Component, input, output } from '@angular/core';
import type { Entry } from './codex-types';
import { excerptOf, subtitleOf, urlOf, when } from './codex-format';

@Component({
  selector: 'codex-entry-card',
  template: `
    <div class="codex-entry-row">
      <button type="button" class="codex-entry-main" (click)="opened.emit()">
        <span class="codex-entry-title">
          @if (entry().game === 'poe2') {
            <span class="codex-poe2">PoE 2</span>
          }
          @if (entry().pinned) {
            <span class="codex-pin" title="Pinned">★</span>
          }
          {{ entry().title || '(untitled)' }}
        </span>
        <small class="codex-entry-sub">{{ subtitle() }}</small>
        @if (full() && excerpt()) {
          <span class="codex-entry-body">{{ excerpt() }}</span>
        }
        @if (entry().tags.length) {
          <span class="codex-entry-tags">
            @for (tag of entry().tags; track tag) {
              <span class="codex-tag-chip">{{ tag }}</span>
            }
          </span>
        }
      </button>
      @if (link()) {
        <a
          class="codex-entry-open"
          [href]="link()"
          target="_blank"
          rel="noreferrer"
          title="Open in a new tab"
          >↗</a
        >
      }
      @if (showWhen()) {
        <span class="codex-entry-when">{{ edited() }}</span>
      }
    </div>
  `,
})
export class CodexEntryCard {
  readonly entry = input.required<Entry>();
  /** cards mode, and pages, show the note under the title; a dense list does not */
  readonly full = input(false);
  readonly showWhen = input(true);

  readonly opened = output<void>();

  subtitle(): string {
    return subtitleOf(this.entry());
  }

  excerpt(): string {
    return excerptOf(this.entry());
  }

  link(): string {
    return urlOf(this.entry());
  }

  edited(): string {
    return when(this.entry().updatedAt);
  }
}
