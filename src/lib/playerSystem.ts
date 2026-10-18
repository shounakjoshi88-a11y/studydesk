/**
 * Lock screen controls and screen wake management for the player.
 *
 * Both capabilities here are conveniences layered over playback, never
 * requirements for it. A WebView on one phone exposes lock screen controls and
 * wake holding, on another phone exposes neither, and the player must feel
 * identical apart from that: a missing capability quietly means no lock screen
 * card, or a screen that dims on its own, while the video itself keeps playing.
 * Every export in this file therefore degrades to a safe no-op instead of
 * throwing, and every teardown path releases what it took, because a player
 * that leaves handlers or locks behind is a battery and behaviour leak.
 *
 * Nothing at module scope touches page globals, so this file stays importable
 * in a bare test runtime with no page present. Each function looks globals up
 * late, behind a presence check, at the moment it is called.
 */

export interface MediaSessionOptions {
  title: string;
  artist?: string;
  album?: string;
  /** Cover art. Pass a small local file link, never a remote token-bearing one. */
  artwork?: Array<{ src: string; sizes?: string; type?: string }>;
  skipOffsetSeconds?: number;
  onPlay: () => void;
  onPause: () => void;
  onSeekBack: (deltaSeconds: number) => void;
  onSeekForward: (deltaSeconds: number) => void;
  onSeekTo: (seconds: number) => void;
  onStop?: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
}

export interface MediaSessionHandle {
  /** Push current playback state. Call on play/pause/seek/rate change. */
  update(state: {
    playing: boolean;
    position: number;
    duration: number;
    playbackRate: number;
    paused?: boolean;
  }): void;
  dispose(): void;
}

/** The one live attachment, so a second player cannot stack handlers on the first. */
let active: MediaSessionHandle | null = null;

/**
 * Looks up the lock screen control surface late, because the module must load
 * where no page exists at all. Absence is normal on older WebViews and simply
 * means the caller skips the card.
 */
function mediaSessionOf(): MediaSession | null {
  if (typeof navigator === "undefined") return null;
  try {
    const candidate = navigator as Navigator & { mediaSession?: MediaSession };
    if (!("mediaSession" in navigator) || !candidate.mediaSession) return null;
    return candidate.mediaSession;
  } catch {
    return null;
  }
}

/**
 * One control action on its own, because older WebViews reject the actions
 * they never implemented and that rejection must stay local to the action.
 */
function setHandler(
  session: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
): void {
  try {
    session.setActionHandler(action, handler);
  } catch {
    /* an unknown action here must not block the ones that follow */
  }
}

/**
 * Puts the episode on the lock screen and in notifications, routing hardware
 * and system buttons back into the player. Returns null where the surface is
 * absent, and never throws: without it the player just has no remote card.
 *
 * Attaching twice replaces the first attachment rather than layering a second
 * set of handlers, since a screen shows one player at a time and a stale set
 * would answer buttons meant for the new one. Teardown clears every handler
 * it registered and drops the card metadata with it.
 */
export function attachMediaSession(opts: MediaSessionOptions): MediaSessionHandle | null {
  const session = mediaSessionOf();
  if (!session) return null;

  if (active) {
    try {
      active.dispose();
    } catch {
      /* a previous teardown owes nothing further */
    }
    active = null;
  }

  // Metadata is best effort: a WebView that dislikes the art or a field still
  // gets working buttons, so its complaint is swallowed here.
  try {
    if (typeof MediaMetadata !== "undefined") {
      session.metadata = new MediaMetadata({
        title: opts.title,
        artist: opts.artist ?? "",
        album: opts.album ?? "",
        artwork: opts.artwork ?? [],
      });
    }
  } catch {
    /* buttons matter, the card text does not */
  }

  // The step a skip button jumps, shared so system buttons and in-app buttons
  // agree with each other instead of each picking their own distance.
  const skip = opts.skipOffsetSeconds ?? 10;

  const registered: MediaSessionAction[] = [];
  const on = (action: MediaSessionAction, handler: MediaSessionActionHandler): void => {
    setHandler(session, action, handler);
    registered.push(action);
  };

  on("play", () => opts.onPlay());
  on("pause", () => opts.onPause());
  on("seekbackward", (details) => opts.onSeekBack(details?.seekOffset ?? skip));
  on("seekforward", (details) => opts.onSeekForward(details?.seekOffset ?? skip));
  on("seekto", (details) => {
    const target = details?.seekTime;
    if (target == null || !Number.isFinite(target)) return;
    opts.onSeekTo(Math.max(0, target));
  });
  // The remaining three exist only when the player has something for them to
  // do: advertising a next button with nowhere to go is worse than none.
  if (opts.onStop) {
    const stop = opts.onStop;
    on("stop", () => stop());
  }
  if (opts.onPrevious) {
    const previous = opts.onPrevious;
    on("previoustrack", () => previous());
  }
  if (opts.onNext) {
    const next = opts.onNext;
    on("nexttrack", () => next());
  }

  const handle: MediaSessionHandle = {
    update(state): void {
      // The banner state follows intent, not the raw element, so a seek that
      // briefly pauses under the hood never flickers the card.
      try {
        session.playbackState = state.paused ?? !state.playing ? "paused" : "playing";
      } catch {
        /* cosmetic, playback is unaffected */
      }
      // Position reporting is the known footgun: the call rejects on a live
      // stream with no finite length, on metadata that has not arrived yet, or
      // on a position past the end after a rounded seek, so anything dubious
      // is held back and the edges are clamped instead of passed through.
      const { position, duration, playbackRate } = state;
      if (!Number.isFinite(duration) || duration <= 0) return;
      if (!Number.isFinite(position) || !Number.isFinite(playbackRate) || playbackRate <= 0) {
        return;
      }
      const clamped = Math.min(Math.max(position, 0), duration);
      try {
        if (typeof session.setPositionState === "function") {
          session.setPositionState({ duration, playbackRate, position: clamped });
        }
      } catch {
        /* stale numbers on a card beat an exception in a ticker */
      }
    },
    dispose(): void {
      for (const action of registered) {
        setHandler(session, action, null);
      }
      try {
        session.metadata = null;
      } catch {
        /* teardown never throws */
      }
      if (active === handle) active = null;
    },
  };

  active = handle;
  return handle;
}

