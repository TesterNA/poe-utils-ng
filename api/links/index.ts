/**
 * POST /api/links — turn a share code into a short link.
 *
 * Body: `{ kind: 'atlas' | 'strategy', code: 'AT3:…' }`, answer: `{ slug }`.
 *
 * Anyone may make one, signed in or not, because a link people cannot make
 * without an account is a link most people will not make. What signing in
 * changes is how long it lasts: an anonymous link is dropped 180 days after it
 * was last opened, one made by an account never is.
 */
import { ObjectId } from 'mongodb';
import { mongo, type LinkDoc } from '../_lib/db';
import { BadRequest, fail, handler, json, readBody } from '../_lib/http';
import {
  expiryFromNow,
  hashCode,
  isCodeFor,
  KINDS,
  MAX_CODE,
  newSlug,
  type Kind,
} from '../_lib/links';
import { readSession } from '../_lib/session';
import { overLimit } from '../_lib/throttle';

function readKind(body: Record<string, unknown>): Kind {
  const kind = body['kind'];
  if (kind !== 'atlas' && kind !== 'strategy') throw new BadRequest('Unknown kind of link.');
  return kind;
}

function readCode(body: Record<string, unknown>, kind: Kind): string {
  const code = body['code'];
  if (typeof code !== 'string' || !code) throw new BadRequest('No code to shorten.');
  if (code.length > MAX_CODE) throw new BadRequest('That code is too long to shorten.');
  if (!isCodeFor(kind, code)) throw new BadRequest(`That is not a ${kind} code.`);
  return code;
}

export const POST = handler(async (request) => {
  const session = readSession(request);
  // Generous for a person, tight enough that nobody fills the collection.
  const limited = await overLimit(request, 'link', session ? 120 : 30, 3600);
  if (limited) return limited;

  const body = await readBody(request);
  const kind = readKind(body);
  const code = readCode(body, kind);

  const { links } = await mongo();
  const h = hashCode(kind, code);
  const owner = session ? new ObjectId(session.uid) : undefined;

  // The same plan shared twice should be the same link, so the hash decides
  // first and a new slug is only minted when nothing matches.
  const existing = await links.findOne({ h });
  if (existing) {
    // Signing in after sharing anonymously should keep the link already given
    // out, so the row is adopted rather than replaced: same slug, no expiry.
    if (owner && !existing.u) {
      await links.updateOne({ _id: existing._id }, { $set: { u: owner }, $unset: { x: '' } });
    }
    return json({ slug: existing._id, reused: true });
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const doc: LinkDoc = {
      _id: newSlug(),
      k: KINDS[kind],
      c: code,
      h,
      t: new Date(),
      ...(owner ? { u: owner } : { x: expiryFromNow() }),
    };
    try {
      await links.insertOne(doc);
      return json({ slug: doc._id, reused: false });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      // Two writers raced on the same code: whoever lost adopts the winner's slug.
      const won = await links.findOne({ h });
      if (won) return json({ slug: won._id, reused: true });
      // Otherwise it was the slug that collided — vanishingly unlikely at 40
      // bits, so just draw another one.
    }
  }
  return fail(500, 'Could not make a link. Try again.');
});
