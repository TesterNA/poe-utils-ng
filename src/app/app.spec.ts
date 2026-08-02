import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { TOOLS } from './tools';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render one sidebar link per visible tool', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const visible = TOOLS.filter((tool) => !tool.hidden);
    expect(compiled.querySelectorAll('.nav-btn').length).toBe(visible.length);
  });

  it('should keep hidden tools out of the sidebar', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const labels = [...compiled.querySelectorAll('.nav-btn')].map((el) => el.textContent?.trim());
    for (const tool of TOOLS.filter((t) => t.hidden)) {
      expect(labels).not.toContain(tool.label);
    }
  });
});