/**
 * Holds the screen awake while the lecture plays, returning a release function
 * the player calls on pause, on end, and on destroy.
 *
 * The hold is fragile by design: the platform drops it silently whenever the
 * page hides, and it can be refused outright under battery saver or in the
 * background. Both cases resolve to a release that simply does nothing, so the
 * video plays on and only the screen dims. A visibility listener re-takes the
 * hold on return, which is also what heals an earlier refusal for free.
 *
 * Note for this app: StudyDesk ships as an Android app, where the sturdier
 * answer is the native keep-screen-on flag on the player view, which survives
 * dimming rules the page never sees. From inside the WebView without adding a
 * native plugin, this page-level hold is the best available equivalent, and it
 * must be treated as advisory rather than guaranteed.
 */
export function acquireWakeLock(): Promise<() => void> {
  const noop = (): void => undefined;
  if (typeof navigator === "undefined") return Promise.resolve(noop);
  const holder = navigator as Navigator & {
    wakeLock?: { request: (kind: "screen") => Promise<WakeLockSentinel> };
  };
  if (!holder.wakeLock || typeof holder.wakeLock.request !== "function") {
    return Promise.resolve(noop);
  }

  // The live hold, nulled the moment the platform takes it back so release and
  // re-take decisions always read the truth rather than a stale object.
  let sentinel: WakeLockSentinel | null = null;
  // Once true, no further hold is taken and an in-flight request hands its
  // grant straight back instead of keeping it.
  let done = false;
  const canListen =
    typeof document !== "undefined" && typeof document.addEventListener === "function";

  const hold = async (): Promise<void> => {
    if (done) return;
    // Asking while hidden is refused on sight, so wait for the return instead.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    try {
      const next = await holder.wakeLock!.request("screen");
      if (done) {
        if (!next.released) await next.release();
        return;
      }
      sentinel = next;
      next.addEventListener("release", () => {
        if (sentinel === next) sentinel = null;
      });
    } catch {
      // Refused or dropped: absence of a hold is a normal state, not an error.
      sentinel = null;
    }
  };

  const onVisibility = (): void => {
    if (typeof document === "undefined" || done) return;
    if (document.visibilityState !== "visible") return;
    if (sentinel && !sentinel.released) return;
    void hold();
  };
  if (canListen) document.addEventListener("visibilitychange", onVisibility);

  const release = (): void => {
    // Double release is a normal unmount ordering, not a fault, so the second
    // call finds nothing to do and leaves quietly.
    if (done) return;
    done = true;
    if (canListen) document.removeEventListener("visibilitychange", onVisibility);
    const live = sentinel;
    sentinel = null;
    if (live && !live.released) {
      void live.release().catch(() => undefined);
    }
  };

  // The first attempt runs now; a refusal still returns a working release,
  // and the visibility listener keeps healing the hold afterwards.
  return hold().then(
    () => release,
    () => release,
  );
}

/**
 * Whether the page is currently hidden, so the caller can stand down its
 * frame ticker. A hidden WebView still burns battery driving frames nobody
 * sees, and there is no page at all in a bare test runtime, which counts as
 * visible so nothing wedges waiting for a show that never comes.
 */
export function isDocumentHidden(): boolean {
  if (typeof document === "undefined") return false;
  try {
    return document.visibilityState === "hidden";
  } catch {
    return false;
  }
}
