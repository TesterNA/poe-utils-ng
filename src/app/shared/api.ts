/**
 * Talking to the functions under /api.
 *
 * Plain `fetch` rather than HttpClient: there are six endpoints, all JSON, all
 * on this origin, and none of them wants an interceptor, an observable or a
 * retry policy. The session travels as an httpOnly cookie, so nothing here
 * carries a token and nothing has to remember to attach one.
 *
 * `ng serve` has no functions behind it, so a request can land on the SPA
 * fallback and come back as index.html. That is reported as status 0 —
 * "there is no backend here" — which is what the sign-in UI hides itself on,
 * rather than showing an error nobody can act on.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  /** No backend answered: running the dev server, or offline. */
  get offline(): boolean {
    return this.status === 0;
  }
}

export async function api<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server.');
  }

  // The SPA fallback answers 200 with HTML when no function is deployed.
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new ApiError(response.ok ? 0 : response.status, 'The server is not available.');
  }

  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? 'Something went wrong.');
  return body;
}
