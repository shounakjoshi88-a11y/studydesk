/**
 * A dotLottie sticker, played in place as a tile preview.
 *
 * WhatsApp's newer stickers are ZIP-wrapped Lottie animations that the phone
 * saves under a ".webp" name. A native thumbnail decode of one returns
 * nothing, which is why they used to show up as a document icon. This renders
 * the animation itself instead — so a sticker in a list looks like a sticker,
 * with no tap required.
 *
 * Three guards keep a folder of two hundred stickers pleasant:
 *  - the file is only read once the tile scrolls into view;
 *  - playback pauses while the tile is off screen;
 *  - at most MAX_LIVE tiles animate at once; the rest hold their first frame.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import lottie, { type AnimationItem } from "lottie-web";
import JSZip from "jszip";
import { b64ToBytes } from "../lib/store";
import { readFile } from "../lib/deviceFiles";

/** Parsed animations are kept so scrolling back to a sticker is instant. */
const CACHE_MAX = 32;
const cache = new Map<string, unknown>();
function cacheGet(path: string) {
  const hit = cache.get(path);
  if (hit === undefined) return null;
  // Refresh insertion order so the hottest entries survive eviction.
  cache.delete(path);
  cache.set(path, hit);
  return hit;
}
function cachePut(path: string, value: unknown) {
  cache.set(path, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

const MAX_LIVE = 10;
let live = 0;

export function StickerTile({
  path,
  className = "",
  frameClassName = "",
  fallback = null,
}: {
  path: string;
  className?: string;
  frameClassName?: string;
  fallback?: ReactNode;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const anim = useRef<AnimationItem | null>(null);
  const playing = useRef(false);
  const onScreen = useRef(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">("idle");

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    let alive = true;
    let started = false;

    const release = () => {
      if (playing.current) {
        playing.current = false;
        live = Math.max(0, live - 1);
      }
    };
    const acquire = () => {
      const a = anim.current;
      if (!a || playing.current || !onScreen.current) return;
      if (live >= MAX_LIVE) return;
      if (a.isPaused) a.play();
      playing.current = true;
      live += 1;
    };

    const mount = async () => {
      setState("loading");
      try {
        const data = cacheGet(path);
        let animationData: unknown;
        if (data) {
          animationData = data;
        } else {
          const got = await readFile(path);
          if (!got) throw new Error("unreadable");
          const zip = await JSZip.loadAsync(b64ToBytes(got.data).buffer as ArrayBuffer);
          const entries = Object.values(zip.files).filter((f) => !f.dir);
          const file =
            entries.find((f) => /(^|\/)animation\.json$/i.test(f.name)) ??
            entries.find((f) => /\.json$/i.test(f.name) && !/(trust_token|metadata)/i.test(f.name));
          if (!file) throw new Error("not a sticker");
          animationData = JSON.parse(await file.async("string"));
          cachePut(path, animationData);
        }
        if (!alive || !holder.current) return;
        holder.current.innerHTML = "";
        anim.current = lottie.loadAnimation({
          container: holder.current,
          renderer: "svg",
          loop: true,
          autoplay: false,
          animationData,
          rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
        });
        anim.current.goToAndStop(0, true);
        setState("ready");
        acquire();
      } catch {
        if (alive) setState("failed");
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((x) => x.isIntersecting);
        onScreen.current = visible;
        if (!visible) {
          if (anim.current && !anim.current.isPaused) anim.current.pause();
          release();
          return;
        }
        if (!started) {
          started = true;
          void mount();
          return;
        }
        acquire();
      },
      { rootMargin: "140px" },
    );
    io.observe(el);

    return () => {
      alive = false;
      io.disconnect();
      release();
      anim.current?.destroy();
      anim.current = null;
    };
  }, [path]);

  if (state === "failed") {
    return (
      <div className={`flex items-center justify-center ${className}`}>{fallback}</div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      <div ref={holder} className={`h-full w-full ${frameClassName}`} aria-hidden="true" />
      {state !== "ready" && fallback && (
        <div className="absolute inset-0 flex items-center justify-center">{fallback}</div>
      )}
    </div>
  );
}
