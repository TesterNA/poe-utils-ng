import { Component, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ToolPage } from '../../shared/tool-page';
import { loadPresets, loadWorking, savePresets, saveWorking } from './trade-storage';
import {
  BEASTS_PRESET,
  Calculator,
  CurrencyType,
  DEFAULT_PRESET,
  Preset,
  deepCopy,
  isValidPreset,
  numText,
  parseNum,
  parseRate,
} from './trade-types';

const DIV_IMG = 'assets/div.png';
const CHAOS_IMG = 'assets/chaos.png';
const MAX_CALCULATORS = 20;

/**
 * One calculator as the component stores it. The numeric fields are held as the
 * raw text the user typed — exactly like the original, whose inputs were
 * `type="text"` and only parsed on the way *out* — so half-typed values such as
 * "1," or "0." are not stomped on mid-keystroke.
 */
interface CalcEntry {
  id: number;
  label: string;
  totalText: string;
  priceText: string;
  currencyType: CurrencyType;
  /** "Qty sold" box; the original kept this in `state.soldAmounts`, never persisted. */
  soldText: string;
}

/** A `CalcEntry` plus everything derived from it that the template renders. */
interface CalcRow extends CalcEntry {
  total: number;
  price: number;
  sold: number;
  resultText: string;
}

interface TradeSummary {
  totalDText: string;
  totalCText: string;
  totalInCText: string;
  wholeDPart: number;
  remainderCText: string;
}

@Component({
  selector: 'poe-trade',
  imports: [ToolPage, FormsModule],
  templateUrl: './trade.html',
})
export class Trade {
  /** Saved presets. Never mutated while editing — only by the preset actions. */
  protected readonly presets = signal<Preset[]>([deepCopy(DEFAULT_PRESET), deepCopy(BEASTS_PRESET)]);
  /** Name of the preset the working copy came from. */
  protected readonly loadedName = signal(DEFAULT_PRESET.name);

  // ── Working copy, exploded into signals ────────────────
  private readonly workingName = signal(DEFAULT_PRESET.name);
  protected readonly exchangeRateText = signal(String(DEFAULT_PRESET.exchangeRate));
  protected readonly requestHeader = signal(DEFAULT_PRESET.requestHeader);
  protected readonly requestFooter = signal(DEFAULT_PRESET.requestFooter);
  protected readonly entries = signal<CalcEntry[]>(toEntries(DEFAULT_PRESET.calculators));

  // ── UI-only state ──────────────────────────────────────
  protected readonly showPresetPanel = signal(false);
  protected readonly newPresetName = signal('');
  protected readonly importText = signal('');
  protected readonly modalOpen = signal(false);
  protected readonly modalBody = signal('');

  protected readonly divImg = DIV_IMG;
  protected readonly chaosImg = CHAOS_IMG;

  protected readonly exchangeRate = computed(() => parseRate(this.exchangeRateText()));

  protected readonly rows = computed<CalcRow[]>(() =>
    this.entries().map((entry) => {
      const price = parseNum(entry.priceText);
      const sold = parseNum(entry.soldText);
      return {
        ...entry,
        total: parseNum(entry.totalText),
        price,
        sold,
        resultText: (sold * price).toFixed(2),
      };
    }),
  );

  /** The working copy reassembled into the on-disk `Preset` shape. */
  protected readonly working = computed<Preset>(() => ({
    name: this.workingName(),
    exchangeRate: this.exchangeRate(),
    requestHeader: this.requestHeader(),
    requestFooter: this.requestFooter(),
    calculators: this.rows().map((row) => ({
      id: row.id,
      label: row.label,
      totalQuantity: row.total,
      price: row.price,
      currencyType: row.currencyType,
    })),
  }));

  protected readonly canAddCalculator = computed(() => this.entries().length < MAX_CALCULATORS);
  protected readonly soloCalculator = computed(() => this.entries().length <= 1);

  protected readonly summary = computed<TradeSummary>(() => {
    const rate = this.exchangeRate() || 160;
    let totalD = 0;
    let totalC = 0;
    for (const row of this.rows()) {
      const value = row.sold * row.price;
      if (row.currencyType === 'д') totalD += value;
      else totalC += value;
    }
    const totalInC = totalC + totalD * rate;
    const wholeDPart = Math.floor(totalInC / rate);
    const remainderC = totalInC - wholeDPart * rate;
    return {
      totalDText: totalD.toFixed(2),
      totalCText: totalC.toFixed(2),
      totalInCText: totalInC.toFixed(2),
      wholeDPart,
      remainderCText: remainderC.toFixed(2),
    };
  });

