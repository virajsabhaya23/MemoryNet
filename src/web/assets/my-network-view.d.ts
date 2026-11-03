// Types for the "Your network" helpers, so the server and tests written in TypeScript can check them.

export interface Point {
  x: number;
  y: number;
}

export declare const PLACE_BUDGET: number;
export declare const UNIT_BUDGET: number;
export declare const OPEN_BUDGET: number;
export declare const OPEN_LIMIT: number;

// The canvas map.

export type Theme = "dark" | "light";
export type Access = "direct" | "covered" | "inside";

/** What the page knows about a place, as the server describes it. */
export interface PlaceInfo {
  title: string;
  name?: string;
  suffix?: string;
  level: "organization" | "business_unit" | "project";
  access: Access;
  total?: number;
  [key: string]: unknown;
}

export interface ItemInfo {
  id: string;
  kind: string;
  family: string;
  label: string;
  owned: boolean;
  [key: string]: unknown;
}

export interface PlaceContents {
  items: readonly ItemInfo[];
  children?: ReadonlyArray<{ id: string }>;
  links?: ReadonlyArray<{ from: string; to: string; relation: string }>;
  more: number;
}

export interface MapNode {
  id: string;
  group: string | null;
  hub: boolean;
  kind: string;
  label: string;
  r: number;
  color?: string;
  fixed?: boolean;
  depth?: number;
  weight?: number;
  family?: string;
  badge?: string | null;
  place?: PlaceInfo;
  item?: ItemInfo;
  [key: string]: unknown;
}

export interface MapLink {
  id: string;
  source: string;
  target: string;
  structure?: boolean;
  hidden?: boolean;
  access?: boolean;
  color?: string;
  relation?: string;
  distance?: number;
  strength?: number;
}

export interface MapGraph {
  nodes: MapNode[];
  links: MapLink[];
  parentOf: Map<string, string>;
}

export declare const YOU: string;
export declare const ACCENT: Readonly<Record<Theme, string>>;
export declare const PALETTE: Readonly<Record<Theme, Readonly<Record<string, string>>>>;
export declare const YOU_RADIUS: number;
export declare const HUB_RADIUS: Readonly<Record<string, number>>;
export declare const NODE_RADIUS: Readonly<Record<string, number>>;
export declare const GLYPHS: Readonly<Record<string, unknown>>;

export declare function mixHex(hex: string, other: string, t: number): string;
export declare function colorOf(node: MapNode, theme: Theme): string;
export declare function projectsOf(
  unitId: string,
  kids: Readonly<Record<string, readonly string[]>>,
  opened: ReadonlyMap<string, PlaceContents>,
): string[];
export declare function buildGraph(input: {
  org: string;
  tops: readonly string[];
  kids: Readonly<Record<string, readonly string[]>>;
  places: ReadonlyMap<string, PlaceInfo>;
  opened: ReadonlyMap<string, PlaceContents>;
  listedCount?: number;
  theme?: Theme;
}): MapGraph;
export declare function firstPositions(
  nodes: readonly MapNode[],
  org: string,
): Map<string, Point>;
export declare function chainOf(
  parentOf: ReadonlyMap<string, string>,
  id: string,
): string[];
export declare function focusOf(
  graph: MapGraph,
  id: string,
): { near: Set<string>; edges: Set<string> };
export declare function closeForRoom(
  order: readonly string[],
  keep: ReadonlySet<string>,
  limit: number,
): string[];
