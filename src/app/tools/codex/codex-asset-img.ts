/**
 * An image that lives in IndexedDB.
 *
 * The bytes are a Blob, so there is no URL until one is made; the store keeps
 * the object URL once it has, and this asks for it when the card is drawn
 * rather than when the library is read — a page of forty cards should not turn
 * forty screenshots into forty live URLs before showing anything.
 */
import { Component, effect, inject, input, signal } from '@angular/core';
import { CodexStore } from './codex-store';

@Component({
  selector: 'codex-asset-img',
  template: `
    @if (url()) {
      <img class="codex-asset" [src]="url()" [alt]="alt()" loading="lazy" />
    }
  `,
})
export class CodexAssetImg {
  readonly assetId = input.required<string>();
  readonly alt = input('');

  private readonly store = inject(CodexStore);
  readonly url = signal('');

  constructor() {
    effect(() => {
      const id = this.assetId();
      this.url.set('');
      if (id) void this.store.assetUrl(id).then((url) => this.url.set(url));
    });
  }
}
