/**
 * The debug page: what is running, and what changed in it.
 *
 * Deliberately unlinked — no sidebar entry, no footer link — because it is for
 * whoever is checking whether a deploy actually went out, not for someone
 * looking for a calculator. Reached by typing `/debug`.
 */
import { Component } from '@angular/core';
import { APP_DATE, APP_VERSION, RELEASES } from '../shared/version';
import { PoeCard } from '../shared/poe-card';
import { ToolPage } from '../shared/tool-page';

@Component({
  selector: 'app-debug',
  imports: [PoeCard, ToolPage],
  templateUrl: './debug.html',
})
export class Debug {
  readonly version = APP_VERSION;
  readonly date = APP_DATE;
  readonly releases = RELEASES;
}
