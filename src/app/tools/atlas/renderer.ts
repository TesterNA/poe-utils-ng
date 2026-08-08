import type { Tree, TreeNode } from './tree-types';
import { SpriteAtlas } from './sprites';

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface RenderState {
  allocated: Set<number>;
  /** mode 2: nodes the user demanded */
  targets: Set<number>;
  /** nodes the route must never pass through */
  excluded: Set<number>;
  /** mode 2: the computed minimal tree */
  route: Set<number>;
  /** mode 1: path that a click would allocate right now */
  preview: Set<number>;
  /**
   * Nodes called out from the panel: one mechanic's passives, or the nodes
   * behind a line of the summary. Purely a "look here", with no bearing on
   * what is allocated.
   */
  highlight: Set<number>;
  /**
   * What the search box matches. While it holds anything the rest of the tree is
   * drawn faint, which is the whole answer to "where are they" — a search and a
   * called-out mechanic can be up at once, so the hits also have their own
   * colour rather than borrowing the highlight's.
   */
  matched: Set<number>;
  hovered: number | null;
  mode: 'path' | 'targets';
}

const COLORS = {
  lineIdle: '#413a2e',
  lineActive: '#d8b45a',
  linePreview: '#5ec8ff',
  lineRoute: '#ff9d3a',
  target: '#ff4d4d',
  excluded: '#c2413f',
  hover: '#ffffff',
  highlight: '#7ce89a',
  matched: '#ff7ae0',
};

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  camera: Camera = { x: 0, y: 0, scale: 0.08 };
  private dpr = 1;
  width = 0;
  height = 0;

  /**
   * How much of the canvas's right edge lies under the side panel.
   *
   * The canvas runs the full width of the shell so the tree keeps drawing
   * behind the panel — that blurred tree is what the glass is made of. The
   * camera, though, should still centre on what you can actually see, so every
   * screen calculation below works from the middle of the *free* area rather
   * than the middle of the canvas. Nodes under the panel are drawn but cannot
   * be clicked; pan them out to reach them.
   */
  private insetRight = 0;

  private get centreX(): number {
    return (this.width - this.insetRight) / 2;
  }
  private get centreY(): number {
    return this.height / 2;
  }

  setInset(right: number): void {
    this.insetRight = Math.max(0, Math.min(right, this.width));
  }

  constructor(
    private canvas: HTMLCanvasElement,
    private tree: Tree,
    private sprites: SpriteAtlas,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas context is unavailable');
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
  }

  fit(): void {
    const b = this.tree.bounds;
    const free = this.width - this.insetRight;
    const scale = Math.min(free / (b.maxX - b.minX), this.height / (b.maxY - b.minY)) * 0.95;
    this.camera.scale = scale;
    this.camera.x = (b.minX + b.maxX) / 2;
    this.camera.y = (b.minY + b.maxY) / 2;
  }

  screenToTree(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.centreX) / this.camera.scale + this.camera.x,
      y: (sy - this.centreY) / this.camera.scale + this.camera.y,
    };
  }

  treeToScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.camera.x) * this.camera.scale + this.centreX,
      y: (y - this.camera.y) * this.camera.scale + this.centreY,
    };
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToTree(sx, sy);
    this.camera.scale = clamp(this.camera.scale * factor, 0.02, 1.2);
    const after = this.screenToTree(sx, sy);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
  }

  /**
   * Topmost node under a screen point, if any. A mastery — the mechanic icon in
   * the middle of a wheel — only wins when nothing else is there: it is the
   * largest thing on the tree and would otherwise swallow clicks meant for the
   * passives around it.
   */
  pick(sx: number, sy: number): TreeNode | null {
    const p = this.screenToTree(sx, sy);
    let best: TreeNode | null = null;
    let bestDist = Infinity;
    let centre: TreeNode | null = null;
    let centreDist = Infinity;
    for (const node of this.tree.nodes) {
      if (node.kind === 'structural') continue;
      const dx = node.x - p.x;
      const dy = node.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > node.radius * node.radius) continue;
      if (node.kind === 'mastery') {
        if (d2 < centreDist) {
          centreDist = d2;
          centre = node;
        }
      } else if (d2 < bestDist) {
        bestDist = d2;
        best = node;
      }
    }
    return best ?? centre;
  }

  draw(state: RenderState): void {
    const ctx = this.ctx;
    const { camera } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#080a0c';
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    ctx.translate(this.centreX, this.centreY);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-camera.x, -camera.y);

    // culling still covers the whole canvas, panel-covered part included: it is
    // drawn, just seen through glass
    const view = {
      minX: camera.x - this.centreX / camera.scale,
      maxX: camera.x + (this.width - this.centreX) / camera.scale,
      minY: camera.y - this.centreY / camera.scale,
      maxY: camera.y + (this.height - this.centreY) / camera.scale,
    };

    this.drawBackground(view);
    this.drawGroups(view);
    this.drawEdges(state, view);
    this.drawNodes(state, view);

    ctx.restore();
  }

  private drawBackground(view: { minX: number; maxX: number; minY: number; maxY: number }): void {
    const ctx = this.ctx;
    const pattern = this.sprites.pattern(ctx, 'background', 'Background2');
    if (pattern) {
      const tile = 2; // 128px sheet at zoom 0.5 => 256 tree units
      pattern.setTransform(new DOMMatrix().scale(tile));
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = pattern;
      ctx.fillRect(view.minX, view.minY, view.maxX - view.minX, view.maxY - view.minY);
      ctx.restore();
    }
    // Centred on the tree itself, not on the root node: the root is the Atlas
    // centre by meaning, but it sits well below the middle of the layout, which
    // dragged the whole painting down with it.
    const b = this.tree.bounds;
    ctx.save();
    ctx.globalAlpha = 0.75;
    this.sprites.draw(
      ctx,
      'atlasBackground',
      'AtlasPassiveBackground',
      (b.minX + b.maxX) / 2,
      (b.minY + b.maxY) / 2,
      2.6,
    );
    ctx.restore();
  }

  private drawGroups(view: { minX: number; maxX: number; minY: number; maxY: number }): void {
    const ctx = this.ctx;
    for (const g of this.tree.groups) {
      if (!g.background) continue;
      if (g.x < view.minX - 800 || g.x > view.maxX + 800) continue;
      if (g.y < view.minY - 800 || g.y > view.maxY + 800) continue;
      this.sprites.draw(
        ctx,
        'groupBackground',
        g.background.image,
        g.x + (g.background.offsetX ?? 0),
        g.y + (g.background.offsetY ?? 0),
      );
    }
    const root = this.tree.nodes[this.tree.rootIdx];
    this.sprites.draw(ctx, 'startNode', 'AtlasPassiveSkillScreenStart', root.x, root.y);
  }

  private drawEdges(
    state: RenderState,
    view: { minX: number; maxX: number; minY: number; maxY: number },
  ): void {
    const ctx = this.ctx;
    const nodes = this.tree.nodes;
    // Idle first, then the highlighted passes, so highlights always sit on top.
    const layers: Array<{ color: string; width: number; alpha: number; test: (e: number) => boolean }> =
      [
        {
          color: COLORS.lineIdle,
          width: 12,
          alpha: 1,
          test: () => true,
        },
        {
          color: COLORS.lineActive,
          width: 16,
          alpha: 1,
          test: (i) => {
            const e = this.tree.edges[i];
            return state.allocated.has(e.a) && state.allocated.has(e.b);
          },
        },
        {
          color: COLORS.lineRoute,
          width: 18,
          alpha: 0.95,
          test: (i) => {
            const e = this.tree.edges[i];
            return state.route.has(e.a) && state.route.has(e.b);
          },
        },
        {
          color: COLORS.linePreview,
          width: 18,
          alpha: 0.95,
          test: (i) => {
            const e = this.tree.edges[i];
            return state.preview.has(e.a) && state.preview.has(e.b);
          },
        },
      ];

    // A search takes the whole tree down with it, lines included — a lit node
    // inside a full-strength web is not much easier to find than before.
    const quiet = state.matched.size > 0 ? 0.3 : 1;

    for (const layer of layers) {
      ctx.beginPath();
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = layer.width;
      ctx.globalAlpha = layer.alpha * quiet;
      ctx.lineCap = 'round';
      let any = false;
      for (let i = 0; i < this.tree.edges.length; i++) {
        const e = this.tree.edges[i];
        const a = nodes[e.a];
        const b = nodes[e.b];
        if (Math.max(a.x, b.x) < view.minX || Math.min(a.x, b.x) > view.maxX) continue;
        if (Math.max(a.y, b.y) < view.minY || Math.min(a.y, b.y) > view.maxY) continue;
        if (!layer.test(i)) continue;
        any = true;
        if (e.arc) {
          ctx.moveTo(a.x, a.y);
          ctx.arc(e.cx, e.cy, e.r, e.a0, e.a1, e.anticlockwise);
        } else {
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
      }
      if (any) ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawNodes(
    state: RenderState,
    view: { minX: number; maxX: number; minY: number; maxY: number },
  ): void {
    const ctx = this.ctx;
    const detailed = this.camera.scale > 0.05;
    const searching = state.matched.size > 0;
    for (const node of this.tree.nodes) {
      if (node.x < view.minX - 300 || node.x > view.maxX + 300) continue;
      if (node.y < view.minY - 300 || node.y > view.maxY + 300) continue;

      if (node.kind === 'mastery') {
        const lit = state.highlight.has(node.idx);
        const hit = state.matched.has(node.idx);
        // A cluster centre stays visible when its mechanic is called out, even
        // zoomed far enough out that the icons are normally dropped — finding
        // the other clusters is the whole point of lighting them up.
        if (detailed || lit || hit) {
          ctx.save();
          if (searching && !hit) ctx.globalAlpha = 0.22;
          this.sprites.draw(ctx, 'mastery', node.icon, node.x, node.y);
          ctx.restore();
        }
        if (hit) beacon(ctx, node, COLORS.matched);
        if (lit) beacon(ctx, node, COLORS.highlight);
        if ((lit || hit) && state.hovered === node.idx) ring(ctx, node, COLORS.hover, 8, 1.16);
        continue;
      }
      // Nothing is drawn for a structural junction; the lines through it are
      // the only thing there, exactly as in game.
      if (node.kind === 'root' || node.kind === 'structural') continue;

      const excluded = state.excluded.has(node.idx);
      const allocated = state.allocated.has(node.idx);
      const inRoute = state.route.has(node.idx);
      const inPreview = state.preview.has(node.idx);
      const active = allocated || inRoute || inPreview;

      // Blocked nodes are dimmed so the eye skips them the way the solver does;
      // during a search everything the query missed is dimmed harder still.
      const missed = searching && !state.matched.has(node.idx);
      const faded = excluded || missed;
      if (faded) {
        ctx.save();
        ctx.globalAlpha = missed ? (excluded ? 0.1 : 0.22) : 0.4;
      }

      const sheet = active ? 'Active' : 'Inactive';
      const iconGroup =
        node.kind === 'notable'
          ? `notable${sheet}`
          : node.kind === 'keystone'
            ? `keystone${sheet}`
            : node.kind === 'wormhole'
              ? `wormhole${sheet}`
              : `normal${sheet}`;
      const iconKey = node.kind === 'wormhole' ? 'Wormhole' : node.icon;
      this.sprites.draw(ctx, iconGroup, iconKey, node.x, node.y);

      const frameKey = frameFor(node.kind, active);
      if (frameKey) this.sprites.draw(ctx, 'frame', frameKey, node.x, node.y);

      if (faded) ctx.restore();

      if (state.matched.has(node.idx)) found(ctx, node, COLORS.matched, this.camera.scale);

      // Target, route and block markers go quiet with their nodes, otherwise a
      // planned tree stays a wall of rings and the search is lost inside it.
      if (missed) {
        ctx.save();
        ctx.globalAlpha = 0.22;
      }

      if (state.highlight.has(node.idx)) ring(ctx, node, COLORS.highlight, 9, 1.2);

      if (inPreview && !allocated) ring(ctx, node, COLORS.linePreview, 7);
      else if (inRoute && !allocated) ring(ctx, node, COLORS.lineRoute, 7);

      if (excluded) cross(ctx, node, COLORS.excluded, 9);

      if (state.targets.has(node.idx)) {
        ring(ctx, node, COLORS.target, 11, 1.14);
        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = COLORS.target;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius * 1.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (missed) ctx.restore();

      // Whatever the pointer is on stays bright: you are asking about that one.
      if (state.hovered === node.idx) ring(ctx, node, COLORS.hover, 5, 1.26);
    }
  }
}

function frameFor(kind: TreeNode['kind'], active: boolean): string | null {
  switch (kind) {
    case 'notable':
      return active ? 'NotableFrameAllocated' : 'NotableFrameUnallocated';
    case 'keystone':
      return active ? 'KeystoneFrameAllocated' : 'KeystoneFrameUnallocated';
    case 'wormhole':
      return active ? 'WormholeFrameAllocated' : 'WormholeFrameUnallocated';
    case 'normal':
      return active ? 'PSSkillFrameActive' : 'PSSkillFrame';
    default:
      return null;
  }
}

/** Struck-through marker drawn over a blocked node. */
function cross(
  ctx: CanvasRenderingContext2D,
  node: TreeNode,
  color: string,
  width: number,
): void {
  const r = node.radius * 0.72;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(node.x - r, node.y - r);
  ctx.lineTo(node.x + r, node.y + r);
  ctx.moveTo(node.x + r, node.y - r);
  ctx.lineTo(node.x - r, node.y + r);
  ctx.stroke();
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = Math.max(3, width * 0.6);
  ctx.beginPath();
  ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * A cluster centre that has been called out. Drawn as a filled halo rather than
 * a ring because the point of it is to be findable while the camera is
 * somewhere else entirely.
 */
function beacon(ctx: CanvasRenderingContext2D, node: TreeNode, color: string): void {
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(node.x, node.y, node.radius * 1.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ring(ctx, node, color, 12, 1.35);
}

/**
 * A search hit. Everything here is drawn in tree units, and zoomed out to the
 * whole atlas a passive is four pixels across — so the mark has a floor in
 * screen space: big enough to spot from the far side of the tree, no wider than
 * the node once you have panned in.
 */
function found(
  ctx: CanvasRenderingContext2D,
  node: TreeNode,
  color: string,
  scale: number,
): void {
  const r = Math.max(node.radius * 1.35, 12 / scale);
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(8, 2.5 / scale);
  ctx.beginPath();
  ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function ring(
  ctx: CanvasRenderingContext2D,
  node: TreeNode,
  color: string,
  width: number,
  scale = 1,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(node.x, node.y, node.radius * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
