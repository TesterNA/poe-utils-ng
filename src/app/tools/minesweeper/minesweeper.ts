/* Minesweeper — anti-landmine stash search generator */
import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';
import { regexRange } from './regex-range';

const STORAGE_KEY = 'poe_minesweeper_state';

/** The in-game search box takes 250 characters; past that the term is cut off. */
const SEARCH_LIMIT = 250;

const MAX_PRICE = 9999;
const MAX_LEVEL = 100;

/** What a cleared price field means. Emptying Max is not the same as asking
 *  for a one-price band — the search would then hide everything but that
 *  price, which is the opposite of what an unfinished field should do. */
const DEFAULT_MIN = 1;
const DEFAULT_MAX = 20;

export const CURRENCIES = ['chaos', 'divine', 'exalted'] as const;
type Currency = (typeof CURRENCIES)[number];

/**
 * `pte` is the stash-search shorthand for corrupted — the shortest run of
 * letters that appears in "Corrupted" and in no other word on an item — and a
 * leading `!` turns any term into its opposite.
 */
export const CORRUPTION = [
  { value: 'any', label: 'Any', term: '' },
  { value: 'yes', label: 'Corrupted', term: 'pte' },
  { value: 'no', label: 'Not corrupted', term: '!pte' },
] as const;
type Corruption = (typeof CORRUPTION)[number]['value'];

/**
 * The shared/stored form. Keys are one character because the whole thing rides
 * inside a link — and they match the original tool's, so its links open here.
 */
interface Share {
  /** lowest price */
  m?: number;
  /** highest price */
  M?: number;
  /** currency the price is noted in */
  c?: string;
  /** item level */
  i?: number;
  /** area level */
  a?: number;
  /** map tier */
  t?: number;
  /** corruption: 1 corrupted, 0 not, absent either */
  p?: number;
  /** extra search terms, passed through untouched */
  x?: string;
}

@Component({
  selector: 'poe-minesweeper',
  imports: [ToolPage, PoeCard],
  templateUrl: './minesweeper.html',
})
export class Minesweeper {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly currencies = CURRENCIES;
  readonly corruptionOptions = CORRUPTION;
  readonly maxPrice = MAX_PRICE;
  readonly maxLevel = MAX_LEVEL;
  readonly searchLimit = SEARCH_LIMIT;

  /** Raw field contents — left unclamped so typing is never fought with. */
  readonly minInput = signal<number | null>(DEFAULT_MIN);
  readonly maxInput = signal<number | null>(DEFAULT_MAX);
  readonly currency = signal<Currency>('chaos');
  readonly ilvlInput = signal<number | null>(null);
  readonly areaInput = signal<number | null>(null);
  readonly tierInput = signal<number | null>(null);
  readonly corruption = signal<Corruption>('any');
  readonly extra = signal('');

  readonly message = signal('');

  /** What the price fields mean once they are in range and the right way round. */
  readonly min = computed(() => clamp(this.minInput(), 1, MAX_PRICE, DEFAULT_MIN));
  readonly max = computed(() =>
    Math.max(this.min(), clamp(this.maxInput(), 1, MAX_PRICE, DEFAULT_MAX)),
  );

  /**
   * One search term per line of the form. Terms are space separated and the
   * game ands them together; quotes are what let a term contain spaces.
   */
  readonly terms = computed(() => {
    const terms = [`"~b/o ${regexRange(this.min(), this.max())} ${this.currency()}"`];
    const ilvl = clampOrNull(this.ilvlInput());
    const area = clampOrNull(this.areaInput());
    const tier = clampOrNull(this.tierInput());
    if (ilvl !== null) terms.push(`"ilvl: ${ilvl}"`);
    if (area !== null) terms.push(`"area level: ${area}"`);
    if (tier !== null) terms.push(`"tier: ${tier}"`);
    const corruption = CORRUPTION.find((option) => option.value === this.corruption());
    if (corruption?.term) terms.push(corruption.term);
    const extra = this.extra().trim();
    if (extra) terms.push(extra);
    return terms;
  });

  readonly search = computed(() => this.terms().join(' '));
  readonly overLimit = computed(() => this.search().length > SEARCH_LIMIT);

