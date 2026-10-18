/**
 * The headless core of the StudyDesk player: the native engine adapter plus the
 * state machine, with no React and no rendering anywhere in this file.
 *
 * A player is three layers that have to stay apart - the engine that decodes,
 * this core that owns state, and the UI that renders it. The tell for a bad
 * split is when you cannot unit test the core without rendering a component, so
 * every pure function here (clamp, scrubTarget, precisionScale, accumulateSeek,
 * rateStep, mapMediaError) is deterministic and side-effect free, and everything
 * that touches the DOM lives inside a function body rather than at module scope.
 * That last rule is what keeps the file importable from `bun test`, where there
 * is no window, no document and no video element.
 *
 * The rule this file exists to enforce, from the skill's state machine pitfalls:
 * `wantsToPlay` is the caller's intent, tracked next to - never derived from -
 * the element's `paused` flag. A seek, a buffer stall and an engine that pauses
 * itself during a seek all fire `pause`; if the UI read intent off that flag it
 * would flicker between play and pause three times during one scrub.
 */

export type PlayerStatus =
  | "idle" | "loading" | "ready" | "playing" | "paused"
  | "buffering" | "seeking" | "ended" | "error";

export type PlayerErrorCategory =
  | "network" | "notfound" | "unsupported" | "decode" | "permission";

export interface PlayerError {
  category: PlayerErrorCategory;
  /** Human sentence shown to the user. Never a raw code (skill 4.7 / 11). */
  message: string;
  /** Small expandable technical detail for support. */
  detail?: string;
}

export interface BufferedRange { start: number; end: number }

export interface PlayerState {
  status: PlayerStatus;
  /** USER INTENT, tracked separately from raw element state so the UI does not
   *  flicker between play and pause when a seek or buffer interrupts playback. */
  wantsToPlay: boolean;
  currentTime: number;      // seconds
  duration: number;         // seconds; may be NaN before metadata — guard every use
  buffered: BufferedRange[];
  playbackRate: number;
  volume: number;           // 0..1
  muted: boolean;
  isLive: boolean;
  isFullscreen: boolean;
  /** True only once `waiting` has lasted ~400ms. See skill 1.2 — a spinner that
   *  flashes on every tiny stall is an anti-pattern. */
  buffering: boolean;
  /** Set while the user is actively dragging the scrubber. */
  scrubbing: boolean;
  error?: PlayerError;
}

export interface LoadOptions {
  startAt?: number;
  autoplay?: boolean;
  poster?: string;
}

export interface PlayerController {
  attach(el: HTMLVideoElement): void;
  load(src: string, opts?: LoadOptions): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  toggle(): void;
  seekTo(seconds: number): void;
  seekBy(delta: number): void;
  /** Live preview while dragging; does NOT seek the engine until commit(). */
  previewSeek(seconds: number): void;
  /** Commit the value set by previewSeek (skill 4.2: pause timeupdate-driven
   *  updates while dragging, commit the seek on release, restore play state). */
  commitSeek(): void;
  cancelScrub(): void;
  setRate(rate: number): void;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  enterFullscreen(el: HTMLElement): Promise<void>;
  exitFullscreen(): void;
  retry(): void;
  destroy(): void;
  getState(): PlayerState;
  getBufferedAt(t: number): number;   // 0..1 fraction buffered at time t
  getProgress(): number;              // currentTime/duration, guarded, 0 if unknown
  subscribe(listener: (s: PlayerState) => void): () => void;
  /** The interval `seekBy()` uses, and the one the UI should label its skip
   *  buttons with. Optional so a hand-written controller still satisfies this
   *  interface. */
  readonly skipSeconds?: number;
}

// ── pure helpers ────────────────────────────────────────────

export function clamp(v: number, lo: number, hi: number): number {
  // A reversed range would make every clamp return the wrong bound, and a NaN
  // would poison whatever it was assigned to, so both are handled here rather
  // than at each of the two dozen call sites.
  const low = lo <= hi ? lo : hi;
  const high = lo <= hi ? hi : lo;
  if (Number.isNaN(v)) return low;
  return v < low ? low : v > high ? high : v;
}

