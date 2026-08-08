/**
 * POST /api/auth/logout — drop the cookie.
 *
 * POST rather than GET so a link or an image tag on another site cannot log
 * someone out by being loaded.
 */
import { handler, json } from '../_lib/http';
import { clearedCookie } from '../_lib/session';

export const POST = handler(async () => json({ ok: true }, { cookie: clearedCookie() }));
