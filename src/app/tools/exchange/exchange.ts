/* Currency Exchange Calculator */
import { Component, signal } from '@angular/core';
import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';

/** Which amount field the user touched last — ratio edits recompute from it. */
type LastEdited = 'A' | 'B';

interface WholeRatio {
  readonly wA: number;
  readonly wB: number;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** Smallest whole-number pack the ratio can be traded in (4 decimals of precision). */
function getWholeNumberRatio(rA: number, rB: number): WholeRatio {
  const mul = 10000;
  const iA = Math.round(rA * mul);
  const iB = Math.round(rB * mul);
  const d = gcd(iA, iB);
  return { wA: iA / d, wB: iB / d };
}

@Component({
  selector: 'poe-exchange',
  imports: [ToolPage, PoeCard],
  templateUrl: './exchange.html',
})
export class Exchange {
  // Kept as raw strings so the fields read back exactly what the old inputs held
  // (including the `.toFixed(2)` formatting written into the opposite amount).
  readonly ratioA = signal('1');
  readonly ratioB = signal('1.20');
  readonly amountA = signal('0');
  readonly amountB = signal('0');

  readonly optimalInput = signal(0);
  readonly optimalResult = signal(0);
  readonly optimalInputLabel = signal('Optimal Amount to Exchange');
  readonly optimalResultLabel = signal('You will receive exactly');

  private lastEdited: LastEdited = 'A';

  constructor() {
    // The old IIFE ran one pass on load, which also set the "Currency A" labels.
    this.calcFromA();
  }

  onRatioAInput(event: Event): void {
    this.ratioA.set(readValue(event));
    this.onRatioChange();
  }

  onRatioBInput(event: Event): void {
    this.ratioB.set(readValue(event));
    this.onRatioChange();
  }

  onAmountAInput(event: Event): void {
    this.amountA.set(readValue(event));
    this.lastEdited = 'A';
    this.calcFromA();
  }

  onAmountBInput(event: Event): void {
    this.amountB.set(readValue(event));
    this.lastEdited = 'B';
    this.calcFromB();
  }

  private onRatioChange(): void {
    if (this.lastEdited === 'A') {
      this.calcFromA();
    } else {
      this.calcFromB();
    }
  }

  private calcFromA(): void {
    const rA = parseFloat(this.ratioA()) || 1;
    const rB = parseFloat(this.ratioB()) || 1;
    const amt = parseFloat(this.amountA()) || 0;
    this.amountB.set((amt * (rB / rA)).toFixed(2));
    this.updateOptimalA(amt, rA, rB);
  }

  private calcFromB(): void {
    const rA = parseFloat(this.ratioA()) || 1;
    const rB = parseFloat(this.ratioB()) || 1;
    const amt = parseFloat(this.amountB()) || 0;
    this.amountA.set((amt * (rA / rB)).toFixed(2));
    this.updateOptimalB(amt, rA, rB);
  }

  private updateOptimalA(inputA: number, rA: number, rB: number): void {
    this.optimalInputLabel.set('Optimal Currency A Amount');
    this.optimalResultLabel.set('You will receive exactly (Currency B)');
    if (inputA > 0) {
      const { wA, wB } = getWholeNumberRatio(rA, rB);
      const packs = Math.floor(inputA / wA);
      this.optimalInput.set(packs > 0 ? packs * wA : 0);
      this.optimalResult.set(packs > 0 ? packs * wB : 0);
    } else {
      this.optimalInput.set(0);
      this.optimalResult.set(0);
    }
  }

  private updateOptimalB(inputB: number, rA: number, rB: number): void {
    this.optimalInputLabel.set('Optimal Currency B Amount');
    this.optimalResultLabel.set('You will receive exactly (Currency A)');
    if (inputB > 0) {
      const { wA, wB } = getWholeNumberRatio(rA, rB);
      const packs = Math.floor(inputB / wB);
      this.optimalInput.set(packs > 0 ? packs * wB : 0);
      this.optimalResult.set(packs > 0 ? packs * wA : 0);
    } else {
      this.optimalInput.set(0);
      this.optimalResult.set(0);
    }
  }
}

function readValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}
