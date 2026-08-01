import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';
import type { ColoredLike, HaxeProbability, PoEChromaticCalcMain } from './poe-chromatic-calc';

/**
 * Structurally compatible stand-in for the solver's internal `Colored` class,
 * which the vendored script never exports. `getColorChances` only calls
 * `total()`, `countNonZero()` and `map()` on it, and `getProbabilities` only
 * reads `red` / `green` / `blue` and calls `total()`.
 */
class Colored implements ColoredLike {
  constructor(
    readonly red: number,
    readonly green: number,
    readonly blue: number,
  ) {}

  total(): number {
    return this.red + this.green + this.blue;
  }

  countNonZero(): number {
    return (this.red > 0 ? 1 : 0) + (this.green > 0 ? 1 : 0) + (this.blue > 0 ? 1 : 0);
  }

  map(fn: (value: number) => number): ColoredLike {
    return new Colored(fn(this.red), fn(this.green), fn(this.blue));
  }
}

/** Six cells of a row, in the order the result table renders them. */
type RowCells = readonly [string, string, string, string, string, string];

function row(cells: RowCells): HaxeProbability {
  return {
    recipeName: cells[0],
    avgCost: cells[1],
    chance: cells[2],
    avgTries: cells[3],
    recipeCost: cells[4],
    stdDev: cells[5],
    favg: 0,
  };
}

/**
 * The old page created twenty rows up front and left the first four showing a
 * dash until the first calculation, so the table never collapses to nothing.
 */
const PLACEHOLDER_ROWS: readonly HaxeProbability[] = [1, 2, 3, 4].map(() =>
  row(['-', '-', '-', '-', '-', '-']),
);

@Component({
  selector: 'poe-chromatic',
  imports: [ToolPage, PoeCard, FormsModule],
  templateUrl: './chromatic.html',
})
export class Chromatic {
  /** `window.Main` from the vendored Haxe build, or null if it never loaded. */
  private readonly solver: PoEChromaticCalcMain | null = Chromatic.resolveSolver();

  readonly solverReady = this.solver !== null;

  readonly sockets = signal<number | null>(null);
  readonly str = signal<number | null>(null);
  readonly dex = signal<number | null>(null);
  readonly int = signal<number | null>(null);
  readonly red = signal<number | null>(null);
  readonly green = signal<number | null>(null);
  readonly blue = signal<number | null>(null);

  readonly rows = signal<readonly HaxeProbability[]>(PLACEHOLDER_ROWS);
  /** False until the first Calculate press, while the dashes are still shown. */
  readonly calculated = signal(false);

  /**
   * Cheapest craft, highlighted with `.best`. Mirrors the solver's own rule:
   * the lowest positive average cost, falling back to the first row (which is
   * how an error row ends up highlighted).
   */
  readonly bestIndex = computed(() => {
    if (!this.calculated()) {
      return -1;
    }
    let best = 0;
    let min = 0;
    this.rows().forEach((probability, index) => {
      if (probability.favg > 0 && (min === 0 || min > probability.favg)) {
        best = index;
        min = probability.favg;
      }
    });
    return best;
  });

  calculate(): void {
    const solver = this.solver;
    if (!solver) {
      return;
    }

    // Empty fields parse as null in the original (Std.parseInt) and are then
    // treated as zero, so the same inputs produce the same errors here.
    const str = this.str() ?? 0;
    const dex = this.dex() ?? 0;
    const int = this.int() ?? 0;
    const red = this.red() ?? 0;
    const green = this.green() ?? 0;
    const blue = this.blue() ?? 0;

    let sockets = this.sockets();
    if (sockets === null) {
      // Left blank: assume exactly as many sockets as colours asked for, and
      // write the number back into the field like the old page did.
      sockets = red + green + blue;
      this.sockets.set(sockets);
    }

    const errors: HaxeProbability[] = [];
    if (sockets <= 0 || sockets > 6) {
      errors.push(row(['Error:', 'Invalid', 'number', 'of', 'sockets.', ':(']));
    }
    if (str < 0 || dex < 0 || int < 0) {
      errors.push(row(['Error:', 'Invalid', 'item', 'stat', 'requirements.', ':(']));
    }
    if (str === 0 && dex === 0 && int === 0) {
      errors.push(row(['Error:', 'Please', 'fill in', 'stat', 'requirements.', ':(']));
    }
    if (
      red < 0 ||
      green < 0 ||
      blue < 0 ||
      red + green + blue === 0 ||
      red > 6 ||
      green > 6 ||
      blue > 6 ||
      red + green + blue > sockets
    ) {
      errors.push(row(['Error:', 'Invalid', 'desired', 'socket', 'colors.', ':(']));
    }

    this.rows.set(
      errors.length > 0
        ? errors
        : solver.getProbabilities(
            new Colored(str, dex, int),
            new Colored(red, green, blue),
            sockets,
          ),
    );
    this.calculated.set(true);
  }

  private static resolveSolver(): PoEChromaticCalcMain | null {
    if (typeof window === 'undefined') {
      return null;
    }
    const main = window.Main;
    if (!main || typeof main.getProbabilities !== 'function') {
      return null;
    }
    if (!main.recipes || main.recipes.length === 0) {
      // `main()` fills the recipe list before it reaches the old site's DOM,
      // so a retry is safe: it either finishes the setup we need or throws on
      // elements this app does not have.
      try {
        main.main();
      } catch {
        // Expected: the old #resultbody / #calcButton elements are gone.
      }
      if (!main.recipes || main.recipes.length === 0) {
        return null;
      }
    }
    return main;
  }
}
