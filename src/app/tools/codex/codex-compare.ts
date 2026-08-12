/**
 * Several strategies, side by side.
 *
 * This is one of the three source documents in one screen. That one is four
 * scarab setups, eight screenshots of a loot tracker and a caption under each —
 * "x5 abyss regular 8 mods", "3.17 div investment" — and it exists as a
 * separate spreadsheet only because the document that links to it has nowhere
 * to put the numbers. Reading it means holding four screenshots in your head at
 * once, and nothing in it can be sorted.
 *
 * Here the same four are columns, and every row is one question asked of all of
 * them at once: what went in the device, what map, what it cost, what it made.
 * The best number in each row is marked, because "which of these is better" is
 * the only question anybody opens that document to answer.
 */
import { Component, computed, inject, input } from '@angular/core';
import { CodexAssetImg } from './codex-asset-img';
import { CodexStore } from './codex-store';
import { div, duration, perHourLabel, runTotals, type RunTotals } from './codex-metrics';
import { pointsOf } from './codex-query';
import type { Entry } from './codex-types';

interface Column {
  entry: Entry;
  totals: RunTotals;
  scarabs: string;
  map: string;
  astrolabe: string;
  tree: string;
  thumbId: string;
  thumbUrl: string;
  shotIds: string[];
}

@Component({
  selector: 'codex-compare',
  imports: [CodexAssetImg],
  template: `
    <div class="codex-compare">
      <table>
        <thead>
          <tr>
            <th></th>
            @for (column of columns(); track column.entry.id) {
              <th>{{ column.entry.title }}</th>
            }
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>tree</th>
            @for (column of columns(); track column.entry.id) {
              <td>
                @if (column.thumbId) {
                  <button type="button" class="codex-thumb" (click)="zoom(column, column.thumbId)">
                    <codex-asset-img [assetId]="column.thumbId" alt="" />
                  </button>
                } @else if (column.thumbUrl) {
                  <button type="button" class="codex-thumb" (click)="zoomUrl(column)">
                    <img class="codex-asset" [src]="column.thumbUrl" alt="" loading="lazy" />
                  </button>
                }
                <span>{{ column.tree }}</span>
              </td>
            }
          </tr>
          <tr>
            <th>device</th>
            @for (column of columns(); track column.entry.id) {
              <td>{{ column.scarabs || '—' }}</td>
            }
          </tr>
          <tr>
            <th>maps</th>
            @for (column of columns(); track column.entry.id) {
              <td>{{ column.map || '—' }}</td>
            }
          </tr>
          <tr>
            <th>astrolabe</th>
            @for (column of columns(); track column.entry.id) {
              <td>{{ column.astrolabe || '—' }}</td>
            }
          </tr>
          <tr>
            <th>measured</th>
            @for (column of columns(); track column.entry.id) {
              <td>
                @if (column.totals.runs) {
                  {{ column.totals.runs }} runs · {{ time(column.totals.minutes) }}
                  @if (column.totals.maps) {
                    · {{ column.totals.maps }} maps
                  }
                } @else {
                  nobody has
                }
              </td>
            }
          </tr>
          <tr>
            <th>invested</th>
            @for (column of columns(); track column.entry.id) {
              <td>
                {{ money(column.totals.investDiv) }}
                @if (column.totals.investPerMap) {
                  <small>{{ money(column.totals.investPerMap) }}/map</small>
                }
              </td>
            }
          </tr>
          <tr>
            <th>net</th>
            @for (column of columns(); track column.entry.id) {
              <td [class.best]="column.totals.netDiv === best().net && column.totals.runs > 0">
                {{ money(column.totals.netDiv) }}
                @if (column.totals.netPerMap) {
                  <small>{{ money(column.totals.netPerMap) }}/map</small>
                }
              </td>
            }
          </tr>
          <tr>
            <th>per hour</th>
            @for (column of columns(); track column.entry.id) {
              <td [class.best]="column.totals.perHour === best().rate && column.totals.minutes > 0">
                {{ rate(column.totals) || '—' }}
              </td>
            }
          </tr>
          <tr>
            <th>proof</th>
            @for (column of columns(); track column.entry.id) {
              <td>
                @for (shot of column.shotIds; track shot) {
                  <button type="button" class="codex-thumb" (click)="zoom(column, shot)">
                    <codex-asset-img [assetId]="shot" alt="" />
                  </button>
                }
                @if (!column.shotIds.length) {
                  <span>—</span>
                }
              </td>
            }
          </tr>
          <tr>
            <th>notes</th>
            @for (column of columns(); track column.entry.id) {
              <td class="codex-compare-note">{{ column.entry.body || '—' }}</td>
            }
          </tr>
        </tbody>
      </table>
    </div>
  `,
})
export class CodexCompare {
  readonly entries = input.required<readonly Entry[]>();
  private readonly store = inject(CodexStore);

  readonly columns = computed<Column[]>(() =>
    this.entries().map((entry) => {
      const data = entry.data;
      const src = data.k === 'strategy' ? data.src : null;
      const snapshot = src?.snapshot;
      const scarabs =
        snapshot?.picks.map((pick) => `${pick.count}× ${pick.name}`).join(', ') ??
        src?.picksText ??
        '';
      const atlas = data.k === 'atlas' ? data.src : src?.atlas;
      const points = pointsOf(entry);
      const keystones = snapshot?.keystones ?? atlas?.snapshot?.keystones ?? [];
      return {
        entry,
        totals: runTotals(entry.runs),
        scarabs,
        map: src?.map ?? '',
        astrolabe: src?.astrolabe ?? '',
        tree: [points ? `${points} pts` : '', keystones.join(', ')].filter(Boolean).join(' · '),
        thumbId: snapshot?.atlasThumbId ?? atlas?.snapshot?.thumbId ?? atlas?.assetId ?? '',
        thumbUrl: atlas?.imageUrl ?? '',
        shotIds: (entry.runs ?? []).flatMap((run) => run.assetIds ?? []),
      };
    }),
  );

  /** The best cell in each row, so the answer is visible rather than worked out. */
  readonly best = computed(() => {
    const measured = this.columns().filter((column) => column.totals.runs > 0);
    return {
      net: Math.max(...measured.map((column) => column.totals.netDiv), Number.NEGATIVE_INFINITY),
      rate: Math.max(
        ...measured
          .filter((column) => column.totals.minutes > 0)
          .map((column) => column.totals.perHour),
        Number.NEGATIVE_INFINITY,
      ),
    };
  });

  zoom(column: Column, assetId: string): void {
    this.store.lightbox.set({ assetId, title: column.entry.title });
  }

  zoomUrl(column: Column): void {
    this.store.lightbox.set({ url: column.thumbUrl, title: column.entry.title });
  }

  money(value: number): string {
    return value ? div(value) : '—';
  }

  time(minutes: number): string {
    return duration(minutes) || '—';
  }

  rate(totals: RunTotals): string {
    return perHourLabel(totals);
  }
}