  constructor() {
    this.loadFromStorage();
    effect(() => savePresets(this.presets()));
    effect(() => saveWorking(this.loadedName(), this.working()));
  }

  // ── Storage ────────────────────────────────────────────
  private loadFromStorage(): void {
    const presets = loadPresets();
    if (presets) this.presets.set(presets);

    const stored = loadWorking();
    if (stored) {
      this.loadedName.set(stored.loadedName);
      this.applyWorking(stored.working);
    }
  }

  /** Push a whole preset into the working signals (clears the sold boxes). */
  private applyWorking(preset: Preset): void {
    this.workingName.set(preset.name);
    this.exchangeRateText.set(String(preset.exchangeRate));
    this.requestHeader.set(preset.requestHeader);
    this.requestFooter.set(preset.requestFooter);
    this.entries.set(toEntries(preset.calculators));
  }

  /**
   * The original re-rendered every input from state after any structural
   * change, which normalised whatever the user had typed. This reproduces that
   * without throwing away the sold amounts.
   */
  private normalizeTexts(): void {
    this.exchangeRateText.set(String(this.exchangeRate()));
    this.entries.update((list) =>
      list.map((entry) => ({
        ...entry,
        totalText: numText(parseNum(entry.totalText)),
        priceText: numText(parseNum(entry.priceText)),
        soldText: numText(parseNum(entry.soldText)),
      })),
    );
  }

