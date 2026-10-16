import assert from "node:assert/strict";
import { project, rubberband, springStep, velocityTracker } from "../../../docs/motion.js";

function settle(damping: number, response = 0.4) {
  let s = { x: 0, v: 0 }, max = 0, t = 0;
  for (; t < 3; t += 1 / 240) {
    s = springStep(s, 100, { damping, response }, 1 / 240);
    max = Math.max(max, s.x);
  }
  return { x: s.x, max };
}

Deno.test("critically damped spring settles without overshoot", () => {
  const { x, max } = settle(1);
  assert.ok(Math.abs(x - 100) < 0.01);
  assert.ok(max <= 100.001, `overshot to ${max}`);
});

Deno.test("under-damped spring (0.8) overshoots a little, then settles", () => {
  const { x, max } = settle(0.8);
  assert.ok(Math.abs(x - 100) < 0.01);
  assert.ok(max > 100 && max < 105, `max ${max}`);
});

Deno.test("smaller response reaches the target sooner", () => {
  const at = (response: number) => {
    let s = { x: 0, v: 0 };
    for (let i = 0; i < 48; i++) s = springStep(s, 100, { damping: 1, response }, 1 / 240); // 0.2s
    return s.x;
  };
  assert.ok(at(0.3) > at(0.6));
});

Deno.test("momentum projection matches Apple's formula", () => {
  assert.ok(Math.abs(project(1000) - 499) < 0.01);
  assert.equal(project(0), 0);
  assert.ok(project(-500) < 0);
});

Deno.test("rubber-banding resists progressively and never exceeds the pull", () => {
  const a = rubberband(100, 800), b = rubberband(400, 800);
  assert.ok(a < 100 && b < 400);
  assert.ok(b - a < 300 && b > a);
});

Deno.test("velocity tracker uses recent samples (px/s)", () => {
  const t = velocityTracker();
  t.add(0, 0); t.add(10, 400); t.add(20, 450); t.add(40, 500); // old sample at 0ms dropped
  assert.equal(Math.round(t.velocity()), 300);
});
