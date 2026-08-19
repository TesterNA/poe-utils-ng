import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';
import {
  Board,
  CELLS,
  EAST,
  NORTH,
  Policy,
  SHAPES,
  SHAPE_CONNECTIONS,
  SHAPE_GLYPH,
  SHAPE_LABEL,
  SOUTH,
  START_CELL,
  Shape,
  WEST,
  isValidBoard,
  recipes,
  shapeOf,
} from './voyage-rules';
import { Plan, PlanResult, gatherPlans, planVoyages, shortfall } from './voyage-solver';
import type { SearchRequest, SearchResponse } from './voyage.worker';

/* Voyage Builder.

   You say how many Charts of each shape are in the stash; the tool lays out as
   many complete Voyages as those Charts can be made into, each Chart spent at
   most once. Nothing here weighs a Chart's modifiers — the question it answers
   is only whether the Connections line up.

   `voyage-rules.ts` holds what the board accepts and every set of nine Charts
   that can fill one; `voyage-solver.ts` packs the stash with those sets. */

const STORAGE_KEY = 'poe_voyage_state';

/** Searches run per press. They agree on the count and differ on the layout. */
const ATTEMPTS = 8;

/** What a single search may spend before it settles for the best it has. */
const BUDGET_MS = 400;

interface StoredState {
  counts: Record<string, number>;
  policy: Policy;
}

/** Board drawing, in the units the SVG is written in. */
const CELL = 40;
const GAP = 6;
const STRIDE = CELL + GAP;
/** how far a Connection reaches past its cell — half the gap, so two meet */
const REACH = GAP / 2;
const EXTENT = 3 * STRIDE - GAP;

interface Stub {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface CellView {
  index: number;
  x: number;
  y: number;
  shape: string;
  /** where the Voyage begins */
  start: boolean;
  stubs: Stub[];
}

interface BoardView {
  cells: CellView[];
  /** what the nine Charts cost, as "3 Corner · 2 Junction · …" */
  spend: string;
  valid: boolean;
}

interface ShapeRow {
  shape: Shape;
  label: string;
  /** "2 connections", or the one shape that has a single one */
  note: string;
  glyph: Stub[];
  count: number;
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

/** The Connections of a cell, drawn from its middle outwards. */
function stubsFor(index: number, connections: number, size: number, reach: number): Stub[] {
  const column = index % 3;
  const row = Math.floor(index / 3);
  const x = column * (size + reach * 2);
  const y = row * (size + reach * 2);
  const cx = x + size / 2;
  const cy = y + size / 2;
  const stubs: Stub[] = [];

  if (connections & NORTH) stubs.push({ x1: cx, y1: cy, x2: cx, y2: y - reach });
  if (connections & SOUTH) stubs.push({ x1: cx, y1: cy, x2: cx, y2: y + size + reach });
  if (connections & WEST) stubs.push({ x1: cx, y1: cy, x2: x - reach, y2: cy });
  if (connections & EAST) stubs.push({ x1: cx, y1: cy, x2: x + size + reach, y2: cy });

  return stubs;
}

@Component({
  selector: 'poe-voyage',
  imports: [ToolPage, PoeCard, FormsModule],
  templateUrl: './voyage.html',
})
export class Voyage {
  readonly shapes = SHAPES;
  readonly attempts = ATTEMPTS;
  readonly viewBox = `${-REACH - 3} ${-REACH - 3} ${EXTENT + REACH * 2 + 6} ${EXTENT + REACH * 2 + 6}`;
  readonly cellSize = CELL;

  private readonly counts = signal<Record<Shape, number>>(
    Object.fromEntries(SHAPES.map((shape) => [shape, 0])) as Record<Shape, number>,
  );
  readonly policy = signal<Policy>('connected');

  readonly result = signal<PlanResult | null>(null);
  readonly planIndex = signal(0);
  readonly pasteMessage = signal('');
  readonly searching = signal(false);

  private workers: Worker[] = [];
  private collected: Plan[] = [];
  private runId = 0;
  private pending = 0;
  private startedAt = 0;