  readonly shareLink = computed(
    () => `${location.origin}${location.pathname}?s=${encodeShare(this.share())}`,
  );

  private readonly share = computed<Share>(() => {
    const share: Share = { m: this.min(), M: this.max(), c: this.currency() };
    const ilvl = clampOrNull(this.ilvlInput());
    const area = clampOrNull(this.areaInput());
    const tier = clampOrNull(this.tierInput());
    if (ilvl !== null) share.i = ilvl;
    if (area !== null) share.a = area;
    if (tier !== null) share.t = tier;
    if (this.corruption() !== 'any') share.p = this.corruption() === 'yes' ? 1 : 0;
    const extra = this.extra().trim();
    if (extra) share.x = extra;
    return share;
  });

  constructor() {
    const inbound = this.route.snapshot.queryParamMap.get('s');
    if (inbound) {
      const share = decodeShare(inbound);
      if (share) this.apply(share);
      else this.message.set('That link carries nothing this tool understands.');
      // Drop the parameter: a later refresh should keep your edits rather than
      // re-importing the original search on top of them.
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: {},
        replaceUrl: true,
      });
    } else {
      this.restore();
    }
    effect(() => this.persist());
  }

  // ── input ────────────────────────────────────────────────────────────────

  onMinInput(event: Event): void {
    this.minInput.set(readNumber(event));
    this.message.set('');
  }

  onMaxInput(event: Event): void {
    this.maxInput.set(readNumber(event));
    this.message.set('');
  }

  onCurrencyChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (isCurrency(value)) this.currency.set(value);
    this.message.set('');
  }

  onIlvlInput(event: Event): void {
    this.ilvlInput.set(readNumber(event));
    this.message.set('');
  }

  onAreaInput(event: Event): void {
    this.areaInput.set(readNumber(event));
    this.message.set('');
  }

  onTierInput(event: Event): void {
    this.tierInput.set(readNumber(event));
    this.message.set('');
  }

  setCorruption(value: Corruption): void {
    this.corruption.set(value);
    this.message.set('');
  }

  onExtraInput(event: Event): void {
    this.extra.set((event.target as HTMLInputElement).value);
    this.message.set('');
  }

  // ── output ───────────────────────────────────────────────────────────────

  async copySearch(): Promise<void> {
    await this.copyText(this.search(), 'Search copied.');
  }

  async copyLink(): Promise<void> {
    await this.copyText(this.shareLink(), 'Link copied.');
  }

  private async copyText(text: string, done: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.message.set(done);
    } catch {
      this.message.set('Clipboard blocked — select the text and copy it manually.');
    }
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private apply(share: Share): void {
    if (typeof share.m === 'number') this.minInput.set(clamp(share.m, 1, MAX_PRICE));
    if (typeof share.M === 'number') this.maxInput.set(clamp(share.M, 1, MAX_PRICE));
    if (typeof share.c === 'string' && isCurrency(share.c)) this.currency.set(share.c);
    this.ilvlInput.set(level(share.i));
    this.areaInput.set(level(share.a));
    this.tierInput.set(level(share.t));
    this.corruption.set(share.p === 1 ? 'yes' : share.p === 0 ? 'no' : 'any');
    this.extra.set(typeof share.x === 'string' ? share.x : '');
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) this.apply(parsed as Share);
    } catch {
      // corrupt or unavailable storage is not worth failing the tool over
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.share()));
    } catch {
      // private mode / quota — the tool still works, it just forgets
    }
  }
}

function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}

function readNumber(event: Event): number | null {
  const raw = (event.target as HTMLInputElement).value.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function clamp(value: number | null, min: number, max: number, blank = min): number {
  if (value === null || !Number.isFinite(value)) return blank;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** An optional field: blank stays blank, anything else lands inside the range. */
function clampOrNull(value: number | null): number | null {
  return value === null ? null : clamp(value, 1, MAX_LEVEL);
}

function level(value: unknown): number | null {
  return typeof value === 'number' ? clamp(value, 1, MAX_LEVEL) : null;
}

// ── share codes ────────────────────────────────────────────────────────────

function encodeShare(share: Share): string {
  const bytes = new TextEncoder().encode(JSON.stringify(share));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeShare(text: string): Share | null {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Share) : null;
  } catch {
    return null;
  }
}
