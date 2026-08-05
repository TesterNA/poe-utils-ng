/**
 * Every atlas tree dataset the tool knows about.
 *
 * The `id` is baked into share codes, so it is a permanent contract: never
 * renumber an entry and never point an existing id at different data. When GGG
 * ships a new tree, drop its export into a new folder under public/assets/atlas
 * named after the league and add an entry here — old codes keep resolving to the
 * tree they were made against, and the version selector appears by itself once
 * there is more than one entry.
 */
export interface AtlasTreeVersion {
  id: number;
  label: string;
  /**
   * Folder under public/assets/atlas/ holding this tree's data *and* its sprite
   * sheets. Icons and sheet layouts change between leagues, so the whole set has
   * to move together — versioning the folder rather than the json is what keeps
   * an old tree renderable.
   */
  dir: string;
}

export const TREE_VERSIONS: readonly AtlasTreeVersion[] = [
  { id: 1, label: '3.29', dir: '3.29' },
];

/** Newest known tree — what a fresh session and a code-less link get. */
export const DEFAULT_TREE_VERSION = TREE_VERSIONS[TREE_VERSIONS.length - 1].id;

export function findTreeVersion(id: number): AtlasTreeVersion | null {
  return TREE_VERSIONS.find((v) => v.id === id) ?? null;
}
