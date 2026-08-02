/* Atlas Selector — interactive Path of Exile Atlas passive tree.

   Two ways to plan:
     1 · Path    click a node, get the shortest route to it from the Atlas centre
     2 · Targets click any number of nodes, get the cheapest tree that takes them all

   Mode 2 is a Steiner tree problem: every atlas passive costs one point and a
   tree with V nodes has V-1 edges, so "fewest points" is exactly minimum edges.
   See steiner.ts for the heuristic + exact Dreyfus-Wagner solver, which runs in
   a worker so the UI never blocks.

   Tree data and sprite sheets come from GGG's official export:
   https://github.com/grindinggear/atlastree-export */
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  NgZone,
  signal,
  viewChild,
} from '@angular/core';
import { bfs, connectedWithin, walkBack, withoutBlocked, type Graph } from './graph';
import { Renderer, type RenderState } from './renderer';
import { SpriteAtlas } from './sprites';
import { ATLAS_ASSET_BASE, loadTree } from './tree-loader';
import type { SolverResponse } from './solver.worker';
import type { Tree, TreeNode } from './tree-types';

type Mode = 'path' | 'targets';
type SolveTier = 'fast' | 'full';

interface NodeChip {
  idx: number;
  name: string;
  kind: string;
}

interface SearchHit extends NodeChip {
  stat: string;
}

interface TooltipView {
  x: number;
  y: number;
  name: string;
  kind: string;
  stats: string[];
  reminder: string[];
  hint: string;
}

/**
 * Tie-break cost per node kind, used only to pick between routes that cost the
 * same number of points. Gateways are pure connectors and do nothing for you, so
 * they are the last resort; keystones are avoided as incidental filler because
 * they change how maps play and are rarely something you want by accident; a
 * notable is strictly better value than a plain node for the same point.
 */
const KIND_PENALTY: Record<string, number> = {
  wormhole: 8,
  keystone: 4,
  normal: 1,
  notable: 0,
};

const STORAGE_KEY = 'poe_atlas_state';

interface StoredState {
  mode: Mode;
  allocated: string[];
  targets: string[];
  excluded: string[];
}

@Component({
  selector: 'poe-atlas',
  templateUrl: './atlas.html',
})
export class Atlas {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  readonly mode = signal<Mode>('path');
  readonly allocatedCount = signal(0);
  readonly routeCount = signal(0);
  readonly basePoints = signal(138);
  /** Extra points granted by the tree on screen — Unwavering Vision hands out 20. */
  readonly bonusPoints = signal(0);
  readonly totalPoints = computed(() => this.basePoints() + this.bonusPoints());
  readonly targets = signal<NodeChip[]>([]);
  readonly excluded = signal<NodeChip[]>([]);
  readonly status = signal('No targets picked');
  readonly notice = signal('');
  readonly loading = signal('Loading atlas tree...');
  readonly query = signal('');
  readonly searchHits = signal<SearchHit[]>([]);
  readonly tooltip = signal<TooltipView | null>(null);

  private tree: Tree | null = null;
  private graph: Graph | null = null;
  private renderer: Renderer | null = null;
  private worker: Worker | null = null;

  // Sets rather than signals: the renderer reads them every frame and they hold
  // up to a thousand entries, so copying them on each edit would be wasteful.
  private allocated = new Set<number>();
  private targetSet = new Set<number>();
  private excludedSet = new Set<number>();
  /** `graph` with excluded nodes isolated — what every search actually walks. */
  private searchGraph: Graph | null = null;
  private penalties: number[] = [];
  private route = new Set<number>();
  private preview = new Set<number>();
  private hovered: number | null = null;

  private dist = new Int32Array(0);
  private parent = new Int32Array(0);
  private dirty = true;
  private frame = 0;
  private solveId = 0;
  private solving = false;
  private fastTimer: ReturnType<typeof setTimeout> | null = null;
  private fullTimer: ReturnType<typeof setTimeout> | null = null;
  private tier: SolveTier = 'full';

  private dragging = false;
  private dragMoved = 0;
  private lastX = 0;
  private lastY = 0;

