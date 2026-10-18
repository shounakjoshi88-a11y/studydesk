/**
 * Full-screen viewer for sticker files that are not plain images.
 *
 * WhatsApp's newer stickers are dotLottie packages: a ZIP holding one
 * `animation/animation.json` (plus a trust token) that the phone saves with a
 * ".webp" name. An <img> pointed at one of those renders a blank page — which
 * is exactly why these stickers have always looked broken in a file manager.
 * This viewer opens the ZIP in memory, finds the animation, and plays it with
 * the standard Lottie player, so a sticker file finally behaves like a
 * sticker.
 *
 * Static WebP stickers never reach this component: the caller sniffs the bytes
 * and routes real images to the image viewer instead.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Pause, Play, TriangleAlert } from "lucide-react";
import lottie, { type AnimationItem } from "lottie-web";
import JSZip from "jszip";
import { b64ToBytes } from "../lib/store";

export function StickerViewer({
  name,
  data,
  onClose,
}: {
  name: string;
  data: string;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement | null>(null);
  const anim = useRef<AnimationItem | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [playing, setPlaying] = useState(true);
  const [staticUrl, setStaticUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    setState("loading");
    setStaticUrl(null);
    setPlaying(true);
    anim.current?.destroy();
    anim.current = null;

    (async () => {
      try {
        const bytes = b64ToBytes(data);
        const zip = await JSZip.loadAsync(bytes.buffer as ArrayBuffer);
        const entries = Object.values(zip.files).filter((f) => !f.dir);

        const animated =
          entries.find((f) => /(^|\/)animation\.json$/i.test(f.name)) ??
          entries.find((f) => f.name.toLowerCase().endsWith(".json"));

        if (animated) {
          const json = JSON.parse(await animated.async("string")) as {
            assets?: Array<{ u?: string; p?: string; e?: number }>;
          };
          // A dotLottie may keep raster layers beside the JSON; rebind them to
          // blob URLs so the player can draw them without touching the disk.
          if (Array.isArray(json.assets)) {
            for (const a of json.assets) {
              if (!a || typeof a.p !== "string" || a.e === 1) continue;
              const rel = a.u ? `${a.u}${a.p}` : a.p;
              const found = entries.find(
                (f) =>
                  f.name === rel ||
                  f.name.endsWith(`/${rel}`) ||
                  f.name.toLowerCase().endsWith(`/${rel.toLowerCase()}`),
              );
              if (found) {
                const blob = await found.async("blob");
                const u = URL.createObjectURL(blob);
                urls.push(u);
                a.p = u;
                a.u = "";
              }
            }
          }
          if (!alive || !stage.current) return;
          stage.current.innerHTML = "";
          anim.current = lottie.loadAnimation({
            container: stage.current,
            renderer: "svg",
            loop: true,
            autoplay: true,
            animationData: json,
            rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
          });
          setState("ready");
          return;
        }

        // No Lottie inside: some packs hold a plain image instead. Show that.
        const still = entries.find((f) => /\.(webp|png|jpe?g|gif)$/i.test(f.name));
        if (still) {
          const blob = await still.async("blob");
          const u = URL.createObjectURL(blob);
          urls.push(u);
          if (!alive) return;
          setStaticUrl(u);
          setState("ready");
          return;
        }

        if (alive) setState("error");
      } catch {
        if (alive) setState("error");
      }
    })();

    return () => {
      alive = false;
      anim.current?.destroy();
      anim.current = null;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [data]);

  const toggle = useCallback(() => {
    const a = anim.current;
    if (!a || staticUrl) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      a.play();
      setPlaying(true);
    }
  }, [playing, staticUrl]);

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-black">
      <header className="flex items-center gap-2 px-3 pb-2.5 shrink-0 pt-[max(30px,env(safe-area-inset-top))]">
        <button
          onClick={onClose}
          className="sd-press sd-icon -ml-1 text-white"
          aria-label="Back"
        >
          <ArrowLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-white">{name}</div>
          <div className="text-[11px] uppercase tracking-wide text-white/60">
            {staticUrl ? "sticker image" : "animated sticker"}
          </div>
        </div>
        {state === "ready" && !staticUrl && (
          <button
            onClick={toggle}
            className="sd-press sd-icon text-white"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
        )}
      </header>

      <div className="relative flex-1 overflow-hidden">
        <div
          ref={stage}
          onClick={toggle}
          className="h-full w-full p-8"
          role="img"
          aria-label={name}
        />
        {state === "loading" && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            role="status"
            aria-label="Opening sticker"
          >
            <span
              className="block h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/90"
              aria-hidden="true"
            />
          </div>
        )}
        {state === "error" && (
          <div className="absolute inset-0 flex items-center justify-center px-8">
            <div className="flex items-start gap-2 rounded-card border border-line bg-surface-1 p-4 text-sm text-ink-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>This file is a sticker package, but its animation could not be read on this device.</span>
            </div>
          </div>
        )}
        {state === "ready" && staticUrl && (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <img src={staticUrl} alt={name} className="max-h-full max-w-full object-contain" />
          </div>
        )}
      </div>
    </div>
  );
}
