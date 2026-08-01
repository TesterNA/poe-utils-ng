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
  /** mode 2: the computed minimal tree */
  route: Set<number>;
  /** mode 1: path that a click would allocate right now */
  preview: Set<number>;
  hovered: number | null;
  mode: 'path' | 'targets';
}

const COLORS = {
  lineIdle: '#413a2e',
  lineActive: '#d8b45a',
  linePreview: '#5ec8ff',
  lineRoute: '#ff9d3a',
  target: '#ff4d4d',
  hover: '#ffffff',
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

  /** Topmost node under a screen point, if any. */
  pick(sx: number, sy: number): TreeNode | null {
    const p = this.screenToTree(sx, sy);
    let best: TreeNode | null = null;
    let bestDist = Infinity;
    for (const node of this.tree.nodes) {
      if (node.kind === 'mastery') continue;
      const dx = node.x - p.x;
      const dy = node.y - p.y;
      const d2 = dx * dx + dy * dy;
      const r = node.radius;
      if (d2 <= r * r && d2 < bestDist) {
        bestDist = d2;
        best = node;
      }
    }
    return best;
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
        if (detailed) this.sprites.draw(ctx, 'mastery', node.icon, node.x, node.y);
        continue;
      }
      if (node.kind === 'root') continue;

      const allocated = state.allocated.has(node.idx);
      const inRoute = state.route.has(node.idx);
      const inPreview = state.preview.has(node.idx);
      const active = allocated || inRoute || inPreview;

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

      if (inPreview && !allocated) ring(ctx, node, COLORS.linePreview, 7);
      else if (inRoute && !allocated) ring(ctx, node, COLORS.lineRoute, 7);

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