  constructor() {
    // The canvas has to exist and have a real size before we can size buffers,
    // so all of the setup hangs off the first render rather than the constructor.
    afterNextRender(() => void this.init());
    this.destroyRef.onDestroy(() => this.teardown());
  }

  // ------------------------------------------------------------------ setup --

  private async init(): Promise<void> {
    const canvas = this.canvasRef().nativeElement;
    // Wheel has to be non-passive to stop the page scrolling behind the canvas,
    // which template event bindings cannot express.
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.destroyRef.onDestroy(() => canvas.removeEventListener('wheel', this.onWheel));

    try {
      this.tree = await loadTree();
      this.loading.set('Loading sprites...');
      const sprites = new SpriteAtlas(this.tree.raw);
      await sprites.load(ATLAS_ASSET_BASE);

      this.graph = {
        n: this.tree.nodes.length,
        offsets: this.tree.offsets,
        adjacency: this.tree.adjacency,
      };
      this.dist = new Int32Array(this.graph.n);
      this.parent = new Int32Array(this.graph.n);
      this.penalties = this.tree.nodes.map((n) => KIND_PENALTY[n.kind] ?? 0);
      this.basePoints.set(this.tree.totalPoints);

      this.renderer = new Renderer(canvas, this.tree, sprites);
      this.renderer.fit();
      this.startWorker();
      this.restore();

      const observer = new ResizeObserver(() => {
        this.renderer?.resize();
        this.dirty = true;
      });
      observer.observe(canvas);
      this.destroyRef.onDestroy(() => observer.disconnect());

      this.loading.set('');
      // The draw loop ticks every frame and touches no bindings, so keeping it
      // out of the zone stops it triggering change detection 60 times a second.
      this.zone.runOutsideAngular(() => this.loop());
    } catch (err) {
      this.loading.set(`Error: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    }
  }

  private startWorker(): void {
    this.worker?.terminate();
    this.solving = false;
    this.worker = new Worker(new URL('./solver.worker', import.meta.url));
    this.worker.onmessage = (ev: MessageEvent<SolverResponse>) => this.onSolverMessage(ev.data);
    const graph = this.graph;
    if (!graph) return;
    // The worker keeps its own copy of the adjacency arrays.
    this.worker.postMessage({
      type: 'init',
      n: graph.n,
      offsets: graph.offsets.slice().buffer,
      adjacency: graph.adjacency.slice().buffer,
    });
  }

  private teardown(): void {
    this.worker?.terminate();
    this.worker = null;
    this.cancelPendingSolves();
    if (this.frame) cancelAnimationFrame(this.frame);
  }

  private loop = (): void => {
    if (this.dirty && this.renderer) {
      this.dirty = false;
      const state: RenderState = {
        allocated: this.allocated,
        targets: this.targetSet,
        excluded: this.excludedSet,
        route: this.mode() === 'targets' ? this.route : new Set<number>(),
        preview: this.preview,
        hovered: this.hovered,
        mode: this.mode(),
      };
      this.renderer.draw(state);
    }
    this.frame = requestAnimationFrame(this.loop);
  };

  // ------------------------------------------------------------ persistence --

  private restore(): void {
    const tree = this.tree;
    if (!tree) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<StoredState>;
      if (saved.mode === 'path' || saved.mode === 'targets') this.mode.set(saved.mode);
      for (const id of saved.allocated ?? []) {
        const node = tree.byId.get(id);
        if (node?.allocatable) this.allocated.add(node.idx);
      }
      for (const id of saved.targets ?? []) {
        const node = tree.byId.get(id);
        if (node?.allocatable) this.targetSet.add(node.idx);
      }
      for (const id of saved.excluded ?? []) {
        const node = tree.byId.get(id);
        if (node?.allocatable && !this.targetSet.has(node.idx)) this.excludedSet.add(node.idx);
      }
    } catch {
      // corrupt or unavailable storage is not worth failing the tool over
    }
    this.rebuildSearchGraph();
    this.syncCounts();
    if (this.targetSet.size) this.solve();
  }

  private persist(): void {
    const tree = this.tree;
    if (!tree) return;
    const ids = (set: Set<number>) => [...set].map((i) => tree.nodes[i].id);
    const state: StoredState = {
      mode: this.mode(),
      allocated: ids(this.allocated),
      targets: ids(this.targetSet),
      excluded: ids(this.excludedSet),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // private mode / quota — nothing we can do, the tool still works
    }
  }

  /**
   * Keeps the header's limit and the over-budget warning talking about the same
   * budget. While you are planning in targets mode the route is what the warning
   * judges, so its grants have to count towards the limit on screen too —
   * otherwise the header says 138 while the warning says 158.
   */
  private refreshBudget(): void {
    const granting = new Set(this.allocated);
    if (this.mode() === 'targets') for (const v of this.route) granting.add(v);
    this.bonusPoints.set(this.grantedBy(granting));
  }

  /** Atlas points handed out by the nodes in `set`. */
  private grantedBy(set: Set<number>): number {
    const tree = this.tree;
    if (!tree) return 0;
    let total = 0;
    for (const idx of set) total += tree.nodes[idx].grantsPoints;
    return total;
  }

  private syncCounts(): void {
    const tree = this.tree;
    this.allocatedCount.set(this.allocated.size);
    this.routeCount.set(this.route.size);
    this.refreshBudget();
    const chips = (set: Set<number>): NodeChip[] =>
      tree
        ? [...set].map((idx) => ({
            idx,
            name: tree.nodes[idx].name,
            kind: tree.nodes[idx].kind,
          }))
        : [];
    this.targets.set(chips(this.targetSet));
    this.excluded.set(chips(this.excludedSet));
    this.dirty = true;
  }

  private changed(): void {
    this.syncCounts();
    this.persist();
  }

  // ----------------------------------------------------------------- modes ---

  setMode(mode: Mode): void {
    this.mode.set(mode);
    this.refreshBudget();
    this.preview.clear();
    this.dirty = true;
    this.persist();
  }

  // ----------------------------------------------------------- exclusions ---

  /**
   * Rebuilt whenever the exclusion set changes. Every search — manual pathing,
   * the hover preview and the solver — walks this instead of the raw graph, so
   * blocked nodes are invisible to all of them rather than each having to
   * remember to skip them.
   */
  private rebuildSearchGraph(): void {
    const graph = this.graph;
    if (!graph) return;
    if (this.excludedSet.size === 0) {
      this.searchGraph = graph;
      return;
    }
    const mask = new Uint8Array(graph.n);
    for (const v of this.excludedSet) mask[v] = 1;
    this.searchGraph = withoutBlocked(graph, mask);
  }

  private search(): Graph | null {
    return this.searchGraph ?? this.graph;
  }

  /** Blocking a node also drops it as a target and unallocates it. */
  toggleExcluded(idx: number): void {
    const tree = this.tree;
    if (!tree || !tree.nodes[idx].allocatable) return;
    if (this.excludedSet.has(idx)) {
      this.excludedSet.delete(idx);
    } else {
      this.excludedSet.add(idx);
      this.targetSet.delete(idx);
      if (this.allocated.has(idx)) this.dropAllocation(idx);
    }
    this.rebuildSearchGraph();
    this.preview.clear();
    this.notice.set('');
    this.solve();
    this.changed();
  }

  removeExclusion(idx: number): void {
    this.excludedSet.delete(idx);
    this.rebuildSearchGraph();
    this.solve();
    this.changed();
  }

  clearExcluded(): void {
    this.excludedSet.clear();
    this.rebuildSearchGraph();
    this.solve();
    this.changed();
  }

  // ------------------------------------------------------------ allocation ---

  /** BFS sources: the free centre node plus everything already allocated. */
  private sources(): number[] {
    const tree = this.tree;
    return tree ? [tree.rootIdx, ...this.allocated] : [];
  }

  private allocatePathTo(idx: number): void {
    const graph = this.search();
    const tree = this.tree;
    if (!graph || !tree) return;
    if (this.excludedSet.has(idx)) {
      this.notice.set('That node is blocked. Right-click it to unblock.');
      return;
    }
    bfs(graph, this.sources(), this.dist, this.parent);
    if (this.dist[idx] < 0) {
      this.notice.set(
        this.excludedSet.size
          ? 'No path to that node — blocked nodes are in the way.'
          : 'There is no path to that node.',
      );
      return;
    }
    for (const v of walkBack(this.parent, idx)) {
      if (v !== tree.rootIdx) this.allocated.add(v);
    }
    this.notice.set('');
    this.changed();
  }

  private deallocate(idx: number): void {
    if (!this.allocated.has(idx)) return;
    this.dropAllocation(idx);
    this.changed();
  }

  /** Removes a node and everything that was only reachable through it. */
  private dropAllocation(idx: number): void {
    const graph = this.search();
    const tree = this.tree;
    if (!graph || !tree) return;
    this.allocated.delete(idx);
    // Anything that hung off this node loses its connection to the centre.
    const withRoot = new Set(this.allocated);
    withRoot.add(tree.rootIdx);
    const kept = connectedWithin(graph, withRoot, tree.rootIdx);
    kept.delete(tree.rootIdx);
    this.allocated = kept;
  }

  // --------------------------------------------------------------- solving ---

  private cancelPendingSolves(): void {
    if (this.fastTimer !== null) clearTimeout(this.fastTimer);
    if (this.fullTimer !== null) clearTimeout(this.fullTimer);
    this.fastTimer = null;
    this.fullTimer = null;
    // Cancelling the timers does not stop a search the worker already started.
    // Bumping the id makes any result still in flight stale, otherwise it lands
    // afterwards and puts the route back — visible as a cleared route quietly
    // reappearing a second or two after Reset all.
    this.solveId++;
  }

  /**
   * Two tiers, because the useful thing about this mode is seeing what a target
   * costs the instant you click it, and a full search takes seconds once there
   * are a dozen targets.
   *
   * The fast tier is heuristic-only and lands in ~150 ms, so the number keeps up
   * with clicking. The exact tier only fires once you have stopped for a moment,
   * and it is what upgrades the answer to a proven optimum. In testing the
   * heuristic already matched the optimum nearly every time, so the fast number
   * rarely changes when the exact one arrives.
   */
  private solve(): void {
    this.cancelPendingSolves();
    if (this.targetSet.size === 0) {
      this.route.clear();
      this.routeCount.set(0);
      this.status.set('No targets picked');
      this.dirty = true;
      return;
    }
    this.status.set('Solving...');
    this.fastTimer = setTimeout(() => {
      this.fastTimer = null;
      this.runSolve('fast');
    }, 120);
    this.fullTimer = setTimeout(() => {
      this.fullTimer = null;
      this.runSolve('full');
    }, 1000);
  }

  private runSolve(tier: SolveTier): void {
    // The worker searches synchronously, so the only way to abandon a stale run
    // is to throw the worker away and start over.
    if (this.solving) this.startWorker();
    const tree = this.tree;
    if (!this.worker || !tree) return;
    this.solving = true;
    this.tier = tier;
    this.worker.postMessage({
      type: 'solve',
      id: ++this.solveId,
      terminals: [tree.rootIdx, ...this.targetSet],
      blocked: [...this.excludedSet],
      penalties: this.penalties,
      heuristicMs: tier === 'fast' ? 120 : this.targetSet.size > 12 ? 700 : 350,
      exactMs: tier === 'fast' ? 0 : 8000,
    });
  }

  private onSolverMessage(msg: SolverResponse): void {
    const tree = this.tree;
    if (!tree) return;
    if (msg.type === 'progress') {
      if (msg.id === this.solveId) {
        this.status.set(`${msg.phase}... ${Math.round(msg.fraction * 100)}%`);
      }
      return;
    }
    if (msg.type !== 'result' || msg.id !== this.solveId) return;
    this.solving = false;

    const result = msg.result;
    this.route = new Set(result.nodes);
    this.route.delete(tree.rootIdx);
    const cost = this.route.size;
    const flag = result.optimal
      ? '✓ optimal'
      : this.tier === 'fast'
        ? '≈ estimate, refining…'
        : '≈ ' + result.note;
    const targets = this.targetSet.size;
    const missed = result.unreachable.length;
    // Say "3 of 4" rather than "4" when blocks have cut some targets off, so the
    // number is never read as covering more than it does.
    const scope = missed
      ? `${targets - missed} of ${targets} targets`
      : `${targets} ${plural(targets, 'target')}`;
    this.status.set(
      `${cost} ${plural(cost, 'point')} for ${scope} · ${flag} · ${Math.round(result.ms)} ms`,
    );
    // Judge the route against its own budget: if it takes a node that grants
    // points, those points are available to it.
    const routeLimit = this.basePoints() + this.grantedBy(this.route);
    if (missed) {
      this.notice.set(
        `${missed} ${plural(missed, 'target')} cannot be reached — blocked nodes cut ` +
          `${missed === 1 ? 'it' : 'them'} off.`,
      );
    } else if (cost > routeLimit) {
      this.notice.set(`This route needs ${cost} points, over the ${routeLimit} point limit.`);
    } else {
      this.notice.set('');
    }
    this.routeCount.set(cost);
    this.refreshBudget();
    this.dirty = true;
  }

  // ---------------------------------------------------------------- panel ----

  applyRoute(): void {
    const tree = this.tree;
    if (!tree) return;
    this.allocated = new Set(this.route);
    this.allocated.delete(tree.rootIdx);
    this.changed();
  }

  clearTargets(): void {
    this.targetSet.clear();
    this.route.clear();
    this.solve();
    this.changed();
  }

  seedFromAllocated(): void {
    const tree = this.tree;
    if (!tree) return;
    this.targetSet.clear();
    for (const idx of this.allocated) {
      const kind = tree.nodes[idx].kind;
      if (kind === 'notable' || kind === 'keystone') this.targetSet.add(idx);
    }
    if (!this.targetSet.size) {
      this.notice.set('The current tree has no notables or keystones.');
      return;
    }
    this.notice.set('');
    this.setMode('targets');
    this.solve();
    this.changed();
  }

  removeTarget(idx: number): void {
    this.targetSet.delete(idx);
    this.solve();
    this.changed();
  }

  resetAll(): void {
    this.allocated.clear();
    this.targetSet.clear();
    this.excludedSet.clear();
    this.route.clear();
    this.notice.set('');
    this.rebuildSearchGraph();
    this.solve();
    this.changed();
  }

  fitToScreen(): void {
    this.renderer?.fit();
    this.dirty = true;
  }

  highlight(idx: number): void {
    this.hovered = idx;
    this.dirty = true;
  }

  onSearch(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);
    const tree = this.tree;
    const q = value.trim().toLowerCase();
    if (!tree || q.length < 2) {
      this.searchHits.set([]);
      return;
    }
    const hits = tree.nodes
      .filter((n) => n.allocatable && n.searchText.includes(q))
      .sort((a, b) => rank(a, q) - rank(b, q))
      .slice(0, 40)
      .map((n) => ({ idx: n.idx, name: n.name, kind: n.kind, stat: n.stats[0] ?? '' }));
    this.searchHits.set(hits);
  }

  pickSearchHit(idx: number): void {
    const tree = this.tree;
    const renderer = this.renderer;
    if (!tree || !renderer) return;
    const node = tree.nodes[idx];
    renderer.camera.x = node.x;
    renderer.camera.y = node.y;
    renderer.camera.scale = Math.max(renderer.camera.scale, 0.22);
    if (this.mode() === 'targets') {
      this.targetSet.add(idx);
      this.solve();
      this.changed();
    } else if (!this.allocated.has(idx)) {
      this.allocatePathTo(idx);
    }
    this.dirty = true;
  }

  // --------------------------------------------------------------- canvas ----

  onPointerDown(event: PointerEvent): void {
    this.dragging = true;
    this.dragMoved = 0;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.canvasRef().nativeElement.setPointerCapture(event.pointerId);
  }

  onPointerMove(event: PointerEvent): void {
    const renderer = this.renderer;
    if (!renderer) return;
    if (this.dragging) {
      const dx = event.clientX - this.lastX;
      const dy = event.clientY - this.lastY;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      renderer.camera.x -= dx / renderer.camera.scale;
      renderer.camera.y -= dy / renderer.camera.scale;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.dirty = true;
      return;
    }
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    this.onHover(event.clientX - rect.left, event.clientY - rect.top, event.clientX, event.clientY);
  }

  onPointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvasRef().nativeElement.releasePointerCapture(event.pointerId);
    if (this.dragMoved >= 5) return;
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    const node = this.renderer?.pick(event.clientX - rect.left, event.clientY - rect.top);
    if (node) this.onNodeClick(node);
  }

  /** Right-click blocks or unblocks whatever is under the cursor. */
  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    const node = this.renderer?.pick(event.clientX - rect.left, event.clientY - rect.top);
    if (node?.allocatable) this.toggleExcluded(node.idx);
  }

  onPointerLeave(): void {
    this.hovered = null;
    this.preview.clear();
    this.tooltip.set(null);
    this.dirty = true;
  }

  /** Bound in the host so we can mark it non-passive and block page scrolling. */
  private readonly onWheel = (event: WheelEvent): void => {
    const renderer = this.renderer;
    if (!renderer) return;
    event.preventDefault();
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    renderer.zoomAt(
      event.clientX - rect.left,
      event.clientY - rect.top,
      Math.pow(0.999, event.deltaY),
    );
    this.dirty = true;
  };

  private onHover(sx: number, sy: number, clientX: number, clientY: number): void {
    const renderer = this.renderer;
    const graph = this.search();
    const tree = this.tree;
    if (!renderer || !graph || !tree) return;

    const node = renderer.pick(sx, sy);
    const idx = node?.idx ?? null;
    if (idx !== this.hovered) {
      this.hovered = idx;
      this.preview.clear();
      if (
        node &&
        this.mode() === 'path' &&
        !this.allocated.has(node.idx) &&
        !this.excludedSet.has(node.idx) &&
        node.allocatable
      ) {
        bfs(graph, this.sources(), this.dist, this.parent);
        if (this.dist[node.idx] >= 0) {
          for (const v of walkBack(this.parent, node.idx)) this.preview.add(v);
          this.preview.delete(tree.rootIdx);
        }
      }
      this.dirty = true;
    }
    this.tooltip.set(node ? this.buildTooltip(node, clientX, clientY) : null);
  }

  private buildTooltip(node: TreeNode, clientX: number, clientY: number): TooltipView | null {
    if (node.kind === 'root') return null;
    let hint = '';
    if (!node.allocatable) {
      hint = '';
    } else if (this.excludedSet.has(node.idx)) {
      hint = 'Blocked · right-click to unblock';
    } else if (this.mode() === 'targets') {
      hint = this.targetSet.has(node.idx)
        ? 'Click to remove target · right-click to block'
        : 'Click to add as target · right-click to block';
    } else if (!this.allocated.has(node.idx) && this.preview.size) {
      hint = `+${this.preview.size} point(s) · right-click to block`;
    } else {
      hint = 'Right-click to block';
    }
    return {
      // offset so the cursor never sits on top of the box
      x: clientX + 18,
      y: clientY + 18,
      name: node.name,
      kind: node.kind,
      stats: node.stats,
      reminder: node.reminder,
      hint,
    };
  }

  private onNodeClick(node: TreeNode): void {
    if (!node.allocatable) return;
    if (this.mode() === 'targets') {
      if (this.targetSet.has(node.idx)) this.targetSet.delete(node.idx);
      else this.targetSet.add(node.idx);
      this.solve();
      this.changed();
      return;
    }
    if (this.allocated.has(node.idx)) this.deallocate(node.idx);
    else this.allocatePathTo(node.idx);
  }

}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function rank(node: TreeNode, q: string): number {
  const name = node.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  return 3;
}
