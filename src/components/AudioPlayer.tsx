/**
 * AudioPlayer — the screen a song or a voice note opens into. The Files tab
 * had viewers for photos, clips and stickers; sound was the one kind of file
 * it could only offer as a hex dump. This is the missing fourth: a tile the
 * size the artwork would be, the name, a scrubbable rail, and three buttons.
 *
 * The <audio> element is built by hand instead of rendered into the tree so
 * the source can change without React recreating it mid-playback — and so
 * closing the screen is what stops the sound, not a stray re-render.
 *
 * Playback starts on open, because opening a file from a list is the
 * gesture. If the WebView still refuses (fresh process, no user activation
 * yet), the failure is silent on purpose: the play button is right there,
 * and tapping it is itself the gesture that unblocks the sound.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Loader2, Music, Pause, Play, RotateCcw, RotateCw, X } from "lucide-react";
import { humanSize, whenLabel } from "../lib/deviceFiles";

/** Seconds to m:ss / h:mm:ss. Unlike formatDuration, a zero here is a real
 *  position on the rail and earns its "0:00". */
function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function AudioPlayer({
  path,
  name,
  ext,
  size,
  lastModified,
  data,
  onClose,
}: {
  /** Absolute device path. Empty when the sound lives inside the app. */
  path: string;
  name: string;
  ext: string;
  size: number;
  lastModified: number;
  /** Base64 for app-owned files; a data URL is their only playable form. */
  data?: string;
  onClose: () => void;
}) {
  const el = useRef<HTMLAudioElement | null>(null);
  const rail = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  /** While a finger is down on the rail this is where the head is drawn;
   *  the element seeks once, on release. */
  const [drag, setDrag] = useState<number | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const src = useMemo(() => {
    if (data) return `data:audio/${ext === "mp3" ? "mpeg" : ext || "mpeg"};base64,${data}`;
    if (!path) return null;
    if (path.startsWith("file:") || path.startsWith("content:")) return path;
    return Capacitor.convertFileSrc(path);
  }, [data, ext, path]);

  useEffect(() => {
    if (!src) {
      setFatal("This file could not be opened. It may have been moved or deleted since the list was loaded.");
      return;
    }
    setFatal(null);
    setPlaying(false);
    setBuffering(true);
    setTime(0);
    setDuration(0);
    const audio = new Audio();
    el.current = audio;
    let alive = true;
    audio.preload = "auto";
    audio.src = src;

    const onMeta = () => {
      if (!alive) return;
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    };
    const onTime = () => {
      if (alive) setTime(audio.currentTime);
    };
    const onPlay = () => {
      if (alive) setPlaying(true);
    };
    const onPause = () => {
      if (alive) setPlaying(false);
    };
    const onWaiting = () => {
      if (alive) setBuffering(true);
    };
    const onPlaying = () => {
      if (alive) setBuffering(false);
    };
    const onEnded = () => {
      if (alive) {
        setPlaying(false);
        setTime(audio.duration || 0);
      }
    };
    const onError = () => {
      if (alive) {
        setBuffering(false);
        setFatal("This file could not be played. The phone may have no decoder for it.");
      }
    };

    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    void audio.play().catch(() => {
      /* Autoplay refused: the button stays on ▶ and a tap is the gesture. */
      if (alive) setBuffering(false);
    });

    return () => {
      alive = false;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      el.current = null;
    };
  }, [src]);

  const toggle = () => {
    const audio = el.current;
    if (!audio) return;
    if (audio.ended) audio.currentTime = 0;
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  };

  const skip = (delta: number) => {
    const audio = el.current;
    if (!audio) return;
    const end = audio.duration || duration || 0;
    audio.currentTime = Math.min(Math.max(0, audio.currentTime + delta), end);
    setTime(audio.currentTime);
  };

  const seekTo = (clientX: number): number => {
    const r = rail.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return 0;
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return p * (duration || el.current?.duration || 0);
  };

  const commitDrag = () => {
    if (drag == null) return;
    const audio = el.current;
    if (audio) audio.currentTime = drag;
    setTime(drag);
    setDrag(null);
  };

  const shown = drag ?? time;
  const pct = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${name}`}
      className="fixed inset-0 z-[80] flex flex-col bg-background"
      style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
    >
      <header className="flex shrink-0 items-center gap-2 px-2 pb-1 pt-[max(30px,env(safe-area-inset-top))]">
        <button
          onClick={onClose}
          className="sd-press sd-icon"
          aria-label="Close player"
        >
          <X className="size-5" style={{ color: "var(--ink-1)" }} />
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-[13px]" style={{ color: "var(--ink-2)" }}>
          {name}
        </div>
        {/* Keeps the name centred over the full width, not over the row
            minus one button. */}
        <span className="size-11 shrink-0" aria-hidden />
      </header>

      {fatal ? (
        <div className="flex flex-1 items-center justify-center px-10">
          <p className="text-center text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
            {fatal}
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-8">
          <div
            className="sd-card-in flex aspect-square w-full max-w-[248px] items-center justify-center rounded-[28px]"
            style={{ background: "var(--surface-1)" }}
          >
            <Music className="size-16" style={{ color: "var(--ink-3)" }} aria-hidden />
          </div>

          <h2 className="mt-7 w-full truncate text-center text-[17px] font-semibold tracking-tight text-ink-1">
            {name}
          </h2>
          <p className="tnum mt-1.5 text-[12px] text-ink-2">
            {humanSize(size)}
            <span style={{ color: "var(--ink-3)" }}> • </span>
            {whenLabel(lastModified)}
          </p>

          <div className="mt-6 w-full max-w-[320px]">
            <div
              ref={rail}
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(shown)}
              className="relative flex h-10 cursor-pointer touch-none select-none items-center"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setDrag(seekTo(e.clientX));
              }}
              onPointerMove={(e) => {
                if (drag != null) setDrag(seekTo(e.clientX));
              }}
              onPointerUp={commitDrag}
              onPointerCancel={commitDrag}
            >
              <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-3)" }}>
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--brand)" }} />
              </div>
              <span
                className="absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full"
                style={{ left: `clamp(0px, calc(${pct}% - 7px), calc(100% - 14px))`, background: "var(--brand)" }}
                aria-hidden
              />
            </div>
            <div className="tnum -mt-0.5 flex items-center justify-between text-[11px]" style={{ color: "var(--ink-3)" }}>
              <span>{clock(shown)}</span>
              <span>{duration > 0 ? clock(duration) : "--:--"}</span>
            </div>
          </div>

          <div className="mt-7 flex items-center justify-center gap-9">
            <button
              onClick={() => skip(-10)}
              className="sd-press flex size-12 items-center justify-center rounded-full"
              style={{ background: "var(--surface-2)", color: "var(--ink-1)" }}
              aria-label="Back 10 seconds"
            >
              <RotateCcw className="size-[22px]" />
            </button>
            <button
              onClick={toggle}
              className="sd-tap flex size-[72px] items-center justify-center rounded-full bg-brand text-background"
              aria-label={playing ? "Pause" : "Play"}
            >
              {buffering && !playing ? (
                <Loader2 className="size-7 animate-spin" />
              ) : playing ? (
                <Pause className="size-8" />
              ) : (
                /* The play triangle's optical centre sits left of its box;
                   two pixels of travel make it look centred in the circle. */
                <Play className="size-8 translate-x-[2px]" />
              )}
            </button>
            <button
              onClick={() => skip(10)}
              className="sd-press flex size-12 items-center justify-center rounded-full"
              style={{ background: "var(--surface-2)", color: "var(--ink-1)" }}
              aria-label="Forward 10 seconds"
            >
              <RotateCw className="size-[22px]" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
