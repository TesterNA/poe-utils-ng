/**
 * Passwords and sessions, on nothing but node:crypto.
 *
 * Both jobs here are small and well defined, and the standard library does them
 * properly: scrypt is a memory-hard KDF designed for exactly this, and an
 * HMAC-signed cookie is what a JWT reduces to once you drop the algorithm
 * negotiation that has caused most of the JWT footguns. So no dependency.
 *
 * The session token is a signed statement, not a database row: nothing to look
 * up, so `me` and every authenticated call cost no read. The price is that a
 * token cannot be revoked before it expires — acceptable for a tool that saves
 * atlas trees, and the reason the lifetime is 30 days rather than forever.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const COOKIE = 'poe_session';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * N=16384 is the reference cost; r=8 p=1 are its usual companions. The default
 * `maxmem` is 32 MB, which 16384 x 8 x 128 sits just under — raised anyway so a
 * later bump to N does not fail at runtime instead of at review.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;

/** `promisify` drops the options overload, so the callback is wrapped by hand. */
function scrypt(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export interface Session {
  /** the user's `_id` as a hex string */
  uid: string;
  email: string;
  /** unix seconds */
  exp: number;
}

function secret(): Buffer {
  const value = process.env['SESSION_SECRET'];
  if (!value || value.length < 32) {
    throw new Error('SESSION_SECRET is missing or shorter than 32 characters');
  }
  return Buffer.from(value, 'utf8');
}

// --- passwords ---------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  if (!expected.length) return false;
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

// --- tokens ------------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload: string): string {
  return b64url(createHmac('sha256', secret()).update(payload).digest());
}

export function issueToken(uid: string, email: string): string {
  const session: Session = {
    uid,
    email,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
  };
  const payload = b64url(Buffer.from(JSON.stringify(session), 'utf8'));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string): Session | null {
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const given = unb64url(token.slice(dot + 1));
  const want = unb64url(sign(payload));
  // Lengths must match before timingSafeEqual, which throws otherwise.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const session = JSON.parse(unb64url(payload).toString('utf8')) as Session;
    if (typeof session.uid !== 'string' || typeof session.exp !== 'number') return null;
    if (session.exp * 1000 < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

// --- cookies -----------------------------------------------------------------

/**
 * `SameSite=Lax` rather than `Strict`: a shared link lands on the site from
 * somewhere else, and Strict would leave the visitor looking logged out on that
 * first paint. Lax still refuses to send the cookie on cross-site POSTs, which
 * is the part that matters.
 */
export function sessionCookie(token: string): string {
  return [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SECONDS}`,
  ].join('; ');
}

export function clearedCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSession(request: Request): Session | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    return verifyToken(part.slice(eq + 1).trim());
  }
  return null;
}
