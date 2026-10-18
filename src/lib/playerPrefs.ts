/**
 * What the player remembers between sessions: where each video was left, and
 * the handful of controls the user has already chosen.
 *
 * Two rules shape the whole file. The first is that storage is a place that can
 * be absent, full, or hostile. A Capacitor WebView can deny localStorage
 * outright, a desktop browser in private mode throws on write, and a device can
 * hit its quota in the middle of a lecture. None of that is a reason for a video
 * to stop playing, so every touch of storage sits behind a guard and every
 * failure degrades to "nothing remembered" rather than to an exception under
 * the play button.
 *
 * The second is that what comes back out is not trusted. Values in this store
 * outlive the build that wrote them: a hand-edited key, a record left half
 * written by a process the OS killed, or a leftover from a shape that no longer
 * exists all arrive as the same untyped JSON. Every read validates, and anything
 * that cannot be validated is replaced by the default rather than repaired. A
 * wrong resume point is invisible to the viewer and impossible to argue with,
 * whereas starting from zero is only a small loss.
 *
 * localStorage is the only store used. The skill suggests the platform's own
 * persistence on mobile, and inside a WebView that is exactly what localStorage
 * is: an app-private origin whose storage survives process death and is cleared
 * together with the app's data. Nothing here writes a file path or a media URL,
 * because those can carry a token and a filename, and a MediaStore row id is a
 * local identifier that is safe to key on.
 */

// ── shape ─────────────────────────────────────────────────

export interface PlayerPrefs {
  rate: number;
  volume: number;
  muted: boolean;
  /** The distance one press of a skip button travels. */
  skipSeconds: number;
  captionsOn: boolean;
}

/**
 * A fresh player is unremarkable: normal speed, full volume, audible, captions
 * off. Volume starts at 1 rather than at whatever the element happens to hold,
 * because the element's own level is a transient detail of the page and the
 * stored one is what the user actually chose.
 */
export const DEFAULT_PREFS: Readonly<PlayerPrefs> = Object.freeze({
  rate: 1,
  volume: 1,
  muted: false,
  skipSeconds: 10,
  captionsOn: false,
});

/**
 * The speeds the menu offers (skill 3, P0). The list is closed on purpose: a
 * stored rate is snapped onto it rather than passed to the element, because
 * `playbackRate` is one of the few video properties that is happily set to
 * anything at all, and 9999 is a valid assignment that produces a permanently
 * stalled frame and no error to explain it.
 */
export const SPEED_STEPS: readonly number[] = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);

/** The skip distances the settings menu offers. Ten is the default because ten
 *  seconds is long enough to cover the sentence you missed and short enough that
 *  pressing it twice has not thrown away the minute. */
export const SKIP_CHOICES: readonly number[] = Object.freeze([5, 10, 15, 30]);

/**
 * Ten seconds, and the same ten at both ends of the timeline (skill 5.1).
 *
 * At the start it is a floor on meaning: below ten seconds the user has not
 * really begun, and dropping them into the middle of an opening sentence, or
 * past a title card, is a worse experience than letting them hear the first
 * few seconds again.
 *
 * At the end it is a floor on "finished". Ten seconds is roughly the length of
 * the tail a lecture carries (the closing summary, the last slide, the fade), so
 * resuming into it lands the viewer on the end card and an immediate ended
 * state, which reads as a broken player rather than as a finished lesson. It is
 * also forgiving enough that someone who watched the final line and closed the
 * app a moment later is not treated as done.
 *
 * One number rather than two keeps the rule explainable to whoever debugs a
 * "why did it not resume" report later.
 */
export const RESUME_EDGE_SECONDS = 10;

// ── keys ──────────────────────────────────────────────────

/** Per-video records are namespaced under vp: so a future export or import can
 *  find every key this player owns without walking the whole origin. */
export const positionKey = (videoId: string): string => `vp:pos:${videoId}`;

/** The one global record: speed, volume, mute, skip step, captions. */
export const PREFS_KEY = "vp:prefs";

// ── storage, defensively ──────────────────────────────────

/** The slice of Storage this file needs, declared structurally so nothing has to
 *  exist at runtime for the type to be satisfiable. */
type WebStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * Looks localStorage up late rather than at module scope. A bare test runtime
 * has no window at all, and on some WebViews the property access itself throws
 * when storage is blocked for the origin, so both the read of the global and the
 * shape check happen inside the guard and every caller sees a plain null.
 */
function storage(): WebStore | null {
  try {
    const s = (globalThis as { localStorage?: unknown }).localStorage as WebStore | undefined;
    return s && typeof s.getItem === "function" ? s : null;
  } catch {
    return null;
  }
}

