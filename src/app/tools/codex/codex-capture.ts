/**
 * Paste anything, get an entry.
 *
 * This is how a Codex actually fills up. Nobody opens a form mid-league; they
 * copy a link out of a stream chat and come back to it later. So one box takes
 * whatever is on the clipboard and works out what it was.
 *
 * Two things it gets from the source documents rather than from imagination:
 *
 * **Lines are written `Label: url`.** "ендгейм поба: https://pobb.in/…",
 * "Видос по билду: https://youtu.be/…", "Leveling Filter (for blight): …" —
 * that is the shape of every link list in every one of them. The label is the
 * title, and throwing it away would be throwing away the only thing that says
 * which of a build's four PoBs this one is.
 *
 * **A list is pasted as a list.** Those documents hold link lists thirty rows
 * long. One line, one entry.
 *
 * The host tells us what a link is *for*. It is a guess, it is right nearly
 * every time for the dozen sites these documents live on, and it is a field you
 * can change afterwards rather than something the entry is stuck with.
 */
import type { EntryData, EntryKind, FilterInfo, Game, LinkRole } from './codex-types';
import { hostOf } from './codex-schema';

export interface Captured {
  kind: EntryKind;
  title: string;
  data: EntryData;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

/** Trailing punctuation is sentence, not URL: "see https://x.com/y." */
function tidyUrl(url: string): string {
  return url.replace(/[.,;:!?)\]]+$/, '');
}

interface HostRule {
  test: (url: URL) => boolean;
  role: LinkRole;
}

/**
 * First match wins, so the path-specific rules come before the host ones —
 * poe.ninja is a PoB or a profile depending on the path, and pathofexile.com is
 * a filter list or an account page the same way.
 */
