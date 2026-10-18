/**
 * "Cleaned so far" — the one number the drawer keeps between visits.
 *
 * It counts the bytes that walked out of folders through a Clean action
 * (junk, duplicate copies, month-old downloads). All of those went to the
 * bin, so the number is really "space on its way out" — honest enough with
 * the label it ships under, and it updates the moment anything comes back.
 * Local storage only, like every other bookkeeping list in this app.
 */
const KEY = "studydesk.cleanedBytes.v1";

export function cleanedBytes(): number {
  const raw = Number(localStorage.getItem(KEY) ?? "0");
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function addCleaned(bytes: number): void {
  if (!(bytes > 0)) return;
  try {
    localStorage.setItem(KEY, String(cleanedBytes() + bytes));
  } catch {
    /* a full quota is not worth raising over a counter */
  }
}

/** A restore puts space back on the "not cleaned" side of the ledger. */
export function subtractCleaned(bytes: number): void {
  if (!(bytes > 0)) return;
  try {
    localStorage.setItem(KEY, String(Math.max(0, cleanedBytes() - bytes)));
  } catch {
    /* see above */
  }
}
