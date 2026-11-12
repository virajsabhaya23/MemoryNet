// Types for the browser view helpers, so tests written in TypeScript can check them.

export type Mode = "network" | "timeline" | "trace" | "table";
export type Shade = "none" | "items" | "pending" | "incidents" | "recent";
export type NodeState =
  | "current"
  | "retired"
  | "pending"
  | "warning"
  | "flagged";

export interface GroupLike {
  id: string;
  parentId: string | null;
  pendingNewDefinitions?: number | null;
}

export interface NodeLike {
  id: string;
  kind: string;
  clusterId: string;
  label?: string;
  status?: string | null;
  details?: any;
}

export interface EdgeLike {
  id: string;
  relation: string;
  from: string;
  to: string;
}

export interface TimelineEvent {
  id: string;
  at: string;
  what: "approved" | "retired" | "captured";
  version: number | null;
  by: string | null;
}

export interface GroupMeasure {
  items: number;
  pending: number;
  incidents: number;
  recent: number;
  kinds: Record<string, number>;
}

export interface ViewState {
  mode: Mode;
  node: string | null;
  focus: string | null;
  isolate: boolean;
  depth: number;
  impact: boolean;
  hideKinds: string[];
  hideRelations: string[];
  retired: boolean;
  /** People and agent accounts are drawn only when asked for; owners show as initials otherwise. */
  people: boolean;
  pins: string[];
  camera: { x: number; y: number; k: number } | null;
  from: string | null;
  to: string | null;
}

export interface SavedView {
  name: string;
  query: string;
  savedAt: string | null;
}

export interface SearchItem {
  id: string;
  label: string;
  keywords?: string;
  rank?: number;
  [extra: string]: unknown;
}

export const MODES: readonly Mode[];
export const DEPTHS: readonly number[];
export const MIN_ZOOM: number;
export const MAX_ZOOM: number;
export const MAX_PINS: number;
export const MAX_SAVED_VIEWS: number;
export const RELIES_ON: readonly string[];
export const SECURITY_FLAGS: readonly string[];
export const SHADES: readonly Shade[];
export function groupAndInside(
  clusters: readonly GroupLike[],
  id: string,
): Set<string>;
export function groupPath<T extends GroupLike>(
  groupById: ReadonlyMap<string, T>,
  id: string,
): T[];
export function sectorPath(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
): string;
export function brainRegistry(
  nodes: readonly NodeLike[],
  clusters: readonly GroupLike[],
): ReturnType<typeof attentionItems> & {
  tiers: Record<
    "procedural" | "semantic" | "episodic" | "people",
    { count: number; ids: string[] }
  >;
  ready: { count: number; ids: string[] };
};
export function reach(
  edges: readonly EdgeLike[],
  start: string,
  direction: "in" | "out",
  maxDepth?: number,
  relations?: readonly string[],
): Map<string, number>;
export function provenancePaths(
  edges: readonly EdgeLike[],
  start: string,
  limit?: number,
): string[][];
export function nearestInDirection(
  from: { x: number; y: number },
  candidates: ReadonlyArray<{ id: string; x: number; y: number }>,
  direction: "left" | "right" | "up" | "down",
): string | null;
export function nodeStates(node: NodeLike): NodeState[];
export function timelineEvents(nodes: readonly NodeLike[]): TimelineEvent[];
export function inDayRange(
  event: TimelineEvent,
  from: string | null,
  to: string | null,
): boolean;
export function eventsByDay(
  events: readonly TimelineEvent[],
): Array<{ day: string; events: TimelineEvent[] }>;
export function groupMeasures(
  clusters: readonly GroupLike[],
  nodes: readonly NodeLike[],
  now: string,
  recentDays?: number,
): Map<string, GroupMeasure>;
export function shadeLevels(
  measures: ReadonlyMap<string, GroupMeasure>,
  shade: string,
): Map<string, number>;
export function attentionItems(
  nodes: readonly NodeLike[],
  clusters: readonly GroupLike[],
): {
  pending: { count: number; ids: string[]; newDefinitions: number };
  warnings: { count: number; ids: string[] };
  flagged: { count: number; ids: string[] };
  retired: { count: number; ids: string[] };
};
export function networkChanges(
  previous: {
    clusters: readonly GroupLike[];
    nodes: readonly NodeLike[];
    edges: readonly EdgeLike[];
  },
  next: {
    clusters: readonly GroupLike[];
    nodes: readonly NodeLike[];
    edges: readonly EdgeLike[];
  },
): { added: string[]; removed: string[]; changed: string[] };
export function searchItems<T extends SearchItem>(
  query: string,
  items: readonly T[],
  limit?: number,
): T[];
export function encodeViewState(state: Partial<ViewState>): string;
export function decodeViewState(
  search: string,
  known: {
    nodes: ReadonlySet<string>;
    clusters: ReadonlySet<string>;
    kinds: ReadonlySet<string>;
    relations: ReadonlySet<string>;
  },
): ViewState;
export function parseSavedViews(text: string | null): SavedView[];
export function withSavedView(
  views: readonly SavedView[],
  name: string,
  query: string,
  savedAt: string | null,
): SavedView[];
