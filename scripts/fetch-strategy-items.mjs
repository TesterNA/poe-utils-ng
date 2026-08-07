/**
 * Rebuilds public/assets/strategy/items.json — every scarab and allflame ember
 * the Strategy tool can put in a map device — from poedb.
 *
 *   node scripts/fetch-strategy-items.mjs 3.29
 *
 * The version argument is the game version being scraped, and it is the whole
 * point of running this again. The file is a *merge*, never a replacement:
 *
 *   - an item that is new in this scrape gets `since` set to that version
 *   - an item that was in the file and is no longer on poedb gets `removedIn`
 *     set to it, and is kept
 *   - an item that comes back has `removedIn` cleared
 *   - `code`, the number share codes are written in, is assigned once and never
 *     reused, so an old strategy keeps naming the same items forever
 *
 * Items from the very first scrape have no `since`: they existed at or before
 * the earliest version we ever looked at, and guessing which league each was
 * introduced in would be inventing data. Only what a scrape actually witnessed
 * is recorded.
 *
 * Icons are downloaded alongside, because hotlinking poedb's CDN would put a
 * third party in the render path of a page that otherwise works offline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'assets', 'strategy');
const iconDir = path.join(outDir, 'icons');
const outFile = path.join(outDir, 'items.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const SOURCES = [
  { url: 'https://poedb.tw/us/Scarab', type: 'scarab', tab: 'ScarabsItem' },
  { url: 'https://poedb.tw/us/Allflame_ember', type: 'allflame', tab: 'AllflameItem' },
];

// --- html ---------------------------------------------------------------------

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** `<br>` becomes a line, every other tag disappears. */
function textOf(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * poedb lays each item out as one `col` holding an icon, a name link and a
 * block of properties and mods.
 *
 * Only the first tab is the item list. The later tabs on the same page use the
 * same markup for related things — where scarabs drop from, which atlas
 * passives affect them — so the slice has to stop at the next tab or those get
 * scraped in as items.
 */
function splitCards(html, tab) {
  const start = html.indexOf(`id="${tab}"`);
  if (start < 0) throw new Error(`tab ${tab} not found — poedb's markup changed`);
  // `id="X"` sits inside the tab's own `class="tab-pane"` div, so the search
  // for the *next* tab starts past this one's opening tag.
  const rest = html.slice(start);
  const end = rest.indexOf('class="tab-pane', rest.indexOf('>'));
  const marker = '<div class="col"><div class="d-flex border-top rounded">';
  return (end > 0 ? rest.slice(0, end) : rest).split(marker).slice(1);
}

function parseCard(card, type) {
  const name = /<a class="whiteitem[^"]*"[^>]*>([^<]+)<\/a>/.exec(card)?.[1];
  if (!name) return null;
  const href = /<a class="whiteitem[^"]*"[^>]*href="([^"]+)"/.exec(card)?.[1] ?? '';
  const icon = /<img[^>]+src="(https:\/\/cdn\.poedb\.tw\/image\/[^"]+)"/.exec(card)?.[1] ?? '';

  const properties = {};
  for (const [, key, value] of card.matchAll(
    /<div class="property">([^<:]+):\s*<span[^>]*>([^<]*)<\/span>/g,
  )) {
    properties[key.trim()] = decodeEntities(value).trim();
  }

  // An ember's tooltip text is its implicit; a scarab has only the explicit.
  // Rows holding a `secondary` span are the raw internal stat and never shown.
  const mods = [];
  for (const [, kind, body] of card.matchAll(
    /<div class="(implicitMod|explicitMod)">([\s\S]*?)<\/div>/g,
  )) {
    if (/class="secondary"/.test(body)) continue;
    if (type === 'allflame' && kind === 'explicitMod' && mods.length) continue;
    mods.push(...textOf(body));
  }

  const limit = Number(properties['Limit']);
  return {
    id: slugOf(href, name),
    name: decodeEntities(name).trim(),
    type,
    group: groupOf(name, type),
    limit: Number.isFinite(limit) && limit > 0 ? limit : 1,
    stats: [...new Set(mods)],
    icon: icon ? path.basename(new URL(icon).pathname) : '',
    iconUrl: icon,
  };
}

