import { Component, input } from '@angular/core';

/**
 * Page wrapper every tool sits in: the centred header with its three pips,
 * a title and a subtitle, followed by the tool's own content.
 *
 * Each tool lights a different combination of pips — pass `pips` to match the
 * one the old markup used.
 */
@Component({
  selector: 'poe-tool-page',
  template: `
    <div class="tool-page">
      <div class="tool-header">
        <div class="icon-pips">
          @for (on of pips(); track $index) {
            <div class="icon-pip" [class.active]="on"></div>
          }
        </div>
        <h2 class="tool-title">{{ heading() }}</h2>
        @if (subtitle()) {
          <div class="tool-subtitle">{{ subtitle() }}</div>
        }
      </div>
      <ng-content />
    </div>
  `,
})
export class ToolPage {
  readonly heading = input.required<string>();
  readonly subtitle = input('');
  readonly pips = input<boolean[]>([true, true, true]);
}
