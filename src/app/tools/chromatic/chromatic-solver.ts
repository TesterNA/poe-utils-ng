import type { PoEChromaticCalcMain } from './poe-chromatic-calc';

const SCRIPT_URL = 'vendor/PoEChromaticCalc.js';

let pending: Promise<PoEChromaticCalcMain | null> | null = null;

/**
 * Loads the vendored Haxe solver on demand and hands back `window.Main`.
 *
 * The script self-invokes `Main.main()`, which fills the recipe list and then
 * walks the original page's DOM: it appends twenty rows to `#resultbody` and
 * assigns an onclick to `#calcButton`. Neither exists here, so loading it from
 * index.html threw on every single page load. Giving it a throwaway hidden host
 * with just those two ids lets it finish silently; the host is removed straight
 * afterwards and nothing else in the app ever looks at it.
 *
 * Loading it here rather than in index.html also means the ~50 kB of vendored
 * code is only fetched when someone actually opens the Chromatic tool.
 *
 * The result is cached, so repeated visits reuse the first load.
 */
export function loadChromaticSolver(): Promise<PoEChromaticCalcMain | null> {
  pending ??= load();
  return pending;
}

async function load(): Promise<PoEChromaticCalcMain | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  if (isUsable(window.Main)) return window.Main ?? null;

  const host = document.createElement('div');
  host.style.display = 'none';
  host.setAttribute('aria-hidden', 'true');
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  tbody.id = 'resultbody';
  table.appendChild(tbody);
  const button = document.createElement('button');
  button.id = 'calcButton';
  host.append(table, button);
  document.body.appendChild(host);

  // The vendored IIFE takes `console` as its first argument and keeps that one
  // reference for its lifetime, so swapping it just while the script evaluates
  // permanently mutes the debug line it prints on every calculation — without
  // editing the file and without muting anything else. warn/error stay real via
  // the prototype chain, so genuine failures still surface.
  const realConsole = window.console;
  const quiet: Console = Object.create(realConsole);
  quiet.log = () => {};
  window.console = quiet;

  try {
    await injectScript(SCRIPT_URL);
  } catch {
    return null;
  } finally {
    window.console = realConsole;
    host.remove();
  }

  return isUsable(window.Main) ? (window.Main ?? null) : null;
}

function isUsable(main: PoEChromaticCalcMain | undefined): boolean {
  return (
    !!main && typeof main.getProbabilities === 'function' && (main.recipes?.length ?? 0) > 0
  );
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}
