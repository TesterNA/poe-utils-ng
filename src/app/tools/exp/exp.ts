import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';

/* EXP Penalty Calculator — Path of Exile 1 & 2
   Formulas from the PoE / PoE 2 community wikis.
     SafeZone           = floor(3 + level/16)                       (both games)
     EffectiveDifference = max(|level - effMonsterLevel| - SafeZone, 0)
     XPMultiplier       = max( ((level+5)/(level+5 + diff^2.5))^E, 0.01 )
                          E = 1.5 (PoE 1)  ·  E = 1.3 (PoE 2)
   PoE 1 only: areas with monster level > 70 are treated as a lower level for
   XP purposes:  effML = -0.03*ml^2 + 5.17*ml - 144.9  (caps near 77.7). */

export type ExpGame = 'poe1' | 'poe2';

type CategoryKey = 'full' | 'min' | 'mod' | 'heavy' | 'severe';

interface Category {
  key: CategoryKey;
  label: string;
}

interface ExpResult {
  effML: number;
  safe: number;
  effDiff: number;
  mult: number;
}

/** Contiguous span of area levels granting full XP, plus the single best level. */
interface FullXpBand {
  lo: number | null;
  hi: number | null;
  best: number;
  bestMult: number;
}

/** One rendered line of the "XP By Area Level" table. */
interface ExpRow {
  level: number;
  /** `exp-row xp-<key>` plus `exp-row-current` for the entered zone */
  cls: string;
  delta: string;
  tier: number | null;
  /** inline width of the coloured bar, e.g. `"73.4%"` */
  barWidth: string;
  pct: string;
}

function safeZone(level: number): number {
  return Math.floor(3 + level / 16);
}

function effectiveMonsterLevel(monsterLevel: number, game: ExpGame): number {
  if (game === 'poe1' && monsterLevel > 70) {
    const eff = -0.03 * monsterLevel * monsterLevel + 5.17 * monsterLevel - 144.9;
    return Math.min(monsterLevel, eff);
  }
  return monsterLevel;
}

// Map tier for an area level (T1–T16). Differs by game:
//   PoE 1: T1 = area level 68 … T16 = 83
//   PoE 2: T1 = area level 65 … T16 = 80
// Returns null outside that range (no tier shown above/below).
function mapTier(areaLevel: number, game: ExpGame): number | null {
  const t = areaLevel - (game === 'poe2' ? 64 : 67);
  return t >= 1 && t <= 16 ? t : null;
}

function compute(level: number, monsterLevel: number, game: ExpGame): ExpResult {
  const effML = effectiveMonsterLevel(monsterLevel, game);
  const safe = safeZone(level);
  const effDiff = Math.max(Math.abs(level - effML) - safe, 0);
  const outer = game === 'poe2' ? 1.3 : 1.5;
  const base = level + 5;
  const raw = Math.pow(base / (base + Math.pow(effDiff, 2.5)), outer);
  return { effML, safe, effDiff, mult: Math.max(raw, 0.01) };
}

function category(mult: number): Category {
  if (mult >= 0.9999) return { key: 'full', label: 'Full XP — No Penalty' };
  if (mult >= 0.9) return { key: 'min', label: 'Minimal Penalty' };
  if (mult >= 0.5) return { key: 'mod', label: 'Moderate Penalty' };
  if (mult >= 0.1) return { key: 'heavy', label: 'Heavy Penalty' };
  return { key: 'severe', label: 'Severe Penalty' };
}

function fmtPct(mult: number): string {
  const pct = mult * 100;
  return Math.abs(pct - Math.round(pct)) < 0.05 ? Math.round(pct) + '%' : pct.toFixed(1) + '%';
}

