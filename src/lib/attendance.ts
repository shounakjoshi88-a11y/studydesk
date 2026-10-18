/**
 * Attendance domain logic.
 *
 * RCOEM's Juno build exposes only the *overall* percentage — every
 * subject-wise endpoint is behind a mobile auth layer this app can't
 * reach. So per-subject tracking is local: the student marks Present /
 * Absent (or scans a class), and this module does the interesting part —
 * the bunk arithmetic nobody else shows you.
 */

export type Band = "safe" | "caution" | "risk" | "critical";

export const REQUIRED = 75;

export type SubjectMark = {
  /** Stable id — usually the normalised subject code, e.g. "DT-304". */
  id: string;
  name: string;
  attended: number;
  total: number;
  /** Optional instructor initials shown as a secondary line. */
  teacher?: string;
};

/**
 * Percentage, or null when there is no data.
 *
 * A subject the portal reports as 0/0 is *unknown*, not 0% — the college's
 * own app renders it as "NaN%". Treating it as zero would paint it critical
 * red and drag the overall average down for a class that simply hasn't run.
 */
export function pct(s: { attended: number; total: number }): number | null {
  if (!s.total) return null;
  return (s.attended / s.total) * 100;
}

/** Percentage for display, with an explicit "no data" case. */
export function pctText(s: { attended: number; total: number }): string {
  const p = pct(s);
  return p === null ? "no data" : `${p.toFixed(1)}%`;
}

export function bandOf(p: number | null): Band {
  if (p === null) return "safe";
  if (p >= 85) return "safe";
  if (p >= 75) return "caution";
  if (p >= 60) return "risk";
  return "critical";
}

/**
 * Band → CSS custom property names. Kept as strings so Tailwind's
 * runtime picks them up as arbitrary values (text-[var(--...)]).
 */
export const BAND_COLOR: Record<Band, string> = {
  safe: "var(--att-safe)",
  caution: "var(--att-caution)",
  risk: "var(--att-risk)",
  critical: "var(--att-critical)",
};
export const BAND_TEXT: Record<Band, string> = {
  safe: "var(--att-safe-text)",
  caution: "var(--att-caution-text)",
  risk: "var(--att-risk-text)",
  critical: "var(--att-critical-text)",
};
export const BAND_LABEL: Record<Band, string> = {
  safe: "Comfortable",
  caution: "Watch it",
  risk: "At risk",
  critical: "Critical",
};
/** Glyph paired with every percentage so colour is never the only signal. */
export const BAND_GLYPH: Record<Band, string> = {
  safe: "●", // filled
  caution: "◐", // half
  risk: "◔", // mostly empty
  critical: "○", // empty
};

/**
 * How many more lectures can be skipped and still finish at >= REQUIRED.
 * Negative means you are already under the line and must attend.
 */
export function safeBunks(s: { attended: number; total: number }): number {
  // After n bunks: attended / (total + n) >= R/100
  const a = s.attended;
  const t = s.total;
  const floor = Math.ceil((REQUIRED * t) / 100);
  return Math.max(0, a - floor);
}

/** Lectures you must attend consecutively to climb back to the line. */
export function needToAttend(s: { attended: number; total: number }): number {
  const a = s.attended;
  const t = s.total;
  // After n attends: (a + n) / (t + n) >= R/100
  const need = Math.ceil((REQUIRED * t - 100 * a) / (100 - REQUIRED));
  return Math.max(0, need);
}

/** One sentence of plain advice. This is the payoff of the whole screen. */
export function bunkInfo(s: SubjectMark): string {
  const p = pct(s);
  if (p === null) return "No classes recorded yet";
  const b = bandOf(p);
  if (p >= 100) return "Perfect record — attend anything";
  if (b === "critical") return `Attend the next ${needToAttend(s)} to reach ${REQUIRED}%`;
  if (b === "risk") return `${safeBunks(s)} safe ${safeBunks(s) === 1 ? "bunk" : "bunks"} · need ${needToAttend(s)} to reach ${REQUIRED}%`;
  if (b === "caution") return `${safeBunks(s)} safe ${safeBunks(s) === 1 ? "bunk" : "bunks"} left`;
  return `${safeBunks(s)} safe ${safeBunks(s) === 1 ? "bunk" : "bunks"} — comfortable`;
}

/** Worst-first ordering, so the student sees what needs action.
 *  Subjects with no data sink to the bottom instead of pretending to be 0%. */
export function byUrgency(list: SubjectMark[]): SubjectMark[] {
  return [...list].sort((a, b) => {
    const pa = pct(a);
    const pb = pct(b);
    if (pa === null && pb === null) return 0;
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb;
  });
}

export type Overall = {
  pct: number;
  band: Band;
  /** Subjects with at least one recorded class. */
  subjects: number;
  /** Subjects the portal reports but that have no data yet. */
  unknown: number;
  atRisk: number;
  totalBunks: number;
};

export function rollUp(list: SubjectMark[]): Overall {
  const attended = list.reduce((n, s) => n + s.attended, 0);
  const total = list.reduce((n, s) => n + s.total, 0);
  const p = total ? (attended / total) * 100 : 0;
  return {
    pct: Math.round(p * 10) / 10,
    band: bandOf(p),
    subjects: list.filter((s) => s.total > 0).length,
    unknown: list.filter((s) => s.total === 0).length,
    atRisk: list.filter((s) => {
      const v = pct(s);
      return v !== null && v < 75;
    }).length,
    totalBunks: list.reduce((n, s) => n + safeBunks(s), 0),
  };
}

/**
 * Normalise a timetable subject string into a stable key so "TOC (DT-812)"
 * and "TOC DT-812" from two different photos land on the same record.
 */
export function subjectKey(raw: string): string {
  const s = raw.toUpperCase();
  const room = s.match(/\b(DT|DL|IT|SE|CE|ME|EE|CS|BC|MT|AR)[-\s]?(\d{3})\b/);
  if (room) return `${room[1]}-${room[2]}`;
  const abbr = s.match(/\b([A-Z]{2,5})\b/);
  return (abbr ? abbr[1] : s.replace(/[^A-Z0-9]/g, "")).slice(0, 12);
}

const MK = "sd_attendance_v1";

export function loadMarks(): SubjectMark[] {
  try {
    const v = JSON.parse(localStorage.getItem(MK) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveMarks(list: SubjectMark[]) {
  localStorage.setItem(MK, JSON.stringify(list));
}

export function mark(list: SubjectMark[], id: string, present: boolean): SubjectMark[] {
  const next = list.map((s) =>
    s.id === id ? { ...s, attended: Math.max(0, Math.min(s.total, s.attended + (present ? 1 : 0))), total: s.total + 1 } : s
  );
  saveMarks(next);
  return next;
}

/** Reconcile stored marks against the OCR'd timetable: create new subjects,
 *  and keep totals if they've already been seen. */
export function reconcile(list: SubjectMark[], subjects: Array<{ subject: string }>): SubjectMark[] {
  const out = [...list];
  for (const { subject } of subjects) {
    const id = subjectKey(subject);
    if (!id) continue;
    if (!out.some((s) => s.id === id)) {
      out.push({ id, name: subject.replace(/\s+/g, " ").trim().slice(0, 44), attended: 0, total: 0 });
    }
  }
  saveMarks(out);
  return out;
}