function slugOf(href, name) {
  const raw = href || name;
  return decodeURIComponent(raw)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Scarabs are named "<Mechanic> Scarab of <Effect>", so the words before
 * "Scarab" are the family the game itself groups them by. The ones with no
 * prefix are the general-purpose ones and have no family of their own.
 */
function groupOf(name, type) {
  if (type === 'allflame') return 'Allflame';
  const before = name.split(' Scarab')[0];
  return before === name || before === 'Scarab' || before === '' ? 'Miscellaneous' : before;
}

// --- merge --------------------------------------------------------------------

function readExisting() {
  if (!existsSync(outFile)) return { versions: [], items: [] };
  return JSON.parse(readFileSync(outFile, 'utf8'));
}

async function main() {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+$/.test(version)) {
    console.error('usage: node scripts/fetch-strategy-items.mjs <game version, e.g. 3.29>');
    process.exit(1);
  }

  const scraped = [];
  for (const source of SOURCES) {
    const response = await fetch(source.url, { headers: { 'User-Agent': UA } });
    if (!response.ok) throw new Error(`${source.url} -> ${response.status}`);
    const html = await response.text();
    const items = splitCards(html, source.tab)
      .map((card) => parseCard(card, source.type))
      .filter(Boolean);
    if (!items.length) throw new Error(`${source.url} parsed to nothing`);
    console.log(`${source.url}: ${items.length} items`);
    scraped.push(...items);
  }

  mkdirSync(iconDir, { recursive: true });
  let downloaded = 0;
  for (const item of scraped) {
    const file = item.icon ? path.join(iconDir, item.icon) : '';
    if (!item.iconUrl || (file && existsSync(file))) continue;
    // The CDN throttles a run of a hundred-odd requests and answers 403 to a
    // few of them; a pause and a second ask is usually all it wants. A handful
    // of files it refuses however often you ask — those items ship without an
    // icon rather than with a request the browser will 404 on.
    let body = null;
    for (let attempt = 0; attempt < 4 && !body; attempt++) {
      if (attempt) await new Promise((done) => setTimeout(done, 1500 * attempt));
      const response = await fetch(item.iconUrl, { headers: { 'User-Agent': UA } });
      if (response.ok) body = Buffer.from(await response.arrayBuffer());
      else console.warn(`icon ${item.icon} -> ${response.status}, retrying`);
    }
    if (!body) {
      console.warn(`icon ${item.icon}: giving up, ${item.name} ships without one`);
      item.icon = '';
      continue;
    }
    writeFileSync(file, body);
    downloaded++;
  }

  const previous = readExisting();
  const byId = new Map(previous.items.map((item) => [item.id, item]));
  const firstScrape = previous.items.length === 0;
  let nextCode = previous.items.reduce((max, item) => Math.max(max, item.code), 0) + 1;

  const seen = new Set();
  const items = [];
  for (const item of scraped) {
    seen.add(item.id);
    const before = byId.get(item.id);
    items.push({
      // A share code names an item by this number, so it is a permanent
      // contract: assigned once, never reused, even after the item is removed.
      code: before?.code ?? nextCode++,
      id: item.id,
      name: item.name,
      type: item.type,
      group: item.group,
      limit: item.limit,
      stats: item.stats,
      icon: item.icon,
      // Absent means "at or before the earliest version we scraped".
      ...(before ? (before.since ? { since: before.since } : {}) : firstScrape ? {} : { since: version }),
      removedIn: null,
    });
  }

  // Anything the scrape did not find is gone from the game as of this version.
  // It stays in the file: old strategies still refer to it and want to say so.
  for (const item of previous.items) {
    if (seen.has(item.id)) continue;
    items.push({ ...item, removedIn: item.removedIn ?? version });
  }

  items.sort((a, b) => a.code - b.code);

  const versions = [...new Set([...previous.versions, version])].sort();
  writeFileSync(outFile, `${JSON.stringify({ versions, items }, null, 1)}\n`);

  const removed = items.filter((item) => item.removedIn).length;
  console.log(
    `${outFile}: ${items.length} items (${removed} removed), ${downloaded} new icons, versions ${versions.join(', ')}`,
  );
}

await main();