function trimNum(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

// Contiguous span of area levels that grant full XP, plus the single best area
// level (highest multiplier) — used as a fallback when no full-XP band exists,
// e.g. high-level PoE 1 chars capped out by the level-70 area reduction.
function fullXpRange(level: number, game: ExpGame): FullXpBand {
  let lo: number | null = null;
  let hi: number | null = null;
  let best = 1;
  let bestMult = -1;
  for (let z = 1; z <= 100; z++) {
    if (Math.abs(level - effectiveMonsterLevel(z, game)) - safeZone(level) <= 0) {
      if (lo === null) lo = z;
      hi = z;
    }
    const m = compute(level, z, game).mult;
    if (m > bestMult) {
      bestMult = m;
      best = z;
    }
  }
  return { lo, hi, best, bestMult };
}

function buildTable(level: number, currentZone: number, game: ExpGame, band: FullXpBand): ExpRow[] {
  // Span the range so it covers the character, the entered zone AND the
  // full-XP band — so the dropoff between them is always visible.
  const hiAnchor = band.lo !== null && band.hi !== null ? band.hi : band.best;
  const loAnchor = band.lo !== null ? band.lo : band.best;
  let top = Math.min(100, Math.max(level + 4, currentZone + 3, hiAnchor + 2));
  let bottom = Math.max(1, Math.min(level - 6, currentZone - 3, loAnchor - 2));
  // Guard against absurd spans (e.g. level 1 vs zone 100) — keep it readable.
  if (top - bottom > 48) {
    top = Math.min(100, currentZone + 24);
    bottom = Math.max(1, top - 48);
  }
  const rows: ExpRow[] = [];
  for (let z = top; z >= bottom; z--) {
    const r = compute(level, z, game);
    const cat = category(r.mult);
    const pct = r.mult * 100;
    const delta = z - level;
    rows.push({
      level: z,
      cls: 'exp-row xp-' + cat.key + (z === currentZone ? ' exp-row-current' : ''),
      delta: (delta > 0 ? '+' : '') + delta,
      tier: mapTier(z, game),
      barWidth: pct.toFixed(1) + '%',
      pct: fmtPct(r.mult),
    });
  }
  return rows;
}

/** Mirrors the old `parseInt` + clamp: bad/empty input falls back, then clamps. */
function clampInt(v: number | null, min: number, max: number, fallback: number): number {
  const parsed = v === null || Number.isNaN(v) ? fallback : Math.trunc(v);
  return Math.min(max, Math.max(min, parsed));
}

@Component({
  selector: 'poe-exp',
  imports: [ToolPage, PoeCard, FormsModule],
  templateUrl: './exp.html',
})
export class Exp {
  private readonly injector = inject(Injector);

  private readonly tableWrap = viewChild<ElementRef<HTMLDivElement>>('tableWrap');
  private readonly resultValue = viewChild<ElementRef<HTMLDivElement>>('resultValue');

  readonly game = signal<ExpGame>('poe1');

  /** Raw field contents — kept unclamped so typing is never fought with. */
  readonly levelInput = signal<number | null>(90);
  readonly zoneInput = signal<number | null>(83);

  readonly level = computed(() => clampInt(this.levelInput(), 1, 100, 90));
  readonly zone = computed(() => clampInt(this.zoneInput(), 1, 100, 83));

  private readonly result = computed(() => compute(this.level(), this.zone(), this.game()));

  readonly category = computed(() => category(this.result().mult));
  readonly resultPct = computed(() => fmtPct(this.result().mult));
  readonly resultClass = computed(() => 'result-value xp-text-' + this.category().key);
  readonly statusClass = computed(() => 'exp-status xp-' + this.category().key);

  readonly safeZoneText = computed(() => '±' + this.result().safe);
  readonly diffText = computed(() => {
    const diff = this.zone() - this.level();
    return (diff > 0 ? '+' : '') + diff;
  });
  readonly effDiffText = computed(() => trimNum(this.result().effDiff));

  /** The PoE 1 area-level reduction only exists above monster level 70. */
  readonly showEffML = computed(() => this.game() === 'poe1' && this.zone() > 70);
  readonly effMLText = computed(() => this.result().effML.toFixed(1));

  private readonly band = computed(() => fullXpRange(this.level(), this.game()));

  readonly hasFullXpBand = computed(() => this.band().lo !== null);
  readonly bandLabel = computed(() =>
    this.hasFullXpBand() ? 'Full XP at area levels:' : 'No full-XP area · best is:',
  );
  readonly bandValue = computed(() => {
    const band = this.band();
    if (band.lo === null) {
      // No penalty-free area exists — show the best obtainable instead.
      return 'level ' + band.best + ' (' + fmtPct(band.bestMult) + ')';
    }
    return band.lo === band.hi ? String(band.lo) : band.lo + ' – ' + band.hi;
  });

  readonly rows = computed(() =>
    buildTable(this.level(), this.zone(), this.game(), this.band()),
  );

  readonly showPoe1Note = computed(() => this.game() === 'poe1');
  readonly showLevel95Note = computed(() => this.game() === 'poe1' && this.level() >= 95);

  constructor() {
    // The old script re-ran `calculate()` on a `tool:shown` CustomEvent because
    // every view lived in the DOM behind `display:none` — the first run could
    // not measure anything, so the table auto-scroll silently did nothing. With
    // the router this component is only created once it is navigated to, so the
    // event is gone; what is left is purely a post-render DOM concern.
    //
    // `effect` + `afterNextRender` was chosen over a bare `afterNextRender`
    // because the original re-positioned on *every* recalculation, not just the
    // first one: the effect tracks the table, `afterNextRender` guarantees the
    // rebuilt rows are laid out (and therefore measurable) before we scroll.
    effect(() => {
      this.rows();
      this.resultPct();
      afterNextRender(
        () => {
          this.scrollCurrentIntoView();
          this.popResult();
        },
        { injector: this.injector },
      );
    });
  }

  /** Scroll the table so the entered zone sits in view (ramp visible below it). */
  private scrollCurrentIntoView(): void {
    const wrap = this.tableWrap()?.nativeElement;
    const current = wrap?.querySelector<HTMLTableRowElement>('.exp-row-current');
    if (!wrap || !current || wrap.offsetParent === null) return;
    const wrapRect = wrap.getBoundingClientRect();
    const curRect = current.getBoundingClientRect();
    wrap.scrollTop += curRect.top - wrapRect.top - wrap.clientHeight / 3;
  }

  /** Restart the `countPop` keyframes on the big number (reflow forces a replay). */
  private popResult(): void {
    const el = this.resultValue()?.nativeElement;
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = 'countPop 0.15s ease';
  }
}
