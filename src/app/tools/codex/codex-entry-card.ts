/**
 * One entry, as a row.
 *
 * The same card is used by the library, by a page that placed the entry, and by
 * a live query block on a page — which is the point of entries being a library
 * rather than page content: it is one thing, shown wherever it earns a place.
 *
 * An atlas or a strategy shows what it *is* rather than that it exists: the
 * shape of the tree, the scarabs by icon, the mechanics it leans on. All of
 * that comes off the snapshot taken when it was saved, so a list of forty cards
 * costs no fetches — see codex-snapshot.ts.
 */
import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodexAssetImg } from './codex-asset-img';
import { CodexStore } from './codex-store';
import type { Entry } from './codex-types';
import { completeness, excerptOf, subtitleOf, urlOf, when, type Mark } from './codex-format';
import { runsLabel, runTotals } from './codex-metrics';

@Component({
  selector: 'codex-entry-card',
  imports: [CodexAssetImg, RouterLink],
  template: `
    <div class="codex-entry-row">
      @if (thumbId() || thumbUrl()) {
        <button
          type="button"
          class="codex-thumb"
          title="See it full size"
          (click)="zoom()"
        >
          @if (thumbId()) {
            <codex-asset-img [assetId]="thumbId()" alt="" />
          } @else {
            <img class="codex-asset" [src]="thumbUrl()" alt="" loading="lazy" />
          }
        </button>
      }

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

        @if (picks().length) {
          <span class="codex-picks">
            @for (pick of picks(); track pick.code) {
              <span class="codex-pick" [title]="pick.count + '× ' + pick.name">
                @if (pick.icon) {
                  <img [src]="pick.icon" alt="" loading="lazy" />
                }
                <b>{{ pick.count }}</b>
              </span>
            }
          </span>
        }

        @if (full()) {
          @if (runsLine()) {
            <span class="codex-runs-line">{{ runsLine() }}</span>
          }
          @if (keystones().length) {
            <span class="codex-keystones">{{ keystones().join(' · ') }}</span>
          }
          @for (line of mechanics(); track line.label) {
            <span class="codex-mech"><b>{{ line.label }}</b> {{ line.value }}</span>
          }
          @if (excerpt()) {
            <span class="codex-entry-body">{{ excerpt() }}</span>
          }
        }

        @if (entry().tags.length) {
          <span class="codex-entry-tags">
            @for (tag of entry().tags; track tag) {
              <span class="codex-tag-chip">{{ tag }}</span>
            }
          </span>
        }
      </button>

      @if (marks().length) {
        <span class="codex-marks" [title]="marksTitle()">
          @for (mark of marks(); track mark.label) {
            <i [class.on]="mark.on"></i>
          }
        </span>
      }
      @if (ours(); as own) {
        <a
          class="codex-entry-open"
          [routerLink]="own.path"
          [queryParams]="own.params"
          [title]="own.title"
          >⌖</a
        >
      }
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
  private readonly store = inject(CodexStore);

  readonly entry = input.required<Entry>();
  /** cards mode, and pages, show the note and the mechanics; a dense list does not */
  readonly full = input(false);
  readonly showWhen = input(true);

  readonly opened = output<void>();

  /** A picture we hold: the drawn shape of a tree, or a screenshot. */
  readonly thumbId = computed(() => {
    const data = this.entry().data;
    if (data.k === 'atlas') return data.src.snapshot?.thumbId ?? data.src.assetId ?? '';
    if (data.k === 'strategy') {
      return data.src.snapshot?.atlasThumbId ?? data.src.atlas?.assetId ?? '';
    }
    if (data.k === 'image') return data.thumbId ?? data.assetId ?? '';
    return '';
  });

  /** One somebody else holds — an imgur atlas, which is how the docs do it. */
  readonly thumbUrl = computed(() => {
    const data = this.entry().data;
    if (data.k === 'atlas') return data.src.imageUrl ?? '';
    if (data.k === 'strategy') return data.src.atlas?.imageUrl ?? '';
    if (data.k === 'image') return data.imageUrl ?? '';
    return '';
  });

  readonly picks = computed(() => {
    const data = this.entry().data;
    return data.k === 'strategy' ? (data.src.snapshot?.picks ?? []) : [];
  });

  readonly keystones = computed(() => {
    const data = this.entry().data;
    const list =
      data.k === 'atlas'
        ? data.src.snapshot?.keystones
        : data.k === 'strategy'
          ? (data.src.snapshot?.keystones ?? data.src.atlas?.snapshot?.keystones)
          : undefined;
    return list ?? [];
  });

  readonly mechanics = computed(() => {
    const data = this.entry().data;
    return data.k === 'atlas' ? (data.src.snapshot?.mechanics ?? []) : [];
  });

  readonly marks = computed<Mark[]>(() => completeness(this.entry()));

  /** "3 runs · 4h 10m · +52 div net · 12 div/h" — the whole of doc B, in a line. */
  readonly runsLine = computed(() => runsLabel(runTotals(this.entry().runs)));

  /**
   * Our own code opens the tool with the tree in it, which is the thing a
   * screenshot in a spreadsheet could never do.
   */
  readonly ours = computed(() => {
    const data = this.entry().data;
    if (data.k === 'atlas' && data.src.code) {
      return { path: ['/atlas'], params: { c: data.src.code }, title: 'Open this tree in the Atlas' };
    }
    if (data.k === 'strategy' && data.src.code) {
      return { path: ['/strategy'], params: { s: data.src.code }, title: 'Open in Map Strategy' };
    }
    if (data.k === 'strategy' && data.src.atlas?.code) {
      return {
        path: ['/atlas'],
        params: { c: data.src.atlas.code },
        title: 'Open this tree in the Atlas',
      };
    }
    return null;
  });

  /**
   * The card shows a 46 pixel square; the numbers on a loot tracker are not
   * readable at 46 pixels, and reading them is the only reason the screenshot
   * was kept. So the thumbnail is a button and the full one is behind it.
   */
  zoom(): void {
    const data = this.entry().data;
    const title = this.entry().title;
    if (data.k === 'image' && data.assetId) {
      this.store.lightbox.set({ assetId: data.assetId, title });
      return;
    }
    const url = this.thumbUrl();
    if (url) {
      this.store.lightbox.set({ url, title });
      return;
    }
    const id = this.thumbId();
    if (id) this.store.lightbox.set({ assetId: id, title });
  }

  marksTitle(): string {
    const marks = this.marks();
    const has = marks.filter((mark) => mark.on).map((mark) => mark.label);
    const missing = marks.filter((mark) => !mark.on).map((mark) => mark.label);
    const parts: string[] = [];
    if (has.length) parts.push(`Has ${has.join(', ')}`);
    if (missing.length) parts.push(`no ${missing.join(', ')}`);
    return parts.join(' · ');
  }

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
