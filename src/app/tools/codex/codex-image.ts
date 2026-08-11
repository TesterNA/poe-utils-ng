/**
 * Screenshots, made small enough to keep.
 *
 * This is the half of the feature the spreadsheets cannot do at all: one of the
 * three documents it was designed against is *nothing but* screenshots of a
 * loot tracker, because a sheet has nowhere to put the numbers they contain.
 * They run 160–200 KB each as PNG, straight off the clipboard, and eight of
 * them is one evening's testing.
 *
 * So nothing is stored as it arrived:
 *
 * - **webp, not PNG.** Measured on one of those screenshots: 162 KB of PNG at
 *   1505x1209 becomes 75 KB of webp at quality 0.82, and the loot tracker's
 *   numbers are still readable — which is the only thing being kept.
 * - **1600 pixels on the long side.** Every one of those screenshots is a
 *   readable table at 1600; past that is the monitor's resolution, not the
 *   information.
 * - **a 320 pixel thumbnail beside it** — 7 KB for that same screenshot —
 *   because a list of forty cards should not decode forty full screenshots to
 *   draw forty 46 pixel squares.
 *
 * The full one is still there behind the lightbox, which is the whole point of
 * keeping it: the numbers on the loot tracker have to be readable, or the
 * screenshot is decoration.
 */

export const FULL_MAX = 1600;
export const THUMB_MAX = 320;
const QUALITY = 0.82;

export interface PreparedImage {
  full: Blob;
  thumb: Blob;
  w: number;
  h: number;
}

/**
 * The size a picture is drawn at, never enlarging it: a 200 pixel icon pasted
 * into the box stays a 200 pixel icon rather than becoming a blurry 1600.
 */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const longest = Math.max(w, h);
  if (longest <= max || longest === 0) return { w, h };
  const scale = max / longest;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** "Screenshot 2026-08-11 233015.png" -> "Screenshot 2026-08-11 233015". */
export function imageTitle(name: string): string {
  const bare = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim();
  return bare.slice(0, 80) || 'Screenshot';
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', QUALITY));
}

function scaled(bitmap: ImageBitmap, max: number): HTMLCanvasElement | null {
  const size = fitWithin(bitmap.width, bitmap.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // Scaling a screenshot down without smoothing turns thin text into noise,
  // and text is the only reason these are kept.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, size.w, size.h);
  return canvas;
}

/**
 * Returns null when the browser cannot decode it — a PDF dropped on the box, a
 * file that says it is an image and is not.
 */
export async function prepareImage(source: Blob): Promise<PreparedImage | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return null;
  }
  try {
    const fullCanvas = scaled(bitmap, FULL_MAX);
    const thumbCanvas = scaled(bitmap, THUMB_MAX);
    if (!fullCanvas || !thumbCanvas) return null;
    const [full, thumb] = await Promise.all([toBlob(fullCanvas), toBlob(thumbCanvas)]);
    if (!full || !thumb) return null;
    return { full, thumb, w: fullCanvas.width, h: fullCanvas.height };
  } finally {
    bitmap.close();
  }
}

/** The images on a clipboard or in a drop, in the order they arrived. */
export function imagesIn(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...(data.files ?? [])].filter((file) => file.type.startsWith('image/'));
  if (files.length) return files;
  return [...(data.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}