export function safeDuration(d: number): number {
  // NaN before metadata, Infinity on a live stream, and some engines report a
  // negative duration mid-teardown. Every one of them has to become 0 here so
  // that the divisions downstream cannot produce NaN into the UI.
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Where a drag of `deltaPx` from `startTime` lands, in seconds.
 *
 * Two modes, and which one is used is the whole point of precision scrubbing:
 *  - With `pixelsPerSecond`, the caller owns the mapping. The timeline computes
 *    `pps = (duration / trackWidthPx) * precisionScale(dy)`, so dragging away
 *    from the track literally converts fewer pixels into fewer seconds.
 *  - Without it, the default: one track width equals the whole video, which is
 *    what a plain horizontal drag on the video surface wants.
 */
export function scrubTarget(opts: {
  startTime: number; trackWidthPx: number; deltaPx: number;
  duration: number; pixelsPerSecond?: number;
}): number {
  const duration = safeDuration(opts.duration);
  const start = Number.isFinite(opts.startTime) ? opts.startTime : 0;
  // A non-finite delta moves the thumb nowhere. Left alone it would reach
  // clamp() as NaN and land on the low bound, which is the worst possible
  // failure mode: a broken drag silently rewinding to the start.
  const delta = Number.isFinite(opts.deltaPx) ? opts.deltaPx : 0;
  const pps = opts.pixelsPerSecond;
  let seconds: number;
  if (typeof pps === "number" && Number.isFinite(pps) && pps > 0) {
    seconds = delta / pps;
  } else {
    const width = opts.trackWidthPx;
    // A zero-width track (a hidden timeline, a layout that has not settled)
    // means there is nothing to divide by, and the drag goes nowhere.
    seconds = width > 0 ? (delta * duration) / width : 0;
  }
  return clamp(start + seconds, 0, duration);
}

/** How far the finger may stray from the track before the scrub slows down. */
const PRECISION_FREE_PX = 40;
/** The slowest a scrub gets at the bottom of the falloff. Zero would be a
 *  scrubber that stops responding, which reads as a broken player. */
const PRECISION_FLOOR = 0.08;
/** Vertical distance over which the rate falls by roughly 1/e. */
const PRECISION_FALLOFF_PX = 120;

/**
 * Precision scrubbing: dragging further away from the track slows the scrub
 * rate. Returns a multiplier where 1 is normal speed.
 *
 * The rate is 1 inside a comfortable band around the track (so an ordinary drag
 * that wobbles a few pixels still feels exactly like every other player), then
 * decays exponentially to a floor. Continuous and monotonic, which matters
 * because a stepped curve makes the playhead jump and then creep.
 */
export function precisionScale(dyPx: number): number {
  const away = Math.abs(dyPx);
  if (!Number.isFinite(away) || away <= PRECISION_FREE_PX) return 1;
  const rate =
    PRECISION_FLOOR + (1 - PRECISION_FLOOR) * Math.exp(-(away - PRECISION_FREE_PX) / PRECISION_FALLOFF_PX);
  return clamp(rate, PRECISION_FLOOR, 1);
}

/** Double-tap seeks stack for about this long (skill 4.4). */
export const SEEK_STACK_WINDOW_MS = 600;

/**
 * Double-tap accumulation: taps inside the window add up (+10, +20, +30) instead
 * of resetting to +10 every time. Returns the NEW accumulated seconds and the
 * timestamp to store for the next tap.
 *
 * The caller resets `prev` to `{ total: 0, at: now }` when the direction flips,
 * because reversing a gesture should not read as "forward twenty seconds".
 */
export function accumulateSeek(
  prev: { total: number; at: number },
  now: number,
  stepSeconds: number,
  windowMs: number = SEEK_STACK_WINDOW_MS,
): { total: number; at: number } {
  const prevTotal = Number.isFinite(prev.total) ? prev.total : 0;
  const prevAt = Number.isFinite(prev.at) ? prev.at : NaN;
  const elapsed = now - prevAt;
  // The lower bound matters as much as the upper one: a clock that jumps
  // backwards (a resumed device, a timezone-corrected Date) would otherwise make
  // an old tap look impossibly recent and stack onto it.
  const withinWindow = elapsed >= 0 && elapsed <= windowMs;
  return { total: withinWindow ? prevTotal + stepSeconds : stepSeconds, at: now };
}

/** Playback speeds offered by the menu (skill P0). Pitch is preserved. */
export const SPEED_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Float slack when matching a current rate against the step list, so a rate the
 *  engine echoed back as 1.0000001 does not skip a whole step. */
const RATE_EPSILON = 1e-6;

export function rateStep(current: number, dir: 1 | -1): number {
  if (!Number.isFinite(current)) return 1;
  if (dir >= 1) {
    for (const step of SPEED_STEPS) {
      if (step > current + RATE_EPSILON) return step;
    }
    return SPEED_STEPS[SPEED_STEPS.length - 1];
  }
  let found = SPEED_STEPS[0];
  for (const step of SPEED_STEPS) {
    if (step < current - RATE_EPSILON) found = step;
  }
  return found;
}

/** MediaError code names, used only for the expandable support detail. */
const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

const GENERIC_ERROR_MESSAGE = "This video could not be loaded. Check your connection and try again.";

/**
 * Turns whatever the element reported into one of five user-facing categories
 * with a sentence a stranger can act on.
 *
 * The raw code only ever reaches `detail`, which is the expandable bit for
 * support - skill 11 lists "raw error codes as the entire error UI" as an
 * anti-pattern. `notfound` is absent here on purpose: a <video> element cannot
 * tell a 404 from an expired signed URL, so that category only exists when an
 * engine knows the HTTP status.
 */
export function mapMediaError(e: MediaError | null | undefined): PlayerError {
  const code = e && Number.isFinite(e.code) ? e.code : 0;
  const name = MEDIA_ERROR_NAMES[code];
  const detail = name
    ? `MediaError code ${code} (${name})`
    : "The device reported a media failure with no error code";
  switch (code) {
    case 1:
      return {
        category: "network",
        message: "Playback stopped before the video could continue.",
        detail,
      };
    case 2:
      return { category: "network", message: GENERIC_ERROR_MESSAGE, detail };
    case 3:
      return {
        category: "decode",
        message: "This video could not be decoded. The file may be damaged or incomplete.",
        detail,
      };
    case 4:
      return {
        category: "unsupported",
        message: "This device cannot play this video's format or codec.",
        detail,
      };
    default:
      return { category: "network", message: GENERIC_ERROR_MESSAGE, detail };
  }
}

// ── internal constants ──────────────────────────────────────

/**
 * How long `waiting` has to last before the spinner is allowed to appear. The
 * skill's 300–500ms band, and the reason for it is that every single-buffer
 * stall fires `waiting` for a frame or two; show a spinner for those and the
 * player strobes.
 */
const BUFFERING_SHOW_DELAY_MS = 400;

/** Float slack before a seek is considered a no-op. */
const SEEK_EPSILON_SECONDS = 0.04;

/**
 * How long a seek may be in flight before we stop believing the `seeked` event
 * is coming. Without this, one engine that never fires `seeked` would leave the
 * position ticker stopped forever.
 */
const SEEK_WATCHDOG_MS = 4000;

/** `load()` resolves rather than hanging if metadata never arrives at all. */
const LOAD_METADATA_TIMEOUT_MS = 15000;

/** Rate bounds for the element, deliberately wider than the menu. */
const MIN_RATE = 0.25;
const MAX_RATE = 8;

/** A stream claiming to be longer than a day is a live edge, not a lecture. */
const LIVE_DURATION_THRESHOLD_S = 86400;

/** readyState values, spelled out because a bare 2 in a ternary reads as a typo. */
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;

/** Double-tap window used by `seekBy` callers that stack their own seeks. */
const DEFAULT_SKIP_SECONDS = 10;

/**
 * rAF and the DOM are resolved at call time, never at module scope, because
 * `bun test` imports this file with no window at all and a top-level
 * `requestAnimationFrame` reference would throw before the first test ran.
 */
function hasRaf(): boolean {
  return typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function";
}

function docOrNull(): Document | null {
  return typeof document === "undefined" ? null : document;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function freshState(): PlayerState {
  return {
    status: "idle",
    wantsToPlay: false,
    currentTime: 0,
    duration: 0,
    buffered: [],
    playbackRate: 1,
    volume: 1,
    muted: false,
    isLive: false,
    isFullscreen: false,
    buffering: false,
    scrubbing: false,
  };
}

// ── controller ──────────────────────────────────────────────

export function createPlayer(opts?: { skipSeconds?: number }): PlayerController {
  const skipSeconds =
    typeof opts?.skipSeconds === "number" && Number.isFinite(opts.skipSeconds) && opts.skipSeconds > 0
      ? opts.skipSeconds
      : DEFAULT_SKIP_SECONDS;

  // The mutable working copy and the published snapshot are deliberately two
  // objects: subscribers get a frozen-in-time value they can diff against, and
  // never a reference that mutates under them mid-render.
  const st = freshState();
  let published: PlayerState = freshState();

  let el: HTMLVideoElement | null = null;
  let destroyed = false;
  let source = "";

  // Intent is only ever written by play(), pause(), load(), retry() and the
  // element's `ended` - never by the `pause`/`playing` events, which fire for
  // reasons that have nothing to do with what the user asked for.
  let wantsToPlay = false;
  let endedFlag = false;
  let hasStarted = false;
  let metadataReady = false;
  let permissionBlocked = false;

  // Seek bookkeeping.
  let pendingSeek: number | null = null;
  let scrubbing = false;
  let scrubTargetTime: number | null = null;
  let wasPlayingBeforeScrub = false;
  let seekingFlag = false;
  let seekWatchdogUntil = 0;

  // Coalesced element writes. Volume and mute are cheap on the element and
  // expensive in a render, and a slider or a held arrow key produces far more
  // calls than frames.
  let pendingWrites: { rate?: number; volume?: number; muted?: boolean } | null = null;

  let bufferingTimer: ReturnType<typeof setTimeout> | null = null;
  let rafId = 0;
  let rafBroken = false;

  // Resume position for Retry, kept inside the video rather than at its edges.
  let resumePosition = 0;
  let startAt = 0;
  let startApplied = false;
  let autoplayAfterLoad = false;
  let loadToken = 0;

  const listeners = new Set<(s: PlayerState) => void>();
  /** Every listener handed to the element or the document, so destroy() can
   *  take all of them off. Leaked listeners are how a closed modal keeps
   *  playing audio. */
  const bound: Array<{ target: EventTarget; type: string; fn: EventListener }> = [];

  // ── derived status ─────────────────────────────────────────

  function readyState(): number {
    if (!el) return 0;
    return Number(el.readyState) || 0;
  }

  function isPlayingNow(): boolean {
    return !!el && !el.paused && !el.ended && readyState() >= HAVE_CURRENT_DATA;
  }

  /**
   * One place decides the status, so no two handlers can disagree about it.
   * The order matters: an error outranks everything, a blocked autoplay reads as
   * paused (the poster plus a big play button, not a dead end), and only then do
   * transient phases get a look in.
   */
  function computeStatus(): PlayerStatus {
    if (st.error && !permissionBlocked) return "error";
    if (!source) return "idle";
    if (permissionBlocked) return "paused";
    if (pendingSeek !== null || seekingFlag) return "seeking";
    if (st.buffering) return "buffering";
    if (endedFlag) return "ended";
    if (!metadataReady) return "loading";
    if (wantsToPlay) return isPlayingNow() ? "playing" : hasStarted ? "paused" : "ready";
    return hasStarted ? "paused" : "ready";
  }

  function stateDiffers(a: PlayerState, b: PlayerState): boolean {
    if (
      a.status !== b.status ||
      a.wantsToPlay !== b.wantsToPlay ||
      a.currentTime !== b.currentTime ||
      a.duration !== b.duration ||
      a.playbackRate !== b.playbackRate ||
      a.volume !== b.volume ||
      a.muted !== b.muted ||
      a.isLive !== b.isLive ||
      a.isFullscreen !== b.isFullscreen ||
      a.buffering !== b.buffering ||
      a.scrubbing !== b.scrubbing ||
      a.error !== b.error
    ) {
      return true;
    }
    if (a.buffered.length !== b.buffered.length) return true;
    for (let i = 0; i < a.buffered.length; i += 1) {
      if (a.buffered[i].start !== b.buffered[i].start || a.buffered[i].end !== b.buffered[i].end) {
        return true;
      }
    }
    return false;
  }

  function publish(): void {
    st.status = computeStatus();
    st.wantsToPlay = wantsToPlay;
    st.scrubbing = scrubbing;
    const next: PlayerState = { ...st };
    if (!stateDiffers(published, next)) return;
    published = next;
    // Copied before iterating: a subscriber that unsubscribes from inside its
    // own callback would otherwise mutate the set being walked.
    for (const fn of Array.from(listeners)) {
      try {
        fn(published);
      } catch {
        // One broken subscriber must not stop the others, and a listener error
        // is never a reason to interrupt playback.
      }
    }
  }

  // ── the frame loop ─────────────────────────────────────────

  function isVisible(): boolean {
    const d = docOrNull();
    // With no document there is nothing that can hide us.
    return d ? d.visibilityState !== "hidden" : true;
  }

  function seekingNow(): boolean {
    if (seekingFlag) return true;
    return !!el && el.seeking === true;
  }

  function pendingWork(): boolean {
    return pendingSeek !== null || pendingWrites !== null;
  }

  /**
   * The loop runs while the position can move or while there is work to flush.
   * It stops when paused, when a seek is in flight, when the document is hidden
   * and after destroy - all four are the cases where a rAF callback per frame
   * is pure battery cost with nothing to show for it.
   */
  function shouldTick(): boolean {
    if (destroyed || !el) return false;
    if (!isVisible()) return false;
    if (pendingWork()) return true;
    if (scrubbing) return true;
    if (seekWatchdogUntil > monotonicNow()) return true;
    return wantsToPlay && !seekingNow();
  }

  function onFrame(): void {
    rafId = 0;
    if (destroyed || !el) return;
    if (seekWatchdogUntil > 0 && monotonicNow() > seekWatchdogUntil) {
      // The element never confirmed the seek. Give up on its `seeked` so the
      // ticker comes back instead of leaving a paused-looking player stuck.
      seekWatchdogUntil = 0;
      seekingFlag = false;
    }
    flushPendingWrites();
    flushPendingSeek();
    if (wantsToPlay && !scrubbing && !seekingNow() && !el.paused && !el.ended) {
      st.currentTime = Number(el.currentTime) || 0;
    }
    publish();
    if (shouldTick()) requestFrame();
  }

  function requestFrame(): void {
    if (destroyed || rafId !== 0 || !hasRaf()) return;
    try {
      rafId = requestAnimationFrame(onFrame);
    } catch {
      rafBroken = true;
      rafId = 0;
    }
  }

  function cancelFrame(): void {
    if (rafId === 0 || !hasRaf()) {
      rafId = 0;
      return;
    }
    try {
      cancelAnimationFrame(rafId);
    } catch {
      /* the frame was already cancelled */
    }
    rafId = 0;
  }

  /**
   * Stop the loop because playback is over - but not while something is still
   * queued. A seek that was asked for one frame earlier has to reach the engine
   * even if the user hits pause in the same breath, or the UI shows a position
   * the media never moved to.
   */
  function settleFrame(): void {
    cancelFrame();
    if (pendingWork() && isVisible()) requestFrame();
  }

  /**
   * One seek per frame, ever. A scrub produces dozens of targets a second and
   * every one of them costs a seek in the engine plus a round of segment
   * fetches; queueing them all is how a player ends up seeking fifty times to
   * reach one place.
   */
  function flushPendingSeek(): void {
    if (pendingSeek === null || !el) return;
    const target = pendingSeek;
    pendingSeek = null;
    const duration = safeDuration(el.duration);
    const to = duration > 0 ? clamp(target, 0, duration) : Math.max(0, target);
    try {
      if (Math.abs(Number(el.currentTime) - to) <= SEEK_EPSILON_SECONDS) {
        // Already there. Assigning anyway would not fire `seeking`/`seeked`, so
        // the flag we are about to set would have to wait for the watchdog.
        seekingFlag = false;
        seekWatchdogUntil = 0;
      } else {
        seekingFlag = true;
        seekWatchdogUntil = monotonicNow() + SEEK_WATCHDOG_MS;
        el.currentTime = to;
        st.currentTime = to;
      }
    } catch {
      // A torn-down or stubbed element. Nothing to seek, nothing to report.
      seekingFlag = false;
      seekWatchdogUntil = 0;
    }
    rememberPosition();
  }

  function flushPendingWrites(): void {
    if (!pendingWrites || !el) return;
    const w = pendingWrites;
    pendingWrites = null;
    try {
      if (w.rate !== undefined && el.playbackRate !== w.rate) el.playbackRate = w.rate;
      if (w.volume !== undefined && el.volume !== w.volume) el.volume = w.volume;
      if (w.muted !== undefined && el.muted !== w.muted) el.muted = w.muted;
    } catch {
      /* the element went away between queueing and flushing */
    }
  }

  function queueWrite(patch: { rate?: number; volume?: number; muted?: boolean }): void {
    pendingWrites = pendingWrites ? { ...pendingWrites, ...patch } : { ...patch };
    if (hasRaf() && !rafBroken) {
      requestFrame();
    } else {
      // No frame clock to coalesce against (a headless test, an exotic runtime):
      // correctness beats batching.
      flushPendingWrites();
    }
  }

  // ── buffering spinner ──────────────────────────────────────

  function startBufferingTimer(): void {
    if (bufferingTimer !== null || st.buffering || destroyed) return;
    bufferingTimer = setTimeout(() => {
      bufferingTimer = null;
      if (destroyed || !el) return;
      st.buffering = true;
      publish();
    }, BUFFERING_SHOW_DELAY_MS);
  }

  function clearBuffering(): void {
    if (bufferingTimer !== null) {
      clearTimeout(bufferingTimer);
      bufferingTimer = null;
    }
    st.buffering = false;
  }

  // ── element sync ───────────────────────────────────────────

  function rememberPosition(): void {
    const duration = safeDuration(st.duration);
    const t = st.currentTime;
    // Edges are not resume points: one second in is the opening, and the last
    // second is the credits, not where the user left off.
    if (t > 1 && (duration === 0 || t < duration - 1)) resumePosition = t;
  }

  function syncDuration(): void {
    if (!el) return;
    const raw = Number(el.duration);
    st.duration = safeDuration(raw);
    // Infinity is how every engine says "live". A finite stream longer than a
    // day is treated as live too, since that is what it almost always is.
    if (raw === Infinity) st.isLive = true;
    else if (Number.isFinite(raw) && raw > 0) st.isLive = raw > LIVE_DURATION_THRESHOLD_S;
  }

  function syncBuffered(): void {
    if (!el) return;
    const ranges: BufferedRange[] = [];
    try {
      const b = el.buffered;
      for (let i = 0; i < b.length; i += 1) {
        const start = Number(b.start(i));
        const end = Number(b.end(i));
        if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ start, end });
      }
    } catch {
      // `buffered` throws on a detached or never-loaded element in some engines.
      return;
    }
    st.buffered = ranges;
  }

  function syncFromElement(): void {
    if (!el) return;
    syncDuration();
    syncBuffered();
    try {
      st.volume = el.volume;
      st.muted = el.muted;
      st.playbackRate = Number(el.playbackRate) || st.playbackRate;
      if (!scrubbing) st.currentTime = Number(el.currentTime) || 0;
    } catch {
      /* a stubbed element may not expose these */
    }
  }

  // ── playback ───────────────────────────────────────────────

  /**
   * Post-`ended` the element is sitting at the duration, so "play" has to mean
   * "start over" rather than "resume from the last frame". The seek is applied
   * synchronously here on purpose: queueing it to the next frame would let
   * `play()` win the race and leave the restart parked at the end.
   */
  function restartFromStart(): void {
    endedFlag = false;
    pendingSeek = null;
    if (el) {
      try {
        if (Math.abs(Number(el.currentTime)) > SEEK_EPSILON_SECONDS) el.currentTime = 0;
      } catch {
        /* nothing to restart from */
      }
    }
    st.currentTime = 0;
  }

  function handlePlayRejection(err: unknown): void {
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError") {
      // Not a failure. Something we did on purpose - a pause(), a new load() -
      // interrupted the promise, which is the documented behaviour of play().
      // The caller who interrupted it has already written the real intent.
      publish();
      return;
    }
    if (name === "NotAllowedError") {
      // The autoplay policy refused. The anti-pattern here is the retry loop:
      // every browser blocks this until a real gesture, so retrying forever just
      // burns frames. Instead the state carries a permission affordance and the
      // UI shows the poster with a large play button - and intent goes back to
      // false, because nothing is playing and the glyph must not claim it is.
      wantsToPlay = false;
      permissionBlocked = true;
      st.error = {
        category: "permission",
        message: "Automatic playback was blocked. Tap play to start the video.",
        detail: "play() rejected with NotAllowedError",
      };
      clearBuffering();
      publish();
      return;
    }
    // Anything else: prefer the element's own diagnosis, fall back to the
    // generic sentence so the UI never has to render a bare rejection.
    if (el && el.error) {
      onElementError();
      return;
    }
    const mapped = mapMediaError(null);
    st.error = mapped;
    wantsToPlay = false;
    clearBuffering();
    publish();
  }

  async function attemptPlay(): Promise<void> {
    if (destroyed || !el || !source) return;
    if (endedFlag || el.ended) restartFromStart();
    wantsToPlay = true;
    // A fresh attempt clears the previous refusal; if it is going to be refused
    // again the rejection puts a new one right back.
    st.error = undefined;
    permissionBlocked = false;
    publish();
    requestFrame();
    try {
      await el.play();
      // Counted as started here as well as on the `playing` event: `playing` is
      // a "data is flowing" signal, and an engine that is paused again before it
      // arrives has still been started, which is what separates `ready` from
      // `paused` in the status.
      hasStarted = true;
      publish();
    } catch (err) {
      if (destroyed) return;
      handlePlayRejection(err);
    }
  }

  function onElementError(): void {
    rememberPosition();
    clearBuffering();
    seekingFlag = false;
    seekWatchdogUntil = 0;
    const mapped = mapMediaError(el ? el.error : null);
    permissionBlocked = mapped.category === "permission";
    st.error = mapped;
    wantsToPlay = false;
    endedFlag = false;
    publish();
  }

  // ── element listeners ──────────────────────────────────────

  function add(target: EventTarget | null, type: string, fn: EventListener): void {
    if (!target) return;
    target.addEventListener(type, fn);
    bound.push({ target, type, fn });
  }

  function detachElement(): void {
    for (const b of bound.splice(0, bound.length)) {
      try {
        b.target.removeEventListener(b.type, b.fn);
      } catch {
        /* already gone */
      }
    }
  }

  function onLoadedMetadata(): void {
    metadataReady = true;
    endedFlag = false;
    syncDuration();
    syncBuffered();
    try {
      st.currentTime = Number(el?.currentTime) || 0;
    } catch {
      /* ignore */
    }
    // Resume position goes in as the engine start position when the engine has
    // one. The native element does not, so the closest honest equivalent is to
    // seek once, here, before the first painted frame - a post-load seek from
    // the app layer would fetch the wrong segments first (skill 2.3).
    if (!startApplied && startAt > 0) {
      startApplied = true;
      const duration = safeDuration(st.duration);
      const to = duration > 0 ? Math.min(startAt, duration) : startAt;
      if (el) {
        try {
          el.currentTime = to;
        } catch {
          /* ignore */
        }
      }
      st.currentTime = to;
    } else {
      startApplied = true;
    }
    publish();
  }

  function attachListeners(target: HTMLVideoElement): void {
    add(target, "loadedmetadata", onLoadedMetadata);
    add(target, "durationchange", () => {
      syncDuration();
      publish();
    });
    add(target, "loadeddata", () => {
      clearBuffering();
      publish();
    });
    add(target, "canplay", () => {
      clearBuffering();
      publish();
    });
    add(target, "canplaythrough", () => {
      clearBuffering();
      publish();
    });
    add(target, "progress", () => {
      syncBuffered();
      // `progress` says the buffer moved, not where the playhead is, but it
      // does fire at moments when the position has changed without a
      // `timeupdate` - after a source restore, for one - and a state object
      // that lags the element is worse than one extra property read.
      if (el && !scrubbing && !seekingNow()) st.currentTime = Number(el.currentTime) || 0;
      publish();
    });
    add(target, "timeupdate", () => {
      if (!el) return;
      syncBuffered();
      // The element's own cadence is roughly four times a second, so this only
      // has to keep a paused player's label honest; the rAF loop owns the
      // playhead while it is actually moving.
      if (!scrubbing && !seekingNow()) st.currentTime = Number(el.currentTime) || 0;
      rememberPosition();
      publish();
    });
    add(target, "play", () => {
      // Recorded as started, but intent stays where the caller left it.
      publish();
    });
    add(target, "playing", () => {
      hasStarted = true;
      endedFlag = false;
      clearBuffering();
      publish();
      requestFrame();
    });
    add(target, "pause", () => {
      // Deliberately does not touch wantsToPlay: engines pause themselves during
      // a seek and on a stall, and a UI reading intent from here flickers.
      publish();
    });
    add(target, "waiting", () => {
      startBufferingTimer();
      publish();
    });
    add(target, "stall", () => {
      // A long stall may not fire `waiting` at all on some engines; the same
      // delayed timer keeps the spinner from being wrong in either direction.
      startBufferingTimer();
    });
    add(target, "seeking", () => {
      seekingFlag = true;
      seekWatchdogUntil = monotonicNow() + SEEK_WATCHDOG_MS;
      if (el) st.currentTime = Number(el.currentTime) || 0;
      publish();
    });
    add(target, "seeked", () => {
      seekingFlag = false;
      seekWatchdogUntil = 0;
      clearBuffering();
      if (el) st.currentTime = Number(el.currentTime) || 0;
      rememberPosition();
      publish();
      requestFrame();
    });
    add(target, "ended", () => {
      endedFlag = true;
      // The content is over, so "keeps playing" is no longer what anyone wants.
      wantsToPlay = false;
      hasStarted = true;
      clearBuffering();
      settleFrame();
      if (el) st.currentTime = Number(el.currentTime) || 0;
      publish();
    });
    add(target, "ratechange", () => {
      if (el) st.playbackRate = Number(el.playbackRate) || st.playbackRate;
      publish();
    });
    add(target, "volumechange", () => {
      // The user may have changed volume with hardware keys, or muted from the
      // headset; either way the element is the source of truth here.
      if (el) {
        st.volume = el.volume;
        st.muted = el.muted;
      }
      publish();
    });
    add(target, "emptied", () => {
      metadataReady = false;
      endedFlag = false;
      seekingFlag = false;
      seekWatchdogUntil = 0;
      clearBuffering();
      st.buffered = [];
      publish();
    });
    add(target, "error", () => {
      if (el && el.error) onElementError();
    });
  }

  function setPitchPreservation(video: HTMLVideoElement): void {
    // A speed menu without pitch preservation sounds like a broken record, and
    // a lecture sped up to 2x with chipmunk voices is unusable.
    try {
      if ("preservesPitch" in video) video.preservesPitch = true;
      // Some older Android WebViews only answer to the -moz- spelling.
      const legacy = video as HTMLVideoElement & { mozPreservesPitch?: boolean };
      if (legacy.mozPreservesPitch !== undefined) legacy.mozPreservesPitch = true;
    } catch {
      /* a locked-down WebView can refuse the write; playback still works */
    }
  }

  // ── the public controller ──────────────────────────────────

  function attach(next: HTMLVideoElement): void {
    if (destroyed || !next) return;
    if (el && el !== next) {
      // Re-attaching to a new element must not leave the old one playing.
      detachElement();
      cancelFrame();
      clearBuffering();
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        /* the old element is already gone */
      }
    }
    el = next;
    setPitchPreservation(el);
    attachListeners(el);
    if (source) {
      // A UI that remounts the <video> mid-session hands us a blank element
      // with a source we already know about.
      try {
        el.src = source;
        el.load();
        startApplied = false;
      } catch {
        /* ignore */
      }
    }
    syncFromElement();
    const d = docOrNull();
    if (d) {
      add(d, "visibilitychange", () => {
        // No automatic pause: StudyDesk treats background listening as a
        // feature (audio-only mode for a commute), and the product, not the
        // core, owns that decision. What is unconditional is not burning a
        // frame callback per tick on a hidden WebView.
        if (isVisible()) requestFrame();
        else cancelFrame();
      });
      add(d, "fullscreenchange", () => {
        st.isFullscreen = d.fullscreenElement != null;
        publish();
      });
      const webkitDoc = d as Document & {
        webkitFullscreenElement?: Element | null;
        webkitCancelFullScreen?: () => void;
      };
      add(d, "webkitfullscreenchange", () => {
        st.isFullscreen = (d.fullscreenElement ?? webkitDoc.webkitFullscreenElement) != null;
        publish();
      });
    }
    publish();
    requestFrame();
  }

  async function load(src: string, options?: LoadOptions): Promise<void> {
    if (destroyed || !el || !src) return;
    source = src;
    loadToken += 1;
    const token = loadToken;

    const rawStart = options?.startAt;
    startAt =
      typeof rawStart === "number" && Number.isFinite(rawStart) && rawStart > 0 ? rawStart : 0;
    startApplied = false;
    autoplayAfterLoad = options?.autoplay === true;
    resumePosition = startAt;
    wantsToPlay = autoplayAfterLoad;

    // A new source invalidates every flag the old one set.
    st.error = undefined;
    st.currentTime = 0;
    st.duration = 0;
    st.buffered = [];
    st.isLive = false;
    endedFlag = false;
    metadataReady = false;
    permissionBlocked = false;
    seekingFlag = false;
    seekWatchdogUntil = 0;
    pendingSeek = null;
    scrubbing = false;
    scrubTargetTime = null;
    hasStarted = false;
    clearBuffering();

    try {
      // The poster is rendered by the UI, but it belongs to the element and to
      // the load that caused it.
      el.poster = options?.poster ?? "";
      el.src = src;
      el.load();
    } catch {
      onElementError();
      return;
    }
    publish();

    // Start the fetch immediately rather than after metadata: the element
    // buffers while it loads, and waiting turns a fast local file into a slow
    // one. This is the muted-autoplay path the skill recommends, so the caller
    // has usually already muted us and will not trip NotAllowedError.
    if (autoplayAfterLoad) void attemptPlay();

    await waitForMetadata(token);
  }

  /** Resolves when the engine has told us about the media, on error, on a
   *  destroy, or after a long timeout - never rejects, because a UI that awaits
   *  this should never have to wrap it in a try/catch to survive an error state
   *  the state object already describes. */
  function waitForMetadata(token: number): Promise<void> {
    if (!el) return Promise.resolve();
    if (metadataReady && token === loadToken) return Promise.resolve();
    if (readyState() >= HAVE_METADATA) {
      onLoadedMetadata();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const video = el;
      if (!video) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        // A newer load owns the outcome now; this one just stops waiting.
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("loadedmetadata", finish);
        video.removeEventListener("loadeddata", finish);
        video.removeEventListener("canplay", finish);
        video.removeEventListener("error", finish);
      };
      const timer = setTimeout(finish, LOAD_METADATA_TIMEOUT_MS);
      video.addEventListener("loadedmetadata", finish);
      video.addEventListener("loadeddata", finish);
      video.addEventListener("canplay", finish);
      video.addEventListener("error", finish);
      if (destroyed) finish();
    });
  }

  async function play(): Promise<void> {
    if (destroyed || !el || !source) return;
    await attemptPlay();
  }

  function pause(): void {
    if (destroyed) return;
    wantsToPlay = false;
    if (el) {
      try {
        el.pause();
      } catch {
        /* already paused */
      }
    }
    settleFrame();
    publish();
  }

  function toggle(): void {
    if (wantsToPlay) pause();
    else void play();
  }

  function seekTo(seconds: number): void {
    if (destroyed || !el || !Number.isFinite(seconds)) return;
    // Committing a seek out of `ended` restarts the content, which is what a
    // tap on the timeline at the very end is asking for.
    if (endedFlag && seconds < safeDuration(el.duration)) endedFlag = false;
    const duration = safeDuration(el.duration);
    const target = duration > 0 ? clamp(seconds, 0, duration) : Math.max(0, seconds);
    pendingSeek = target;
    requestFrame();
    if (!hasRaf() || rafBroken) flushPendingSeek();
    publish();
  }

  function seekBy(delta: number): void {
    if (!Number.isFinite(delta)) return;
    // While dragging, the thumb is the source of truth: stacking seeks off the
    // element's time would walk backwards against the finger.
    const base = scrubbing && scrubTargetTime !== null ? scrubTargetTime : st.currentTime;
    seekTo(base + delta);
  }

  function previewSeek(seconds: number): void {
    if (destroyed || !el || !Number.isFinite(seconds)) return;
    if (!scrubbing) {
      wasPlayingBeforeScrub = wantsToPlay;
      scrubbing = true;
      // A preview supersedes anything a keyboard shortcut queued earlier.
      pendingSeek = null;
      scrubTargetTime = st.currentTime;
    }
    const duration = safeDuration(el.duration);
    // An unknown duration must not collapse the thumb to zero.
    const target = clamp(seconds, 0, duration > 0 ? duration : Infinity);
    scrubTargetTime = target;
    st.currentTime = target;
    // The engine keeps playing underneath, but nothing we emit while dragging
    // touches currentTime, so the thumb and the readout agree on one number.
    publish();
    requestFrame();
  }

  function commitSeek(): void {
    if (destroyed) return;
    const target = scrubTargetTime;
    const resume = wasPlayingBeforeScrub;
    const wasScrubbing = scrubbing;
    scrubbing = false;
    scrubTargetTime = null;
    wasPlayingBeforeScrub = false;
    if (wasScrubbing && target !== null) pendingSeek = target;
    publish();
    requestFrame();
    if (pendingSeek !== null && (!hasRaf() || rafBroken)) flushPendingSeek();
    // Seeking while paused must stay paused; seeking while playing must come
    // back. Only the element's own paused flag tells us which, because some
    // engines pause themselves for the duration of a seek.
    if (resume && el && el.paused) void attemptPlay();
    publish();
  }

  function cancelScrub(): void {
    if (destroyed || !scrubbing) return;
    scrubbing = false;
    scrubTargetTime = null;
    wasPlayingBeforeScrub = false;
    // Nothing was ever seeked during the drag, so the element still holds the
    // pre-drag position: read it back rather than guessing.
    if (el) {
      try {
        st.currentTime = Number(el.currentTime) || 0;
      } catch {
        /* ignore */
      }
    }
    publish();
    requestFrame();
  }

  function setRate(rate: number): void {
    if (destroyed || !Number.isFinite(rate) || rate <= 0) return;
    st.playbackRate = clamp(rate, MIN_RATE, MAX_RATE);
    queueWrite({ rate: st.playbackRate });
    publish();
    requestFrame();
  }

  function setVolume(v: number): void {
    if (destroyed || !Number.isFinite(v)) return;
    st.volume = clamp(v, 0, 1);
    queueWrite({ volume: st.volume });
    publish();
    requestFrame();
  }

  function setMuted(m: boolean): void {
    if (destroyed) return;
    st.muted = m === true;
    queueWrite({ muted: st.muted });
    publish();
    requestFrame();
  }

  function fullscreenBlocked(cause: unknown): Error {
    const err = new Error("Fullscreen is not available on this device.");
    if (cause !== undefined) (err as Error & { cause?: unknown }).cause = cause;
    return err;
  }

  async function enterFullscreen(target: HTMLElement): Promise<void> {
    if (destroyed || !target) return;
    const fullTarget = target as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      if (typeof fullTarget.requestFullscreen === "function") {
        await fullTarget.requestFullscreen();
        return;
      }
    } catch (cause) {
      // Rejected rather than swallowed: skill 4.7 says a blocked fullscreen must
      // say so, and the caller is the one that can offer an alternative.
      throw fullscreenBlocked(cause);
    }
    // Android WebView still ships the -webkit- spelling on many OEM builds.
    if (typeof fullTarget.webkitRequestFullscreen === "function") {
      try {
        fullTarget.webkitRequestFullscreen();
        return;
      } catch (cause) {
        throw fullscreenBlocked(cause);
      }
    }
    throw fullscreenBlocked(undefined);
  }

  function exitFullscreen(): void {
    const d = docOrNull();
    if (!d) return;
    try {
      if (typeof d.exitFullscreen === "function") {
        void d.exitFullscreen().catch(() => {});
        return;
      }
    } catch {
      /* fall through to the legacy path */
    }
    const legacyDoc = d as Document & { webkitCancelFullScreen?: () => void };
    if (typeof legacyDoc.webkitCancelFullScreen === "function") {
      try {
        legacyDoc.webkitCancelFullScreen();
      } catch {
        /* ignore */
      }
      return;
    }
    const video = el as (HTMLVideoElement & { webkitExitFullscreen?: () => void }) | null;
    if (video && typeof video.webkitExitFullscreen === "function") {
      try {
        video.webkitExitFullscreen();
      } catch {
        /* ignore */
      }
    }
  }

  function retry(): void {
    if (destroyed || !el || !source) return;
    // Retry resumes where the user was (skill 8.1) rather than at zero, and it
    // asks to play again, because the only reason anyone presses Retry on an
    // error screen is to watch the thing.
    const from = resumePosition > 0 ? resumePosition : 0;
    endedFlag = false;
    st.error = undefined;
    permissionBlocked = false;
    void load(source, { startAt: from, autoplay: true });
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    // Order matters and is the whole reason this function exists: stop the
    // clocks, take every listener off, then stop the media. A leaked player
    // keeps downloading and keeps playing audio into a screen nobody is looking
    // at, which on a phone means a flat battery and a bill.
    cancelFrame();
    clearBuffering();
    bufferingTimer = null;
    pendingSeek = null;
    pendingWrites = null;
    detachElement();
    if (el) {
      try {
        el.pause();
      } catch {
        /* ignore */
      }
      try {
        el.removeAttribute("src");
      } catch {
        /* ignore */
      }
      try {
        // The documented teardown: removing the attribute alone leaves the
        // element holding its buffered data until a load() resets it.
        el.load();
      } catch {
        /* ignore */
      }
    }
    el = null;
    source = "";
    // One last, truthful snapshot while there is still a subscriber to receive
    // it: the player has no media now, and a state object still claiming to be
    // playing after teardown is the kind of lie that costs an afternoon.
    publish();
    listeners.clear();
  }

  function subscribe(listener: (s: PlayerState) => void): () => void {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      listeners.delete(listener);
    };
  }

  return {
    attach,
    load,
    play,
    pause,
    toggle,
    seekTo,
    seekBy,
    previewSeek,
    commitSeek,
    cancelScrub,
    setRate,
    setVolume,
    setMuted,
    enterFullscreen,
    exitFullscreen,
    retry,
    destroy,
    getState: () => published,
    /**
     * How much of the timeline from `t` onward is already downloaded, as a
     * fraction of the whole duration. Zero when `t` is not inside any buffered
     * range, which is what a timeline wants to draw: the bar stops at the first
     * hole instead of snapping to the end of a range the playhead is not in.
     */
    getBufferedAt(t: number): number {
      const duration = published.duration;
      if (!(duration > 0) || !Number.isFinite(t)) return 0;
      for (const range of published.buffered) {
        if (t >= range.start && t < range.end) {
          return clamp((range.end - t) / duration, 0, 1);
        }
      }
      return 0;
    },
    getProgress(): number {
      const d = published.duration;
      // Guarded because duration is 0 for live streams and before metadata, and
      // an unguarded division would hand NaN to a width in CSS.
      if (!(d > 0)) return 0;
      return clamp(published.currentTime / d, 0, 1);
    },
    subscribe,
    skipSeconds,
  };
}   