/**
 * Keeping the saved libraries in step with the account.
 *
 * The merge itself lives on the server (api/_lib/merge.ts) and this side does
 * not repeat it: a device sends what it has and adopts the answer. Two merges
 * would be two chances to disagree about the same pair of libraries, and the
 * disagreement shows up as a build that comes back after you delete it.
 *
 * A tool hands over a port — read what is stored, write what came back — rather
 * than this file knowing about atlas builds or strategies. That keeps the
 * localStorage layout each tool already owns exactly where it was, and means a
 * tool that is not open is simply not part of the round trip. Absence never
 * deletes anything; only a tombstone does.
 *
 * Signed out, none of this runs and every tool behaves as it always has.
 */
import { effect, Injectable, inject, signal } from '@angular/core';
import { api, ApiError } from './api';
import { Auth } from './auth';

export type LibraryKind = 'atlas' | 'strategy';

/** The subset of a saved entry the server stores. Extra fields are dropped. */
export interface SyncEntry {
  id: string;
  name: string;
  code: string;
  points?: number;
  slots?: number;
  treeVersion?: number;
  savedAt: number;
}

export interface LibraryPort {
  read(): SyncEntry[];
  write(entries: SyncEntry[]): void;
}

type Payload = { atlas?: SyncEntry[]; strategy?: SyncEntry[]; gone: Record<string, number> };

const GONE_KEY = 'poe_sync_gone';
/** Which account this device's library was last reconciled with. */
const OWNER_KEY = 'poe_sync_owner';
const MAX_TOMBSTONES = 300;
/** Long enough to fold a burst of saves into one call, short enough to feel immediate. */
const DEBOUNCE_MS = 600;

@Injectable({ providedIn: 'root' })
export class LibrarySync {
  private readonly auth = inject(Auth);

  readonly busy = signal(false);
  readonly message = signal('');

  private readonly ports = new Map<LibraryKind, LibraryPort>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  /**
   * Bumped by every local change. A request carries the number it was sent
   * with, and an answer that comes back to a different one is thrown away — see
   * `exchange`.
   */
  private generation = 0;

  constructor() {
    // Signing in is itself a reason to sync; signing out leaves the device's
    // copy alone, because it is still this device's library.
    effect(() => {
      if (this.auth.user() && this.ports.size) this.schedule();
    });
  }

  /** A tool announces its library while it is on screen. */
  attach(kind: LibraryKind, port: LibraryPort): void {
    this.ports.set(kind, port);
    if (this.auth.user()) this.schedule();
  }

  detach(kind: LibraryKind): void {
    this.ports.delete(kind);
  }

  /**
   * Records that an entry was deleted here. Without this the next sync from a
   * device that still holds it would put it back.
   */
  forget(id: string): void {
    const gone = this.tombstones();
    gone[id] = Date.now();
    this.storeTombstones(gone);
    this.schedule();
  }

  /** Call after any local change. Several calls in a row cost one request. */
  schedule(): void {
    this.generation++;
    if (!this.auth.user()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, DEBOUNCE_MS);
  }

  private run(): Promise<void> {
    // One request at a time; a change that arrives mid-flight queues one more
    // rather than racing it.
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.exchange().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    });
    return this.running;
  }

  private async exchange(): Promise<void> {
    const user = this.auth.user();
    if (!user || !this.ports.size) return;

    this.busy.set(true);
    this.message.set('');
    const sentAt = this.generation;
    try {
      // A device that last synced with a different account must not push that
      // account's library into this one: take the server's copy instead.
      const switched = this.owner() !== null && this.owner() !== user.id;
      const answer = switched
        ? await api<Payload>('sync')
        : await api<Payload>('sync', { method: 'POST', body: this.local() });

      // Something was saved or deleted while this was in the air, so the answer
      // describes a library that no longer exists here. Applying it would undo
      // that change — most visibly a delete, whose tombstone was written after
      // the request left and would be overwritten by the server's older set.
      // The server has already merged what it was sent, so nothing is lost by
      // dropping this answer and going round again with the current state.
      if (this.generation !== sentAt) {
        this.again = true;
        return;
      }

      for (const [kind, port] of this.ports) port.write(answer[kind] ?? []);
      // Merged rather than replaced: the server trims its own set, and a delete
      // this device made should not be forgotten just because the server has
      // aged it out of the list it sends back.
      if (answer.gone) this.storeTombstones({ ...this.tombstones(), ...answer.gone });
      this.setOwner(user.id);
      this.message.set('Synced.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The cookie expired under us. Say so once rather than retrying forever.
        this.auth.user.set(null);
        this.message.set('Signed out — sign in again to keep syncing.');
      } else {
        this.message.set(err instanceof Error ? err.message : 'Sync failed.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  private local(): Payload {
    const payload: Payload = { gone: this.tombstones() };
    for (const [kind, port] of this.ports) payload[kind] = port.read();
    return payload;
  }

  // --- the bits that live in localStorage -------------------------------------

  private tombstones(): Record<string, number> {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(GONE_KEY) ?? '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Record<string, number>;
    } catch {
      return {};
    }
  }

  private storeTombstones(gone: Record<string, number>): void {
    const ids = Object.keys(gone);
    let keep = gone;
    if (ids.length > MAX_TOMBSTONES) {
      ids.sort((a, b) => gone[b] - gone[a]);
      keep = {};
      for (const id of ids.slice(0, MAX_TOMBSTONES)) keep[id] = gone[id];
    }
    try {
      localStorage.setItem(GONE_KEY, JSON.stringify(keep));
    } catch {
      // full or disabled storage — syncing still works, deletes just travel less well
    }
  }

  private owner(): string | null {
    try {
      return localStorage.getItem(OWNER_KEY);
    } catch {
      return null;
    }
  }

  private setOwner(id: string): void {
    try {
      localStorage.setItem(OWNER_KEY, id);
    } catch {
      // see above
    }
  }
}
