/**
 * A picture of a tree, small enough to sit on a card.
 *
 * Deliberately not a screenshot of the atlas. The real rendering needs the
 * sprite sheets and the painted background — about 4 MB — and it draws icons
 * that are illegible at 400 pixels anyway. What actually tells two trees apart
 * at that size is their *shape*: which way the branches run and how far out
 * they reach. So this draws the shape and nothing else, from `tree.json` alone,
 * which is already in memory whenever there is something to snapshot.
 *
 * The unallocated tree is drawn faint underneath, because a branch means
 * nothing without the tree it is a branch of — the allocated set on its own is
 * a constellation nobody can place.
 */
import type { Tree } from '../atlas/tree-types';

const SIZE = 420;
const PAD = 10;

/** Reads out of a canvas as a webp Blob, or null where nothing can draw. */
export async function drawTreeThumb(
  tree: Tree,
  allocated: ReadonlySet<number>,
): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const { minX, minY, maxX, maxY } = tree.bounds;
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = (SIZE - PAD * 2) / span;
  // Centred on the tree's own box rather than on the allocated part, so two
  // trees from the same league line up when you look at them side by side.
  const offX = PAD + ((SIZE - PAD * 2) - (maxX - minX) * scale) / 2;
  const offY = PAD + ((SIZE - PAD * 2) - (maxY - minY) * scale) / 2;
  const px = (x: number) => offX + (x - minX) * scale;
  const py = (y: number) => offY + (y - minY) * scale;

  ctx.fillStyle = '#0b0f20';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Every edge, faint: the ground the allocated tree is read against.
  ctx.strokeStyle = 'rgba(120,140,220,0.13)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const edge of tree.edges) {
    const a = tree.nodes[edge.a];
    const b = tree.nodes[edge.b];
    if (!a || !b) continue;
    ctx.moveTo(px(a.x), py(a.y));
    ctx.lineTo(px(b.x), py(b.y));
  }
  ctx.stroke();

  // The allocated tree, on top and bright. Edges first so the nodes sit over
  // their own joins rather than under them.
  ctx.strokeStyle = 'rgba(138,160,255,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const edge of tree.edges) {
    if (!allocated.has(edge.a) || !allocated.has(edge.b)) continue;
    const a = tree.nodes[edge.a];
    const b = tree.nodes[edge.b];
    if (!a || !b) continue;
    ctx.moveTo(px(a.x), py(a.y));
    ctx.lineTo(px(b.x), py(b.y));
  }
  ctx.stroke();

  for (const idx of allocated) {
    const node = tree.nodes[idx];
    if (!node) continue;
    // Keystones and notables are what somebody would point at, so they are the
    // only things drawn big enough to count.
    const radius = node.kind === 'keystone' ? 5 : node.kind === 'notable' ? 3.5 : 2;
    ctx.fillStyle =
      node.kind === 'keystone' ? '#c46bff' : node.kind === 'notable' ? '#cdd6ff' : '#8aa0ff';
    ctx.beginPath();
    ctx.arc(px(node.x), py(node.y), radius, 0, Math.PI * 2);
    ctx.fill();
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/webp', 0.8);
  });
}
