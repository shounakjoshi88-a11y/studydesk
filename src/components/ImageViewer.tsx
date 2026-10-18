import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X, ChevronLeft, ChevronRight, Share2, Trash2, ZoomIn } from "lucide-react";
import {
  dayHeading,
  deleteMedia,
  humanSize,
  mediaFullUrl,
  mediaThumbUrl,
  shareMedia,
  whenLabel,
  type MediaItem,
} from "../lib/deviceFiles";

export type ImageViewerProps = {
  items: MediaItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
};

// The largest pinch scale. 5x is what the stock gallery allows before the
// image turns to mush; beyond that the user is inspecting compression, not
// the photo.
const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
// A swipe has to travel this far (or flick fast past the lower bound) before
// it counts as navigation rather than a tap that drifted.
const SWIPE_COMMIT_PX = 72;
const SWIPE_FLICK_PX = 28;
const SWIPE_FLICK_MS = 280;
const TAP_SLOP_PX = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 44;

// mediaFullUrl already does the whole job — it asks the native plugin for the
// path and converts it to something the WebView can stream. The only reason
// there is a wrapper here rather than a direct call is that a missing or
// unreadable file must render as a quiet message instead of a broken-image
// glyph, and that decision belongs to this file, not the bridge.
async function resolveFullUrl(item: MediaItem): Promise<string | null> {
  try {
    return await mediaFullUrl(item);
  } catch {
    return null;
  }
}

async function resolveThumbUrl(item: MediaItem, w = 160): Promise<string | null> {
  try {
    const url = await mediaThumbUrl(item, w);
    if (url) return url;
  } catch {
    /* thumbs are best-effort; the full image is the fallback */
  }
  return resolveFullUrl(item);
}

