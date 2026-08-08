/**
 * POST /api/auth/register — make an account and sign in with it.
 *
 * No email confirmation: nothing is ever sent to the address, so a confirmation
 * step would only be a gate in front of a tool that saves atlas trees. The
 * address is a unique name and a way back into your library, which is what the
 * unique index enforces.
 */
import { mongo } from '../_lib/db';
import { readEmail, readPassword } from '../_lib/credentials';
import { fail, handler, json, readBody } from '../_lib/http';
import { hashPassword, issueToken, sessionCookie } from '../_lib/session';
import { overLimit } from '../_lib/throttle';

export const POST = handler(async (request) => {
  const limited = await overLimit(request, 'register', 5, 600);
  if (limited) return limited;

  const body = await readBody(request);
  const email = readEmail(body);
  const password = readPassword(body);

  const { users } = await mongo();
  // Hash before the insert so a duplicate email still costs an attacker the
  // full scrypt work, rather than turning this route into a fast way to ask
  // "is this address registered?".
  const hashed = await hashPassword(password);

  try {
    const result = await users.insertOne({
      email,
      password: hashed,
      createdAt: new Date(),
    } as never);
    const uid = result.insertedId.toHexString();
    return json({ user: { id: uid, email } }, { cookie: sessionCookie(issueToken(uid, email)) });
  } catch (err) {
    // 11000 is the unique index refusing a second account on one address.
    if ((err as { code?: number }).code === 11000) {
      return fail(409, 'That email already has an account. Sign in instead.');
    }
    throw err;
  }
});
