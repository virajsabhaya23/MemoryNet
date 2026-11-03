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
}): Simulation;
export function growSimulation(
  previous: Simulation | null,
  next: { nodes: readonly EngineNode[]; links: readonly EngineLink[] },
  options?: {
    alpha?: number;
    positions?: ReadonlyMap<string, { x: number; y: number }>;
  },
): Simulation;
export function pickLabels<T extends LabelBox>(
  candidates: readonly T[],
  options?: { width: number; height: number; limit?: number; gap?: number },
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
  position(id: string): { x: number; y: number; r: number } | null;
  readonly settled: boolean;
  [key: string]: unknown;
}
export function createGraphView(canvas: unknown, options?: unknown): GraphView;
export interface DepthPose { cx: number; cy: number; yaw: number; pitch: number; focal: number; }
export function projectDepth(x: number, y: number, z: number, pose: DepthPose): { x: number; y: number; z: number; scale: number };
export function unprojectDepth(x: number, y: number, z: number, pose: DepthPose): { x: number; y: number };
