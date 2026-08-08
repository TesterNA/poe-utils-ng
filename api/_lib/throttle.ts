/**
 * A fixed-window rate limit, shared through Mongo.
 *
 * Fixed windows let a caller spend one window's budget at its end and the next
 * one at its start, so the real burst is double the limit. A sliding window
 * would fix that at the cost of keeping every timestamp; at these limits the
 * difference is between "20 password guesses a minute" and "40", neither of
 * which gets anyone anywhere, so the cheap version wins.
 *
 * A single upsert per call, and TTL clears the counters — nothing to sweep.
 */
import { mongo } from './db';
import { fail } from './http';

/**
 * Vercel puts the real client address in `x-forwarded-for`; the first entry is
 * the client and the rest are proxies. Nothing here is worth spoofing beyond
 * evading a rate limit, and someone who can forge this header can also just use
 * another address, so first-entry is enough.
 */
export function callerIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/**
 * Returns a 429 when the caller is over budget, or null to carry on.
 * Never blocks on a storage failure: a broken counter must not take down login.
 */
export async function overLimit(
  request: Request,
  action: string,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  try {
    const { throttle } = await mongo();
    const window = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `${action}:${callerIp(request)}:${window}`;
    const doc = await throttle.findOneAndUpdate(
      { _id: key },
      {
        $inc: { n: 1 },
        $setOnInsert: { x: new Date((window + 1) * windowSeconds * 1000) },
      },
      { upsert: true, returnDocument: 'after' },
    );
    if ((doc?.n ?? 1) > limit) {
      return fail(429, 'Too many attempts. Wait a minute and try again.');
    }
  } catch {
    // storage trouble — let the request through rather than locking everyone out
  }
  return null;
}
