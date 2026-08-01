import type { RawTree, SpriteCoord } from './tree-types';

interface Entry {
  img: HTMLImageElement;
  coord: SpriteCoord;
  /** size in tree units (sprite pixels divided by the sheet's zoom level) */
  w: number;
  h: number;
}

/** Sheets we never draw — skipping them saves ~1.5 MB of downloads. */
const UNUSED_GROUPS = new Set(['line', 'masteryOverlay']);

/** Sprite sheets ship one copy per zoom level; we always take the sharpest. */
export class SpriteAtlas {
  private entries = new Map<string, Entry>();
  private images = new Map<string, HTMLImageElement>();
  loaded = false;

  constructor(private raw: RawTree) {}

  async load(base: string): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const [groupName, levels] of Object.entries(this.raw.sprites)) {
      if (UNUSED_GROUPS.has(groupName)) continue;
      const levelKeys = Object.keys(levels)
        .map(Number)
        .sort((a, b) => a - b);
      const level = levelKeys[levelKeys.length - 1];
      const sheet = levels[String(level)];
      if (!sheet) continue;
      const file = sheet.filename.split('/').pop()!.split('?')[0];
      let img = this.images.get(file);
      if (!img) {
        img = new Image();
        this.images.set(file, img);
        const el = img;
        // Handlers must be attached before src, otherwise a cached image fires
        // load before we are listening and the promise never settles.
        pending.push(
          new Promise<void>((resolve) => {
            el.onload = () => resolve();
            el.onerror = () => resolve();
            el.src = `${base}${file}`;
            if (el.complete) resolve();
            // never let one broken asset block the whole app
            setTimeout(resolve, 15000);
          }),
        );
      }
      for (const [key, coord] of Object.entries(sheet.coords)) {
        this.entries.set(`${groupName}/${key}`, {
          img,
          coord,
          w: coord.w / level,
          h: coord.h / level,
        });
      }
    }
    await Promise.all(pending);
    this.loaded = true;
  }

  size(group: string, key: string): { w: number; h: number } | null {
    const e = this.entries.get(`${group}/${key}`);
    return e ? { w: e.w, h: e.h } : null;
  }

  has(group: string, key: string): boolean {
    return this.entries.has(`${group}/${key}`);
  }

  /** Draws the sprite centred on (x, y) in tree coordinates. */
  draw(ctx: CanvasRenderingContext2D, group: string, key: string, x: number, y: number, scale = 1) {
    const e = this.entries.get(`${group}/${key}`);
    if (!e || !e.img.complete || e.img.naturalWidth === 0) return;
    const w = e.w * scale;
    const h = e.h * scale;
    ctx.drawImage(e.img, e.coord.x, e.coord.y, e.coord.w, e.coord.h, x - w / 2, y - h / 2, w, h);
  }

  image(group: string, key: string): HTMLImageElement | null {
    return this.entries.get(`${group}/${key}`)?.img ?? null;
  }

  pattern(ctx: CanvasRenderingContext2D, group: string, key: string): CanvasPattern | null {
    const e = this.entries.get(`${group}/${key}`);
    if (!e || !e.img.complete) return null;
    return ctx.createPattern(e.img, 'repeat');
  }
}
