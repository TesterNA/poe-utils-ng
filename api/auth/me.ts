/**
 * GET /api/auth/me — who the cookie says you are.
 *
 * The answer comes out of the signed token, so this touches no database at all:
 * it is the app's first call on every load and should not wake the cluster.
 * A missing or expired cookie is `{ user: null }` and a 200, because "nobody is
 * signed in" is a normal answer to this question, not an error.
 */
import { handler, json } from '../_lib/http';
import { readSession } from '../_lib/session';

export const GET = handler(async (request) => {
  const session = readSession(request);
  return json({ user: session ? { id: session.uid, email: session.email } : null });
});
