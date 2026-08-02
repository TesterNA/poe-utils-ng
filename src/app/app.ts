import { Component, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TOOLS, type ToolDef } from './tools';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
})
export class App {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly icons = new Map<string, SafeHtml>();

  readonly tools = TOOLS.filter((tool) => !tool.hidden);
  readonly sidebarOpen = signal(false);

  /** Icon markup comes from our own tools.ts literals, never from user input. */
  icon(tool: ToolDef): SafeHtml {
    let svg = this.icons.get(tool.id);
    if (!svg) {
      svg = this.sanitizer.bypassSecurityTrustHtml(tool.icon);
      this.icons.set(tool.id, svg);
    }
    return svg;
  }

  openSidebar(): void {
    this.sidebarOpen.set(true);
  }

  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }
}
