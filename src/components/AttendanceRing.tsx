import { useEffect, useId, useRef, useState } from "react";
import { BAND_COLOR, BAND_GLYPH, BAND_LABEL, BAND_TEXT, REQUIRED, type Band } from "../lib/attendance";

export const BAND_SHORT: Record<Band, string> = {
  safe: "Safe",
  caution: "Watch",
  risk: "At risk",
  critical: "Critical",
};

/**
 * AttendanceRing — the app's one orchestrated moment.
 *
 * A gauge, not a progress bar bent into a circle. The unfilled part of the
 * scale is a woven diamond mesh rather than a solid grey band, for two
 * reasons. It reads as an instrument instead of a loading spinner, and — the
 * reason it actually changed — a solid ring behind a coloured arc looks, at
 * a glance, like the whole circle is filled. It was genuinely unclear which
 * part was the track and which was the value.
 *
 * The filled part is two strokes of the same colour at different widths and
 * opacities: a soft band with a bright core running down its middle. That
 * gives the arc depth without a gradient, and it works for every band from
 * one rule instead of a hand-picked tint per band.
 *
 * The 75% notch is drawn last, over both, because it is the line the number
 * has to stay above — it should never be the thing that gets covered up.
 *
 * Only the number goes inside the circle. At this size anything else inside
 * collides with the stroke. The unit rides with it because a bare 92.8
 * floating in a ring could be any measure at all.
 */

function useMeshId() {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  return `mesh-${id}`;
}
export function AttendanceRing({
  value,
  size = 120,
  label = "Overall",
  sub,
  animate = true,
  /**
   * The band word and label stacked under the circle. Off by default now:
   * a caption hanging beneath a round shape reads as a label floating in
   * space, and the caller usually has a column beside the ring that says
   * the same thing better.
   */
  caption = false,
}: {
  value: number;
  size?: number;
  label?: string;
  sub?: string;
  animate?: boolean;
  caption?: boolean;
}) {
  const [shown, setShown] = useState(animate ? 0 : value);
  const raf = useRef(0);

  useEffect(() => {
    if (!animate) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const dur = 400;
    const delay = 120;
    const tick = (t: number) => {
      const p = Math.max(0, Math.min(1, (t - start - delay) / dur));
      // easeOut: cubic-bezier(0.16, 1, 0.3, 1) approximated closely
      const e = 1 - Math.pow(1 - p, 3);
      setShown(value * e);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, animate]);

  const band: Band = value >= 85 ? "safe" : value >= 75 ? "caution" : value >= 60 ? "risk" : "critical";
  // The bed is deliberately wider than the arc. That is what makes this a
  // gauge with a mesh dial plate and an indicator running inside it, rather
  // than an arc painted on top of a ring — and it is why the mesh stays
  // visible all the way round instead of only in the sliver you have left.
  const bed = Math.max(16, Math.round(size * 0.185));
  const arcW = Math.max(9, Math.round(size * 0.105));
  const r = size / 2 - bed / 2 - 3;
  const c = 2 * Math.PI * r;
  const arc = Math.max(0, Math.min(100, shown)) / 100;
  const spin = `rotate(-90 ${size / 2} ${size / 2})`;
  // The 75% notch. Drawn over everything, because it is the line the number
  // has to stay above — it should never be the thing that gets covered.
  const na = (REQUIRED / 100) * 360 * (Math.PI / 180) - Math.PI / 2;
  const nx1 = size / 2 + (r - arcW / 2 - 3) * Math.cos(na);
  const ny1 = size / 2 + (r - arcW / 2 - 3) * Math.sin(na);
  const nx2 = size / 2 + (r + arcW / 2 + 3) * Math.cos(na);
  const ny2 = size / 2 + (r + arcW / 2 + 3) * Math.sin(na);
  const mesh = useMeshId();

  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} ${value.toFixed(1)} percent, ${BAND_SHORT[band]}`}>
          <defs>
            {/* A square grid rotated 45° is a diamond lattice. Two line
                families is all a weave is; the pitch has to stay small
                enough that several cells fit across the bed. */}
            <pattern
              id={mesh}
              width="4"
              height="4"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <path d="M0 0V4" stroke="var(--mesh-line)" strokeWidth="0.9" />
              <path d="M0 0H4" stroke="var(--mesh-line)" strokeWidth="0.9" />
            </pattern>
          </defs>

          {/* the mesh dial plate, across the whole 100% scale */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={`url(#${mesh})`}
            strokeWidth={bed}
          />

          {/* The indicator, opaque and narrower than the bed. It was
              previously drawn at 42% opacity, which let the lattice read
              straight through the colour and made the whole thing look
              grubby rather than crisp. */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={BAND_COLOR[band]}
            strokeWidth={arcW}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - arc)}
            transform={spin}
            style={{ transition: "none" }}
          />
          {/* A brighter core down the middle of the band, using the band
              text tint that was already in the palette — so every band gets
              the same depth without a hand-picked highlight per colour. */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={BAND_TEXT[band]}
            strokeWidth={Math.max(2, Math.round(arcW * 0.26))}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - arc)}
            transform={spin}
            style={{ transition: "none" }}
          />

          <line x1={nx1} y1={ny1} x2={nx2} y2={ny2} stroke="var(--ink-2)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="tnum flex items-baseline font-semibold leading-none" style={{ color: BAND_TEXT[band] }}>
            <span style={{ fontSize: size * 0.21, letterSpacing: "-0.02em" }}>{value.toFixed(1)}</span>
            <span style={{ fontSize: size * 0.1, opacity: 0.75 }}>%</span>
          </span>
        </div>
      </div>
      {caption && (
        <div className="mt-2 text-center">
          <div className="text-[12px] font-semibold" style={{ color: BAND_TEXT[band] }}>
            {BAND_GLYPH[band]} {BAND_SHORT[band]}
          </div>
          <div className="text-[11px] font-medium" style={{ color: "var(--ink-2)" }}>{label}</div>
          {sub ? <div className="mt-0.5 text-[11px]" style={{ color: "var(--ink-3)" }}>{sub}</div> : null}
        </div>
      )}
    </div>
  );
}

