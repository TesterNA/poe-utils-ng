/**
 * What counts as an email and a password here.
 *
 * The email check is deliberately shallow. A regex cannot decide whether an
 * address exists, and every strict one rejects addresses that are perfectly
 * valid; since nothing is ever sent to it, the address is really just a unique
 * name, and the check only has to stop obvious typos.
 *
 * The password floor is length and nothing else. Character-class rules push
 * people towards `Passw0rd!` and are worse than the eight characters they
 * decorate.
 */
import { BadRequest } from './http';

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_EMAIL = 200;

export function readEmail(body: Record<string, unknown>): string {
  const raw = body['email'];
  if (typeof raw !== 'string') throw new BadRequest('Email is required.');
  const email = raw.trim().toLowerCase();
  if (email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BadRequest('That does not look like an email address.');
  }
  return email;
}

export function readPassword(body: Record<string, unknown>): string {
  const raw = body['password'];
  if (typeof raw !== 'string') throw new BadRequest('Password is required.');
  if (raw.length < MIN_PASSWORD) {
    throw new BadRequest(`Use at least ${MIN_PASSWORD} characters.`);
  }
  if (raw.length > MAX_PASSWORD) throw new BadRequest('That password is too long.');
  return raw;
}
