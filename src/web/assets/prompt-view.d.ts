// Types for the prompt anatomy stage helpers, so the server and tests written in TypeScript can check them.

export type Orientation = "wide" | "tall";
export type Outward = "up" | "down" | "left" | "right";

export interface Spot {
  x: number;
  y: number;
  /** The side away from the zigzag, where linked records go. */
  out: Outward;
}

export interface SatelliteSpot {
  x: number;
  y: number;
  /** The line from the block's edge to the satellite's edge. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LabelSpot {
  x: number;
  /** The block's name. */
  y: number;
  /** Its size, on the next line. */
  y2: number;
  anchor: "start" | "middle" | "end";
}

export interface Segment {
  x: number;
  width: number;
}

export interface BlockNumbers {
  tokens: number;
  passed: number;
  records: number;
}

export interface Totals {
  step: number;
  tokens: number;
  passed: number;
  records: number;
}

export interface Frame extends Totals {
  done: boolean;
}

export declare const STAGES: Readonly<
  Record<Orientation, Readonly<{ width: number; height: number }>>
>;
export declare const NODE_R: number;
export declare const SATELLITE_R: number;
export declare const SATELLITE_ORBIT: number;
export declare const SATELLITE_SPREAD: number;
export declare const MAX_SATELLITES: number;
export declare const TIMING: Readonly<{
  start: number;
  step: number;
  light: number;
}>;

export declare function blockSpots(
  count: number,
  orientation: Orientation,
): Spot[];
export declare function linkPath(
  a: Spot,
  b: Spot,
  orientation: Orientation,
): string;
export declare function satelliteSpots(
  spot: Spot,
  count: number,
): SatelliteSpot[];
export declare function moreSpot(spot: Spot): { x: number; y: number };
export declare function labelSpot(spot: Spot): LabelSpot;
export declare function barSegments(
  values: readonly number[],
  width: number,
  gap: number,
): Segment[];
export declare function stepStart(step: number): number;
export declare function assemblyLength(count: number): number;
export declare function totalsAt(
  blocks: readonly BlockNumbers[],
  step: number,
): Totals;
export declare function frameAt(
  blocks: readonly BlockNumbers[],
  ms: number,
): Frame;
export declare function formatCount(value: number): string;
export declare function stepNumber(step: number): string;
