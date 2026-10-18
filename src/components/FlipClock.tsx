/**
 * Deadline picker — one quiet field that opens into a split-flap clock.
 *
 * It replaces a native `datetime-local` field that was a blank rounded box
 * with a chevron parked at the far right: nothing said it wanted a time, and
 * the only affordance was a caret you had to trust.
 *
 * The flaps used to sit on the page permanently, which put six cards and a
 * button in front of you before you had written anything. Six controls is a
 * lot of chrome for a value most pins never set, and it made the composer
 * read as a dashboard instead of a form. So the deadline is collapsed by
 * default into a single row styled like the input above it — same shape, same
 * language, so it is obviously a field you can open — and the clock appears
 * only when asked for. The flip is still the confirmation, because changing a
 * number is what setting it means.
 *
 * Minutes step in fives. A deadline does not need second precision, and it
 * keeps every column the same length so the steppers feel identical.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { TimeOfDay } from "../lib/review";

const HOURS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MERIDIEM = ["AM", "PM"] as const;

const p2 = (n: number) => String(n).padStart(2, "0");

/** Last day of a 1-based month, leap years included. */
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();

function wrap<T>(list: T[], i: number): T {
  return list[((i % list.length) + list.length) % list.length]!;
}

/**
 * One flap. `value` is what is committed; the previous face is held for the
 * length of the animation and rotates away to expose the new one underneath,
 * which is the direction a real split-flap moves.
 */
function Flap({
  value,
  kind = "num",
  dir,
  onStep,
  label,
  grow,
}: {
  value: string;
  kind?: "num" | "year" | "text";
  dir: 1 | -1;
  onStep: (d: 1 | -1) => void;
  label: string;
  grow: number;
}) {
  const [back, setBack] = useState<string | null>(null);
  const prev = useRef(value);

  useEffect(() => {
    if (value === prev.current) return;
    setBack(prev.current);
    prev.current = value;
    const t = window.setTimeout(() => setBack(null), 250);
    return () => window.clearTimeout(t);
  }, [value]);

  const face = (v: string) => (
    <span className={`sdf-num is-${kind}${v.startsWith("-") ? " is-blank" : ""}`}>{v}</span>
  );

  return (
    <div className="sdf" style={{ flexGrow: grow }}>
      <div className="sdf-card">
        {face(value)}
        {back !== null && (
          <span key={`${back}${dir}`} aria-hidden="true" className={`sdf-flip${dir === 1 ? " is-up" : " is-down"}`}>
            {face(back)}
          </span>
        )}
      </div>
      {/* Every card gets the same two levers, AM/PM included. It was briefly
          the one card you had to guess at, which read as a fixed value. */}
      <button type="button" className="sdf-step is-up" onClick={() => onStep(1)} aria-label={`${label} up`}>
        <ChevronUp className="sdf-chev" />
      </button>
      <button type="button" className="sdf-step is-down" onClick={() => onStep(-1)} aria-label={`${label} down`}>
        <ChevronDown className="sdf-chev" />
      </button>
    </div>
  );
}

/** Fixed-width gap so a colon and an empty gap occupy the same column. */
function Sep({ children }: { children?: React.ReactNode }) {
  return <span className="sdf-sep">{children}</span>;
}

export function FlipClock({ day, onDay, value, onChange }: {
  day: string;
  onDay: (d: string) => void;
  value: TimeOfDay;
  onChange: (t: TimeOfDay) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<1 | -1>(1);
  const today = useMemo(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
  }, []);

  const parts = useMemo(
    () => (day ? (day.split("-").map(Number) as [number, number, number]) : null),
    [day],
  );
  const y = parts?.[0] ?? today.y;
  const m = parts?.[1] ?? today.m;
  const d = parts?.[2] ?? today.d;

  // Deadlines are near-term, so the year only has to reach a little past the
  // present. A short range keeps the flap from becoming a chore to spin.
  const years = useMemo(() => {
    const out: number[] = [];
    for (let i = today.y - 1; i <= today.y + 5; i++) out.push(i);
    return out;
  }, [today.y]);

  const setDay = (yy: number, mm: number, dd: number) => onDay(`${yy}-${p2(mm)}-${p2(dd)}`);
  const blank = parts === null;

  const summary = useMemo(() => {
    if (!parts) return "Add a deadline";
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    const label = date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    return `${label}, ${value.h}:${p2(value.m)} ${value.ap}`;
  }, [parts, value]);

  // The first tap on any day card arms the date at today rather than jumping
  // a step from nothing — from "--" there is no sensible neighbour to move to.
  const arm = () => {
    if (blank) setDay(today.y, today.m, today.d);
  };

  const stepDay = (dirn: 1 | -1) => {
    arm();
    if (blank) return;
    const span = Array.from({ length: daysIn(y, m) }, (_, i) => i + 1);
    setDay(y, m, wrap(span, d - 1 + dirn));
  };
  const stepMonth = (dirn: 1 | -1) => {
    arm();
    if (blank) return;
    const nm = wrap(MONTHS, m - 1 + dirn);
    // 31 Jan stepped to Feb has to become 28/29 Feb, not roll into March.
    setDay(y, nm, Math.min(d, daysIn(y, nm)));
  };
  const stepYear = (dirn: 1 | -1) => {
    arm();
    if (blank) return;
    const ny = wrap(years, years.indexOf(y) + dirn);
    setDay(ny, m, Math.min(d, daysIn(ny, m)));
  };

  const stepTime = (list: number[], key: "h" | "m") => (dirn: 1 | -1) => {
    setDir(dirn);
    onChange({ ...value, [key]: wrap(list, list.indexOf(value[key]) + dirn) });
  };

  return (
    <div>
      {/* Shaped and toned like the input above it, so it reads as the second
          field of the form rather than as a control parked next to one. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="sd-tap mt-1.5 flex w-full items-center rounded-[6px] border border-line bg-input px-4 py-2.5 text-left text-[15px]"
      >
        <span style={{ color: blank ? "var(--ink-3)" : "var(--ink-1)" }}>{summary}</span>
      </button>

      {open && (
        <div className="sdf-reveal mt-3">
          <div className="sdf-row">
            <Flap label="Day" grow={1} kind="num" value={blank ? "--" : p2(d)} dir={dir} onStep={stepDay} />
            <Sep />
            <Flap label="Month" grow={1} kind="num" value={blank ? "--" : p2(m)} dir={dir} onStep={stepMonth} />
            <Sep />
            <Flap label="Year" grow={1.5} kind="year" value={blank ? "----" : String(y)} dir={dir} onStep={stepYear} />
          </div>
          <div className="sdf-row mt-2">
            <Flap label="Hour" grow={1} kind="num" value={String(value.h)} dir={dir} onStep={stepTime(HOURS, "h")} />
            <Sep>:</Sep>
            <Flap
              label="Minute"
              grow={1}
              kind="num"
              value={String(value.m).padStart(2, "0")}
              dir={dir}
              onStep={stepTime(MINUTES, "m")}
            />
            <Sep />
            <Flap
              label="AM or PM"
              grow={1.5}
              kind="text"
              value={value.ap}
              dir={dir}
              onStep={(dirn) => {
                setDir(dirn);
                onChange({ ...value, ap: (MERIDIEM.indexOf(value.ap) + dirn) % 2 === 0 ? "AM" : "PM" });
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
