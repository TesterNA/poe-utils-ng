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
   * What the search box matches. Its own colour rather than the highlight's:
   * a search and a called-out mechanic are often up at the same time, and the
   * point of the search is to tell its hits apart from everything else.
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
    const scale = Math.min(this.width / (b.maxX - b.minX), this.height / (b.maxY - b.minY)) * 0.95;
    this.camera.scale = scale;
    this.camera.x = (b.minX + b.maxX) / 2;
    this.camera.y = (b.minY + b.maxY) / 2;
  }

  screenToTree(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.width / 2) / this.camera.scale + this.camera.x,
      y: (sy - this.height / 2) / this.camera.scale + this.camera.y,
    };
  }

  treeToScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.camera.x) * this.camera.scale + this.width / 2,
      y: (y - this.camera.y) * this.camera.scale + this.height / 2,
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
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-camera.x, -camera.y);

    const view = {
      minX: camera.x - this.width / 2 / camera.scale,
      maxX: camera.x + this.width / 2 / camera.scale,
      minY: camera.y - this.height / 2 / camera.scale,
      maxY: camera.y + this.height / 2 / camera.scale,
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
    const root = this.tree.nodes[this.tree.rootIdx];
    ctx.save();
    ctx.globalAlpha = 0.75;
    this.sprites.draw(ctx, 'atlasBackground', 'AtlasPassiveBackground', root.x, root.y, 2.6);
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

    for (const layer of layers) {
      ctx.beginPath();
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = layer.width;
      ctx.globalAlpha = layer.alpha;
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
    for (const node of this.tree.nodes) {
      if (node.x < view.minX - 300 || node.x > view.maxX + 300) continue;
      if (node.y < view.minY - 300 || node.y > view.maxY + 300) continue;

      if (node.kind === 'mastery') {
        const lit = state.highlight.has(node.idx);
        const hit = state.matched.has(node.idx);
        // A cluster centre stays visible when its mechanic is called out, even
        // zoomed far enough out that the icons are normally dropped — finding
        // the other clusters is the whole point of lighting them up.
        if (detailed || lit || hit) this.sprites.draw(ctx, 'mastery', node.icon, node.x, node.y);
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

      // Blocked nodes are dimmed so the eye skips them the way the solver does.
      if (excluded) {
        ctx.save();
        ctx.globalAlpha = 0.4;
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

      if (excluded) ctx.restore();

      if (state.matched.has(node.idx)) found(ctx, node, COLORS.matched, this.camera.scale);

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
