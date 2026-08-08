/**
 * Who is signed in.
 *
 * One signal that the whole app reads. It is filled from `/api/auth/me` once at
 * startup — a signature check on the cookie, no database — and then only by
 * signing in or out.
 *
 * `available` is how the app copes with there being no backend: on the dev
 * server, or when the functions are down, the account UI takes itself off
 * screen instead of offering a sign-in that cannot work. Everything else keeps
 * running on localStorage exactly as it did before any of this existed.
 */
import { Injectable, signal } from '@angular/core';
import { api, ApiError } from './api';

export interface Account {
  id: string;
  email: string;
}

@Injectable({ providedIn: 'root' })
export class Auth {
  readonly user = signal<Account | null>(null);
  /** false until the first `me` call comes back, so the UI can hold still */
  readonly ready = signal(false);
  readonly available = signal(true);

  private loading: Promise<void> | null = null;

  /** Safe to call from anywhere; the request only happens once. */
  load(): Promise<void> {
    this.loading ??= this.fetchMe();
    return this.loading;
  }

  private async fetchMe(): Promise<void> {
    try {
      const { user } = await api<{ user: Account | null }>('auth/me');
      this.user.set(user);
    } catch (err) {
      if (err instanceof ApiError && err.offline) this.available.set(false);
      this.user.set(null);
    } finally {
      this.ready.set(true);
    }
  }

  async signIn(email: string, password: string): Promise<void> {
    const { user } = await api<{ user: Account }>('auth/login', {
      method: 'POST',
      body: { email, password },
    });
    this.user.set(user);
  }

  async signUp(email: string, password: string): Promise<void> {
    const { user } = await api<{ user: Account }>('auth/register', {
      method: 'POST',
      body: { email, password },
    });
    this.user.set(user);
  }

  /**
   * Clears the session even if the request fails. A logout that leaves you
   * looking signed in because the network hiccuped is worse than one that drops
   * a cookie the server would have dropped anyway.
   */
  async signOut(): Promise<void> {
    try {
      await api('auth/logout', { method: 'POST' });
    } finally {
      this.user.set(null);
    }
  }
}
