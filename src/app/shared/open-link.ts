/**
 * `/s/:slug` — the other end of a short link.
 *
 * Trades the slug for the code it stands for and hands it to the tool that
 * understands it, replacing this URL on the way so the back button goes where
 * the visitor came from rather than back through the redirect.
 *
 * A dead slug says so on screen instead of bouncing to a tool with nothing
 * loaded, which would look like the link had worked and the plan had been empty.
 */
import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { api } from './api';
import { toolLink } from './short-link';
import type { LibraryKind } from './sync';
import { ToolPage } from './tool-page';
import { PoeCard } from './poe-card';

@Component({
  selector: 'app-open-link',
  imports: [ToolPage, PoeCard, RouterLink],
  template: `
    <poe-tool-page heading="Opening link" [pips]="[true, false, true]">
      <poe-card maxWidth="520px">
        @if (error()) {
          <p class="tool-intro">{{ error() }}</p>
          <a class="poe-btn poe-btn-dim" routerLink="/atlas">Go to the atlas planner</a>
        } @else {
          <p class="tool-intro">Fetching the plan…</p>
        }
      </poe-card>
    </poe-tool-page>
  `,
})
export class OpenLink {
  private readonly router = inject(Router);
  readonly error = signal('');

  constructor() {
    const slug = inject(ActivatedRoute).snapshot.paramMap.get('slug') ?? '';
    void this.open(slug);
  }

  private async open(slug: string): Promise<void> {
    if (!slug) {
      this.error.set('That link is missing its code.');
      return;
    }
    try {
      const { kind, code } = await api<{ kind: LibraryKind; code: string }>(
        `links/${encodeURIComponent(slug)}`,
      );
      const { path, params } = toolLink(kind, code);
      await this.router.navigate([path], { queryParams: params, replaceUrl: true });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'That link could not be opened.');
    }
  }
}
