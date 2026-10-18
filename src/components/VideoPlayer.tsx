/**
 * Full-screen video player.
 *
 * Recreates what the phone's own Photos app does when you tap a clip — and
 * then the parts it leaves out. The stock gallery gives you play/pause and a
 * scrubber; it does not give you speed, loop, fill, or a way to step to the
 * next clip without going back to the grid and losing your place.
 *
 * The one hard constraint that shapes everything here: this runs inside an
 * Android WebView, and the video never passes through JavaScript. Native hands
 * back a `capacitor://` URL for the file's real path and the <video> element
 * streams it off disk itself. Pulling the bytes through the bridge instead —
 * a 40 MB clip as a base64 JSON string — is how you take the WebView's heap
 * out from under the rest of the app.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ChevronsLeft,
  ChevronsRight,
  Gauge,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  Share2,
  Trash,
  TriangleAlert,
  VolumeX,
  X,
} from "lucide-react";
import { Capacitor } from "@capacitor/core";
import {
  deleteMedia,
  formatDuration,
  humanSize,
  mediaFullUrl,
  mediaThumbUrl,
  shareMedia,
  type MediaItem,
} from "../lib/deviceFiles";

export type VideoPlayerProps = {
  items: MediaItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
};

// ── numbers ───────────────────────────────────────────────────

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SKIP_SECONDS = 10;
/** Chrome has to be gone before this plays as "native" rather than "web page". */
const CHROME_IDLE_MS = 3000;
/** A swipe has to commit this far horizontally before it changes video. */
const SWIPE_COMMIT_PX = 48;
/** Past this much travel the gesture is a drag, not a tap. */
const TAP_SLOP_PX = 10;

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * MediaError codes, in the user's language. A WebView that cannot play a clip
 * says nothing at all by default, which leaves a black rectangle; saying
 * *why* is the difference between a dead end and a next step.
 */
function playbackProblem(v: HTMLVideoElement | null): string {
  switch (v?.error?.code) {
    case 1:
      return "Playback stopped before the video could start.";
    case 2:
      return "The file could not be read. It may have been moved or deleted since the list was built.";
    case 3:
      return "This file is damaged, or uses an audio or video codec this device cannot decode.";
    default:
      return "This device cannot play this format. Most video apps on the phone will.";
  }
}

// ── presentational pieces ─────────────────────────────────────

/**
 * A settings row inside the options sheet. Colour is never the only signal —
 * the thumb moves as well as changes value, so the state survives greyscale and
 * every colour-vision type.
 */
