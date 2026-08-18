import { Routes } from '@angular/router';

/**
 * One lazy route per tool. Paths match the old site's hash ids, so a link like
 * `.../#exp` maps onto `/exp` here.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'defense' },
  {
    path: 'defense',
    title: 'Defense Calc · PoE Tools',
    loadComponent: () => import('./tools/defense/defense').then((m) => m.Defense),
  },
  {
    path: 'exchange',
    title: 'Currency · PoE Tools',
    loadComponent: () => import('./tools/exchange/exchange').then((m) => m.Exchange),
  },
  {
    path: 'lucky',
    title: 'Lucky Calc · PoE Tools',
    loadComponent: () => import('./tools/lucky/lucky').then((m) => m.Lucky),
  },
  {
    path: 'chromatic',
    title: 'Chromatic Calc · PoE Tools',
    loadComponent: () => import('./tools/chromatic/chromatic').then((m) => m.Chromatic),
  },
  {
    path: 'exp',
    title: 'EXP Penalty · PoE Tools',
    loadComponent: () => import('./tools/exp/exp').then((m) => m.Exp),
  },
  {
    // hidden from the sidebar (see tools.ts) but still reachable by URL
    path: 'trade',
    title: 'Bulk Trade Calc · PoE Tools',
    loadComponent: () => import('./tools/trade/trade').then((m) => m.Trade),
  },
  {
    path: 'kingsmarch',
    title: 'Kingsmarch Shipment · PoE Tools',
    loadComponent: () => import('./tools/kingsmarch/kingsmarch').then((m) => m.Kingsmarch),
  },
  {
    path: 'atlas',
    title: 'Atlas Selector · PoE Tools',
    loadComponent: () => import('./tools/atlas/atlas').then((m) => m.Atlas),
  },
  {
    path: 'strategy',
    title: 'Map Strategy · PoE Tools',
    loadComponent: () => import('./tools/strategy/strategy').then((m) => m.Strategy),
  },
  {
    path: 'codex',
    title: 'Codex · PoE Tools',
    loadComponent: () => import('./tools/codex/codex').then((m) => m.Codex),
  },
  {
    path: 'minesweeper',
    title: 'Minesweeper · PoE Tools',
    loadComponent: () => import('./tools/minesweeper/minesweeper').then((m) => m.Minesweeper),
  },
  {
    // not a tool, so it is not in TOOLS — reached from the sidebar footer
    path: 'account',
    title: 'Account · PoE Tools',
    loadComponent: () => import('./account/account').then((m) => m.Account),
  },
  {
    // unlinked on purpose: what version is running and what changed in it
    path: 'debug',
    title: 'Debug · PoE Tools',
    loadComponent: () => import('./debug/debug').then((m) => m.Debug),
  },
  {
    // the short-link landing: swaps the slug for a code and forwards
    path: 's/:slug',
    title: 'Opening link · PoE Tools',
    loadComponent: () => import('./shared/open-link').then((m) => m.OpenLink),
  },
  { path: '**', redirectTo: 'defense' },
];
