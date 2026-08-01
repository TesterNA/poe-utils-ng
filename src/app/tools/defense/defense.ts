/* Defense Calculator */
import { Component, ElementRef, computed, effect, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';

type DefenseMode = 'base' | 'percent';

/** Empty / cleared fields counted as 0 in the old `Number(el.value) || 0`. */
function num(value: number | null): number {
  return value ?? 0;
}

@Component({
  selector: 'poe-defense',
  imports: [ToolPage, PoeCard, FormsModule],
  templateUrl: './defense.html',
})
export class Defense {
  readonly mode = signal<DefenseMode>('base');

  readonly base = signal<number | null>(288);
  readonly rangeMin = signal<number | null>(262);
  readonly rangeMax = signal<number | null>(302);
  readonly rangePercent = signal<number | null>(65);

  readonly flat = signal<number | null>(97);
  readonly inc = signal<number | null>(138);
  readonly quality = signal<number | null>(20);

  /** Either the value typed directly, or the roll interpolated inside the range. */
  private readonly baseValue = computed<number>(() => {
    if (this.mode() === 'base') return num(this.base());
    const min = num(this.rangeMin());
    const max = num(this.rangeMax());
    const pct = num(this.rangePercent()) / 100;
    return min + (max - min) * pct;
  });

  readonly result = computed<number>(() =>
    Math.round(
      (this.baseValue() + num(this.flat())) *
        (1 + num(this.inc()) / 100) *
        (1 + num(this.quality()) / 100),
    ),
  );

  /** The slider can only show 0–100, so it follows the field clamped. */
  readonly sliderValue = computed<number>(() =>
    Math.min(100, Math.max(0, num(this.rangePercent()))),
  );

  readonly pctLabel = computed<number>(() => Math.round(num(this.rangePercent())));

  private readonly resultEl = viewChild<ElementRef<HTMLDivElement>>('resultEl');

  constructor() {
    effect(() => {
      this.result();
      const el = this.resultEl()?.nativeElement;
      if (!el) return;
      // Restart the pop animation on every change (needs a forced reflow).
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = 'countPop 0.15s ease';
    });
  }

  /** Dragging the slider writes back into the percent field. */
  onSlider(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.rangePercent.set(Number(input.value));
  }
}
