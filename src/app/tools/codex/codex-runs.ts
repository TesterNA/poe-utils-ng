/**
 * What a strategy actually paid, written down as numbers.
 *
 * In the documents this replaces this is a sentence — "профит 14 в час минус
 * замаз 2д = 12 в час" — or a screenshot of a loot tracker, which is a number
 * rendered as pixels. Neither can be sorted, averaged, or set beside the
 * strategy on the next row; one of those documents is a whole separate
 * spreadsheet of screenshots for exactly that reason.
 *
 * The form asks for the four things the loot tracker already shows — how long,
 * what it cost to set up, what came out, and how many maps — because per map is
 * the unit those captions actually compare in. Net and per-hour are never
 * typed: they are the arithmetic, and a typed total is a total that can
 * disagree with its own parts.
 */
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CodexAssetImg } from './codex-asset-img';
import { CodexStore } from './codex-store';
import { imagesIn } from './codex-image';
import { div, duration, perHourLabel, runTotals } from './codex-metrics';
import { newId } from './codex-schema';
import type { Run } from './codex-types';

interface Draft {
  minutes: string;
  maps: string;
  investDiv: string;
  revenueDiv: string;
  note: string;
}

const EMPTY: Draft = { minutes: '', maps: '', investDiv: '', revenueDiv: '', note: '' };

function num(text: string): number {
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : 0;
}

@Component({
  selector: 'codex-runs',
  imports: [CodexAssetImg],
  template: `
    <div class="codex-runs">
      @if (runs().length) {
        <table class="codex-runs-table">
          <thead>
            <tr>
              <th>when</th>
              <th>time</th>
              <th>maps</th>
              <th>in</th>
              <th>out</th>
              <th>net</th>
              <th>rate</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (run of runs(); track run.id) {
              <tr [title]="run.note ?? ''">
                <td>{{ day(run.at) }}</td>
                <td>{{ time(run.minutes) }}</td>
                <td>{{ run.maps || '' }}</td>
                <td>{{ money(run.investDiv) }}</td>
                <td>{{ money(run.revenueDiv) }}</td>
                <td [class.good]="net(run) > 0" [class.bad]="net(run) < 0">{{ money(net(run)) }}</td>
                <td>{{ rate(run) }}</td>
                <td class="codex-runs-actions">
                  @if (shotOf(run)) {
                    <button
                      type="button"
                      class="codex-runs-shot"
                      title="The screenshot it came off"
                      (click)="show(run)"
                    >
                      <codex-asset-img [assetId]="shotOf(run)" alt="" />
                    </button>
                  }
                  <button type="button" title="Drop this run" (click)="drop(run)">&times;</button>
                </td>
              </tr>
            }
          </tbody>
          <tfoot>
            <tr>
              <td>{{ totals().runs }} runs</td>
              <td>{{ time(totals().minutes) }}</td>
              <td>{{ totals().maps || '' }}</td>
              <td>{{ money(totals().investDiv) }}</td>
              <td>{{ money(totals().revenueDiv) }}</td>
              <td [class.good]="totals().netDiv > 0" [class.bad]="totals().netDiv < 0">
                {{ money(totals().netDiv) }}
              </td>
              <td>{{ perHour() }}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      }

      <div
        class="codex-run-form"
        [class.over]="over()"
        (paste)="onPaste($event)"
        (dragover)="onDragOver($event)"
        (dragleave)="over.set(false)"
        (drop)="onDrop($event)"
      >
        <label>
          <span>minutes</span>
          <input
            type="number"
            inputmode="numeric"
            [value]="draft().minutes"
            (input)="set('minutes', $event)"
          />
        </label>
        <label>
          <span>maps</span>
          <input
            type="number"
            inputmode="numeric"
            [value]="draft().maps"
            (input)="set('maps', $event)"
          />
        </label>
        <label>
          <span>invested</span>
          <input
            type="number"
            inputmode="decimal"
            [value]="draft().investDiv"
            (input)="set('investDiv', $event)"
          />
        </label>
        <label>
          <span>came out</span>
          <input
            type="number"
            inputmode="decimal"
            [value]="draft().revenueDiv"
            (input)="set('revenueDiv', $event)"
          />
        </label>
        <label class="wide">
          <span>note</span>
          <input type="text" [value]="draft().note" (input)="set('note', $event)" />
        </label>
        @if (shotId()) {
          <codex-asset-img class="codex-run-shot" [assetId]="shotId()" alt="" />
        }
        <button class="poe-btn poe-btn-dim" [disabled]="!canAdd()" (click)="add()">Add run</button>
      </div>
      <p class="codex-hint">
        Divines, and the minutes the loot tracker already counted. Paste its screenshot onto this
        row and it travels with the numbers.
      </p>
    </div>
  `,
})
export class CodexRuns {
  readonly runs = input.required<readonly Run[]>();
  readonly changed = output<Run[]>();

  private readonly store = inject(CodexStore);

  readonly draft = signal<Draft>({ ...EMPTY });
  readonly shotId = signal('');
  readonly over = signal(false);

  readonly totals = computed(() => runTotals(this.runs()));

  perHour(): string {
    return perHourLabel(this.totals());
  }

  set(field: keyof Draft, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((draft) => ({ ...draft, [field]: value }));
  }

  canAdd(): boolean {
    const draft = this.draft();
    // Something has to have been measured. A run of nothing is a row that drags
    // every average down and says nothing about why.
    return num(draft.minutes) > 0 || num(draft.revenueDiv) > 0 || num(draft.investDiv) > 0;
  }

  add(): void {
    if (!this.canAdd()) return;
    const draft = this.draft();
    const run: Run = {
      id: newId(),
      at: Date.now(),
      minutes: num(draft.minutes),
      ...(num(draft.maps) ? { maps: num(draft.maps) } : {}),
      investDiv: num(draft.investDiv),
      revenueDiv: num(draft.revenueDiv),
      ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      ...(this.shotId() ? { assetIds: [this.shotId()] } : {}),
    };
    this.changed.emit([...this.runs(), run]);
    this.draft.set({ ...EMPTY });
    this.shotId.set('');
  }

  drop(run: Run): void {
    this.changed.emit(this.runs().filter((entry) => entry.id !== run.id));
  }

  shotOf(run: Run): string {
    return run.assetIds?.[0] ?? '';
  }

  show(run: Run): void {
    const id = this.shotOf(run);
    if (id) this.store.lightbox.set({ assetId: id, title: run.note || 'Run' });
  }

  // --- the proof ---------------------------------------------------------------

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

  private async take(file: Blob | undefined): Promise<void> {
    if (!file) return;
    const kept = await this.store.addImage(file);
    if (kept) this.shotId.set(kept.assetId);
  }

  // --- reading -----------------------------------------------------------------

  net(run: Run): number {
    return run.revenueDiv - run.investDiv;
  }

  rate(run: Run): string {
    return perHourLabel(runTotals([run]));
  }

  money(value: number): string {
    return value ? div(value) : '—';
  }

  time(minutes: number): string {
    return duration(minutes) || '—';
  }

  day(at: number): string {
    return at ? new Date(at).toLocaleDateString() : '';
  }
}
