/**
 * localStorage boundary for the Bulk Trade Calculator.
 *
 * The keys and the stored JSON are byte-for-byte what the old vanilla tool
 * wrote, so existing saved presets keep working:
 *
 *   poe_trade_presets → Preset[]
 *   poe_trade_working → { loadedName: string, working: Preset }
 */

import { Preset, StoredWorking, isRecord, isValidPreset } from './trade-types';

const PRESETS_KEY = 'poe_trade_presets';
const WORKING_KEY = 'poe_trade_working';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The original's migration step: older presets had no request header/footer,
 * so default them to '' before validating.
 */
export function migratePreset(raw: unknown): Preset | null {
  if (!isRecord(raw)) return null;
  const migrated = {
    ...raw,
    requestHeader: asString(raw['requestHeader']),
    requestFooter: asString(raw['requestFooter']),
  };
  return isValidPreset(migrated) ? migrated : null;
}

export function loadPresets(): Preset[] | null {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const presets: Preset[] = [];
    for (const item of parsed) {
      const preset = migratePreset(item);
      if (preset) presets.push(preset);
    }
    return presets.length > 0 ? presets : null;
  } catch {
    return null;
  }
}

export function loadWorking(): StoredWorking | null {
  try {
    const raw = localStorage.getItem(WORKING_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const working = migratePreset(parsed['working']);
    if (!working) return null;
    const loadedName = parsed['loadedName'];
    return {
      loadedName: typeof loadedName === 'string' && loadedName ? loadedName : working.name,
      working,
    };
  } catch {
    return null;
  }
}

export function savePresets(presets: Preset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {
    /* quota / private mode — the original swallowed this too */
  }
}

export function saveWorking(loadedName: string, working: Preset): void {
  try {
    const payload: StoredWorking = { loadedName, working };
    localStorage.setItem(WORKING_KEY, JSON.stringify(payload));
  } catch {
    /* ignored */
  }
}
