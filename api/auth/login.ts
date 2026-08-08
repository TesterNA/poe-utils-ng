/**
 * POST /api/auth/login — exchange an email and password for a session cookie.
 *
 * A wrong address and a wrong password give the same answer, so this cannot be
 * used to find out who has an account.
 */
import { mongo } from '../_lib/db';
import { readEmail, readPassword } from '../_lib/credentials';
import { fail, handler, json, readBody } from '../_lib/http';
import { issueToken, sessionCookie, verifyPassword } from '../_lib/session';
import { overLimit } from '../_lib/throttle';

export const POST = handler(async (request) => {
  const limited = await overLimit(request, 'login', 10, 300);
  if (limited) return limited;

  const body = await readBody(request);
  const email = readEmail(body);
  const password = readPassword(body);

  const { users } = await mongo();
  const user = await users.findOne({ email });
  if (!user || !(await verifyPassword(password, user.password))) {
    return fail(401, 'Wrong email or password.');
  }

  const uid = user._id.toHexString();
  return json({ user: { id: uid, email } }, { cookie: sessionCookie(issueToken(uid, email)) });
});
