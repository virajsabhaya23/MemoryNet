import { test } from "node:test";
import assert from "node:assert/strict";
import { projectDepth, unprojectDepth } from "../src/web/assets/graph-engine.js";

test("perspective preserves the focal plane and scales distant nodes down", () => {
  const pose = { cx: 20, cy: -10, yaw: 0, pitch: 0, focal: 1100 };
  assert.deepEqual(projectDepth(120, 90, 0, pose), {x:120,y:90,z:0,scale:1});
  assert.ok(projectDepth(120, 90, 100, pose).scale < 1);
  assert.ok(projectDepth(120, 90, -100, pose).scale > 1);
});

test("inverse perspective keeps dragged nodes under the pointer across camera tilts", () => {
  for (const yaw of [-.4, 0, .4]) for (const pitch of [-.3, 0, .3]) {
    const pose = {cx:0,cy:0,yaw,pitch,focal:1100};
    for (const [x,y,z] of [[-300,120,-90],[200,-220,80],[0,0,0]]) {
      const point = projectDepth(x!,y!,z!,pose);
      const back = unprojectDepth(point.x,point.y,z!,pose);
      assert.ok(Math.abs(back.x-x!) < .001);
      assert.ok(Math.abs(back.y-y!) < .001);
    }
  }
});
