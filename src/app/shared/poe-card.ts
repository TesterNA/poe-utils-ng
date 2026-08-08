import { Component, input } from '@angular/core';

/** The glass panel used across every tool. */
@Component({
  selector: 'poe-card',
  template: `
    <div class="poe-card" [style.max-width]="maxWidth()" [style.margin]="'0 auto'">
      @if (divider()) {
        <div class="poe-divider">
          <div class="poe-divider-line"></div>
          <div class="poe-diamond"></div>
          <div class="poe-divider-line"></div>
        </div>
      }
      <ng-content />
    </div>
  `,
})
export class PoeCard {
  readonly maxWidth = input('none');
  readonly divider = input(true);
}
