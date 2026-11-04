// Types for the pure graph-tier helpers, so tests written in TypeScript can check them.

export type GraphTier = "far" | "mid" | "near";
export type KindShape =
  | "circle" | "diamond" | "triangle" | "square"
  | "hexagon" | "pentagon" | "ring" | "double-ring";

export const TIER_ZOOM_MID: 0.45;
export const TIER_ZOOM_NEAR: 1.1;
export const MAX_CARDS: 60;

export function tierForZoom(k: number): GraphTier;
export function kindShape(kind: string): KindShape;

export interface TierItem {
  id: string;
  hub?: boolean;
  inViewport?: boolean;
  priority?: number;
  selected?: boolean;
  hovered?: boolean;
  pinned?: boolean;
}
export function assignTiers(items: readonly TierItem[], k: number): Map<string, GraphTier>;

export function wrapTitle(text: string, maxChars?: number, maxLines?: number): string[];

export interface CardNodeLike {
  kind: string;
  status?: string | null;
  details?: any;
}
export function cardMeta(node: CardNodeLike, citedBy: number, nowIso: string): string;

export function convexHull(
  points: readonly { x: number; y: number }[],
): { x: number; y: number }[];