function timeOfDay(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function metaLine(item: MediaItem): string {
  // One EXIF-style summary line is the single place a middle-dot join earns
  // its keep: these fragments are facets of one fact (this file), not a
  // decorative label row.
  const parts: string[] = [];
  if (item.bucket) parts.push(item.bucket);
  if (item.width && item.height) parts.push(`${item.width} × ${item.height}`);
  if (item.size) parts.push(humanSize(item.size));
  const when = whenLabel(item.lastModified);
  if (when) parts.push(when);
  return parts.join(" · ");
}

export function ImageViewer({ items, index, onClose, onIndexChange }: ImageViewerProps) {
  // The viewer keeps its own copy of the set because deleting a photo must
  // remove the frame immediately — the parent's list is read-only from here
  // and may re-render with the deleted item still in it. Ids removed here are
  // remembered so a later parent sync can never resurrect them.
  const removedIds = useRef<Set<string>>(new Set());
  const [entries, setEntries] = useState<MediaItem[]>(() =>
    items.filter((i) => !removedIds.current.has(i.id)),
  );
  useEffect(() => {
    setEntries(items.filter((i) => !removedIds.current.has(i.id)));
  }, [items]);

  const count = entries.length;
  const clampedIndex = count === 0 ? 0 : Math.min(Math.max(index, 0), count - 1);
  const item = entries[clampedIndex] ?? null;

  const reduceMotion = useReducedMotion();
  const still = reduceMotion === true;
  const fadeMs = still ? 0 : 180;

  const [chrome, setChrome] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [showHint, setShowHint] = useState(true);

  // Resolved full-size urls by item id. `undefined` means still resolving,
  // `null` means it failed — the two states render differently (spinner vs a
  // quiet line), and a failed image never reaches an <img> so the platform
  // broken-glyph can never appear.
  const [fullUrls, setFullUrls] = useState<Record<string, string | null | undefined>>({});
  const [thumbUrls, setThumbUrls] = useState<Record<string, string | null>>({});

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Gesture state lives in refs, applied straight to the slide's style, so a
  // pinch never re-renders React at 60Hz. State only mirrors "are we zoomed"
  // (which gates swipe-vs-pan) on gesture end.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gest = useRef({
    scale: 1,
    tx: 0,
    ty: 0,
    mode: "idle" as "idle" | "touch" | "pinch" | "zoom-toggle",
    startDist: 0,
    startScale: 1,
    startTx: 0,
    startTy: 0,
    startMidX: 0,
    startMidY: 0,
    downX: 0,
    downY: 0,
    downT: 0,
    moved: false,
    swipeDx: 0,
  });
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyTransform = useCallback(() => {
    const el = slideRef.current;
    if (!el) return;
    const { scale, tx, ty } = gest.current;
    el.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
  }, []);

  const setSlideTransition = useCallback(
    (on: boolean) => {
      const el = slideRef.current;
      if (!el) return;
      el.style.transition = on && !still ? "transform 180ms cubic-bezier(0.2, 0.7, 0.2, 1)" : "none";
    },
    [still],
  );

  // Pan is clamped against the STAGE, not the decoded bitmap: with
  // object-contain the bitmap is letterboxed to an unknown box, so the bitmap
  // size is unknowable at gesture time. At scale s an image that exactly fills
  // the stage overflows by (s-1)/2 per side; clamping travel to that bound
  // means a full-bleed photo still covers the viewport at the limit, and a
  // letterboxed one keeps its centre on screen. Either way the photo can
  // never be dragged completely off screen.
  const clampPan = useCallback((scale: number, tx: number, ty: number) => {
    const stage = stageRef.current;
    if (!stage || scale <= MIN_SCALE + 0.01) return { tx: 0, ty: 0 };
    const r = stage.getBoundingClientRect();
    const mx = ((scale - 1) * r.width) / 2;
    const my = ((scale - 1) * r.height) / 2;
    return {
      tx: Math.min(mx, Math.max(-mx, tx)),
      ty: Math.min(my, Math.max(-my, ty)),
    };
  }, []);

  const commitZoom = useCallback(
    (scale: number, tx: number, ty: number) => {
      const g = gest.current;
      g.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
      if (g.scale <= MIN_SCALE + 0.01) {
        g.scale = MIN_SCALE;
        g.tx = 0;
        g.ty = 0;
      } else {
        const c = clampPan(g.scale, tx, ty);
        g.tx = c.tx;
        g.ty = c.ty;
      }
      applyTransform();
      setZoomed(g.scale > MIN_SCALE + 0.01);
      if (g.scale > MIN_SCALE + 0.01) setShowHint(false);
    },
    [applyTransform, clampPan],
  );

  // A fresh photo always opens at 1x. Kept in an effect (not in the swipe
  // handler) so every path that changes the photo — swipe, filmstrip jump,
  // keyboard, delete-neighbour — resets through the same door.
  useEffect(() => {
    const g = gest.current;
    g.scale = MIN_SCALE;
    g.tx = 0;
    g.ty = 0;
    g.mode = "idle";
    g.swipeDx = 0;
    setSlideTransition(false);
    applyTransform();
    setZoomed(false);
    setConfirming(false);
  }, [clampedIndex, item?.id, applyTransform, setSlideTransition]);

  // Resolve the current photo, and warm the neighbours so the next swipe is
  // instant. Neighbour resolves only prime an <img> preloader — they never
  // touch state, so scrubbing fast through the set cannot thrash renders.
  useEffect(() => {
    if (!item) return;
    let live = true;
    if (fullUrls[item.id] === undefined) {
      resolveFullUrl(item).then((url) => {
        if (live) setFullUrls((m) => (m[item.id] === undefined ? { ...m, [item.id]: url } : m));
      });
    }
    for (const d of [-1, 1]) {
      const n = entries[clampedIndex + d];
      if (!n || fullUrls[n.id] !== undefined) continue;
      resolveFullUrl(n).then((url) => {
        if (live && url) {
          const im = new Image();
          im.src = url;
        }
        if (live) setFullUrls((m) => (m[n.id] === undefined ? { ...m, [n.id]: url } : m));
      });
    }
    return () => {
      live = false;
    };
    // fullUrls is read but intentionally not a dep: re-resolving on every
    // cache fill would refetch the neighbours on each arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, clampedIndex, entries]);

  // Filmstrip thumbs resolve lazily and independently of the main image, and
  // only around the frame being looked at: resolving every one of them the
  // moment the viewer opens is what made a photo in a large set feel like a
  // download rather than a glance.
  useEffect(() => {
    let live = true;
    const from = Math.max(0, clampedIndex - 15);
    const to = Math.min(entries.length, clampedIndex + 16);
    for (let i = from; i < to; i += 1) {
      const e = entries[i];
      if (!e || thumbUrls[e.id] !== undefined) continue;
      resolveThumbUrl(e).then((url) => {
        if (live && url) setThumbUrls((m) => (m[e.id] === undefined ? { ...m, [e.id]: url } : m));
      });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, clampedIndex]);

  // Keep the current frame centred in the filmstrip as the user swipes.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>("[data-active='true']");
    active?.scrollIntoView({ inline: "center", block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [clampedIndex, still]);

  const goTo = useCallback(
    (next: number) => {
      if (count === 0) return;
      // Clamped at both ends, never wrapping: wrapping in a photo set feels
      // like losing your place, and the first/last frames are usually the
      // oldest/newest — jumping between them is disorienting.
      const clamped = Math.min(count - 1, Math.max(0, next));
      if (clamped === clampedIndex) {
        // Bump against the end: snap the slide back instead of sticking.
        setSlideTransition(true);
        gest.current.swipeDx = 0;
        applyTransform();
        return;
      }
      onIndexChange(clamped);
    },
    [count, clampedIndex, onIndexChange, applyTransform, setSlideTransition],
  );

  const toggleChrome = useCallback(() => {
    if (confirming) return;
    setChrome((c) => !c);
  }, [confirming]);

  const zoomAroundPoint = useCallback(
    (px: number, py: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const g = gest.current;
      if (g.scale > MIN_SCALE + 0.01) {
        commitZoom(MIN_SCALE, 0, 0);
        return;
      }
      // With a centred transform origin, scaling about a tap point p needs
      // t = (c - p) * (s - 1): the content under the finger stays glued while
      // everything else grows around it.
      const s = DOUBLE_TAP_SCALE;
      const tx = (cx - px) * (s - 1);
      const ty = (cy - py) * (s - 1);
      const c = clampPan(s, tx, ty);
      commitZoom(s, c.tx, c.ty);
    },
    [clampPan, commitZoom],
  );

  const clearTapTimer = () => {
    if (tapTimer.current) {
      clearTimeout(tapTimer.current);
      tapTimer.current = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!item) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is an optimisation, not a requirement */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gest.current;
    setSlideTransition(false);

    if (pointers.current.size === 2) {
      // Second finger down: whatever the first finger was doing becomes a
      // pinch. A pending single-tap chrome toggle is cancelled — this is a
      // zoom gesture now, not a tap.
      clearTapTimer();
      const [a, b] = [...pointers.current.values()];
      g.mode = "pinch";
      g.startDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      g.startScale = g.scale;
      g.startTx = g.tx;
      g.startTy = g.ty;
      g.startMidX = (a.x + b.x) / 2;
      g.startMidY = (a.y + b.y) / 2;
      return;
    }
    if (pointers.current.size > 2) return;

    // Possible double-tap: close in time and space to the previous tap.
    const now = performance.now();
    const dt = now - lastTap.current.t;
    const dd = Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y);
    if (dt < DOUBLE_TAP_MS && dd < DOUBLE_TAP_SLOP_PX) {
      clearTapTimer();
      g.mode = "zoom-toggle";
      zoomAroundPoint(e.clientX, e.clientY);
      lastTap.current = { t: 0, x: 0, y: 0 };
      return;
    }
    g.mode = "touch";
    g.downX = e.clientX;
    g.downY = e.clientY;
    g.downT = now;
    g.moved = false;
    g.startTx = g.tx;
    g.startTy = g.ty;
    g.swipeDx = 0;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const g = gest.current;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();

    if (g.mode === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (g.startScale * dist) / g.startDist));
      // Focal-point-preserving zoom: the content under the pinch midpoint
      // stays under it, scaled around the stage centre.
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const k = next / (g.startScale || 1);
      const rawTx = midX - cx - (g.startMidX - cx - g.startTx) * k + (midX - g.startMidX);
      const rawTy = midY - cy - (g.startMidY - cy - g.startTy) * k + (midY - g.startMidY);
      const c = clampPan(next, rawTx, rawTy);
      g.scale = next;
      g.tx = c.tx;
      g.ty = c.ty;
      applyTransform();
      return;
    }

    if (g.mode !== "touch" || pointers.current.size !== 1) return;
    const dx = e.clientX - g.downX;
    const dy = e.clientY - g.downY;
    if (Math.hypot(dx, dy) > TAP_SLOP_PX) g.moved = true;
    if (!g.moved) return;

    if (g.scale > MIN_SCALE + 0.01) {
      // Zoomed: drag pans the photo. Vertical and horizontal both clamp, so
      // an edge is always on screen.
      const c = clampPan(g.scale, g.startTx + dx, g.startTy + dy);
      g.tx = c.tx;
      g.ty = c.ty;
      applyTransform();
    } else {
      // Not zoomed: a horizontal drag is a potential swipe. At the ends the
      // drag meets resistance instead of a dead stop, which is how the photo
      // tells you there is nothing further without needing a toast.
      const atStart = clampedIndex === 0 && dx > 0;
      const atEnd = clampedIndex === count - 1 && dx < 0;
      g.swipeDx = atStart || atEnd ? dx * 0.35 : dx;
      const el = slideRef.current;
      if (el) el.style.transform = `translate3d(${g.swipeDx}px, 0, 0) scale(1)`;
    }
  };

  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gest.current;

    if (g.mode === "pinch") {
      if (pointers.current.size >= 2) return;
      // Pinch released: settle, snapping back to 1x if the user came back
      // down to (almost) unzoomed rather than leaving a 1.03x limbo.
      setSlideTransition(true);
      commitZoom(g.scale, g.tx, g.ty);
      g.mode = pointers.current.size === 1 ? "touch" : "idle";
      return;
    }
    if (g.mode === "zoom-toggle") {
      g.mode = "idle";
      return;
    }
    if (g.mode !== "touch" || pointers.current.size !== 0) return;
    g.mode = "idle";

    const dx = e.clientX - g.downX;
    const dt = performance.now() - g.downT;

    if (!g.moved && dt < 500) {
      // A clean tap. Chrome toggles after the double-tap window so a
      // double-tap zoom never flashes the chrome on the way in.
      lastTap.current = { t: performance.now(), x: e.clientX, y: e.clientY };
      clearTapTimer();
      tapTimer.current = setTimeout(toggleChrome, DOUBLE_TAP_MS);
      // Restore the slide in case the tap drifted a pixel or two.
      setSlideTransition(true);
      applyTransform();
      return;
    }

    if (g.scale <= MIN_SCALE + 0.01) {
      const flick = Math.abs(dx) > SWIPE_FLICK_PX && dt < SWIPE_FLICK_MS;
      if (Math.abs(dx) > SWIPE_COMMIT_PX || flick) {
        const dir = dx < 0 ? 1 : -1;
        setSlideTransition(false);
        goTo(clampedIndex + dir);
        return;
      }
      setSlideTransition(true);
      g.swipeDx = 0;
      applyTransform();
    } else {
      setSlideTransition(true);
      commitZoom(g.scale, g.tx, g.ty);
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // Desktop and trackpad path: ctrl-wheel (pinch) or plain wheel zooms
    // about the cursor. Phones never fire this; it exists so the viewer is
    // still fully usable in the browser during development.
    if (!item) return;
    e.preventDefault();
    const g = gest.current;
    const delta = e.deltaY / (e.ctrlKey ? 200 : 600);
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, g.scale * Math.exp(-delta)));
    if (Math.abs(next - g.scale) < 0.001) return;
    const stage = stageRef.current;
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const k = next / g.scale;
    const rawTx = e.clientX - cx - (e.clientX - cx - g.tx) * k;
    const rawTy = e.clientY - cy - (e.clientY - cy - g.ty) * k;
    const c = clampPan(next, rawTx, rawTy);
    setSlideTransition(false);
    commitZoom(next, c.tx, c.ty);
  };

  // ── actions ──────────────────────────────────────────────────────

  const flashNotice = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2600);
  };

  const onShare = async () => {
    if (!item) return;
    try {
      await shareMedia(item);
      flashNotice("Photo shared");
    } catch {
      // The sheet dismissing counts as a throw on some builds; only report a
      // genuine failure to resolve.
      flashNotice("Could not share this photo");
    }
  };

  const onDelete = async () => {
    if (!item) return;
    let ok = false;
    try {
      ok = await deleteMedia(item);
    } catch {
      ok = false;
    }
    if (!ok) {
      flashNotice("Could not delete this photo");
      setConfirming(false);
      return;
    }
    // Drop the frame from local state now — waiting for a parent refresh
    // would leave a dead frame (or a spinner for a file that no longer
    // exists). The last photo closing the viewer is the graceful end state,
    // not an error state.
    const id = item.id;
    removedIds.current.add(id);
    const next = entries.filter((e) => e.id !== id);
    setEntries(next);
    setConfirming(false);
    if (next.length === 0) {
      onClose();
      return;
    }
    if (clampedIndex >= next.length) onIndexChange(next.length - 1);
  };

  // ── overlay lifecycle ────────────────────────────────────────────

  // The overlay is a dialog: it takes focus on open, Escape closes (or backs
  // out of the delete confirm first), arrows move through the set, and Tab
  // cycles inside so keyboard and switch users cannot fall through to the
  // page behind the scrim.
  useEffect(() => {
    rootRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      clearTapTimer();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      if (confirming) {
        setConfirming(false);
        cancelRef.current?.focus();
      } else onClose();
      return;
    }
    if (confirming) return;
    if (e.key === "ArrowRight") {
      goTo(clampedIndex + 1);
    } else if (e.key === "ArrowLeft") {
      goTo(clampedIndex - 1);
    } else if (e.key === "Tab") {
      const root = rootRef.current;
      if (!root) return;
      const focusables = [...root.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      )].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  if (!item) return null;

  const url = fullUrls[item.id];
  const resolving = url === undefined;
  const failed = url === null;

  return (
    <motion.div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: still ? 0 : 0.2 }}
      className="fixed inset-0 z-[80] bg-black text-white outline-none select-none"
      style={{ touchAction: "none" }}
    >
      {/* Stage: the photo itself. The one orchestrated motion in this view is
          the overlay fade plus the per-photo cross-fade; everything else is
          direct-manipulation feedback on the slide below. */}
      <div
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onWheel={onWheel}
        className="absolute inset-0 overflow-hidden"
        style={{ touchAction: "none", overscrollBehavior: "contain" }}
      >
        <div ref={slideRef} className="absolute inset-0 will-change-transform">
          <AnimatePresence initial={false}>
            <motion.div
              key={item.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: fadeMs / 1000 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              {resolving &&
                (thumbUrls[item.id] ? (
                  /* The row's own thumbnail stands in while the full image
                     resolves: a soft preview beats a spinner, and it is
                     already on screen in the filmstrip below. */
                  <div className="relative flex h-full w-full items-center justify-center" role="status" aria-label="Loading photo">
                    <img
                      src={thumbUrls[item.id] as string}
                      alt=""
                      aria-hidden="true"
                      draggable={false}
                      className="h-full w-full object-contain opacity-80"
                    />
                    <span
                      className="absolute bottom-6 right-6 block h-6 w-6 rounded-full border-2 border-white/25 border-t-white/90 animate-spin"
                      aria-hidden="true"
                    />
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3" role="status" aria-label="Loading photo">
                    <span
                      className="block h-8 w-8 rounded-full border-2 border-white/20 border-t-white/90 animate-spin"
                      aria-hidden="true"
                    />
                  </div>
                ))}
              {failed && !resolving && (
                <p className="px-8 text-center text-[15px] text-white/70">Could not open this photo</p>
              )}
              {!!url && !failed && (
                <img
                  src={url}
                  alt={item.name}
                  draggable={false}
                  onError={() => setFullUrls((m) => ({ ...m, [item.id]: null }))}
                  className="h-full w-full object-contain"
                  style={{ WebkitUserDrag: "none" } as React.CSSProperties}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Edge arrows: a pointer-device convenience (phones swipe), always
            44px targets, hidden at the clamped ends so they never promise a
            photo that is not there. */}
        {chrome && !confirming && count > 1 && (
          <>
            {clampedIndex > 0 && (
              <button
                type="button"
                aria-label="Previous photo"
                onClick={() => goTo(clampedIndex - 1)}
                className="pointer-events-auto absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/90"
              >
                <ChevronLeft size={22} strokeWidth={1.75} />
              </button>
            )}
            {clampedIndex < count - 1 && (
              <button
                type="button"
                aria-label="Next photo"
                onClick={() => goTo(clampedIndex + 1)}
                className="pointer-events-auto absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/90"
              >
                <ChevronRight size={22} strokeWidth={1.75} />
              </button>
            )}
          </>
        )}
      </div>

      {/* Top chrome. pointer-events-none lets taps fall through to the stage
          everywhere except on the controls themselves. */}
      <AnimatePresence>
        {chrome && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: still ? 0 : 0.18 }}
            className="pointer-events-none absolute inset-x-0 top-0"
            style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
          >
            <div className="bg-gradient-to-b from-black/70 to-transparent px-2 pb-6 pt-2">
              <div className="flex min-h-[44px] items-center gap-1">
                <button
                  type="button"
                  aria-label="Close viewer"
                  onClick={onClose}
                  className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full text-white"
                >
                  <X size={24} strokeWidth={1.75} />
                </button>
                <div className="min-w-0 flex-1 text-center">
                  <p className="truncate text-[15px] font-medium text-white">{dayHeading(item.lastModified)}</p>
                  <p className="tnum text-[13px] text-white/70">
                    {timeOfDay(item.lastModified)}
                    <span aria-hidden="true"> · </span>
                    <span>
                      {clampedIndex + 1} of {count}
                    </span>
                  </p>
                </div>
                {/* Share is the single primary action here, so it reads
                    brightest; delete stays a quiet ghost — destructive is
                    never the loudest thing in the room. */}
                <button
                  type="button"
                  aria-label="Share photo"
                  onClick={onShare}
                  className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full bg-white text-black"
                >
                  <Share2 size={20} strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label="Delete photo"
                  onClick={() => setConfirming(true)}
                  className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full text-white/70"
                >
                  <Trash2 size={20} strokeWidth={1.75} />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom chrome: metadata, then the filmstrip for jumping. */}
      <AnimatePresence>
        {chrome && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: still ? 0 : 0.18 }}
            className="pointer-events-none absolute inset-x-0 bottom-0"
            style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
          >
            <div className="bg-gradient-to-t from-black/75 to-transparent px-4 pb-2 pt-8">
              <p className="tnum truncate pb-2 text-center text-[13px] text-white/70">{metaLine(item)}</p>
              <div
                ref={stripRef}
                role="listbox"
                aria-label="Photos in this set"
                className="pointer-events-auto flex gap-2 overflow-x-auto py-1"
                style={{ scrollbarWidth: "none" }}
              >
                {entries.map((e, i) => {
                  const active = i === clampedIndex;
                  const thumb = thumbUrls[e.id];
                  return (
                    <button
                      key={e.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      aria-label={`Photo ${i + 1}: ${e.name}`}
                      data-active={active ? "true" : "false"}
                      onClick={() => goTo(i)}
                      className={`h-14 w-14 flex-none overflow-hidden rounded-lg outline-none ${
                        active ? "ring-2 ring-white ring-offset-2 ring-offset-black" : "opacity-55"
                      } focus-visible:ring-2 focus-visible:ring-white`}
                    >
                      {thumb ? (
                        <img src={thumb} alt="" aria-hidden="true" draggable={false} className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center bg-white/10 text-[13px] text-white/60">
                          {e.name ? e.name.charAt(0) : "·"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* First-run hint. One quiet line, dismissed forever on first zoom — a
          viewer people open daily must not narrate itself every time. */}
      {showHint && chrome && !zoomed && !resolving && !failed && (
        <div className="pointer-events-none absolute inset-x-0 bottom-32 flex justify-center">
          <p className="flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-[13px] text-white/80">
            <ZoomIn size={15} strokeWidth={1.75} aria-hidden="true" />
            Pinch or double-tap to zoom
          </p>
        </div>
      )}

      {/* Delete confirm: an inline bar, not a modal — the viewer is already a
          dialog, and stacking dialogs strands focus. Cancel takes initial
          focus so the safe choice is the cheap one. */}
      <AnimatePresence>
        {confirming && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: still ? 0 : 0.18 }}
            role="alertdialog"
            aria-label="Delete this photo"
            aria-describedby="iv-delete-desc"
            className="absolute inset-x-4 bottom-24 rounded-2xl bg-[#14181f] p-4"
            style={{ marginBottom: "env(safe-area-inset-bottom, 0px)" }}
          >
            <p id="iv-delete-desc" className="text-[15px] text-white">
              Delete this photo? This cannot be undone.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => setConfirming(false)}
                className="flex min-h-[44px] items-center rounded-full bg-white px-5 text-[15px] font-medium text-black"
              >
                Keep photo
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="flex min-h-[44px] items-center rounded-full px-5 text-[15px] text-white/70"
              >
                Delete
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Transient status. Polite live region, never a modal for a success. */}
      <AnimatePresence>
        {notice && !confirming && (
          <motion.p
            role="status"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: still ? 0 : 0.15 }}
            className="pointer-events-none absolute inset-x-0 top-20 text-center text-[14px] text-white/85"
          >
            {notice}
          </motion.p>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
