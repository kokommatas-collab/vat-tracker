// Spring + gesture helpers, after Apple's "Designing Fluid Interfaces" (WWDC 2018).
// Springs use Apple's designer parameters: damping ratio (1 = no overshoot) and
// response (seconds to reach the target; not a duration).

/** One semi-implicit Euler step of a unit-mass spring. */
export function springStep(state, target, { damping = 1, response = 0.4 }, dt) {
  const stiffness = (2 * Math.PI / response) ** 2;
  const friction = (4 * Math.PI * damping) / response;
  const accel = -stiffness * (state.x - target) - friction * state.v;
  const v = state.v + accel * dt;
  return { x: state.x + v * dt, v };
}

/** Where a flick would come to rest (Apple's projection, scroll-like deceleration). */
export function project(velocity, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Progressive resistance past a boundary instead of a hard stop. */
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Release velocity (px/s) from the last ~100ms of pointer samples. */
export function velocityTracker(windowMs = 100) {
  const samples = [];
  return {
    add(y, t) {
      samples.push({ y, t });
      while (samples.length > 2 && t - samples[0].t > windowMs) samples.shift();
    },
    velocity() {
      if (samples.length < 2) return 0;
      const a = samples[0], b = samples[samples.length - 1];
      return b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0;
    },
  };
}

export const prefersReducedMotion = () =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Interruptible spring animation. Starts from the live value and carries the
 * given velocity, so a gesture can grab it mid-flight and hand velocity back.
 */
export function animateSpring({ from, to, velocity = 0, damping = 1, response = 0.4, onUpdate, onDone }) {
  let state = { x: from, v: velocity };
  let raf = 0;
  if (prefersReducedMotion()) {
    onUpdate(to);
    onDone?.();
    return { stop() {}, get value() { return to; } };
  }
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const steps = Math.max(1, Math.ceil(dt * 240));
    for (let i = 0; i < steps; i++) state = springStep(state, to, { damping, response }, dt / steps);
    if (Math.abs(state.x - to) < 0.5 && Math.abs(state.v) < 10) {
      state = { x: to, v: 0 };
      onUpdate(to);
      onDone?.();
      return;
    }
    onUpdate(state.x);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return { stop() { cancelAnimationFrame(raf); }, get value() { return state.x; } };
}
