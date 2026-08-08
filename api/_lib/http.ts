/**
 * The small amount of plumbing every endpoint here repeats.
 *
 * Nothing is cached at the edge: every route either reads the caller's session
 * or writes, so `no-store` is on all of it, and the one route that could be
 * cached — resolving a slug — is a single indexed read that is not worth the
 * staleness.
 */

export function json(body: unknown, init: { status?: number; cookie?: string } = {}): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (init.cookie) headers.append('set-cookie', init.cookie);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

export function fail(status: number, message: string): Response {
  return json({ error: message }, { status });
}

/**
 * Turns a thrown error into a 500 without leaking what broke. A missing
 * environment variable is the one exception worth naming, because otherwise a
 * fresh deployment fails with a blank 500 and no clue which variable was
 * forgotten.
 */
export async function guard(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message, err);
    if (/is not set|is missing/.test(message)) return fail(500, `Server misconfigured: ${message}`);
    return fail(500, 'Something went wrong.');
  }
}

/** Refuses anything that is not a JSON object, so handlers can trust the shape. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new BadRequest('Expected a JSON body.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequest('Expected a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export class BadRequest extends Error {}

/** `guard`, plus turning a BadRequest into the 400 it describes. */
export function handler(run: (request: Request) => Promise<Response>) {
  return (request: Request): Promise<Response> =>
    guard(async () => {
      try {
        return await run(request);
      } catch (err) {
        if (err instanceof BadRequest) return fail(400, err.message);
        throw err;
      }
    });
}
