/**
 * Short links.
 *
 * A share link carries the whole plan in its query string, which is the right
 * default — it needs no server and it cannot rot. It is also 200 characters
 * that some places will wrap, truncate or refuse. This trades that for an
 * eight character slug and a server that has to still be there.
 *
 * What gets stored is the code alone. The origin and the path are the same in
 * every row, so the server keeps neither and this file puts them back.
 */
import { api } from './api';
import type { LibraryKind } from './sync';

/** Which query parameter each tool reads its code from. */
const PARAM: Record<LibraryKind, string> = { atlas: 'c', strategy: 's' };

export async function shorten(kind: LibraryKind, code: string): Promise<string> {
  const { slug } = await api<{ slug: string }>('links', { method: 'POST', body: { kind, code } });
  return `${location.origin}/s/${slug}`;
}

/** Where `/s/:slug` sends someone once the slug has been turned back into a code. */
export function toolLink(kind: LibraryKind, code: string): { path: string; params: Record<string, string> } {
  return { path: `/${kind}`, params: { [PARAM[kind]]: code } };
}
