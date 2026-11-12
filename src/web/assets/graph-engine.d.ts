export interface EngineNode {
  id: string;
  group: string | null;
  hub?: boolean;
  r?: number;
  /** Holds its starting position, as if pinned. */
  fixed?: boolean;
}

export interface EngineLink {
  source: string;
  target: string;
  distance?: number;
  strength?: number;
}

export interface Simulation {
  alpha: number;
  count: number;
  /** How hard overlapping cells push apart (only with `cells`), and the space kept between them. */
  cellPush: number;
  cellGap: number;
  index: Map<string, number>;
  xs: Float64Array;
  ys: Float64Array;
  pinned: Uint8Array;
  tick(times?: number): number;
  running(): boolean;
  reheat(to?: number): void;
  settle(budget?: number): number;
  position(id: string): { x: number; y: number; r: number } | null;
  pin(id: string, x: number, y: number): void;
  release(id: string): void;
  setActive(ids: Set<string>): void;
}

export interface LabelBox {
  id?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  priority: number;
  force?: boolean;
  /** Other spots to try, in order, before the box is dropped. */
  alts?: readonly { x: number; y: number }[];
}

export function hashUnit(text: string): number;
export function seedPositions(
  nodes: readonly EngineNode[],
): Map<string, { x: number; y: number }>;
export function growPositions(
  nodes: readonly EngineNode[],
  previous: ReadonlyMap<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }>;
export function createSimulation(input: {
  nodes: readonly EngineNode[];
  links: readonly EngineLink[];
  positions?: Map<string, { x: number; y: number }>;
  /** Each hub and its own members form a cell, and cells push apart until they clear. */
  cells?: boolean;
}): Simulation;
export function growSimulation(
  previous: Simulation | null,
  next: { nodes: readonly EngineNode[]; links: readonly EngineLink[] },
  options?: {
    alpha?: number;
    positions?: ReadonlyMap<string, { x: number; y: number }>;
    cells?: boolean;
  },
): Simulation;
export function pickLabels<T extends LabelBox>(
  candidates: readonly T[],
  options?: {
    width: number;
    height: number;
    limit?: number;
    gap?: number;
    /** Boxes no name may cover, except the one with the same id. */
    obstacles?: readonly LabelBox[];
  },
): T[];
export function clip(text: string, max?: number): string;
export function mix(hex: string, other: string, t: number): string;
export function withAlpha(hex: string, alpha: number): string;
export interface GraphView {
  setData(
    next: { nodes: readonly EngineNode[]; links: readonly EngineLink[] },
    options?: {
      keepPositions?: boolean;
      alpha?: number;
      positions?: ReadonlyMap<string, { x: number; y: number }>;
    },
  ): void;
  /** On screen the map can float in depth: `z` is how far back, `scale` how much it shrinks. */
  position(
    id: string,
  ): { x: number; y: number; r: number; z?: number; scale?: number } | null;
  /** Rings the given records for a few seconds after a live change; `strong` for new ones. */
  pulse(ids: Iterable<string>, strong?: boolean): void;
  readonly settled: boolean;
  [key: string]: unknown;
}
export function createGraphView(canvas: unknown, options?: unknown): GraphView;
export interface DepthPose {
  cx: number;
  cy: number;
  yaw: number;
  pitch: number;
  focal: number;
}
export function projectDepth(
  x: number,
  y: number,
  z: number,
  pose: DepthPose,
): { x: number; y: number; z: number; scale: number };
export function unprojectDepth(
  x: number,
  y: number,
  z: number,
  pose: DepthPose,
): { x: number; y: number };
export function depthFor(id: string, kind?: string, hub?: boolean): number;
export function signalProgress(
  id: string,
  clock: number,
  period: number,
  travel: number,
): number | null;
export function curveControl(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  bend: number,
): { x: number; y: number };
