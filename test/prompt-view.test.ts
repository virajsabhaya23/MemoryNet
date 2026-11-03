import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assemblyLength,
  barSegments,
  blockSpots,
  formatCount,
  frameAt,
  labelSpot,
  linkPath,
  MAX_SATELLITES,
  moreSpot,
  NODE_R,
  SATELLITE_R,
  satelliteSpots,
  STAGES,
  stepNumber,
  stepStart,
  TIMING,
  totalsAt,
  type Orientation,
} from "../src/web/assets/prompt-view.js";

const BLOCKS = [
  { tokens: 100, passed: 3, records: 1 },
  { tokens: 211, passed: 1, records: 2 },
  { tokens: 177, passed: 2, records: 2 },
  { tokens: 218, passed: 3, records: 2 },
  { tokens: 91, passed: 0, records: 0 },
  { tokens: 99, passed: 1, records: 1 },
  { tokens: 25, passed: 1, records: 0 },
];
const ORIENTATIONS: Orientation[] = ["wide", "tall"];

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

test("the stylesheet lights each block at the time the script counts it", () => {
  const css = readFileSync(
    new URL("../src/web/assets/style.css", import.meta.url),
    "utf8",
  );
  for (let step = 1; step <= 7; step += 1) {
    const rule = new RegExp(
      `\\.pa-stage \\[data-at="${step}"\\] \\{\\s*--pa-at: (\\d+)ms;`,
    ).exec(css);
    assert.equal(Number(rule?.[1]), stepStart(step), `block ${step}`);
  }
  assert.equal(
    Number(/--pa-end: (\d+)ms;/.exec(css)?.[1]),
    assemblyLength(7),
    "the clock runs for the whole assembly",
  );
  assert.match(
    css,
    new RegExp(
      `\\.pa-auto \\.pa-node \\{\\s*animation: pa-node-in ${TIMING.light}ms`,
    ),
  );
});

