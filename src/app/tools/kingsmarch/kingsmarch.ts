import { Component, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';
import {
  BONUS_OPTIONS,
  GROUP_LABEL,
  GROUP_NOTE,
  MAX_SHIPMENT,
  MIN_SHIPMENT,
  PRIORITY_OPTIONS,
  PRIORITY_WEIGHT,
  Priority,
  RESOURCES,
  ResourceGroup,
  baseForTotal,
  totalWithDust,
} from './kingsmarch-data';
import { MatchMode, SolverItem, solveShipment } from './shipment-solver';

/* Kingsmarch Shipment Planner.

   You say what is in the warehouse and how much shipment value you are after;
   the tool works out which units to load. See `shipment-solver.ts` for how the
   mix is chosen — the short version is that the target fixes how much value
   gets shipped, so the priorities only decide *which* goods pay for it. */

const STORAGE_KEY = 'poe_kingsmarch_state';

interface StoredState {
  stock: Record<string, number>;
  priority: Record<string, Priority>;
  bonus: Record<string, number>;
  target: number | null;
  dust: number | null;
  mode: MatchMode;
}

interface Section {
  group: ResourceGroup;
  label: string;
  note: string;
  rows: Row[];
  /** shipment value the group contributes */
  valueText: string;
}

interface Row {
  id: string;
  name: string;
  /** what a unit is worth here, once a port quota is applied */
  effective: string;
  boosted: boolean;
  have: number | null;
  priority: Priority;
  bonus: number;
  ship: number;
  shipText: string;
  leftText: string;
  /** shipment value this row contributes */
  contributesText: string;
  /** width of the in-row bar, as a share of the biggest contributor */
  barWidth: string;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function clampNumber(value: number | null, min: number, max: number): number {
  if (value === null || Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isPriority(value: unknown): value is Priority {
  return PRIORITY_OPTIONS.some((option) => option.value === value);
}

function load(): StoredState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as StoredState;
  } catch {
    return null;
  }
}

@Component({
  selector: 'poe-kingsmarch',
  imports: [ToolPage, PoeCard, FormsModule],
  templateUrl: './kingsmarch.html',
})
export class Kingsmarch {
  readonly priorityOptions = PRIORITY_OPTIONS;
  readonly bonusOptions = BONUS_OPTIONS;
  readonly minShipment = MIN_SHIPMENT;
  readonly maxShipment = MAX_SHIPMENT;
  readonly minShipmentText = fmt(MIN_SHIPMENT);
  readonly maxShipmentText = fmt(MAX_SHIPMENT);

  /** Raw field contents — left unclamped so typing is never fought with. */
  readonly targetInput = signal<number | null>(MIN_SHIPMENT);
  readonly dustInput = signal<number | null>(0);
  readonly mode = signal<MatchMode>('nearest');

  private readonly stock = signal<Record<string, number | null>>({});
  private readonly priority = signal<Record<string, Priority>>(
    Object.fromEntries(RESOURCES.map((r) => [r.id, 'normal' as Priority])),
  );
  private readonly bonus = signal<Record<string, number>>(
    Object.fromEntries(RESOURCES.map((r) => [r.id, 0])),
  );

  readonly copied = signal(false);

  constructor() {
    this.restore();
    effect(() => this.persist());
  }

  // ── input ────────────────────────────────────────────────────────────────

  setStock(id: string, value: number | null): void {
    this.stock.update((current) => ({ ...current, [id]: value }));
  }

  setPriority(id: string, value: Priority): void {
    this.priority.update((current) => ({ ...current, [id]: value }));
  }

  setBonus(id: string, value: number): void {
    this.bonus.update((current) => ({ ...current, [id]: Number(value) }));
  }

  setTargetTo(value: number): void {
    this.targetInput.set(value);
  }

  clearStock(): void {
    this.stock.set({});
  }

  resetPriorities(): void {
    this.priority.set(Object.fromEntries(RESOURCES.map((r) => [r.id, 'normal' as Priority])));
    this.bonus.set(Object.fromEntries(RESOURCES.map((r) => [r.id, 0])));
  }

  // ── the plan ─────────────────────────────────────────────────────────────

  /**
   * Port quotas add whole tenths (+20% … +100%), so the moment one is set the
   * whole calculation moves to tenths of a point to stay on integers.
   */
  private readonly scale = computed(() =>
    RESOURCES.some((r) => (this.bonus()[r.id] ?? 0) > 0) ? 10 : 1,
  );

  /** Unit value in solver units — tenths of a point when a quota is active. */
  private unitValue(id: string, value: number): number {
    const scale = this.scale();
    return scale === 1 ? value : value * (10 + (this.bonus()[id] ?? 0));
  }

  readonly target = computed(() => clampNumber(this.targetInput(), 0, MAX_SHIPMENT));
  readonly dust = computed(() => clampNumber(this.dustInput(), 0, MAX_SHIPMENT));

  /** What the real goods have to be worth once dust has topped the rest up. */
  readonly requiredBase = computed(() => baseForTotal(this.target(), this.dust()));

  private readonly items = computed<SolverItem[]>(() =>
    RESOURCES.filter((r) => this.priority()[r.id] !== 'never').map((r) => ({
      key: r.id,
      value: this.unitValue(r.id, r.value),
      stock: Math.max(0, Math.trunc(this.stock()[r.id] ?? 0)),
      weight: PRIORITY_WEIGHT[this.priority()[r.id] ?? 'normal'],
    })),
  );

  private readonly solution = computed(() => {
    const scale = this.scale();
    const base = this.requiredBase() * scale;
    const mode = this.mode();
    // Round in the direction the mode promises, so the dust conversion cannot
    // nudge the answer past the wrong side of the target.
    const rounded =
      mode === 'atLeast'
        ? Math.ceil(base)
        : mode === 'atMost'
          ? Math.floor(base)
          : Math.round(base);
    return solveShipment(this.items(), rounded, mode);
  });

  /** Shipment value carried by the goods themselves. */
  readonly baseValue = computed(() => this.solution().total / this.scale());
  readonly totalValue = computed(() => totalWithDust(this.baseValue(), this.dust()));
  readonly dustValue = computed(() => this.totalValue() - this.baseValue());

  readonly delta = computed(() => Math.round(this.totalValue() - this.target()));

  readonly totalText = computed(() => fmt(this.totalValue()));
  readonly baseText = computed(() => fmt(this.baseValue()));
  readonly dustText = computed(() => fmt(this.dustValue()));
  readonly requiredBaseText = computed(() => fmt(this.requiredBase()));

  readonly deltaText = computed(() => {
    const delta = this.delta();
    if (delta === 0) return 'Exact match';
    return (delta > 0 ? '+' : '−') + fmt(Math.abs(delta)) + ' vs target';
  });

  /** `full` / `over` / `under` / `short`, driving the colour of the readout. */
  readonly status = computed<'full' | 'over' | 'under' | 'short'>(() => {
    if (this.solution().short) return 'short';
    const delta = this.delta();
    if (delta === 0) return 'full';
    return delta > 0 ? 'over' : 'under';
  });

  readonly statusLabel = computed(() => {
    switch (this.status()) {
      case 'full':
        return 'Target hit exactly';
      case 'over':
        return 'Closest above target';
      case 'under':
        return 'Closest below target';
      default:
        return 'Not enough goods';
    }
  });

  readonly resultClass = computed(() => 'result-value ks-text-' + this.status());
  readonly statusClass = computed(() => 'exp-status ks-' + this.status());

  readonly belowMinimum = computed(() => this.target() > 0 && this.target() < MIN_SHIPMENT);
  readonly aboveMaximum = computed(() => (this.targetInput() ?? 0) > MAX_SHIPMENT);

  /** What the shippable warehouse is worth, quotas included, ignoring the target. */
  readonly stockValue = computed(() => {
    const scale = this.scale();
    return RESOURCES.filter((r) => this.priority()[r.id] !== 'never').reduce(
      (sum, r) =>
        sum + (this.unitValue(r.id, r.value) * Math.max(0, this.stock()[r.id] ?? 0)) / scale,
      0,
    );
  });
  readonly stockValueText = computed(() => fmt(this.stockValue()));

  /** Aims the target at everything on hand — the biggest shipment possible. */
  fillFromStock(): void {
    this.targetInput.set(Math.floor(totalWithDust(this.stockValue(), this.dust())));
  }

  // ── rendering ────────────────────────────────────────────────────────────

  readonly sections = computed<Section[]>(() => {
    const units = this.solution().units;
    const scale = this.scale();
    const contributions = new Map<string, number>();
    let widest = 0;
    for (const r of RESOURCES) {
      const value = ((units[r.id] ?? 0) * this.unitValue(r.id, r.value)) / scale;
      contributions.set(r.id, value);
      widest = Math.max(widest, value);
    }

    const groups: ResourceGroup[] = ['ore', 'bar', 'crop'];
    return groups.map((group) => {
      let groupValue = 0;
      const rows = RESOURCES.filter((r) => r.group === group).map<Row>((r) => {
        const have = this.stock()[r.id] ?? null;
        const ship = units[r.id] ?? 0;
        const contributes = contributions.get(r.id) ?? 0;
        const bonus = this.bonus()[r.id] ?? 0;
        groupValue += contributes;
        return {
          id: r.id,
          name: r.name,
          effective: (this.unitValue(r.id, r.value) / scale).toFixed(scale === 1 ? 0 : 1),
          boosted: bonus > 0,
          have,
          priority: this.priority()[r.id] ?? 'normal',
          bonus,
          ship,
          shipText: fmt(ship),
          leftText: fmt(Math.max(0, Math.trunc(have ?? 0)) - ship),
          contributesText: fmt(contributes),
          barWidth: widest > 0 ? ((contributes / widest) * 100).toFixed(1) + '%' : '0%',
        };
      });
      return {
        group,
        label: GROUP_LABEL[group],
        note: GROUP_NOTE[group],
        rows,
        valueText: fmt(groupValue),
      };
    });
  });

  readonly shippedRows = computed(() =>
    this.sections()
      .flatMap((s) => s.rows)
      .filter((r) => r.ship > 0),
  );

  readonly hasPlan = computed(() => this.shippedRows().length > 0 || this.dust() > 0);

  readonly manifest = computed(() => {
    const lines = this.shippedRows().map((row) => `${row.name} x${row.shipText}`);
    if (this.dust() > 0) lines.push(`Thaumaturgic Dust x${fmt(this.dust())}`);
    lines.push(`— shipment value ${this.totalText()}`);
    return lines.join('\n');
  });

  async copyManifest(): Promise<void> {
    const text = this.manifest();
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        /* fall through to the legacy path */
      }
    }
    if (!ok) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      document.body.removeChild(textarea);
    }
    if (ok) {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    }
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private restore(): void {
    const saved = load();
    if (!saved) return;
    if (saved.stock && typeof saved.stock === 'object') {
      const stock: Record<string, number | null> = {};
      for (const r of RESOURCES) {
        const value = saved.stock[r.id];
        if (typeof value === 'number' && Number.isFinite(value)) stock[r.id] = value;
      }
      this.stock.set(stock);
    }
    if (saved.priority && typeof saved.priority === 'object') {
      this.priority.update((current) => {
        const next = { ...current };
        for (const r of RESOURCES) {
          const value = saved.priority[r.id];
          if (isPriority(value)) next[r.id] = value;
        }
        return next;
      });
    }
    if (saved.bonus && typeof saved.bonus === 'object') {
      this.bonus.update((current) => {
        const next = { ...current };
        for (const r of RESOURCES) {
          const value = saved.bonus[r.id];
          if (typeof value === 'number' && BONUS_OPTIONS.some((o) => o.value === value)) {
            next[r.id] = value;
          }
        }
        return next;
      });
    }
    if (typeof saved.target === 'number') this.targetInput.set(saved.target);
    if (typeof saved.dust === 'number') this.dustInput.set(saved.dust);
    if (saved.mode === 'nearest' || saved.mode === 'atLeast' || saved.mode === 'atMost') {
      this.mode.set(saved.mode);
    }
  }

  private persist(): void {
    const stock: Record<string, number> = {};
    for (const r of RESOURCES) {
      const value = this.stock()[r.id];
      if (typeof value === 'number' && Number.isFinite(value)) stock[r.id] = value;
    }
    const state: StoredState = {
      stock,
      priority: this.priority(),
      bonus: this.bonus(),
      target: this.targetInput(),
      dust: this.dustInput(),
      mode: this.mode(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* private mode / quota — the tool still works, it just forgets */
    }
  }
}
