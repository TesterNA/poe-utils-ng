/* Lucky Percentage Calculator */
import { Component, computed, signal } from '@angular/core';
import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';

type LuckyTab = 'normal' | 'reverse';

/**
 * How many independent attempts you get, best one kept. Two is what the game
 * calls lucky; three is the same arithmetic one roll further, so it is a number
 * rather than a second pair of formulas.
 */
export const ROLL_COUNTS = [2, 3] as const;
type Rolls = (typeof ROLL_COUNTS)[number];

/** One result banner: hidden until a calculation runs, red when the input is bad. */
interface LuckyResult {
  readonly show: boolean;
  readonly error: boolean;
  /** Plain text prefix (or the whole error message). */
  readonly label: string;
  /** Highlighted part, rendered inside <strong>. Empty when there is none. */
  readonly value: string;
}

const CLEARED: LuckyResult = { show: false, error: false, label: '', value: '' };

function invalid(): LuckyResult {
  return {
    show: true,
    error: true,
    label: 'Please enter a valid percentage (0 – 100)',
    value: '',
  };
}

@Component({
  selector: 'poe-lucky',
  imports: [ToolPage, PoeCard],
  templateUrl: './lucky.html',
})
export class Lucky {
  readonly tab = signal<LuckyTab>('normal');
  readonly rollCounts = ROLL_COUNTS;
  readonly rolls = signal<Rolls>(2);
  readonly rollWord = computed(() => (this.rolls() === 2 ? 'Two' : 'Three'));

  readonly initialPct = signal('');
  readonly luckyPct = signal('');

  readonly result1 = signal<LuckyResult>(CLEARED);
  readonly result2 = signal<LuckyResult>(CLEARED);

  switchTab(tab: LuckyTab): void {
    this.tab.set(tab);
    this.clear();
  }

  /** Both directions are about the same roll count, so it is one switch for both. */
  setRolls(rolls: Rolls): void {
    this.rolls.set(rolls);
    this.clear();
  }

  private clear(): void {
    this.result1.set(CLEARED);
    this.result2.set(CLEARED);
  }

  onInitialInput(event: Event): void {
    this.initialPct.set(readValue(event));
    this.result1.set(CLEARED);
  }

  onLuckyInput(event: Event): void {
    this.luckyPct.set(readValue(event));
    this.result2.set(CLEARED);
  }

  /** n independent rolls at the same chance, best kept: 1 − (1 − p)ⁿ. */
  calcLucky(): void {
    const val = parseFloat(this.initialPct());
    if (isNaN(val) || val < 0 || val > 100) {
      this.result1.set(invalid());
      return;
    }
    const lucky = (1 - Math.pow(1 - val / 100, this.rolls())) * 100;
    this.result1.set({
      show: true,
      error: false,
      label: 'Lucky Percentage: ',
      value: lucky.toFixed(2) + '%',
    });
  }

  /** Inverse of the above: p = 1 − ⁿ√(1 − lucky). */
  calcRequired(): void {
    const val = parseFloat(this.luckyPct());
    if (isNaN(val) || val < 0 || val > 100) {
      this.result2.set(invalid());
      return;
    }
    const initial = (1 - Math.pow(1 - val / 100, 1 / this.rolls())) * 100;
    this.result2.set({
      show: true,
      error: false,
      label: 'Required Initial: ',
      value: initial.toFixed(2) + '%',
    });
  }
}

function readValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}