test("the totals climb while blocks light up and end at the full totals", () => {
  assert.deepEqual(frameAt(BLOCKS, 0), {
    step: 0,
    tokens: 0,
    passed: 0,
    records: 0,
    done: false,
  });
  let previous = frameAt(BLOCKS, 0);
  const seen = new Set<number>();
  for (let ms = 0; ms <= assemblyLength(BLOCKS.length) + 100; ms += 10) {
    const frame = frameAt(BLOCKS, ms);
    for (const key of ["step", "tokens", "passed", "records"] as const) {
      assert.ok(
        frame[key] >= previous[key],
        `${key} never goes down (${ms}ms)`,
      );
    }
    seen.add(frame.step);
    previous = frame;
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(frameAt(BLOCKS, assemblyLength(BLOCKS.length)), {
    ...totalsAt(BLOCKS, BLOCKS.length),
    done: true,
  });
  const halfway = frameAt(BLOCKS, stepStart(3) + TIMING.light / 2);
  assert.equal(halfway.step, 3);
  assert.equal(
    halfway.passed,
    3 + 1 + 2,
    "checks count once a block is half lit",
  );
  assert.equal(frameAt([], 0).done, true);
});

test("totals by hand add whole blocks and stay within the blocks there are", () => {
  assert.deepEqual(totalsAt(BLOCKS, 2), {
    step: 2,
    tokens: 311,
    passed: 4,
    records: 3,
  });
  assert.deepEqual(totalsAt(BLOCKS, -1), {
    step: 0,
    tokens: 0,
    passed: 0,
    records: 0,
  });
  assert.equal(totalsAt(BLOCKS, 99).step, 7);
  assert.equal(totalsAt(BLOCKS, 99).tokens, 921);
});

test("blocks, their records, and their names fit the stage without touching", () => {
  for (const orientation of ORIENTATIONS) {
    const { width, height } = STAGES[orientation];
    const spots = blockSpots(7, orientation);
    assert.equal(spots.length, 7);
    const circles: Array<{ x: number; y: number; r: number; owner: number }> =
      [];
    spots.forEach((spot, index) => {
      circles.push({ ...spot, r: NODE_R, owner: index });
      for (const satellite of satelliteSpots(spot, MAX_SATELLITES + 3)) {
        circles.push({ ...satellite, r: SATELLITE_R, owner: index });
      }
    });
    assert.equal(
      circles.length,
      7 * (1 + MAX_SATELLITES),
      "at most six records are drawn around a block",
    );
    for (const circle of circles) {
      assert.ok(
        circle.x - circle.r >= 0 &&
          circle.x + circle.r <= width &&
          circle.y - circle.r >= 0 &&
          circle.y + circle.r <= height,
        `${orientation}: inside the stage at ${circle.x},${circle.y}`,
      );
    }
    for (let i = 0; i < circles.length; i += 1) {
      for (let j = i + 1; j < circles.length; j += 1) {
        const a = circles[i];
        const b = circles[j];
        if (!a || !b) continue;
        assert.ok(
          distance(a, b) >= a.r + b.r + 4,
          `${orientation}: ${a.x},${a.y} and ${b.x},${b.y} stay apart`,
        );
      }
    }
    for (const spot of spots) {
      const label = labelSpot(spot);
      const box = {
        left:
          label.anchor === "start"
            ? label.x
            : label.anchor === "end"
              ? label.x - 110
              : label.x - 55,
        right:
          label.anchor === "start"
            ? label.x + 110
            : label.anchor === "end"
              ? label.x
              : label.x + 55,
        top: label.y - 13,
        bottom: label.y2 + 4,
      };
      for (const circle of circles) {
        const nearestX = Math.max(box.left, Math.min(circle.x, box.right));
        const nearestY = Math.max(box.top, Math.min(circle.y, box.bottom));
        assert.ok(
          distance(circle, { x: nearestX, y: nearestY }) > circle.r,
          `${orientation}: the name at ${label.x},${label.y} clears ${circle.x},${circle.y}`,
        );
      }
      const more = moreSpot(spot);
      assert.ok(more.y > 0 && more.y < height && more.x > 0 && more.x < width);
    }
  }
});

test("each line runs from the edge of one block to the edge of the next", () => {
  for (const orientation of ORIENTATIONS) {
    const spots = blockSpots(7, orientation);
    for (let index = 1; index < spots.length; index += 1) {
      const a = spots[index - 1];
      const b = spots[index];
      if (!a || !b) continue;
      const numbers = linkPath(a, b, orientation)
        .match(/-?\d+(\.\d+)?/g)
        ?.map(Number);
      assert.equal(numbers?.length, 8, "one cubic curve");
      const [x1 = 0, y1 = 0] = numbers ?? [];
      const [x2 = 0, y2 = 0] = (numbers ?? []).slice(-2);
      assert.equal(Math.round(distance(a, { x: x1, y: y1 })), NODE_R);
      assert.equal(Math.round(distance(b, { x: x2, y: y2 })), NODE_R);
    }
  }
  const spot = blockSpots(7, "wide")[1];
  assert.ok(spot);
  for (const satellite of satelliteSpots(spot, 3)) {
    assert.equal(
      Math.round(distance(spot, { x: satellite.x1, y: satellite.y1 })),
      NODE_R + 4,
    );
    assert.ok(
      distance(satellite, { x: satellite.x2, y: satellite.y2 }) > SATELLITE_R,
      "the line stops short of the record",
    );
  }
  assert.deepEqual(satelliteSpots(spot, 0), []);
});

test("the token bar gives each block its share, with gaps, in order", () => {
  const segments = barSegments([300, 0, 100], 1000, 4);
  assert.deepEqual(segments, [
    { x: 0, width: 747 },
    { x: 751, width: 0 },
    { x: 751, width: 249 },
  ]);
  const last = segments.at(-1);
  assert.equal((last?.x ?? 0) + (last?.width ?? 0), 1000);
  assert.deepEqual(barSegments([0, 0], 1000, 4), [
    { x: 0, width: 0 },
    { x: 0, width: 0 },
  ]);
});

test("numbers read the same everywhere", () => {
  assert.equal(formatCount(1234.4), "1,234");
  assert.equal(formatCount(0), "0");
  assert.equal(stepNumber(3), "03");
  assert.equal(stepNumber(12), "12");
});
