// Pull to refresh: content follows the finger with rubber-band resistance,
// holds while refreshing, then springs back.
import { animateSpring, rubberband } from "./motion.js";

const THRESHOLD = 72; // px of (damped) pull that arms the refresh
const HOLD = 56;      // px the content rests at while refreshing

export function pullToRefresh({ content, indicator, onRefresh, enabled = () => true }) {
  let startY = null, y = 0, anim = null, busy = false;

  const set = (value) => {
    y = value;
    content.style.transform = value > 0 ? `translate3d(0, ${value}px, 0)` : "";
    indicator.style.setProperty("--pull", String(Math.min(1, value / THRESHOLD)));
    indicator.classList.toggle("armed", value >= THRESHOLD);
  };
  const springTo = (target) => {
    anim?.stop();
    anim = animateSpring({ from: y, to: target, damping: 1, response: 0.35, onUpdate: set });
  };

  addEventListener("touchstart", (e) => {
    if (busy || !enabled() || scrollY > 0 || e.touches.length > 1) return;
    anim?.stop();
    startY = e.touches[0].clientY;
  }, { passive: true });

  addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) return set(0);
    e.preventDefault();
    set(rubberband(dy, innerHeight));
  }, { passive: false });

  addEventListener("touchend", async () => {
    if (startY === null) return;
    startY = null;
    if (y < THRESHOLD) return springTo(0);
    busy = true;
    indicator.classList.add("spinning");
    springTo(HOLD);
    try { await onRefresh(); } finally {
      busy = false;
      indicator.classList.remove("spinning");
      springTo(0);
    }
  });
}