  private patchEntry(id: number, patch: Partial<CalcEntry>): void {
    this.entries.update((list) =>
      list.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  }

  // ── Preset actions ─────────────────────────────────────
  protected togglePresetPanel(): void {
    this.showPresetPanel.update((open) => !open);
  }

  protected loadPreset(name: string): void {
    const preset = this.presets().find((p) => p.name === name);
    if (!preset) return;
    this.loadedName.set(name);
    this.applyWorking(deepCopy(preset));
  }

  protected savePreset(name: string): void {
    if (!name) {
      window.alert('Enter a preset name');
      return;
    }
    if (this.presets().some((p) => p.name === name)) {
      window.alert('A preset with this name already exists');
      return;
    }
    const newPreset = deepCopy(this.working());
    newPreset.name = name;
    this.presets.update((list) => [...list, newPreset]);
    this.loadedName.set(name);
    // The working copy already *is* this preset, only its name changes.
    this.workingName.set(name);
    this.normalizeTexts();
    this.newPresetName.set('');
    window.alert(`Preset "${name}" saved!`);
  }

  protected overwriteCurrentPreset(): void {
    const name = this.loadedName();
    if (!window.confirm(`Overwrite preset "${name}" with current settings?`)) return;
    const copy = deepCopy(this.working());
    copy.name = name;
    this.presets.update((list) => {
      const idx = list.findIndex((p) => p.name === name);
      if (idx === -1) return [...list, copy];
      const next = [...list];
      next[idx] = copy;
      return next;
    });
    window.alert(`Preset "${name}" updated!`);
  }

  protected deletePreset(name: string): void {
    if (name === 'Main') {
      window.alert('Cannot delete the Main preset');
      return;
    }
    if (!window.confirm(`Delete preset "${name}"?`)) return;
    this.presets.update((list) => list.filter((p) => p.name !== name));
    this.loadPreset('Main');
  }

  protected exportPreset(): void {
    const data = btoa(encodeURIComponent(JSON.stringify(this.working())));
    void this.copyToClipboard(data).then((ok) => {
      window.alert(ok ? 'Export code copied!' : 'Copy this code:\n\n' + data);
    });
  }

  protected importPreset(base64: string): void {
    if (!base64.trim()) {
      window.alert('Enter a base64 string');
      return;
    }
    const decoded = decodePreset(base64.trim());
    if (decoded === 'error') {
      window.alert('Import error — check the base64 string');
      return;
    }
    if (decoded === 'invalid') {
      window.alert('Invalid preset data');
      return;
    }
    const migrated = decoded;

    let name = migrated.name;
    let counter = 1;
    while (this.presets().some((p) => p.name === name)) name = `${migrated.name} (${counter++})`;
    migrated.name = name;

    this.presets.update((list) => [...list, migrated]);
    this.loadPreset(name);
    this.importText.set('');
    window.alert('Preset imported!');
  }

  // ── Working-state mutators ─────────────────────────────
  protected setLabel(id: number, value: string): void {
    this.patchEntry(id, { label: value });
  }

  protected setTotalText(id: number, value: string): void {
    this.patchEntry(id, { totalText: value });
  }

  protected setPriceText(id: number, value: string): void {
    this.patchEntry(id, { priceText: value });
  }

  protected setSoldText(id: number, value: string): void {
    this.patchEntry(id, { soldText: value });
  }

  protected setCurrency(id: number, currency: CurrencyType): void {
    this.patchEntry(id, { currencyType: currency });
  }

  protected addCalculator(): void {
    const list = this.entries();
    if (list.length >= MAX_CALCULATORS) return;
    const newId = Math.max(...list.map((entry) => entry.id)) + 1;
    this.entries.set([
      ...list,
      { id: newId, label: '', totalText: '', priceText: '', currencyType: 'д', soldText: '' },
    ]);
    this.normalizeTexts();
  }

  protected removeCalculator(id: number): void {
    if (this.entries().length <= 1) return;
    if (!window.confirm('Remove this calculator?')) return;
    this.entries.update((list) => list.filter((entry) => entry.id !== id));
    this.normalizeTexts();
  }

  protected markAsSold(id: number): void {
    const row = this.rows().find((r) => r.id === id);
    if (!row || row.sold <= 0) return;
    this.patchEntry(id, { totalText: numText(Math.max(0, row.total - row.sold)), soldText: '' });
    this.normalizeTexts();
  }

  protected resetAllTotals(): void {
    if (!window.confirm('Reset all total quantities to 0?')) return;
    this.entries.update((list) => list.map((entry) => ({ ...entry, totalText: '' })));
    this.normalizeTexts();
  }

  protected soldAll(): void {
    if (!window.confirm('Mark all sold quantities as sold?')) return;
    this.entries.update((list) =>
      list.map((entry) => {
        const sold = parseNum(entry.soldText);
        const total = parseNum(entry.totalText);
        return {
          ...entry,
          totalText: sold > 0 ? numText(Math.max(0, total - sold)) : entry.totalText,
          soldText: '',
        };
      }),
    );
    this.normalizeTexts();
  }

  // ── Request modal ──────────────────────────────────────
  protected openRequestModal(): void {
    const items = this.rows()
      .filter((row) => row.total > 0)
      .map(
        (row) =>
          `x${row.total} ${row.label || 'Calculator_' + row.id} - ${row.price}` +
          `${row.currencyType === 'д' ? ':divine:' : ':chaos:'}/ea`,
      );
    this.modalBody.set(
      items.length ? items.join('\n') : 'No items for sale (all quantities = 0)',
    );
    this.modalOpen.set(true);
  }

  protected closeRequestModal(): void {
    this.modalOpen.set(false);
  }

  protected copyFullRequest(): void {
    const text = [this.requestHeader().trim(), this.modalBody(), this.requestFooter().trim()]
      .filter(Boolean)
      .join('\n\n');
    void this.copyToClipboard(text).then((ok) => {
      window.alert(ok ? 'Copied!' : 'Copy manually:\n' + text);
    });
  }

  /** Async Clipboard API with the old `execCommand` textarea fallback. */
  private async copyToClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* fall through to the legacy path */
      }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(textarea);
    return ok;
  }

  // ── Template helpers ───────────────────────────────────
  protected imgSrc(type: CurrencyType): string {
    return type === 'д' ? DIV_IMG : CHAOS_IMG;
  }

  protected imgAlt(type: CurrencyType): string {
    return type === 'д' ? 'div' : 'chaos';
  }
}

function toEntries(calculators: Calculator[]): CalcEntry[] {
  return calculators.map((calc) => ({
    id: calc.id,
    label: calc.label,
    totalText: numText(calc.totalQuantity),
    priceText: numText(calc.price),
    currencyType: calc.currencyType,
    soldText: '',
  }));
}

function readString(source: unknown, key: string): string {
  if (typeof source !== 'object' || source === null) return '';
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/**
 * `atob` + `decodeURIComponent` + `JSON.parse`, mirroring `exportPreset()`.
 * Returns 'error' for undecodable input and 'invalid' for a well-formed blob
 * that is not a preset — the two distinct messages the original showed.
 */
function decodePreset(base64: string): Preset | 'invalid' | 'error' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(atob(base64)));
  } catch {
    return 'error';
  }
  const candidate = {
    ...(typeof parsed === 'object' && parsed !== null ? parsed : {}),
    requestHeader: readString(parsed, 'requestHeader'),
    requestFooter: readString(parsed, 'requestFooter'),
  };
  return isValidPreset(candidate) ? candidate : 'invalid';
}
