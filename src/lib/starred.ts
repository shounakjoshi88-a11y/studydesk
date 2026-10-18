/**
 * Starred — the device files this person marked with a star, the way Files
 * by Google keeps them (its home Collections card and drawer both land on
 * this list).
 *
 * A star is a path, not a copy: nothing moves, nothing duplicates, and the
 * list is local storage only. Files that later move or get deleted are not
 * silently dropped — the Starred screen asks Android what still exists and
 * greys out what does not, because a star list that quietly reshuffles
 * itself is worse than one that admits a file walked off.
 */

import type { DfFile } from "./deviceFiles";

const KEY = "studydesk.starred.v1";
const CAP = 100;

export type StarredEntry = DfFile & { at: number };

function read(): StarredEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const xs = raw ? (JSON.parse(raw) as StarredEntry[]) : [];
    if (!Array.isArray(xs)) return [];
    return xs.filter((x) => x && typeof x.path === "string" && typeof x.name === "string");
  } catch {
    return [];
  }
}

function write(xs: StarredEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(xs));
  } catch {
    /* a full quota is not worth raising over a convenience list */
  }
}

export function starredEntries(): StarredEntry[] {
  return read();
}

export function starredCount(): number {
  return read().length;
}

export function isStarred(path: string): boolean {
  return read().some((x) => x.path === path);
}

/** Starring an already-starred file refreshes its row instead of duplicating. */
export function starOn(e: DfFile): void {
  const rest = read().filter((x) => x.path !== e.path);
  write([{ ...e, at: Date.now() }, ...rest].slice(0, CAP));
}

export function starOff(path: string): void {
  write(read().filter((x) => x.path !== path));
}
