/**
 * One-shot handoff between the importers (Open With, share sheet) and the
 * Notes screen. The incoming handler runs wherever the app happens to be —
 * often before Notes has ever mounted, so a window event alone is not enough.
 * The id is parked here and Notes picks it up on mount; the event covers the
 * case where Notes is already on screen. Both paths clear the value, so a
 * note never opens twice.
 */
export type PendingNote = { id: string; label?: string };

let pending: PendingNote | null = null;

export function setPendingNote(id: string, label?: string) {
  pending = { id, label };
}

export function takePendingNote(): PendingNote | null {
  const p = pending;
  pending = null;
  return p;
}
