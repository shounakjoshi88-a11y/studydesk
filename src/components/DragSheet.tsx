/**
 * DragSheet — the app's one bottom-sheet shell.
 *
 * Two sheets need the same thing: a scrim that fades as the panel leaves, a
 * grabber, and a downward drag that either springs back or dismisses. The
 * first version of this lived inside the Juno sign-in sheet, and the second
 * caller nearly copied it. Copying gesture code is how the two sheets end up
 * disagreeing about the dismiss threshold six weeks apart, so it lives here
 * once and both use it.
 *
 * Deliberately hand-rolled on a motion value rather than motion's `drag`
 * prop: `drag` fights `overflow-y: auto` and insists on owning the gesture,
 * and it also hides the scrim fade unless you bind it yourself anyway.
 *
 * The entrance animates the same motion value the drag drives. An earlier
 * attempt had the entrance as a CSS keyframe on the panel and the drag as a
 * framer transform — and a CSS animation with fill-mode `both` outranks an
 * inline style in the cascade, so the keyframe pinned `transform: none`
 * forever and every drag was silently discarded. One property, one owner.
 */

import { useCallback, useEffect, useRef } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "framer-motion";

const IDLE = { x0: 0, y0: 0, base: 0, t: 0, y: 0, locked: false, dead: false };

export function DragSheet({
  onClose,
  label,
  /** Extra classes for the panel — max-height, padding overrides. */
  panelClassName = "",
  /** Whether a downward drag may dismiss. Off while a request is in flight. */
  dismissable = true,
  children,
}: {
  onClose: () => void;
  label: string;
  panelClassName?: string;
  dismissable?: boolean;
  children: React.ReactNode;
}) {
  const y = useMotionValue(18);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ ...IDLE });
  // The scrim rides the same value, so the dim behind the panel thins out
  // exactly as fast as the panel leaves. It starts at a full 1: the alpha
  // lives in the CSS background, and scaling it down here as well left the
  // page behind barely dimmed and drained the card's contrast.
  const scrimOpacity = useTransform(y, (v: number) => Math.max(0, 1 - Math.max(0, v) / 300));
  const reduce = useReducedMotion();

  const height = () => panelRef.current?.offsetHeight ?? 420;

  useEffect(() => {
    if (reduce) {
      y.set(0);
      return;
    }
    const controls = animate(y, 0, { duration: 0.26, ease: [0.16, 1, 0.3, 1] });
    return () => controls.stop();
  }, [reduce, y]);

  /** Slide out, then let the parent unmount us. */
  const dismiss = useCallback(() => {
    // Overshoot the height so the panel clears the bottom edge instead of
    // parking exactly on it.
    animate(y, height() + 48, { duration: 0.24, ease: [0.4, 0, 1, 1] }).then(onClose);
  }, [onClose, y]);

  const onTouchStart = (e: React.TouchEvent) => {
    if (!dismissable) return;
    const t = e.touches[0]!;
    drag.current = {
      x0: t.clientX, y0: t.clientY, base: y.get(),
      t: performance.now(), y: t.clientY, locked: false, dead: false,
    };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const d = drag.current;
    const t = e.touches[0]!;
    const dx = t.clientX - d.x0;
    const dy = t.clientY - d.y0;
    // Lock to the vertical axis once. Without the lock a diagonal drag
    // jitters between two axes; without the direction check a sideways
    // swipe gets eaten by the drawer logic underneath.
    if (!d.locked) {
      if (Math.abs(dy) < 8) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        d.dead = true;
        return;
      }
      d.locked = true;
    }
    if (d.dead) return;
    d.y = t.clientY;
    d.t = performance.now();
    // Upward drag is resisted rather than blocked, so the panel still feels
    // attached to the finger at the end of its travel.
    y.set(dy < 0 ? d.base + dy * 0.2 : d.base + dy);
  };
  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = { ...IDLE };
    if (!d.locked || d.dead) return;
    const dt = performance.now() - d.t;
    const v = dt > 0 ? (d.y - d.y0) / dt : 0;
    // Distance OR speed, not distance alone. A short fast flick is how
    // everybody actually throws a sheet away, and a long slow drag is how
    // somebody checks what is behind it before letting go. Either one
    // dismissing is what makes the gesture feel like it obeys the finger.
    if (y.get() > height() * 0.3 || v > 0.5) dismiss();
    else animate(y, 0, { type: "spring", stiffness: 620, damping: 46, mass: 0.9 });
  };

  // Escape, and the body stops scrolling behind.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) dismiss();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [dismiss, dismissable]);

  return (
    <motion.div
      className="sd-sheet-scrim"
      style={{ opacity: scrimOpacity }}
      onClick={dismissable ? dismiss : undefined}
    >
      <motion.div
        ref={panelRef}
        style={{ y }}
        className={`sd-sheet ${panelClassName}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="sd-sheet-grab" />
        {children}
      </motion.div>
    </motion.div>
  );
}
