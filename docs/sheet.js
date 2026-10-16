// iOS-style bottom sheet: springs in, follows the finger 1:1, rubber-bands
// upward, and is dismissed by projecting the release velocity.
import { animateSpring, project, rubberband, velocityTracker } from "./motion.js";

export function createSheet({ sheet, scrim, handle, onClosed }) {
  let y = 0;          // current translateY (0 = fully open)
  let height = 0;     // closed position
  let anim = null;
  let open = false;

  const set = (value) => {
    y = value;
    sheet.style.transform = `translate3d(0, ${value}px, 0)`;
    scrim.style.opacity = String(Math.min(1, Math.max(0, 1 - value / height)));
  };

  const springTo = (target, velocity, params) => {
    anim?.stop();
    anim = animateSpring({
      from: y, to: target, velocity, ...params,
      onUpdate: set,
      onDone: () => {
        anim = null;
        if (!open) {
          sheet.hidden = scrim.hidden = true;
          document.body.classList.remove("sheet-open");
          onClosed?.();
        }
      },
    });
  };

  // Keep the sheet above the iOS keyboard.
  const vv = globalThis.visualViewport;
  const fitKeyboard = () => {
    const inset = vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0;
    sheet.style.bottom = `${inset}px`;
  };
  vv?.addEventListener("resize", fitKeyboard);
  vv?.addEventListener("scroll", fitKeyboard);

  function show() {
    open = true;
    sheet.hidden = scrim.hidden = false;
    document.body.classList.add("sheet-open");
    fitKeyboard();
    height = sheet.offsetHeight + 24;
    if (!anim) set(height);
    springTo(0, 0, { damping: 1, response: 0.35 });
  }

  function hide(velocity = 0) {
    if (!open) return;
    open = false;
    springTo(height, Math.max(velocity, 0), { damping: 1, response: 0.3 });
  }

  // Drag: grabber + header (buttons excluded so taps still work).
  let dragging = false, startPointer = 0, startY = 0, tracker = null;
  handle.addEventListener("pointerdown", (e) => {
    if (sheet.hidden || e.target.closest("button")) return;
    anim?.stop(); // interrupt: continue from the on-screen value
    anim = null;
    open = true;
    dragging = true;
    startPointer = e.clientY;
    startY = y;
    tracker = velocityTracker();
    tracker.add(e.clientY, e.timeStamp);
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    tracker.add(e.clientY, e.timeStamp);
    const raw = startY + (e.clientY - startPointer);
    set(raw < 0 ? -rubberband(-raw, height) : raw);
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    const velocity = tracker.velocity();
    if (y + project(velocity) > height * 0.4) hide(velocity);
    else springTo(0, velocity, { damping: 0.8, response: 0.3 }); // flick back: a little bounce
  };
  handle.addEventListener("pointerup", release);
  handle.addEventListener("pointercancel", release);
  scrim.addEventListener("click", () => hide());
  addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });

  return { show, hide, get isOpen() { return open; } };
}