function SwitchRow({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <p className="text-[15px] text-white">{label}</p>
        {hint && <p className="mt-0.5 text-[12px] text-white/50">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        className={`relative h-[26px] w-[46px] flex-none rounded-full transition-colors duration-150 ${
          on ? "bg-white" : "bg-white/20"
        }`}
      >
        <span
          className={`absolute top-[3px] h-5 w-5 rounded-full transition-[left] duration-150 ${
            on ? "left-[23px] bg-black" : "left-[3px] bg-white/70"
          }`}
        />
      </button>
    </div>
  );
}

/**
 * One icon button sized for a thumb. `tone` exists so the primary action can be
 * the only filled thing on screen — everything else is a glyph on black.
 */
function IconButton({
  label,
  onClick,
  disabled,
  tone = "quiet",
  children,
  className = "",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "quiet" | "primary";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      // pointer-events-auto because every bar of chrome sits inside a
      // pointer-events-none wrapper — so that a tap anywhere on the picture
      // still reaches the stage's tap-to-toggle gesture instead of landing on
      // an invisible scrim. The gradient itself stays transparent to touches;
      // only the controls are hit targets.
      className={`sd-tap pointer-events-auto flex h-12 w-12 flex-none items-center justify-center rounded-xl transition-[opacity,background-color] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80 ${
        tone === "primary" ? "bg-white text-black" : "text-white/85 active:bg-white/10"
      } ${disabled ? "opacity-30" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

// ── player ────────────────────────────────────────────────────

export function VideoPlayer({ items, index, onClose, onIndexChange }: VideoPlayerProps) {
  const still = useReducedMotion() ?? false;

  /**
   * The video element lives here rather than in a `ref` prop.
   *
   * React hands a callback ref `null` while it tears a subtree down, and that
   * happens before passive effect cleanups get their turn. A plain `ref` would
   * therefore be null exactly when the unmount cleanup needs it to call
   * pause() — and the audio keeps playing after the user has navigated away.
   * Keeping the last known node, detached or not, is what makes the cleanup
   * reliable.
   */
  const nodeRef = useRef<HTMLVideoElement | null>(null);
  const setVideoNode = useCallback((n: HTMLVideoElement | null) => {
    if (n) nodeRef.current = n;
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const scrubRef = useRef(false);

  // Local copy of the set. Deleting has to remove the frame from *our* list the
  // moment it succeeds; waiting for the parent to hand us a fresh array leaves
  // a dead frame — or a spinner for a file that no longer exists — sitting in
  // front of the user.
  const [list, setList] = useState<MediaItem[]>(items);
  const removedIds = useRef<Set<string>>(new Set());

  const clampedIndex = Math.max(0, Math.min(list.length - 1, index));
  const item = list[clampedIndex] ?? null;
  const count = list.length;

  // `item` is a derived object, so a parent that rebuilds its array on every
  // render would give it a new identity each time. Pinning the id keeps the
  // source-resolving effect from looping.
  const currentId = item?.id ?? "";
  const itemRef = useRef<MediaItem | null>(null);
  useEffect(() => {
    itemRef.current = item;
  });

  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  /**
   * A frame to hold while the decoder wakes up: the clip's own thumbnail,
   * usually resolved already for the grid it was tapped in, so the player
   * opens on a picture rather than on a black rectangle.
   */
  const [poster, setPoster] = useState<string | null>(null);
  /**
   * Bumped by "Try again". Re-running the resolution is the only honest retry:
   * poking play() at an element whose decoder already gave up does nothing.
   */
  const [reloadToken, setReloadToken] = useState(0);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loopOne, setLoopOne] = useState(false);
  const [fill, setFill] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);

  const [chrome, setChrome] = useState(true);
  const [activity, setActivity] = useState(0);
  const [sheet, setSheet] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  const [landscape, setLandscape] = useState(false);
  const [wide, setWide] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  /**
   * Every deferred callback in the file, in one place, so the unmount cleanup
   * cannot miss one. Timers outliving the component is how a player ends up
   * writing state into an unmounted tree, or — worse — holding a closure that
   * keeps the video alive.
   */
  const timeouts = useRef<Set<number>>(new Set());
  const after = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timeouts.current.delete(id);
      fn();
    }, ms);
    timeouts.current.add(id);
    return id;
  }, []);
  const clearAfter = useCallback((id: number | null) => {
    if (id == null) return;
    window.clearTimeout(id);
    timeouts.current.delete(id);
  }, []);
  const noticeTimer = useRef<number | null>(null);

  const pendingSeek = useRef<number | null>(null);
  const seekRaf = useRef(0);
  const gesture = useRef<{ x: number; y: number; t: number; id: number } | null>(null);
  const moveMark = useRef<{ x: number; y: number } | null>(null);
  /** Why we muted: policy, or the user. Only policy is worth re-offering. */
  const policyMuted = useRef(false);
  /** Whether playback still wants starting once real media shows up. */
  const autoPlay = useRef(true);
  const closeGuard = useRef(false);

  // ── feedback ────────────────────────────────────────────────

  const flash = useCallback(
    (msg: string) => {
      setNotice(msg);
      clearAfter(noticeTimer.current);
      noticeTimer.current = after(() => setNotice(null), 2600);
    },
    [after, clearAfter],
  );

  const bumpChrome = useCallback(() => {
    setChrome(true);
    setActivity((n) => n + 1);
  }, []);

  // ── the set ─────────────────────────────────────────────────

  useEffect(() => {
    setList((prev) => {
      const fresh = items.filter((i) => !removedIds.current.has(i.id));
      // Identity-compare so a parent that rebuilds its array every render
      // cannot loop us, and so the current video is not reloaded for nothing.
      const same = fresh.length === prev.length && fresh.every((it, k) => it.id === prev[k]?.id);
      return same ? prev : fresh;
    });
  }, [items]);

  const goTo = useCallback(
    (i: number) => {
      // Clamp, never wrap. A video set is a folder listing; wrapping from the
      // last clip back to the first loses your place, and a chevron that
      // silently reappears elsewhere is worse than one that greys out.
      const next = Math.max(0, Math.min(count - 1, i));
      if (next === clampedIndex || count < 2) return;
      setSheet(false);
      setConfirming(false);
      onIndexChange(next);
    },
    [clampedIndex, count, onIndexChange],
  );

  // ── source ──────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const target = itemRef.current;
    setUrl(undefined);
    setReady(false);
    setFatal(null);
    setNeedsTap(false);
    setTime(0);
    setDuration(target?.durationMs ? target.durationMs / 1000 : 0);
    setBuffered(0);
    setDims(null);
    // Whoever opened this video opened it to watch it. Playback actually
    // starts at loadedmetadata, because that is the first moment there is
    // something to play.
    autoPlay.current = true;
    if (!target) return;

    void (async () => {
      let resolved: string | null = null;
      try {
        resolved = await mediaFullUrl(target);
        // mediaFullUrl answers null when the plugin is absent (web preview) or
        // when MediaStore has no on-disk path for the row. convertFileSrc of
        // the absolute path is the only honest second try, and it is what
        // makes the dev server worth looking at.
        if (!resolved && target.path) resolved = Capacitor.convertFileSrc(target.path);
      } catch {
        resolved = null;
      }
      if (cancelled) return;
      if (!resolved) {
        // A null source with no error event is the worst case: the element just
        // sits there. Say so, or the spinner never stops.
        setFatal("This file could not be opened. It may have been moved or deleted since the list was loaded.");
        setReady(true);
        return;
      }
      setUrl(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentId, reloadToken]);

  /* The poster for the frame above: same thumbnail the grid used, requested at
     a size that still looks like a picture when stretched over the stage. */
  useEffect(() => {
    setPoster(null);
    const target = itemRef.current;
    if (!target) return;
    let live = true;
    void mediaThumbUrl(target, 720).then((u) => {
      if (live && u) setPoster(u);
    });
    return () => {
      live = false;
    };
  }, [currentId]);

  const format = useCallback(
    (ms: number) => formatDuration(ms) || fmtClock(ms),
    [],
  );

  // ── playback ────────────────────────────────────────────────

  /**
   * WebView autoplay policy is the number-one cause of a "dead" player here.
   * Android's WebView only grants an unmuted play() inside a user gesture, and
   * by the time our source has resolved out of the bridge the original tap is
   * long gone — a gesture does not survive an await. So: ask for sound, and if
   * the promise comes back NotAllowedError, fall back to muted and say why,
   * rather than leaving a black frame with no explanation. The sound is handed
   * back on the very next touch, which is also when the policy allows it.
   */
  const attemptPlay = useCallback(
    async (v: HTMLVideoElement): Promise<boolean> => {
      autoPlay.current = false;
      setNeedsTap(false);
      // A play() on an element with no source yet rejects with
      // NotSupportedError, which is indistinguishable from an undecodable
      // file — so refuse to try until there is real media attached.
      if (!v.currentSrc && !v.getAttribute("src")) return false;
      try {
        await v.play();
        setPlaying(true);
        return true;
      } catch (err) {
        setPlaying(false);
        const name = (err as { name?: string } | null)?.name ?? "";
        if (name === "AbortError") {
          // play() interrupted by a load or a pause. Not a policy decision and
          // not a broken file; whichever event owns the element now drives
          // the button state.
          return false;
        }
        if (name === "NotAllowedError") {
          policyMuted.current = true;
          setMuted(true);
          v.muted = true;
          try {
            await v.play();
            setPlaying(true);
            flash("Started without sound. Tap the sound control to turn it back on.");
            return true;
          } catch {
            // Even muted was refused, so no gesture is being credited at all.
            setNeedsTap(true);
            return false;
          }
        }
        if (name === "NotSupportedError") {
          setFatal(playbackProblem(v));
          return false;
        }
        setNeedsTap(true);
        return false;
      }
    },
    [flash],
  );

  /**
   * Settings are pushed onto the element whenever they change *and* whenever
   * the clip changes, because the element is keyed on the item id: a new video
   * is a brand-new <video> that has forgotten the 1.5x and the loop the user
   * chose. Both lists carry currentId for that reason, and together they are
   * the whole of "apply the settings to this element" — which is also why the
   * next video reliably starts at 0, having never been seeked.
   */
  useEffect(() => {
    const v = nodeRef.current;
    if (v) v.playbackRate = rate;
  }, [rate, currentId]);
  useEffect(() => {
    const v = nodeRef.current;
    if (v) v.loop = loopOne;
  }, [loopOne, currentId]);
  useEffect(() => {
    const v = nodeRef.current;
    if (v) v.muted = muted;
  }, [muted, currentId]);

  /**
   * Progress. timeupdate alone only fires about four times a second, which
   * reads as a stuttering bar; a rAF loop throttled to a tenth of a second
   * looks continuous without putting ten full re-renders of the overlay into
   * every second of playback on a mid-range phone.
   */
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = -1;
    const tick = () => {
      const v = nodeRef.current;
      if (v && !scrubRef.current) {
        const q = Math.round(v.currentTime * 10);
        if (q !== last) {
          last = q;
          setTime(v.currentTime);
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [playing]);

  /**
   * Controls fade only while something is actually playing. Hiding them over a
   * paused frame would strand anyone who paused to read the file name on a
   * black screen with no way back.
   */
  useEffect(() => {
    if (!playing || !chrome || sheet || confirming) return;
    const id = window.setTimeout(() => setChrome(false), CHROME_IDLE_MS);
    return () => window.clearTimeout(id);
  }, [playing, chrome, sheet, confirming, activity]);

  const togglePlay = useCallback(() => {
    const v = nodeRef.current;
    if (!v) return;
    bumpChrome();
    if (fatal) {
      // Nothing to retry into: the decoder rejected the file outright, and
      // "Try again" is the only honest way forward.
      return;
    }
    if (!v.currentSrc && !v.getAttribute("src")) {
      // Still resolving. Leave the flag set and let loadedmetadata start it.
      autoPlay.current = true;
      return;
    }
    if (v.paused || v.ended) {
      void attemptPlay(v);
    } else {
      v.pause();
      setPlaying(false);
      // Chrome always comes back on pause: hiding the controls over a still
      // frame is how a player becomes impossible to get out of.
      setChrome(true);
    }
  }, [attemptPlay, bumpChrome, fatal]);

  const seekBy = useCallback(
    (delta: number) => {
      const v = nodeRef.current;
      if (!v) return;
      bumpChrome();
      const total = Number.isFinite(v.duration) ? v.duration : duration;
      const next = Math.max(0, Math.min(total, v.currentTime + delta));
      v.currentTime = next;
      setTime(next);
    },
    [bumpChrome, duration],
  );

  const onScrubInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.currentTarget.value);
    if (!Number.isFinite(t)) return;
    pendingSeek.current = t;
    // The label follows the finger immediately; the seek itself is coalesced
    // to one per frame so a drag across a 40 px bar is not 40 decoder resets.
    setTime(t);
    if (seekRaf.current) return;
    seekRaf.current = window.requestAnimationFrame(() => {
      seekRaf.current = 0;
      const v = nodeRef.current;
      const target = pendingSeek.current;
      if (v && target != null) v.currentTime = target;
    });
  }, []);

  const onScrubKeys = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const v = nodeRef.current;
      if (!v) return;
      const total = Number.isFinite(v.duration) ? v.duration : duration;
      const big = e.shiftKey ? 30 : 5;
      let next: number | null = null;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") next = v.currentTime + big;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = v.currentTime - big;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = total;
      else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (next == null) return;
      e.preventDefault();
      const clamped = Math.max(0, Math.min(total, next));
      v.currentTime = clamped;
      setTime(clamped);
      bumpChrome();
    },
    [bumpChrome, duration, togglePlay],
  );

  const onBuffered = useCallback(() => {
    const v = nodeRef.current;
    if (!v || !v.buffered.length) {
      setBuffered(0);
      return;
    }
    // The range under the thumb, not simply the last one: a partially-cached
    // file has several, and showing the furthest one would claim to have
    // buffered a stretch we have not touched.
    let end = 0;
    for (let i = 0; i < v.buffered.length; i += 1) {
      if (v.currentTime >= v.buffered.start(i) - 0.25 && v.currentTime <= v.buffered.end(i)) {
        end = v.buffered.end(i);
        break;
      }
      end = Math.max(end, v.buffered.end(i));
    }
    setBuffered(end);
  }, []);

  /**
   * End of a scrub, however it ended. The flag has to be released on cancel
   * and blur as well as on pointerup: while it is still set, the progress loop
   * refuses to update the bar and the idle timer keeps re-arming itself, so a
   * dropped pointer would freeze the whole player.
   */
  const endScrub = useCallback(() => {
    if (!scrubRef.current) return;
    scrubRef.current = false;
    const v = nodeRef.current;
    const target = pendingSeek.current;
    if (v && target != null) v.currentTime = target;
  }, []);

  const retry = useCallback(() => {
    autoPlay.current = true;
    setReloadToken((n) => n + 1);
  }, []);

  // ── viewport ────────────────────────────────────────────────

  useEffect(() => {
    const measure = () => {
      setLandscape(window.innerWidth > window.innerHeight);
      setWide(window.innerWidth >= 640);
      setFullscreen(Boolean(document.fullscreenElement));
    };
    measure();
    // resize fires constantly on Android (keyboard, system bars, fullscreen
    // entry). Both setters bail out on an unchanged value, so the redundancy
    // costs nothing and the recomputation is not needed.
    window.addEventListener("orientationchange", measure);
    window.addEventListener("resize", measure);
    document.addEventListener("fullscreenchange", measure);
    return () => {
      window.removeEventListener("orientationchange", measure);
      window.removeEventListener("resize", measure);
      document.removeEventListener("fullscreenchange", measure);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    bumpChrome();
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
      return;
    }
    try {
      const req = el.requestFullscreen?.({ navigationUI: "hide" });
      // A few Android WebView builds ship the API without an implementation.
      // Rather than leave a button that silently does nothing, ask the screen
      // to turn instead; if that is refused too, the manual rotation path
      // still re-lays out the controls.
      void Promise.resolve(req).catch(() => {
        void screen.orientation?.lock?.("landscape").catch(() => {});
      });
    } catch {
      /* no fullscreen at all: the rotation listener still handles landscape */
    }
  }, [bumpChrome]);

  // ── actions ─────────────────────────────────────────────────

  const onShare = useCallback(async () => {
    const target = itemRef.current;
    if (!target) return;
    try {
      await shareMedia(target);
      flash("Video shared");
    } catch {
      // On some builds the sheet dismissing surfaces as a rejection; only a
      // failure to resolve is worth reporting.
      flash("Could not share this video");
    }
  }, [flash]);

  const onDelete = useCallback(async () => {
    const target = itemRef.current;
    if (!target) return;
    let ok = false;
    try {
      // deleteMedia answers false rather than throwing on a permission failure,
      // so the boolean is the result — not merely the absence of an error.
      ok = await deleteMedia(target);
    } catch {
      ok = false;
    }
    if (!ok) {
      setConfirming(false);
      flash("Could not delete this video");
      return;
    }
    const id = target.id;
    removedIds.current.add(id);
    const next = list.filter((e) => e.id !== id);
    setList(next);
    setConfirming(false);
    // The last video going away is the graceful end of the viewer, not an
    // error state to render.
    if (next.length === 0) {
      onClose();
      return;
    }
    if (clampedIndex >= next.length) onIndexChange(next.length - 1);
  }, [clampedIndex, flash, list, onClose, onIndexChange]);

  // ── overlay lifecycle ───────────────────────────────────────

  const close = useCallback(() => {
    if (closeGuard.current) return;
    closeGuard.current = true;
    if (still) {
      onClose();
      return;
    }
    // The exit animation is driven here rather than handed to the parent's
    // AnimatePresence: this component may be mounted by anything, and a
    // hard cut out of a full-screen overlay is the one transition everybody
    // notices.
    setClosing(true);
    after(() => onClose(), 170);
  }, [after, onClose, still]);

  useEffect(() => {
    rootRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  /**
   * The teardown that matters. In a WebView an element left playing keeps its
   * audio going after the route is gone — there is no "the screen closed, so
   * stop" event, only this cleanup. Everything scheduled in this component is
   * released here too: the auto-hide timer and the notice timer live in the
   * timeout set, the seek coalescer is a frame callback, and the hardware back
   * listener is removed.
   */
  useEffect(() => {
    return () => {
      for (const id of timeouts.current) window.clearTimeout(id);
      timeouts.current.clear();
      clearAfter(noticeTimer.current);
      noticeTimer.current = null;
      if (seekRaf.current) window.cancelAnimationFrame(seekRaf.current);
      seekRaf.current = 0;
      // Read the node here on purpose. Copying it into a local when the effect
      // first runs would capture a null, because the <video> is mounted by the
      // very commit this effect belongs to — and React's own ref teardown may
      // have cleared it again by the time cleanup runs. See setVideoNode.
      const v = nodeRef.current;
      try {
        v?.pause();
      } catch {
        /* already gone */
      }
      // Detaching the source and calling load() is what actually releases the
      // decoder; pause() alone leaves the file open.
      try {
        if (v) {
          v.removeAttribute("src");
          v.load();
        }
      } catch {
        /* already gone */
      }
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    };
  }, [clearAfter]);

  // The hardware back button. Without this the player swallows the gesture the
  // user expects to close it, and the WebView exits the app instead.
  useEffect(() => {
    let handle: { remove: () => Promise<void> } | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const h = await App.addListener("backButton", () => {
          if (sheet) setSheet(false);
          else if (confirming) setConfirming(false);
          else close();
        });
        if (cancelled) void h.remove();
        else handle = h;
      } catch {
        /* web preview: no hardware back button */
      }
    })();
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [close, confirming, sheet]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        if (sheet) setSheet(false);
        else if (confirming) setConfirming(false);
        else close();
        return;
      }
      if (e.key === "Tab") {
        // Keep focus inside the scrim. A full-screen overlay with controls that
        // auto-hide must not be tab-navigable once they are invisible.
        const root = rootRef.current;
        if (!root) return;
        const focusables = [...root.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")].filter(
          (el) => el.offsetParent !== null,
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (sheet || confirming) return;
      // The scrubber handles its own arrows; anything else gets the shortcuts.
      if (e.target instanceof HTMLInputElement) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          e.preventDefault();
          seekBy(5);
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekBy(-5);
          break;
        case "ArrowUp":
        case "ArrowDown":
          e.preventDefault();
          seekBy(e.key === "ArrowUp" ? 10 : -10);
          break;
        case "m":
        case "M":
          setMuted((m) => !m);
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "l":
        case "L":
          setLoopOne((l) => !l);
          break;
        default:
          break;
      }
    },
    [close, confirming, seekBy, sheet, toggleFullscreen, togglePlay],
  );

  // ── gesture ─────────────────────────────────────────────────

  const onStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      bumpChrome();

      // A gesture that starts on a control belongs to that control. Capturing
      // the pointer here would steal the scrubber's drag.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("button, input, [role='switch'], [role='dialog']")) return;

      // Restore sound the moment a real gesture arrives, if we had to mute for
      // policy reasons. This is the first event after the mute, so it is also
      // the first one the WebView credits as a user activation.
      const v = nodeRef.current;
      if (policyMuted.current && v) {
        policyMuted.current = false;
        setMuted(false);
        v.muted = false;
        void v.play().catch(() => {
          policyMuted.current = true;
          setMuted(true);
          v.muted = true;
        });
      }

      gesture.current = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
      moveMark.current = { x: e.clientX, y: e.clientY };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    },
    [bumpChrome],
  );

  const onStagePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g || g.id !== e.pointerId) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* nothing captured */
      }

      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (Math.hypot(dx, dy) > TAP_SLOP_PX) {
        // Horizontal intent only: a diagonal drag is still the WebView
        // deciding what it is, and taking it as a swipe would jump the set
        // while the user meant to scroll or rest.
        if (Math.abs(dx) >= SWIPE_COMMIT_PX && Math.abs(dx) > Math.abs(dy) * 1.4) {
          goTo(clampedIndex + (dx < 0 ? 1 : -1));
        } else {
          bumpChrome();
        }
        return;
      }
      if (performance.now() - g.t > 700) return;

      const box = stageRef.current?.getBoundingClientRect();
      const inCentre = box
        ? e.clientX > box.left + box.width * 0.3 && e.clientX < box.left + box.width * 0.7 &&
          e.clientY > box.top + box.height * 0.3 && e.clientY < box.top + box.height * 0.7
        : false;

      if (needsTap) {
        setNeedsTap(false);
        togglePlay();
        return;
      }
      // A tap on the picture is the show/hide gesture. The middle of the frame
      // doubles as play while paused, which is where the thumb already is.
      if (!playing && inCentre) {
        togglePlay();
        return;
      }
      setChrome((v) => !v);
      setActivity((n) => n + 1);
    },
    [bumpChrome, clampedIndex, goTo, needsTap, playing, togglePlay],
  );

  const onRootPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (scrubRef.current) return;
      const mark = moveMark.current;
      // Twelve pixels of travel before the chrome counts as "the user is here".
      // Without this every pixel of a drag re-arms the idle timer and the fade
      // never lands at all.
      if (mark && Math.hypot(e.clientX - mark.x, e.clientY - mark.y) < 12) return;
      moveMark.current = { x: e.clientX, y: e.clientY };
      setChrome(true);
      setActivity((n) => n + 1);
    },
    [],
  );

  // ── derived ─────────────────────────────────────────────────

  const meta = useMemo(() => {
    const parts: string[] = [];
    if (count > 1) parts.push(`${clampedIndex + 1} of ${count}`);
    if (item?.bucket) parts.push(item.bucket);
    const w = dims?.w || item?.width;
    const h = dims?.h || item?.height;
    if (w && h) parts.push(`${w}×${h}`);
    if (item?.size) parts.push(humanSize(item.size));
    return parts.join(" · ");
  }, [clampedIndex, count, dims, item]);

  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const scrubMax = Math.max(total, 0.001);
  const playedPct = scrubMax > 0 ? Math.min(100, (time / scrubMax) * 100) : 0;
  const bufferedPct = scrubMax > 0 ? Math.min(100, (buffered / scrubMax) * 100) : 0;
  const loading = url === undefined || (!ready && !fatal);

  const setSheetOpen = useCallback((open: boolean) => {
    setSheet(open);
    if (open) setChrome(true);
  }, []);

  if (!item) return null;

  // ── render ──────────────────────────────────────────────────

  return (
    <motion.div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Video player"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={onRootPointerMove}
      onPointerMove={onRootPointerMove}
      onPointerUp={endScrub}
      onPointerCancel={endScrub}
      initial={{ opacity: 0 }}
      animate={{ opacity: closing ? 0 : 1 }}
      transition={{ duration: still ? 0 : 0.18 }}
      className="vp-root fixed inset-0 z-[80] bg-black text-white outline-none select-none"
    >
      {/* The player owns its own styles because the design system's index.css is
          a shared file this component may not edit. Chromium/WebKit pseudo
          elements have no Tailwind equivalent. */}
      <style>{VP_CSS}</style>

      {/* ── stage ─────────────────────────────────────────── */}
      <div
        ref={stageRef}
        onPointerDown={onStagePointerDown}
        onPointerUp={onStagePointerUp}
        onPointerCancel={() => {
          gesture.current = null;
        }}
        className="absolute inset-0"
      >
        <video
          key={item.id}
          ref={setVideoNode}
          src={url ?? undefined}
          poster={poster ?? undefined}
          playsInline
          preload="metadata"
          // Keeps a cast button off the overlay, which would be the only
          // other way out of a video.
          disableRemotePlayback
          className={`h-full w-full bg-black ${fill ? "object-cover" : "object-contain"}`}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            // Seed from the element: a clip can lie in MediaStore's metadata,
            // and the decoder's number is the one the scrubber has to agree
            // with.
            if (Number.isFinite(v.duration)) setDuration(v.duration);
            if (v.videoWidth && v.videoHeight) setDims({ w: v.videoWidth, h: v.videoHeight });
            setReady(true);
            onBuffered();
            // First moment there is media to play, and therefore the first
            // moment a play() can succeed.
            if (autoPlay.current) void attemptPlay(v);
          }}
          onProgress={onBuffered}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            // However it stopped — a tap, the end of the clip, or another app
            // taking the audio route — the controls come back. A frozen frame
            // with nothing on it is the one thing a player must never leave
            // behind.
            setChrome(true);
          }}
          onEnded={() => {
            setPlaying(false);
            setChrome(true);
          }}
          onError={(e) => {
            setReady(true);
            setPlaying(false);
            setFatal(playbackProblem(e.currentTarget));
          }}
        />

        {/* Quiet centred spinner. It sits over the picture rather than in a
            corner because the picture is what is loading. */}
        {loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status" aria-label="Loading video">
            <span
              className={`block h-9 w-9 rounded-full border-2 border-white/20 border-t-white/90 ${
                still ? "" : "animate-spin"
              }`}
              aria-hidden="true"
            />
          </div>
        )}

        {/* Nothing playing and nothing to play: say so in words, and offer the
            one route out that does not depend on our codec support. */}
        {(fatal || needsTap) && (
          <div className="absolute inset-0 flex items-center justify-center px-8">
            <div
              role="alert"
              className="max-w-sm rounded-2xl bg-black/72 px-5 py-5 text-center backdrop-blur-sm"
            >
              <TriangleAlert size={22} strokeWidth={1.75} className="mx-auto mb-3 text-white/70" aria-hidden="true" />
              <p className="text-[15px] font-medium text-white">{fatal ? "Cannot play this video" : "Ready to play"}</p>
              <p className="mt-1.5 text-[14px] leading-relaxed text-white/70">
                {fatal ?? "Tap play to start."}
              </p>
              <p className="mt-1 truncate text-[13px] text-white/45">{item.name}</p>
              <div className="mt-4 flex justify-center gap-2">
                {needsTap && (
                  <button
                    type="button"
                    onClick={() => {
                      setNeedsTap(false);
                      togglePlay();
                    }}
                    className="flex min-h-[44px] items-center rounded-xl bg-white px-5 text-[15px] font-medium text-black"
                  >
                    Play
                  </button>
                )}
                {fatal && (
                  <>
                    <button
                      type="button"
                      onClick={retry}
                      className="flex min-h-[44px] items-center rounded-xl px-4 text-[15px] text-white/75"
                    >
                      Try again
                    </button>
                    {/* The system share sheet on Android is also the "open with"
                        chooser, which makes it the escape hatch for a codec we
                        cannot decode. */}
                    <button
                      type="button"
                      onClick={onShare}
                      className="flex min-h-[44px] items-center rounded-xl bg-white px-5 text-[15px] font-medium text-black"
                    >
                      Open in another app
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Chevrons are a pointer-device convenience — on a phone the swipe is
            the gesture, but nothing stops a tablet or a Bluetooth mouse, and a
            44px target still beats a hidden drag. */}
        {count > 1 && chrome && (
          <>
            <button
              type="button"
              aria-label="Previous video"
              disabled={clampedIndex === 0}
              onClick={() => goTo(clampedIndex - 1)}
              className={`absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-xl bg-black/45 text-white/90 ${
                clampedIndex === 0 ? "opacity-25" : ""
              }`}
            >
              <ChevronsLeft size={22} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Next video"
              disabled={clampedIndex >= count - 1}
              onClick={() => goTo(clampedIndex + 1)}
              className={`absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-xl bg-black/45 text-white/90 ${
                clampedIndex >= count - 1 ? "opacity-25" : ""
              }`}
            >
              <ChevronsRight size={22} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      {/* ── top chrome ───────────────────────────────────── */}
      <AnimatePresence>
        {chrome && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: still ? 0 : 0.18 }}
            className="pointer-events-none absolute inset-x-0 top-0"
            style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 6px)" }}
          >
            {/* The scrim is functional, not decorative: video underneath is
                arbitrary, and white 15px type has no contrast guarantee without
                it. */}
            <div className="bg-gradient-to-b from-black/78 via-black/35 to-transparent px-2 pb-7 pt-1">
              <div className="flex min-h-[48px] items-center gap-1">
                <IconButton label="Close player" onClick={close}>
                  <X size={23} strokeWidth={1.75} aria-hidden="true" />
                </IconButton>
                <div className="min-w-0 flex-1 px-1">
                  {landscape ? (
                    <div className="flex min-w-0 items-baseline gap-3">
                      <p className="truncate text-[14px] font-medium text-white">{item.name}</p>
                      {/* Metadata only earns its place beside the name when the
                          long edge has room for it; a phone on its side does
                          not, and a clipped resolution reads as a bug. */}
                      {meta && wide && (
                        <p className="tnum shrink-0 truncate text-[12px] text-white/50">{meta}</p>
                      )}
                    </div>
                  ) : (
                    <>
                      <p className="truncate text-[15px] font-medium text-white">{item.name}</p>
                      {meta && <p className="tnum truncate text-[12px] text-white/55">{meta}</p>}
                    </>
                  )}
                </div>
                {/* Share is the one secondary action worth a permanent slot;
                    delete is a quiet row inside the options sheet, because
                    destructive should never be the loudest thing in a view. */}
                <IconButton label="Share video" onClick={onShare}>
                  <Share2 size={20} strokeWidth={1.75} aria-hidden="true" />
                </IconButton>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── bottom chrome ────────────────────────────────── */}
      <AnimatePresence>
        {chrome && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: still ? 0 : 0.18 }}
            className="pointer-events-none absolute inset-x-0 bottom-0"
            style={{
              paddingBottom: "max(env(safe-area-inset-bottom, 0px), 10px)",
              paddingLeft: "max(env(safe-area-inset-left, 0px), 10px)",
              paddingRight: "max(env(safe-area-inset-right, 0px), 10px)",
            }}
          >
            <div className={`bg-gradient-to-t from-black/82 via-black/38 to-transparent px-1 ${landscape ? "pt-6" : "pt-10"}`}>
              {/* Transport row. Play/pause is the primary action and the only
                  filled control here; the two skips are the other two that
                  matter and stay on the default surface at full size. */}
              <div className={`flex items-center gap-1 ${landscape ? "pb-0.5" : "pb-1"}`}>
                <IconButton
                  label={`Back ${SKIP_SECONDS} seconds`}
                  onClick={() => seekBy(-SKIP_SECONDS)}
                  className="flex-col gap-0.5"
                >
                  <RotateCcw size={20} strokeWidth={1.75} aria-hidden="true" />
                  <span className="tnum text-[9px] leading-none text-white/55">{SKIP_SECONDS}</span>
                </IconButton>

                <IconButton
                  label={playing ? "Pause" : "Play"}
                  onClick={togglePlay}
                  tone="primary"
                  className="mx-1 h-14 w-14 rounded-full"
                >
                  {playing ? (
                    <Pause size={26} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <Play size={26} strokeWidth={2} className="ml-0.5" aria-hidden="true" />
                  )}
                </IconButton>

                <IconButton
                  label={`Forward ${SKIP_SECONDS} seconds`}
                  onClick={() => seekBy(SKIP_SECONDS)}
                  className="flex-col gap-0.5"
                >
                  <RotateCw size={20} strokeWidth={1.75} aria-hidden="true" />
                  <span className="tnum text-[9px] leading-none text-white/55">{SKIP_SECONDS}</span>
                </IconButton>

                <div className="flex-1" />

                <IconButton
                  label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
                  onClick={toggleFullscreen}
                >
                  {fullscreen ? (
                    <Minimize2 size={21} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <Maximize2 size={21} strokeWidth={1.75} aria-hidden="true" />
                  )}
                </IconButton>

                {/* One labelled door to speed, loop, sound, fill and delete. A
                    word rather than a three-dot glyph: it says what it opens
                    before you have to guess from the icon. */}
                <button
                  type="button"
                  onClick={() => setSheetOpen(!sheet)}
                  className="sd-tap pointer-events-auto flex h-12 flex-none items-center justify-center rounded-xl px-3 text-[14px] text-white/85 transition-colors duration-150 active:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80"
                >
                  More
                </button>
              </div>

              {/* Scrubber. A real range input so the platform's own drag, focus
                  and keyboard handling come for free; the buffered and played
                  layers are painted behind it because a range input can only
                  describe one value. */}
              <div className="relative h-11">
                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/20">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-white/38" style={{ width: `${bufferedPct}%` }} />
                  <div className="absolute inset-y-0 left-0 rounded-full bg-white/95" style={{ width: `${playedPct}%` }} />
                </div>
                <input
                  type="range"
                  className="vp-range pointer-events-auto absolute inset-0 z-10 w-full"
                  min={0}
                  max={scrubMax}
                  step="any"
                  value={Math.min(time, scrubMax)}
                  disabled={total <= 0}
                  aria-label="Playback position"
                  aria-valuetext={`${format(time * 1000)} of ${format(total * 1000)}`}
                  onPointerDown={() => {
                    scrubRef.current = true;
                    bumpChrome();
                  }}
                  onPointerUp={endScrub}
                  onPointerCancel={endScrub}
                  onBlur={endScrub}
                  onChange={onScrubInput}
                  onKeyDown={onScrubKeys}
                />
              </div>

              <div className="tnum flex items-center justify-between px-1 text-[12px] text-white/70">
                <span>{format(time * 1000)}</span>
                <span>{format(total * 1000)}</span>
              </div>

              {/* Active state, kept out of the way: what is switched on is
                  worth saying without opening anything. */}
              {(rate !== 1 || loopOne || muted || fill) && (
                <div className="tnum flex items-center gap-2 px-1 pt-1 text-[11px] text-white/55">
                  {rate !== 1 && (
                    <span className="flex items-center gap-1">
                      <Gauge size={11} strokeWidth={2} aria-hidden="true" />
                      {rate}×
                    </span>
                  )}
                  {loopOne && (
                    <span className="flex items-center gap-1">
                      <Repeat size={11} strokeWidth={2} aria-hidden="true" />
                      loop
                    </span>
                  )}
                  {muted && (
                    <span className="flex items-center gap-1">
                      <VolumeX size={11} strokeWidth={2} aria-hidden="true" />
                      muted
                    </span>
                  )}
                  {fill && <span>fill</span>}
                </div>
              )}
            </div>

            {/* Delete confirm: an inline bar, not a second dialog. The player is
                already a modal and stacking modals strands focus; anchoring it
                above the transport keeps the transport reachable either way. */}
            <AnimatePresence>
              {confirming && (
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 12 }}
                  transition={{ duration: still ? 0 : 0.18 }}
                  role="alertdialog"
                  aria-modal="true"
                  aria-label="Delete this video"
                  aria-describedby="vp-delete-desc"
                  className="pointer-events-auto absolute inset-x-1 bottom-full mb-2 rounded-2xl bg-[#14181f] p-4"
                >
                  <p id="vp-delete-desc" className="text-[15px] text-white">
                    Delete this video? It goes from the phone for good.
                  </p>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      ref={cancelRef}
                      type="button"
                      onClick={() => setConfirming(false)}
                      className="flex min-h-[44px] items-center rounded-xl bg-white px-5 text-[15px] font-medium text-black"
                    >
                      Keep video
                    </button>
                    {/* The quiet half of the pair, on purpose. */}
                    <button
                      type="button"
                      onClick={onDelete}
                      className="flex min-h-[44px] items-center rounded-xl px-5 text-[15px] text-white/65"
                    >
                      Delete
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── transient status ─────────────────────────────── */}
      <AnimatePresence>
        {notice && !sheet && (
          <motion.p
            role="status"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: still ? 0 : 0.15 }}
            className="pointer-events-none absolute inset-x-8 top-1/2 -translate-y-24 rounded-xl bg-black/72 px-4 py-2.5 text-center text-[14px] text-white/90"
          >
            {notice}
          </motion.p>
        )}
      </AnimatePresence>

      {/* ── options sheet ────────────────────────────────── */}
      <AnimatePresence>
        {sheet && (
          <motion.div
            className="sd-sheet-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: still ? 0 : 0.18 }}
            onPointerDown={() => setSheetOpen(false)}
          >
            <motion.div
              className="sd-sheet"
              initial={{ y: 48 }}
              animate={{ y: 0 }}
              exit={{ y: 48 }}
              transition={{ duration: still ? 0 : 0.22 }}
              role="dialog"
              aria-modal="true"
              aria-label="Video options"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="sd-sheet-grab" />

              <div className="flex min-h-[44px] items-center justify-between">
                <h2 className="text-[17px] font-medium text-white">Options</h2>
                <button
                  type="button"
                  aria-label="Close options"
                  onClick={() => setSheetOpen(false)}
                  className="flex h-11 w-11 items-center justify-center rounded-xl text-white/70"
                >
                  <X size={20} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>

              <h3 className="pb-2 pt-3 text-[13px] text-white/50">Playback speed</h3>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Playback speed">
                {SPEEDS.map((s) => {
                  const on = rate === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setRate(s)}
                      className={`tnum flex min-h-[44px] items-center justify-center rounded-xl text-[14px] transition-colors duration-150 ${
                        on ? "bg-white text-black" : "bg-white/10 text-white/80"
                      }`}
                    >
                      {s}×
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 divide-y divide-white/10 border-t border-t-white/10">
                <SwitchRow
                  label="Loop this video"
                  hint="Plays again when it ends"
                  on={loopOne}
                  onToggle={() => setLoopOne((v) => !v)}
                />
                <SwitchRow
                  label="Sound"
                  hint={muted ? "Muted" : "On"}
                  on={!muted}
                  onToggle={() => {
                    setMuted((m) => !m);
                    // A deliberate unmute cancels the policy mute for good.
                    if (muted) policyMuted.current = false;
                  }}
                />
                <SwitchRow
                  label="Fill screen"
                  hint="Crops the edges instead of letterboxing"
                  on={fill}
                  onToggle={() => setFill((v) => !v)}
                />
              </div>

              <div className="mt-4 border-t border-t-white/10 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setSheetOpen(false);
                    setConfirming(true);
                    // The confirm bar is focusable; put the safe answer first so
                    // dismissing is the cheap option.
                    after(() => cancelRef.current?.focus(), 220);
                  }}
                  className="flex min-h-[48px] w-full items-center gap-3 rounded-xl text-[15px] text-white/60"
                >
                  <Trash size={18} strokeWidth={1.75} aria-hidden="true" />
                  Delete video
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── scoped styles ─────────────────────────────────────────────
// Injected rather than added to index.css: the scrubber needs
// ::-webkit-slider-thumb, which no Tailwind utility can express, and the shared
// stylesheet belongs to the rest of the app.
const VP_CSS = `
.vp-root { touch-action: none; overscroll-behavior: contain; }
.vp-range {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
  background: transparent;
  cursor: pointer;
}
.vp-range:disabled { cursor: default; }
.vp-range::-webkit-slider-runnable-track { height: 44px; background: transparent; border: 0; }
.vp-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 15px;
  height: 15px;
  border: 0;
  border-radius: 999px;
  background: #f4f5f7;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.65);
  transition: transform 120ms cubic-bezier(0.16, 1, 0.3, 1);
}
.vp-range:active::-webkit-slider-thumb { transform: scale(1.3); }
.vp-range:focus { outline: none; }
.vp-range:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px rgba(244, 245, 247, 0.9);
}
.vp-range::-moz-range-track { height: 44px; background: transparent; border: 0; }
.vp-range::-moz-range-thumb {
  width: 15px; height: 15px; border: 0; border-radius: 999px;
  background: #f4f5f7; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.65);
}
@media (prefers-reduced-motion: reduce) {
  .vp-range::-webkit-slider-thumb { transition: none; }
}
`;