  constructor() {
    this.restore();
    effect(() => this.persist());
    inject(DestroyRef).onDestroy(() => this.stopWorkers());
  }

  // ── the stash ────────────────────────────────────────────────────────────

  readonly rows = computed<ShapeRow[]>(() =>
    SHAPES.map((shape) => ({
      shape,
      label: SHAPE_LABEL[shape],
      note:
        SHAPE_CONNECTIONS[shape] === 1 ? '1 connection' : `${SHAPE_CONNECTIONS[shape]} connections`,
      // drawn on its own, so the glyph is one cell with nothing to meet
      glyph: stubsFor(0, SHAPE_GLYPH[shape], 18, 3),
      count: this.counts()[shape],
    })),
  );

  readonly total = computed(() =>
    SHAPES.reduce((charts, shape) => charts + this.counts()[shape], 0),
  );

  /** The most Voyages the stash could hold if every Chart were the right one. */
  readonly ceiling = computed(() => Math.floor(this.total() / 9));

  setCount(shape: Shape, value: number | null): void {
    const count = value === null || Number.isNaN(value) ? 0 : Math.max(0, Math.trunc(value));
    this.counts.update((current) => ({ ...current, [shape]: count }));
    this.result.set(null);
  }

  add(shape: Shape, delta: number): void {
    this.setCount(shape, this.counts()[shape] + delta);
  }

  clear(): void {
    this.counts.set(Object.fromEntries(SHAPES.map((shape) => [shape, 0])) as Record<Shape, number>);
    this.result.set(null);
    this.pasteMessage.set('');
  }

  setPolicy(policy: Policy): void {
    this.policy.set(policy);
    this.result.set(null);
  }

  /**
   * Charts copied out of the game, however many at a time: every "Chart Shape"
   * line in the pasted text counts as one Chart, and nothing else is read.
   */
  paste(text: string): void {
    const found = [...text.matchAll(/^Chart Shape:\s*(.+)$/gim)];
    const added: Record<string, number> = {};
    let unknown = 0;

    for (const match of found) {
      const shape = readShape(match[1]);
      if (shape === null) {
        unknown++;
        continue;
      }
      added[shape] = (added[shape] ?? 0) + 1;
    }

    if (found.length === 0) {
      this.pasteMessage.set('No Chart found in that text — copy a Chart with Ctrl+C in game.');
      return;
    }

    this.counts.update((current) => {
      const next = { ...current };
      for (const [shape, count] of Object.entries(added)) {
        next[shape as Shape] += count;
      }
      return next;
    });
    this.result.set(null);

    const total = Object.values(added).reduce((sum, count) => sum + count, 0);
    this.pasteMessage.set(
      unknown === 0
        ? `Added ${total} ${total === 1 ? 'Chart' : 'Charts'}.`
        : `Added ${total}, skipped ${unknown} with an unreadable shape.`,
    );
  }

  // ── the plan ─────────────────────────────────────────────────────────────

  /**
   * Starts one worker per search and lets them run side by side, so the page
   * stays live while they work and the first answers show up as they land.
   * Where workers are not to be had the same searches are run in a row.
   */
  calculate(): void {
    const stock = SHAPES.map((shape) => this.counts()[shape]);
    const policy = this.policy();
    this.planIndex.set(0);
    this.stopWorkers();

    const run = ++this.runId;
    this.collected = [];
    this.startedAt = Date.now();

    if (typeof Worker === 'undefined') {
      this.result.set(planVoyages(stock, recipes(policy), { attempts: ATTEMPTS }));
      return;
    }

    this.result.set(null);
    this.searching.set(true);
    this.pending = ATTEMPTS;

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const worker = new Worker(new URL('./voyage.worker', import.meta.url));
      worker.onmessage = (event: MessageEvent<SearchResponse>) => this.onSearch(run, event.data);
      worker.postMessage({
        id: run,
        attempt,
        stock,
        policy,
        budgetMs: BUDGET_MS,
      } satisfies SearchRequest);
      this.workers.push(worker);
    }
  }

