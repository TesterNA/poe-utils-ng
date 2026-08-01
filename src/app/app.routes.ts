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
    path: 'trade',
    title: 'Bulk Trade Calc · PoE Tools',
    loadComponent: () => import('./tools/trade/trade').then((m) => m.Trade),
  },
  {
    path: 'atlas',
    title: 'Atlas Selector · PoE Tools',
    loadComponent: () => import('./tools/atlas/atlas').then((m) => m.Atlas),
  },
  { path: '**', redirectTo: 'defense' },
];
