/**
 * The single list of tools. The sidebar, the routes and the mobile header all
 * read from here, so adding a tool means adding one entry plus its component.
 */
export interface ToolDef {
  /** URL path segment, also the old site's hash id so links keep working */
  id: string;
  label: string;
  /** inner markup of a 24x24 stroke icon */
  icon: string;
  /** kept out of the sidebar; its route still works if you know the URL */
  hidden?: boolean;
}

export const TOOLS: ToolDef[] = [
  {
    id: 'defense',
    label: 'Defense Calc',
    icon: '<path d="M12 2l8 4v6c0 5-4 9-8 10C8 21 4 17 4 12V6z"/>',
  },
  {
    id: 'exchange',
    label: 'Currency',
    icon: '<path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>',
  },
  {
    id: 'lucky',
    label: 'Lucky Calc',
    icon: '<path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>',
  },
  {
    id: 'chromatic',
    label: 'Chromatic Calc',
    icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
  },
  {
    id: 'exp',
    label: 'EXP Penalty',
    icon: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  },
  {
    id: 'trade',
    label: 'Bulk Trade Calc',
    icon: '<path d="M3 3h18v4H3zM3 10h18v4H3zM3 17h18v4H3z"/>',
    hidden: true,
  },
  {
    id: 'kingsmarch',
    label: 'Kingsmarch Ship',
    icon: '<path d="M12 3v9M8 6h8M3 13l9 3 9-3"/><path d="M5 13v3a7 7 0 0 0 14 0v-3"/>',
  },
  {
    id: 'atlas',
    label: 'Atlas Selector',
    icon: '<circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="9"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
  },
  {
    id: 'strategy',
    label: 'Map Strategy',
    icon: '<path d="M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2z"/><path d="M9 4v14M15 6v14"/>',
  },
  {
    // still a beta, and not certain to be finished: kept off the sidebar until
    // it is, though /codex still opens and the two "keep in the Codex" buttons
    // in Atlas and Strategy still write to it
    id: 'codex',
    label: 'Codex',
    icon: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M8 3v14"/><path d="M11.5 7.5h4M11.5 11h4"/>',
    hidden: true,
  },
  {
    id: 'minesweeper',
    label: 'Minesweeper',
    icon: '<circle cx="12" cy="12" r="5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>',
  },
];