  private onSearch(run: number, response: SearchResponse): void {
    // a stash edited mid-search starts a new run; the old answers are stale
    if (run !== this.runId) return;

    this.collected.push(response.plan);
    this.pending--;
    this.result.set(
      gatherPlans(
        SHAPES.map((shape) => this.counts()[shape]),
        this.collected,
        Date.now() - this.startedAt,
      ),
    );

    if (this.pending === 0) {
      this.searching.set(false);
      this.stopWorkers();
    }
  }

  private stopWorkers(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.pending = 0;
    this.searching.set(false);
  }

  readonly plan = computed<Plan | null>(() => {
    const result = this.result();
    if (!result) return null;

    return result.plans[Math.min(this.planIndex(), result.plans.length - 1)] ?? null;
  });

  readonly boards = computed<BoardView[]>(() => {
    const plan = this.plan();
    if (!plan) return [];

    return plan.voyages.map((voyage) => this.boardView(voyage.board, voyage.counts));
  });

  readonly leftover = computed(() => {
    const plan = this.plan();
    if (!plan) return [];

    return SHAPES.map((shape, index) => ({
      label: SHAPE_LABEL[shape],
      count: plan.leftover[index],
    })).filter((entry) => entry.count > 0);
  });

  /** The Charts one more Voyage would need on top of what is left over. */
  readonly missing = computed(() => {
    const plan = this.plan();
    if (!plan) return null;

    const gap = shortfall(plan.leftover, recipes(this.policy()));
    if (gap === null) return null;

    return SHAPES.map((shape, index) => ({ label: SHAPE_LABEL[shape], count: gap.missing[index] }))
      .filter((entry) => entry.count > 0)
      .map((entry) => `${entry.count} ${entry.label}`)
      .join(' · ');
  });

  private boardView(board: Board, counts: readonly number[]): BoardView {
    const cells: CellView[] = [];

    for (let index = 0; index < CELLS; index++) {
      const shape = shapeOf(board[index]);
      cells.push({
        index,
        x: (index % 3) * STRIDE,
        y: Math.floor(index / 3) * STRIDE,
        shape: shape === null ? '' : SHAPE_LABEL[shape],
        start: index === START_CELL,
        stubs: stubsFor(index, board[index], CELL, REACH),
      });
    }

    return {
      cells,
      spend: SHAPES.map((shape, index) => ({ label: SHAPE_LABEL[shape], count: counts[index] }))
        .filter((entry) => entry.count > 0)
        .map((entry) => `${entry.count} ${entry.label}`)
        .join(' · '),
      // the drawn board is checked against the rule again on its way to the
      // screen, so a layout can never be shown as valid on the enumerator's
      // word alone
      valid: isValidBoard(board, this.policy()),
    };
  }

  // ── storage ──────────────────────────────────────────────────────────────

  private restore(): void {
    const stored = load();
    if (!stored) return;

    if (stored.policy === 'connected' || stored.policy === 'open') this.policy.set(stored.policy);
    if (typeof stored.counts === 'object' && stored.counts !== null) {
      this.counts.set(
        Object.fromEntries(
          SHAPES.map((shape) => [shape, Math.max(0, Math.trunc(stored.counts[shape] ?? 0))]),
        ) as Record<Shape, number>,
      );
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ counts: this.counts(), policy: this.policy() } satisfies StoredState),
      );
    } catch {
      /* a full or blocked storage is not worth a broken tool */
    }
  }
}

/** The shape names the game prints, and the ones players write. */
function readShape(text: string): Shape | null {
  const name = text.trim().toLowerCase();
  if (name === 'end' || name === 'dead end') return 'end';
  if (name === 'corner' || name === 'bend') return 'corner';
  if (name === 'straight' || name === 'line') return 'straight';
  if (name === 'junction' || name === 'tee' || name === 't') return 'junction';
  if (name === 'crossing' || name === 'cross' || name === 'crossroads') return 'crossing';

  return null;
}
