/**
 * Sign in, or make an account.
 *
 * The account exists for one reason: to carry your saved atlas builds and
 * strategies between browsers. Nothing else on the site needs it, and the page
 * says so, because an account that appears without explaining itself reads as a
 * wall in front of a tool that used to just work.
 *
 * A real `<form>` with a submit button, and the inputs named the way password
 * managers expect: Enter submits, and browsers offer to save the password
 * instead of treating this as a mystery pair of fields.
 */
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Auth } from '../shared/auth';
import { LibrarySync } from '../shared/sync';
import { PoeCard } from '../shared/poe-card';
import { ToolPage } from '../shared/tool-page';

@Component({
  selector: 'app-account',
  imports: [FormsModule, PoeCard, ToolPage],
  templateUrl: './account.html',
})
export class Account {
  readonly auth = inject(Auth);
  readonly sync = inject(LibrarySync);

  readonly email = signal('');
  readonly password = signal('');
  readonly creating = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  readonly action = computed(() => (this.creating() ? 'Create account' : 'Sign in'));

  constructor() {
    void this.auth.load();
  }

  toggleMode(): void {
    this.creating.update((on) => !on);
    this.error.set('');
  }

  async submit(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const email = this.email().trim();
      const password = this.password();
      if (this.creating()) await this.auth.signUp(email, password);
      else await this.auth.signIn(email, password);
      // Only the password is worth clearing; leaving the address makes a failed
      // first attempt one field to retype instead of two.
      this.password.set('');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      this.busy.set(false);
    }
  }

  async signOut(): Promise<void> {
    this.busy.set(true);
    try {
      await this.auth.signOut();
    } finally {
      this.busy.set(false);
    }
  }
}