const RULES: HostRule[] = [
  { test: (u) => host(u, 'poe.ninja') && /\/pob\//.test(u.pathname), role: 'pob' },
  { test: (u) => host(u, 'poe.ninja') && /\/profile\//.test(u.pathname), role: 'profile' },
  { test: (u) => host(u, 'pathofexile.com') && /item-filters/.test(u.pathname), role: 'filter' },
  { test: (u) => host(u, 'pathofexile.com') && /\/account\//.test(u.pathname), role: 'profile' },
  { test: (u) => host(u, 'pobb.in'), role: 'pob' },
  { test: (u) => host(u, 'mobalytics.gg'), role: 'pob' },
  { test: (u) => host(u, 'poeplanner.com') || host(u, 'poeqol.com'), role: 'atlas' },
  { test: (u) => host(u, 'youtube.com') || host(u, 'youtu.be'), role: 'video' },
  { test: (u) => host(u, 'twitch.tv'), role: 'stream' },
  { test: (u) => host(u, 'filterblade.xyz'), role: 'filter' },
  { test: (u) => host(u, 'imgur.com') || host(u, 'ibb.co'), role: 'image' },
  { test: (u) => host(u, 'docs.google.com') || host(u, 'drive.google.com'), role: 'doc' },
  { test: (u) => host(u, 'reddit.com') || host(u, 'maxroll.gg'), role: 'guide' },
  {
    test: (u) =>
      host(u, 'wealthyexile.com') ||
      host(u, 'poedb.tw') ||
      host(u, 'poe2db.tw') ||
      host(u, 'craftofexile.com') ||
      host(u, 'poewiki.net') ||
      host(u, 'poe.re') ||
      host(u, 'poe-leveling.com'),
    role: 'tool',
  },
];

function host(url: URL, name: string): boolean {
  const hostname = url.hostname.replace(/^www\./, '');
  return hostname === name || hostname.endsWith(`.${name}`);
}

export function roleOf(url: string): LinkRole | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return RULES.find((rule) => rule.test(parsed))?.role;
}

/** Which of a profile's filters this is, when the label bothers to say. */
function stageOf(label: string): FilterInfo['stage'] | undefined {
  const text = label.toLowerCase();
  if (/endgame|энд|енд/.test(text)) return 'endgame';
  if (/map/.test(text)) return 'mapping';
  if (/level|acts|акт|левел/.test(text)) return 'leveling';
  if (/early|start|старт/.test(text)) return 'early';
  return undefined;
}

/**
 * A filter link taken apart. `saveState` is the whole point: two filterblade
 * links from one profile differ by nothing else, and which is the levelling one
 * is not something to work out by eye each league.
 */
export function filterInfoOf(url: string, label = ''): FilterInfo | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const stage = stageOf(label);
  const game: Game | undefined =
    parsed.searchParams.get('game')?.toLowerCase() === 'poe2'
      ? 'poe2'
      : parsed.searchParams.get('game')
        ? 'poe1'
        : undefined;

  if (host(parsed, 'filterblade.xyz')) {
    const profile = parsed.searchParams.get('profile') ?? parsed.searchParams.get('name') ?? '';
    const saveState = parsed.searchParams.get('saveState') ?? '';
    return {
      site: 'filterblade',
      ...(profile ? { profile } : {}),
      ...(saveState ? { saveState } : {}),
      ...(stage ? { stage } : {}),
      ...(game ? { game } : {}),
    };
  }
  if (host(parsed, 'pathofexile.com') && /item-filters/.test(parsed.pathname)) {
    const profile = /view-profile\/([^/]+)/.exec(parsed.pathname)?.[1] ?? '';
    return {
      site: 'poe-profile',
      ...(profile ? { profile: decodeURIComponent(profile) } : {}),
      ...(stage ? { stage } : {}),
    };
  }
  return undefined;
}

/** `pobb.in/PfrGHW7YkQqU` — enough to tell two links apart at a glance. */
function titleFromUrl(url: string): string {
  const host = hostOf(url);
  if (!host) return url.slice(0, 80);
  try {
    const path = new URL(url).pathname.replace(/\/$/, '');
    return path && path !== '/' ? `${host}${path}`.slice(0, 80) : host;
  } catch {
    return host;
  }
}

/**
 * Splits "ендгейм поба: https://pobb.in/x" into its two halves.
 *
 * Only a colon that is not the URL's own counts, which is why this looks for
 * the URL first and reads backwards from it.
 */
function splitLabel(line: string, url: string): string {
  const before = line.slice(0, line.indexOf(url));
  return before
    .replace(/[\s:—–-]+$/, '')
    .replace(/^[\s•*·-]+/, '')
    .trim();
}

/** Our own codes, pasted straight out of the atlas or strategy tool. */
const OWN_CODE = /((?:AT|ST)\d+:[A-Za-z0-9_-]{8,})/;

/**
 * Our own share links. The code is in the query string — `?c=` for a tree,
 * `?s=` for a strategy — which is worth unpicking rather than keeping as a
 * link: a link opens the tool, a code makes an entry that can say what the
 * tree costs and what scarabs go in it.
 *
 * A short link (`/s/slug`) is not unpicked, because the slug means nothing
 * without asking the server what it stands for.
 */
function ownCode(url: string): { kind: 'atlas' | 'strategy'; code: string } | null {
  try {
    const parsed = new URL(url);
    const atlas = parsed.searchParams.get('c');
    if (atlas && /\/atlas$/.test(parsed.pathname)) return { kind: 'atlas', code: atlas };
    const strategy = parsed.searchParams.get('s');
    if (strategy && /\/strategy$/.test(parsed.pathname)) return { kind: 'strategy', code: strategy };
  } catch {
    return null;
  }
  return null;
}

export function captureOne(line: string): Captured | null {
  const text = line.trim();
  if (!text) return null;

  const found = URL_PATTERN.exec(text);
  if (!found) {
    // A bare share code, pasted out of the tool next door.
    const code = OWN_CODE.exec(text);
    if (code) {
      const kind = code[1].startsWith('AT') ? 'atlas' : 'strategy';
      const label = text.replace(code[1], '').replace(/[\s:—–-]+$/, '').trim();
      return kind === 'atlas'
        ? { kind, title: label || 'Atlas tree', data: { k: 'atlas', src: { code: code[1] } } }
        : { kind, title: label || 'Strategy', data: { k: 'strategy', src: { code: code[1] } } };
    }
    // No link: it is something somebody wrote.
    return { kind: 'note', title: text.slice(0, 120), data: { k: 'note' } };
  }

  const url = tidyUrl(found[0]);
  const label = splitLabel(text, found[0]);

  const own = ownCode(url);
  if (own) {
    return own.kind === 'atlas'
      ? { kind: 'atlas', title: label || 'Atlas tree', data: { k: 'atlas', src: { code: own.code } } }
      : { kind: 'strategy', title: label || 'Strategy', data: { k: 'strategy', src: { code: own.code } } };
  }

  const role = roleOf(url);

  // Somebody else's tree is still a tree. It stays a link inside the card —
  // there is nothing to read out of poeplanner from here — but it belongs
  // among the atlases rather than among the odds and ends, and the card has a
  // place to put our own code beside it later.
  if (role === 'atlas') {
    return { kind: 'atlas', title: label || titleFromUrl(url), data: { k: 'atlas', src: { url } } };
  }

  const filter = role === 'filter' ? filterInfoOf(url, label) : undefined;
  return {
    kind: 'link',
    title: label || titleFromUrl(url),
    data: {
      k: 'link',
      url,
      host: hostOf(url),
      ...(role ? { role } : {}),
      ...(filter ? { filter } : {}),
    },
  };
}

/**
 * One line, one entry — unless there are no links at all, in which case the
 * whole paste is one note. A pasted paragraph is a thought, not a list.
 */
export function capture(text: string): Captured[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  // The first line names it and the rest is the body — see `noteBody`, which
  // the caller applies because the body belongs to the Entry, not to this.
  if (!lines.some((line) => URL_PATTERN.test(line))) {
    return [{ kind: 'note', title: lines[0].slice(0, 120), data: { k: 'note' } }];
  }
  return lines.map(captureOne).filter((item): item is Captured => item !== null);
}

/** What a multi-line note keeps beyond its first line. */
export function noteBody(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  return lines.length > 1 ? lines.slice(1).join('\n').trim() : '';
}
