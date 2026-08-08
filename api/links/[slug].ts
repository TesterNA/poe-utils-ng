/**
 * GET /api/links/:slug — the code behind a short link.
 *
 * Answers `{ kind, code }` and leaves it to the browser to put the code back
 * into the tool. Opening an anonymous link pushes its expiry out another 180
 * days, so a link people still use never quietly stops working; one nobody has
 * opened in half a year goes away on its own, which is the only reason the
 * collection does not grow forever.
 *
 * That touch is fire-and-forget. The visitor is waiting on the code, not on a
 * housekeeping write.
 */
import { mongo } from '../_lib/db';
import { fail, handler, json } from '../_lib/http';
import { expiryFromNow, kindFromLetter } from '../_lib/links';

/**
 * Vercel exposes a dynamic segment as a query parameter; reading the path is
 * the fallback so this does not depend on that staying true.
 */
function slugFrom(request: Request): string {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('slug');
  if (fromQuery) return fromQuery;
  return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
}

export const GET = handler(async (request) => {
  const slug = slugFrom(request);
  if (!slug || slug.length > 32) return fail(404, 'No such link.');

  const { links } = await mongo();
  const doc = await links.findOne({ _id: slug });
  if (!doc) return fail(404, 'That link has expired or never existed.');

  const kind = kindFromLetter(doc.k);
  if (!kind) return fail(500, 'That link is stored wrong.');

  if (doc.x) {
    void links
      .updateOne({ _id: slug }, { $set: { x: expiryFromNow() } })
      .catch(() => undefined);
  }

  return json({ kind, code: doc.c });
});
