/**
 * Types for the vendored Vorici solver (`public/vendor/PoEChromaticCalc.js`),
 * a Haxe build by Siveran that is loaded with a plain `<script>` tag in
 * `src/index.html`.
 *
 * The file ends with `})(console, typeof window != "undefined" ? window : exports)`,
 * so its `$hx_exports` object *is* `window` and the single thing it publishes is
 * `window.Main`. Everything else (`Colored`, `Recipe`, `Probability`, `Utils`)
 * stays inside the IIFE and is only reachable through values `Main` hands back.
 *
 * The script also runs `Main.main()` on load. That call fills `Main.recipes`
 * first and only then looks for the old site's `#sockets` / `#resultbody` /
 * `#calcButton` elements, so under Angular it populates the recipe table and
 * then throws on the missing DOM. The static maths entry points we use are
 * unaffected; the DOM-driven `main()` / `calculate()` / `updateTable()` are not
 * used by this port (`updateTable` also needs the SortTable library, which this
 * app does not ship).
 */

/** A plain red/green/blue triple, as returned by `Main.getColorChances`. */
export interface ColorTriple {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/**
 * The subset of the Haxe `Colored` API the solver actually calls on the values
 * passed into `getColorChances` / `getProbabilities`. `Colored` itself is not
 * exported, so callers supply their own structurally compatible object.
 */
export interface ColoredLike extends ColorTriple {
  /** red + green + blue */
  total(): number;
  /** How many of the three components are greater than zero. */
  countNonZero(): number;
  /** Component-wise map; the solver only reads red/green/blue off the result. */
  map(fn: (value: number) => number): ColoredLike;
}

/** One craft option, as pushed into `Main.recipes` by `Main.main()`. */
export interface HaxeRecipe extends ColorTriple {
  /** Cost of a single attempt, in chromatic orbs. */
  readonly cost: number;
  /** Required crafting bench level. */
  readonly level: number;
  /** "Drop Rate", "Chromatic" or e.g. "Vorici 2R1G". */
  readonly description: string;
}

/**
 * One row of the result table. Every display field is a pre-formatted string
 * (the solver does its own rounding/comma insertion); `favg` is the raw
 * average cost used to pick the cheapest row.
 */
export interface HaxeProbability {
  readonly recipeName: string;
  /** Average total cost in chromatics, or "-" for the drop-rate row. */
  readonly avgCost: string;
  /** Success chance, already suffixed with "%". */
  readonly chance: string;
  /** Mean number of attempts. */
  readonly avgTries: string;
  /** Cost of one attempt, or "-" for the drop-rate row. */
  readonly recipeCost: string;
  /** Standard deviation of the number of attempts. */
  readonly stdDev: string;
  /** Raw average cost; 0 when the row is not a real result. */
  readonly favg: number;
}

/** The static class published as `window.Main`. */
export interface PoEChromaticCalcMain {
  /** Filled by `main()`; `getProbabilities` iterates it. */
  readonly recipes?: readonly HaxeRecipe[];
  /** Builds `recipes`, then wires the old site's DOM (throws without it). */
  main(): void;
  /** Per-socket colour odds derived from the item's attribute requirements. */
  getColorChances(requirements: ColoredLike): ColorTriple;
  /** One entry per craft that can produce `desired` on a `totalSockets` item. */
  getProbabilities(
    requirements: ColoredLike,
    desired: ColoredLike,
    totalSockets: number,
  ): readonly HaxeProbability[];
}

declare global {
  interface Window {
    /** Present only once `vendor/PoEChromaticCalc.js` has executed. */
    readonly Main?: PoEChromaticCalcMain;
  }
}