/**
 * Small inline arc used in list rows — no number roll, 1 frame of motion.
 */
export function MiniRing({ value, size = 28 }: { value: number; size?: number }) {
  const band: Band = value >= 85 ? "safe" : value >= 75 ? "caution" : value >= 60 ? "risk" : "critical";
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} className="shrink-0" role="img" aria-label={`${value.toFixed(0)} percent`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={3} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={BAND_COLOR[band]}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(100, value)) / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/**
 * A live "3px rail" that marks the class currently in progress.
 * Only animates while a class is actually live — motion means something.
 */
export function LiveRail({ live, past }: { live: boolean; past: boolean }) {
  if (!live && !past) return <div className="w-[3px] shrink-0 rounded-full" style={{ background: "transparent" }} />;
  return (
    <div
      className={live ? "sd-rail-in w-[3px] shrink-0 rounded-full" : "w-[3px] shrink-0 rounded-full"}
      style={{ background: live ? "var(--att-safe)" : "var(--ink-3)" }}
    />
  );
}

/**
 * Status dot: pulses only while a request is in flight.
 */
export function StatusDot({ working, tone = "var(--att-safe)" }: { working: boolean; tone?: string }) {
  return (
    <span
      className={working ? "sd-live-dot inline-block h-2 w-2 rounded-full" : "inline-block h-2 w-2 rounded-full"}
      style={{ background: tone, color: tone }}
      aria-hidden
    />
  );
}

/**
 * OCR progress: a scan line sweeping the chosen photo instead of a
 * meaningless spinner. Says "looking for the table", not just "working".
 */
export function ScanSweep({ height = 120 }: { height?: number }) {
  return (
    <div className="relative overflow-hidden rounded-lg" style={{ height, background: "var(--surface-2)" }}>
      <div
        className="absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            "linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)",
          backgroundSize: "18px 18px",
        }}
      />
      <div
        className="sd-scan absolute left-0 right-0 h-[2px]"
        style={{ ["--scan-travel" as string]: `${height}px`, background: "var(--brand)", boxShadow: "0 0 12px var(--brand)" }}
      />
    </div>
  );
}
