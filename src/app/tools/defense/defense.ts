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

/**
 * The defence-only magnitudes a Tailoring Orb can enchant onto a body armour.
 * The orb rolls each of these inside a larger enchant — 6% comes paired with
 * resistance or attribute magnitudes, 10-15% with socket colours, lost sockets
 * or heavier attribute requirements — but none of that other half moves a
 * defence number, so only the percentage is worth picking here.
 */
const TAILORING_MAGNITUDES = [6, 8, 10, 12, 15] as const;

/**
 * A magnitude modifier scales the roll of an explicit modifier, and the game
 * truncates the product towards zero rather than rounding it: 8% on a +97
 * roll is 104.76, shown as +104.
 *
 * The multiply is written as `x * (100 + m) / 100` on purpose. `x * 1.06` on a
 * roll of 50 lands on 53.000000000000007, which truncates fine, but the same
 * shape elsewhere lands a hair *under* the whole number and would truncate a
 * clean 28 down to 27. Scaling by the integer first keeps whole rolls whole.
 */
function applyMagnitude(value: number, magnitude: number): number {
  if (!magnitude) return value;
  const scaled = (value * (100 + magnitude)) / 100;
  return scaled < 0 ? Math.ceil(scaled) : Math.floor(scaled);
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

  readonly tailoringMagnitudes = TAILORING_MAGNITUDES;
  /** 0 = no orb. Optional: the calculator behaves exactly as before while it is 0. */
  readonly tailoring = signal<number>(0);

  /**
   * The orb reaches the explicit modifiers and nothing else — not the base
   * defence the item type comes with, and not quality, neither of which is an
   * explicit modifier.
   */
  readonly scaledFlat = computed<number>(() => applyMagnitude(num(this.flat()), this.tailoring()));
  readonly scaledInc = computed<number>(() => applyMagnitude(num(this.inc()), this.tailoring()));

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
      (this.baseValue() + this.scaledFlat()) *
        (1 + this.scaledInc() / 100) *
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

  /** The select carries numbers, which arrive off the DOM as strings. */
  onTailoring(event: Event): void {
    this.tailoring.set(Number((event.target as HTMLSelectElement).value));
  }

  /** Dragging the slider writes back into the percent field. */
  onSlider(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.rangePercent.set(Number(input.value));
  }
}
