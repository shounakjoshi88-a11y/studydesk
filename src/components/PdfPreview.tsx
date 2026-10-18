import { type PointerEvent as RPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Loader2, TriangleAlert } from "lucide-react";
import { b64ToBytes } from "../lib/store";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

/** Page canvases rasterize at this scale times the crisp tier below. */
const BASE_RENDER = 1.8;
const MAX_ZOOM = 4;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A document you cannot pinch is a screenshot of a document. The pages render
 * into a column that answers gestures the same way the photo viewer does:
 * pinch to scale, drag to pan once scaled, double-tap to jump between fit and
 * 250%, and the +/- controls in the header do the same from the outside.
 *
 * The live gesture is a cheap CSS transform. Re-rasterizing happens once the
 * fingers stop (and only when the tier changes), so sharpness comes back
 * without ever paying for it mid-pinch.
 */
export function PdfPreview({
  base64,
  zoom,
  onZoomChange,
}: {
  base64: string;
  zoom: number;
  onZoomChange?: (z: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const [z, setZ] = useState(zoom);
  const [t, setT] = useState({ x: 0, y: 0 });
  const zRef = useRef(z);
  const tRef = useRef(t);
  const applyZ = useCallback((v: number) => {
    zRef.current = v;
    setZ(v);
  }, []);
  const applyT = useCallback((v: { x: number; y: number }) => {
    tRef.current = v;
    setT(v);
  }, []);

  /** Resolution tier of the page rasters; moves only after gestures settle. */
  const [renderZoom, setRenderZoom] = useState(1);
  const gesturing = useRef(false);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; mx: number; my: number; s0: number; tx0: number; ty0: number } | null>(null);
  const pan = useRef<{ x0: number; y0: number; tx0: number; ty0: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  /** Keeps the panned content inside its own edges at a given scale. */
  const clampT = useCallback((x: number, y: number, zz: number) => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return { x, y };
    const W = wrap.clientWidth || 1;
    const H = inner.offsetHeight || 1;
    const minX = Math.min(0, W - W * zz);
    const minY = Math.min(0, H - H * zz);
    return { x: Math.min(0, Math.max(minX, x)), y: Math.min(0, Math.max(minY, y)) };
  }, []);

  /* The +/- buttons and the reset control live in the Reader header; when the
     outside changes zoom, adopt it — unless a gesture is what changed it. */
  useEffect(() => {
    if (gesturing.current) return;
    if (Math.abs(zRef.current - zoom) < 0.001) return;
    applyZ(zoom);
    if (zoom <= 1.001) applyT({ x: 0, y: 0 });
  }, [zoom, applyZ, applyT]);

  /* A new document starts at fit, whatever the last one was left at. */
  useEffect(() => {
    applyZ(1);
    applyT({ x: 0, y: 0 });
    setRenderZoom(1);
  }, [base64, applyZ, applyT]);

  /* Sharpness pass: after zoom stops moving for a beat, re-render the pages if
     the tier changed. Tier, not raw scale — a pinch must never rasterize. */
  useEffect(() => {
    const id = window.setTimeout(() => {
      const tier = z <= 1.2 ? 1 : z <= 1.8 ? 1.5 : 2;
      setRenderZoom((prev) => (prev === tier ? prev : tier));
    }, 260);
    return () => window.clearTimeout(id);
  }, [z]);

  useEffect(() => {
    let cancelled = false;
    setTotal(0);
    setDone(0);
    setErr(null);
    (async () => {
      try {
        const bytes = b64ToBytes(base64);
        const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
        if (cancelled) return;
        setTotal(doc.numPages);
        const host = hostRef.current;
        if (host) host.innerHTML = "";
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale: BASE_RENDER * renderZoom });
          const canvas = document.createElement("canvas");
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          canvas.style.display = "block";
          canvas.style.marginBottom = "8px";
          canvas.style.borderRadius = "4px";
          canvas.style.boxShadow = "0 1px 4px rgba(0,0,0,0.25)";
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          host?.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
          if (!cancelled) setDone(i);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base64, renderZoom]);

  const onPointerDown = useCallback(
    (e: RPointerEvent<HTMLDivElement>) => {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety, not a requirement */
      }
      const wasEmpty = pointers.current.size === 0;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (wasEmpty) {
        /* Double-tap toggles fit <-> 250%, anchored on the tapped spot — the
           same bargain the photo viewer strikes. */
        const now = performance.now();
        const last = lastTap.current;
        if (last && now - last.t < 300 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
          lastTap.current = null;
          const wrap = wrapRef.current;
          if (wrap) {
            const r = wrap.getBoundingClientRect();
            const px = e.clientX - r.left;
            const py = e.clientY - r.top;
            if (zRef.current > 1.02) {
              applyZ(1);
              applyT({ x: 0, y: 0 });
              onZoomChange?.(1);
            } else {
              const nz = 2.5;
              applyZ(nz);
              applyT(clampT(px - px * nz, py - py * nz, nz));
              onZoomChange?.(nz);
            }
          }
          gesturing.current = true;
          pan.current = { x0: e.clientX, y0: e.clientY, tx0: tRef.current.x, ty0: tRef.current.y };
          return;
        }
        lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      }

      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        pinch.current = {
          d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          mx: (a.x + b.x) / 2,
          my: (a.y + b.y) / 2,
          s0: zRef.current,
          tx0: tRef.current.x,
          ty0: tRef.current.y,
        };
        pan.current = null;
        gesturing.current = true;
      } else if (pointers.current.size === 1) {
        pan.current = { x0: e.clientX, y0: e.clientY, tx0: tRef.current.x, ty0: tRef.current.y };
        gesturing.current = true;
      }
    },
    [applyT, applyZ, clampT, onZoomChange],
  );

  const onPointerMove = useCallback(
    (e: RPointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...pointers.current.values()];

      if (pts.length >= 2 && pinch.current) {
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mx = (pts[0].x + pts[1].x) / 2;
        const my = (pts[0].y + pts[1].y) / 2;
        const raw = clamp(pinch.current.s0 * (d / pinch.current.d0), 1, MAX_ZOOM);
        /* Pin the content under the pinch midpoint to the midpoint. */
        const tx = mx - ((pinch.current.mx - pinch.current.tx0) / pinch.current.s0) * raw;
        const ty = my - ((pinch.current.my - pinch.current.ty0) / pinch.current.s0) * raw;
        applyZ(raw);
        applyT(clampT(tx, ty, raw));
        return;
      }

      if (pts.length === 1 && pan.current) {
        if (zRef.current <= 1.02) return; // still fitted: let the page scroll natively
        const dx = e.clientX - pan.current.x0;
        const dy = e.clientY - pan.current.y0;
        applyT(clampT(pan.current.tx0 + dx, pan.current.ty0 + dy, zRef.current));
      }
    },
    [applyT, applyZ, clampT],
  );

  const endPointer = useCallback(
    (e: RPointerEvent<HTMLDivElement>) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size === 0) {
        gesturing.current = false;
        pinch.current = null;
        pan.current = null;
        onZoomChange?.(zRef.current);
        return;
      }
      if (pointers.current.size === 1) {
        const [p] = [...pointers.current.values()];
        pinch.current = null;
        pan.current = { x0: p.x, y0: p.y, tx0: tRef.current.x, ty0: tRef.current.y };
      }
    },
    [onZoomChange],
  );

  return (
    <div
      ref={wrapRef}
      className="relative"
      style={{
        touchAction: z > 1.02 ? "none" : "pan-y",
        overscrollBehavior: "contain",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      {err ? (
        <div className="flex items-start gap-2 text-sm text-caution-text bg-[var(--att-caution)]/10 border border-[var(--att-caution)]/30 rounded-card p-3 m-2">
          <TriangleAlert className="size-4 mt-0.5 shrink-0" />
          <span>Could not render this PDF: {err}</span>
        </div>
      ) : (
        <>
          {done < total && (
            <div className="flex items-center justify-center gap-2 py-3 text-sm text-neutral-500">
              <Loader2 className="size-4 animate-spin" />
              {total === 0 ? "Opening PDF…" : `Rendering page ${done + 1} of ${total}…`}
            </div>
          )}
          <div
            ref={innerRef}
            style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${z})`, transformOrigin: "0 0", willChange: "transform" }}
          >
            <div ref={hostRef} />
          </div>
        </>
      )}
    </div>
  );
}