function readRaw(key: string): string | null {
  const s = storage();
  if (!s) return null;
  try {
    const v = s.getItem(key);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(key, value);
  } catch {
    /* a full quota costs a resume position, never a playback session */
  }
}

function dropRaw(key: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(key);
  } catch {
    /* the record is already unreachable if we cannot ask about storage */
  }
}

/**
 * A MediaStore row id is digits and nothing more, so anything carrying a slash,
 * a query, a fragment or whitespace is not one: it is a path or a URL, and a
 * URL here may be a signed link whose token would then sit in app storage
 * forever (skill 8.4). Those ids are refused rather than stored, because a
 * caller holding only a URL has no stable local identity to resume against
 * anyway. The key is still composed by positionKey() for anyone who wants to
 * reason about the name; it is simply never written.
 */
function usableId(videoId: string): boolean {
  if (typeof videoId !== "string") return false;
  const id = videoId.trim();
  if (!id || id.length > 200) return false;
  return !/[\s/?#\\]/.test(id);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses a stored string into an object or gives up. The parse sits in the
 * guard because the string is arbitrary: anything can be sitting under the key,
 * including a truncated write or another app's leftovers, and a thrown SyntaxError
 * here would surface as a player that cannot start.
 *
 * A non-object (a number, an array, a quoted string) is treated exactly like a
 * parse failure, because for this file's purposes it is one.
 */
function readObject(key: string): Record<string, unknown> | null {
  const raw = readRaw(key);
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** JSON can only carry real numbers, so a field that is not one is either a
 *  different shape or a string someone typed in by hand. Neither is coerced: a
 *  string "1.5" in a numeric field means the record is not the thing this code
 *  expects, and guessing at it is how a rate of NaN reaches the element. */
function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Snaps a value onto a closed set of legal ones. Ties resolve downward, so a
 * stale or hand-written value can never leave the video running faster than the
 * fastest speed on offer, and can never creep upward over repeated round trips.
 */
function nearestStep(steps: readonly number[], v: number): number {
  let best = steps[0];
  for (const s of steps) {
    if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  }
  return best;
}

/** Milliseconds is all the precision a media element's currentTime ever really
 *  carries, and rounding keeps the stored string from filling up with float
 *  noise every time a position lands between two representable doubles. */
const roundSeconds = (v: number): number => Math.round(v * 1000) / 1000;

// ── resume ────────────────────────────────────────────────

/**
 * Whether a stored position is worth restoring. Meaningful means past the
 * opening edge and short of the end (skill 5.1).
 *
 * The tail cannot be measured without a length, so a missing, zero or
 * non-finite duration falls back to the opening rule alone: there is no end in
 * sight to be near, and refusing here would silently drop a real position every
 * time a caller asks before metadata has arrived. Nothing unresumable reaches
 * the store in that state anyway, because savePosition refuses to write a
 * position it cannot measure.
 */
export function shouldResume(position: number, duration: number): boolean {
  const t = finiteNumber(position);
  if (t === null || t <= RESUME_EDGE_SECONDS) return false;
  const d = finiteNumber(duration);
  if (d === null || d <= 0) return true;
  return t < d - RESUME_EDGE_SECONDS;
}

/**
 * The position to hand the engine as its start position, or 0 for none.
 *
 * The number comes back untouched when it is restorable, because re-scaling it
 * here would make the value on screen disagree with the value the element is
 * given. The lecture profile's courtesy rewind (skill 9.1) is likewise the
 * caller's arithmetic to do, not this function's: a preference layer that
 * quietly moved the playhead would be impossible to reason about from the UI.
 */
export function resumeAt(position: number, duration: number): number {
  const t = finiteNumber(position);
  if (t === null || !shouldResume(t, duration)) return 0;
  return t;
}

/**
 * The saved position for a video, or 0. The stored duration is read alongside
 * it because the tail rule needs the length the position was captured against:
 * a file replaced under the same id, or a container that reports a different
 * length than it did before, is judged against what it actually was.
 *
 * Reading never writes. A read that repaired or pruned storage would be a
 * surprising side effect, and would also mean loading a video could fail on a
 * WebView whose storage has just become read-only.
 */
export function loadPosition(videoId: string): number {
  if (!usableId(videoId)) return 0;
  const rec = readObject(positionKey(videoId));
  if (!rec) return 0;
  const t = finiteNumber(rec.t);
  if (t === null) return 0;
  return resumeAt(t, finiteNumber(rec.d) ?? 0);
}

/**
 * Remembers where the video is. The caller owns the throttle (skill 5.1 asks for
 * roughly every five seconds, plus on pause, on hide, and before unmount), so
 * this function stays a plain write with no timer of its own.
 *
 * A position written against an unknown length is refused outright. It is not a
 * place in a video that is known to have one, and a later read would have to
 * guess at the tail against a length the record never carried.
 *
 * Anything the resume rule would refuse is removed instead of written. The tail
 * case is the one the skill is really about: a finished lecture has to restart
 * at zero, and deleting the record is what makes that stick rather than leaving
 * a 95% position behind to be re-examined on every open. A position still inside
 * the opening edge goes the same way, since it would never be restored anyway and
 * would otherwise accumulate a useless record per video.
 */
export function savePosition(videoId: string, position: number, duration: number): void {
  if (!usableId(videoId)) return;
  const t = finiteNumber(position);
  const d = finiteNumber(duration);
  if (t === null || t < 0) return;
  if (d === null || d <= 0) return;
  if (!shouldResume(t, d)) {
    clearPosition(videoId);
    return;
  }
  writeRaw(
    positionKey(videoId),
    JSON.stringify({ t: roundSeconds(t), d: roundSeconds(d), at: Date.now() }),
  );
}

/** Forgets one video, so it opens at the beginning. Used when a file is deleted
 *  or re-imported, and by savePosition when there is nothing left to resume. */
export function clearPosition(videoId: string): void {
  if (!usableId(videoId)) return;
  dropRaw(positionKey(videoId));
}

/**
 * Reads the global preferences, field by field.
 *
 * A record that is not an object at all is discarded whole and the defaults are
 * returned. A record that is an object but has a bad field keeps its good fields:
 * a lone bad volume is not a reason to forget that this user watches at 1.5x,
 * and each field has a default that is exactly as good a fallback as starting
 * from nothing. Repairing a half-good record is not in tension with discarding a
 * bad one; what is refused is guessing at a value whose meaning is unknown.
 */
function readPrefs(): PlayerPrefs {
  const out: PlayerPrefs = { ...DEFAULT_PREFS };
  const rec = readObject(PREFS_KEY);
  if (!rec) return out;

  const rate = finiteNumber(rec.rate);
  if (rate !== null) out.rate = nearestStep(SPEED_STEPS, rate);

  const volume = finiteNumber(rec.volume);
  if (volume !== null) out.volume = clamp(volume, 0, 1);

  if (typeof rec.muted === "boolean") out.muted = rec.muted;

  const skip = finiteNumber(rec.skipSeconds);
  if (skip !== null) out.skipSeconds = nearestStep(SKIP_CHOICES, skip);

  if (typeof rec.captionsOn === "boolean") out.captionsOn = rec.captionsOn;

  return out;
}

/** The preferences to apply when the player mounts. Always a fresh object, so a
 *  caller adjusting what it got back cannot edit the defaults for everyone. */
export function loadPrefs(): PlayerPrefs {
  return readPrefs();
}

/**
 * Merges a patch into the stored preferences and answers with what is now saved.
 *
 * The patch goes through the same validation as a read, so a value of 9999 or -4
 * arriving from a slider, a restore, or a test lands as the nearest legal step
 * or the clamped edge. A field that is absent, undefined, or of the wrong type is
 * left as it was rather than reset: a patch that happens to carry
 * `{ volume: undefined }` is the common shape of a spread object and must not be
 * read as a request to forget the volume.
 *
 * The answer is the persisted record, not the patch, so the caller can apply
 * exactly what survived the trip to storage.
 */
export function savePrefs(patch: Partial<PlayerPrefs>): PlayerPrefs {
  const next = readPrefs();

  if (patch && typeof patch === "object") {
    const rate = finiteNumber(patch.rate);
    if (rate !== null) next.rate = nearestStep(SPEED_STEPS, rate);

    const volume = finiteNumber(patch.volume);
    if (volume !== null) next.volume = clamp(volume, 0, 1);

    if (typeof patch.muted === "boolean") next.muted = patch.muted;

    const skip = finiteNumber(patch.skipSeconds);
    if (skip !== null) next.skipSeconds = nearestStep(SKIP_CHOICES, skip);

    if (typeof patch.captionsOn === "boolean") next.captionsOn = patch.captionsOn;
  }

  writeRaw(PREFS_KEY, JSON.stringify(next));
  return next;
}

/** Back to the defaults, by removing the record rather than writing one, so
 *  there is nothing left behind for a later read to interpret. Per-video
 *  positions are deliberately untouched: a reset of the controls is not a
 *  request to forget where the user was. */
export function resetPrefs(): void {
  dropRaw(PREFS_KEY);
}
