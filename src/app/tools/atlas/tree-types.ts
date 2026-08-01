export interface RawNode {
  skill?: number;
  name?: string;
  icon?: string;
  stats?: string[];
  reminderText?: string[];
  flavourText?: string[];
  isNotable?: boolean;
  isKeystone?: boolean;
  isMastery?: boolean;
  isWormhole?: boolean;
  group?: number;
  orbit?: number;
  orbitIndex?: number;
  in?: string[];
  out?: string[];
}

export interface RawGroup {
  x: number;
  y: number;
  orbits: number[];
  nodes: string[];
  background?: { image: string; offsetX?: number; offsetY?: number; isHalfImage?: boolean };
}

export interface SpriteCoord {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpriteSheet {
  filename: string;
  w: number;
  h: number;
  coords: Record<string, SpriteCoord>;
}

export interface RawTree {
  tree: string;
  groups: Record<string, RawGroup>;
  nodes: Record<string, RawNode>;
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
  constants: {
    skillsPerOrbit: number[];
    orbitRadii: number[];
    PSSCentreInnerRadius: number;
  };
  sprites: Record<string, Record<string, SpriteSheet>>;
  imageZoomLevels: number[];
  points: { totalPoints: number; ascendancyPoints: number };
}

export type NodeKind = 'normal' | 'notable' | 'keystone' | 'wormhole' | 'mastery' | 'root';

/** A node prepared for rendering + graph work. `idx` is the graph index. */
export interface TreeNode {
  idx: number;
  id: string;
  name: string;
  icon: string;
  stats: string[];
  reminder: string[];
  flavour: string[];
  kind: NodeKind;
  /** mastery nodes are decoration only — not allocatable, not in the graph */
  allocatable: boolean;
  group: number;
  orbit: number;
  orbitIndex: number;
  x: number;
  y: number;
  /** hit-test / draw radius in tree units */
  radius: number;
  searchText: string;
}

export interface Edge {
  a: number;
  b: number;
  /** same group + same orbit => rendered as an arc along the orbit */
  arc: boolean;
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
  anticlockwise: boolean;
}

export interface GroupInfo {
  id: number;
  x: number;
  y: number;
  background?: { image: string; offsetX?: number; offsetY?: number };
}

export interface Tree {
  raw: RawTree;
  nodes: TreeNode[];
  byId: Map<string, TreeNode>;
  edges: Edge[];
  /** CSR adjacency over node indices (mastery nodes have no neighbours) */
  offsets: Int32Array;
  adjacency: Int32Array;
  rootIdx: number;
  groups: GroupInfo[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  totalPoints: number;
}
