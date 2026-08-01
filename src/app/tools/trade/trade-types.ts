/**
 * Shapes for the Bulk Trade Calculator.
 *
 * NOTE: `currencyType` uses the single Cyrillic letters the original tool wrote
 * into localStorage — 'д' (divine) and 'с' (chaos). They are *data*, not UI
 * strings, and must stay exactly as-is so previously saved presets keep loading.
 */

export type CurrencyType = 'д' | 'с';

export interface Calculator {
  id: number;
  label: string;
  totalQuantity: number;
  price: number;
  currencyType: CurrencyType;
}

export interface Preset {
  name: string;
  exchangeRate: number;
  requestHeader: string;
  requestFooter: string;
  calculators: Calculator[];
}

/** Exactly the object the old tool stored under `poe_trade_working`. */
export interface StoredWorking {
  loadedName: string;
  working: Preset;
}

export const DEFAULT_PRESET: Preset = {
  name: 'Main',
  exchangeRate: 160,
  requestHeader: '',
  requestFooter: '',
  calculators: [
    { id: 1, label: '', totalQuantity: 0, price: 0, currencyType: 'д' },
    { id: 2, label: '', totalQuantity: 0, price: 0, currencyType: 'д' },
    { id: 3, label: '', totalQuantity: 0, price: 0, currencyType: 'д' },
    { id: 4, label: '', totalQuantity: 0, price: 0, currencyType: 'д' },
    { id: 5, label: '', totalQuantity: 0, price: 0, currencyType: 'д' },
    { id: 6, label: '', totalQuantity: 0, price: 0, currencyType: 'д' },
    { id: 7, label: '', totalQuantity: 0, price: 0, currencyType: 'д' },
    { id: 8, label: '', totalQuantity: 0, price: 0, currencyType: 'д' },
  ],
};

export const BEASTS_PRESET: Preset = {
  name: 'POE BEAST',
  exchangeRate: 160,
  requestHeader: 'WTS Softcore',
  requestFooter: ' IGN: @YOUNICKNAME',
  calculators: [
    { id: 1, label: 'Vivid Watcher', totalQuantity: 0, price: 1.4, currencyType: 'д' },
    { id: 2, label: 'Vivid Vulture', totalQuantity: 0, price: 0.7, currencyType: 'д' },
    { id: 3, label: 'Wild Bristle Matron', totalQuantity: 0, price: 0.7, currencyType: 'д' },
    { id: 4, label: 'Wild Brambleback', totalQuantity: 0, price: 0.2, currencyType: 'д' },
    { id: 5, label: 'Wild Hellion Alpha', totalQuantity: 0, price: 0.4, currencyType: 'д' },
    { id: 6, label: 'Fenumal Plagued Arachnid', totalQuantity: 0, price: 0.1, currencyType: 'д' },
    { id: 7, label: 'Craicic chimeral', totalQuantity: 0, price: 0.7, currencyType: 'д' },
    { id: 8, label: 'Black Morrigan', totalQuantity: 0, price: 1.0, currencyType: 'д' },
  ],
};

export function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Same validation the original `isValidPreset()` performed, plus the two
 *  request fields (which the loader always fills in before validating). */
export function isValidPreset(value: unknown): value is Preset {
  if (!isRecord(value)) return false;
  if (typeof value['name'] !== 'string') return false;
  if (typeof value['exchangeRate'] !== 'number') return false;
  if (typeof value['requestHeader'] !== 'string') return false;
  if (typeof value['requestFooter'] !== 'string') return false;
  const calculators = value['calculators'];
  if (!Array.isArray(calculators)) return false;
  return calculators.every(
    (calc: unknown) =>
      isRecord(calc) &&
      typeof calc['id'] === 'number' &&
      typeof calc['label'] === 'string' &&
      typeof calc['totalQuantity'] === 'number' &&
      typeof calc['price'] === 'number' &&
      (calc['currencyType'] === 'д' || calc['currencyType'] === 'с'),
  );
}

/** `parseNum()` from the original: comma-decimals allowed, NaN → 0, clamped at 0. */
export function parseNum(text: string): number {
  const n = parseFloat(text.replace(',', '.'));
  return isNaN(n) ? 0 : Math.max(0, n);
}

/** The exchange-rate field parsed the way the original did: no clamping, `|| 0`. */
export function parseRate(text: string): number {
  return parseFloat(text.replace(',', '.')) || 0;
}

/** How the original re-rendered a numeric input's value: `${n || ''}`. */
export function numText(n: number): string {
  return n ? String(n) : '';
}
