/**
 * "Recently opened" for the search screen's empty state — the last twenty
 * files this person opened from the Files tab, newest first.
 *
 * Local only, capped, and nothing beyond the fields a row needs to draw.
 * The list is a convenience, not a record: a path that has since moved just
 * fails to open, and nothing here is ever consulted for anything else.
 */

import type { DfFile } from "./deviceFiles";

const KEY = "studydesk.recentOpened.v1";
const CAP = 20;

export type RecentOpen = DfFile & { at: number };

export function recentlyOpened(): RecentOpen[] {
  try {
    const raw = localStorage.getItem(KEY);
    const xs = raw ? (JSON.parse(raw) as RecentOpen[]) : [];
    if (!Array.isArray(xs)) return [];
    return xs.filter((x) => x && typeof x.path === "string" && typeof x.name === "string");
  } catch {
    return [];
  }
}

export function recordOpen(e: DfFile): void {
  try {
    const rest = recentlyOpened().filter((x) => x.path !== e.path);
    const next: RecentOpen[] = [{ ...e, at: Date.now() }, ...rest].slice(0, CAP);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a full quota is not worth raising over a convenience list */
  }
}

/** Settings offers this: one tap and the search screen's empty state is a
 *  clean slate again. Nothing else reads the list, so nothing else changes. */
export function clearOpened(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* see above */
  }
}
