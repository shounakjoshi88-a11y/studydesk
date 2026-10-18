import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Loader2, Search, X } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import {
  countLabel,
  dayHeading,
  formatDuration,
  hasAllFiles,
  humanSize,
  isZipBase64,
  listMedia,
  mediaThumbUrl,
  nativeAvailable,
  onFilesChanged,
  readFile,
  requestAllFiles,
  startWatching,
  type MediaItem,
} from "../lib/deviceFiles";
import { ImageViewer } from "./ImageViewer";
import { VideoPlayer } from "./VideoPlayer";
import { StickerTile } from "./StickerTile";
import { StickerViewer } from "./StickerViewer";

export type MediaGalleryProps = {
  kind: "images" | "videos";
  onClose: () => void;
};

/**
 * Roughly forty rows of three. Big enough that a page of photos arrives in one
 * bridge call, small enough that the last page is never a payload the WebView
 * has to sit on while it renders.
 */
const PAGE = 120;

/** Thumbnail edge, and it is a real edge and not a CSS size: MediaStore scales
 *  to a requested width, and asking for less than the tile costs quality while
 *  asking for more wastes decode time on every tile in the grid. */
const THUMB_W = 400;

/** How far ahead of the viewport a tile starts resolving its thumbnail. */
const THUMB_ROOT_MARGIN = "600px";

const KIND_NOUN: Record<MediaGalleryProps["kind"], { one: string; many: string }> = {
  images: { one: "photo", many: "photos" },
  videos: { one: "video", many: "videos" },
};

/** A cell in a day's grid, carrying where it sits in the loaded list so the
 *  viewer can be handed an absolute index and page through everything loaded
 *  rather than restarting at one. */
type Cell = { item: MediaItem; at: number };
type DaySection = { label: string; cells: Cell[] };

/**
 * One observer for every tile on the screen.
 *
 * Six hundred IntersectionObservers is the same question asked six hundred
 * times; one observer with six hundred targets is it asked once, and a WeakMap
 * means a tile that scrolls out of memory takes its callback with it without
 * anyone having to remember to unregister anything. The margin is generous on
 * purpose — a thumbnail that starts resolving only once its tile is visible
 * arrives after the tile does, and the placeholder is what the user sees while
 * it catches up.
 */
const thumbWatchers = (() => {
  const pending = new WeakMap<Element, () => void>();
  let io: IntersectionObserver | null = null;

  const ensure = (): IntersectionObserver | null => {
    if (typeof IntersectionObserver === "undefined") return null;
    io ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const run = pending.get(e.target);
          // Cleared before it runs: a tile only ever wants one resolution, and
          // unobserving here means a tile that scrolls away and back is served
          // from the cache instead of the bridge.
          pending.delete(e.target);
          io?.unobserve(e.target);
          run?.();
        }
      },
      { rootMargin: THUMB_ROOT_MARGIN }
    );
    return io;
  };

  return {
    /** Run `onNear` once, when `el` comes near the viewport. Returns the
     *  detach that a tile's own unmount cleanup calls. */
    watch(el: Element, onNear: () => void): () => void {
      const obs = ensure();
      // No observer means no "near" signal at all, and a gallery that never
      // loads its pictures is worse than one that loads them eagerly.
      if (!obs) {
        onNear();
        return () => {};
      }
      pending.set(el, onNear);
      obs.observe(el);
      return () => {
        pending.delete(el);
        obs.unobserve(el);
      };
    },
  };
})();

/**
 * Device-wide photos and videos, read from MediaStore.
 *
 * The Images and Videos categories used to open /sdcard/Pictures and
 * /sdcard/Movies, which is why Videos showed one file on a phone full of them:
 * almost nothing records into Movies, and everything lands in Camera,
 * WhatsApp, Telegram or Downloads. MediaStore is the index the phone's own
 * Photos app reads, so one query here returns every photo and clip regardless
 * of which folder anyone happened to choose.
 */
export function MediaGallery({ kind, onClose }: MediaGalleryProps) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [bucket, setBucket] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ index: number } | null>(null);
  /** A dotLottie sticker opened from the grid. It has no second frame the
   *  image pager could offer, so it gets a viewer of its own. */
  const [sticker, setSticker] = useState<{ name: string; data: string } | null>(null);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [prompted, setPrompted] = useState(false);

  const noun = KIND_NOUN[kind];

  const scroller = useRef<HTMLDivElement | null>(null);
  /** Resolved thumbnail URLs, keyed by MediaStore id. Session-lifetime and
   *  never cleared: a file's bytes have not changed just because the user
   *  scrolled it off and back, and re-resolving is the one thing that turns a
   *  grid into a stutter. `null` is a cached miss so a row the native side
   *  cannot read costs one call rather than one per visit. */
  const thumbs = useRef(new Map<string, string | null>());

  /**
   * The paging guard is a ref, not state, on purpose. A scroll listener fires
   * far more often than React commits, so a state flag would be read stale for
   * the whole time between two scrolls — which on a fast fling is several
   * fetches for the same page. A ref is written and read within one tick of
   * the handler, so exactly one page is ever in flight.
   */
  const inFlight = useRef(false);
  /** Set when a live change lands mid-page, so it runs as soon as that page
   *  does rather than being dropped and leaving the gallery stale until the
   *  user happens to scroll past the end. */
  const refreshQueued = useRef(false);
  const done = useRef(false);
  /** The loaded list, mirrored outside state so a fetch can read how deep it
   *  already is without waiting for a render that may not have happened yet. */
  const itemsRef = useRef<MediaItem[]>([]);
  /** Every setState below is behind this. The bridge calls are not cancelable
   *  and the last page of a fast scroll can land after the user is gone. */
  const alive = useRef(true);

  const reduced = useReducedMotion();

  useEffect(() => {
    alive.current = true;
    const had = itemsRef.current.length;
    itemsRef.current = [];
    done.current = false;
    refreshQueued.current = false;
    /* Guarded because the initial state is already empty, and handing React a
       fresh [] on mount would buy one extra render of nothing. A change of
       `kind` without an unmount does not come through here — it comes through
       loadPage's identity changing, which re-runs as a reset and replaces the
       list wholesale. */
    if (had) setItems([]);
    setReady(false);
    setViewer(null);
    /* The native observer is started but never stopped here. startWatching
       is idempotent, stopWatching is not — it tears the ContentObserver down
       unconditionally — so a gallery that unregistered on its way out could
       switch off the feed a view that has already mounted is relying on.
       FilesHome owns the pair. */
    void startWatching();
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void hasAllFiles().then((ok) => {
      if (alive) setGranted(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * One page, once. `reset` re-reads from the top; otherwise it appends.
   *
   * Nothing on this path can throw — `listMedia` swallows a failed query and
   * answers with an empty page — because a gallery that throws under the grid
   * has no way to say so.
   */
  const loadPage = useCallback(
    async (reset: boolean) => {
      if (inFlight.current) {
        if (reset) refreshQueued.current = true;
        return;
      }
      if (!reset && done.current) return;

      inFlight.current = true;
      let again = false;
      const offset = reset ? 0 : itemsRef.current.length;
      /* Re-reading after a live change has to cover the depth already on
         screen. Reading back only the first page would shrink the gallery out
         from under a scroll position the user chose. */
      const depth = reset ? Math.max(itemsRef.current.length, PAGE) : PAGE;
      try {
        const r = await listMedia(kind, depth, offset);
        if (!alive.current) return;

        let merged: MediaItem[];
        if (reset) {
          merged = r.items;
        } else {
          /* A photo taken between two pages shifts every offset after it, so
             an append can repeat a row. Duplicate ids mean duplicate React
             keys, and a duplicated key remounts two tiles and throws both their
             thumbnails away. */
          const seen = new Set(itemsRef.current.map((i) => i.id));
          const fresh = r.items.filter((i) => !seen.has(i.id));
          merged = fresh.length ? itemsRef.current.concat(fresh) : itemsRef.current;
        }

        itemsRef.current = merged;
        setItems(merged);
        setTotal(r.total);
        setReady(true);
        done.current = merged.length >= r.total;

        if (refreshQueued.current) {
          refreshQueued.current = false;
          again = true;
        }
      } finally {
        inFlight.current = false;
      }
      if (again) void loadPage(true);
    },
    [kind]
  );

  useEffect(() => {
    void loadPage(true);
  }, [loadPage]);

  /**
   * MediaStore fires one notification per file it touches, and a camera burst,
   * a chat download landing or a bulk cleanup can touch dozens inside a second.
   * The native side already coalesces onto 1.2s; this second delay is what
   * stops a burst becoming a burst of bridge queries, and clearing it on
   * unmount is what guarantees a pending timer can never write into a tree
   * that is already gone.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onFilesChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadPage(true), 1200);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [loadPage]);

  /* The user comes back from Android settings having just switched the
     permission on, so the screen re-reads the world on resume rather than
     showing remembered state — which is the whole point of having a way back
     out to settings from here. */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void hasAllFiles().then((ok) => {
        if (!alive.current) return;
        setGranted(ok);
        if (ok) void loadPage(true);
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadPage]);

  const closeViewer = useCallback(() => setViewer(null), []);

  /**
   * A ".webp" that is really a dotLottie package cannot ride the image pager —
   * an <img> renders it as a blank page — so those route to the sticker
   * viewer. Real WebPs keep paging exactly as they did.
   */
  const openAt = useCallback(
    async (at: number) => {
      const item = items[at];
      if (item && /\.webp$/i.test(item.name) && item.path) {
        const got = await readFile(item.path);
        if (got && isZipBase64(got.data)) {
          setSticker({ name: item.name, data: got.data });
          return;
        }
      }
      setViewer({ index: at });
    },
    [items],
  );

  // Switching between Images and Videos must not carry a folder filter over —
  // "Camera" in Images says nothing about which bucket a Video belongs to.
  useEffect(() => {
    setBucket(null);
  }, [kind]);

  /* The hardware back button. Without this the gallery swallows the gesture the
     user expects to close it and the WebView exits the app instead. While a
     viewer is open, back closes the viewer — which is what the platform means
     by back — and only then does it mean the gallery. */
  useEffect(() => {
    let handle: { remove: () => Promise<void> } | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const h = await App.addListener("backButton", () => {
          if (sticker) setSticker(null);
          else if (viewer) closeViewer();
          else onClose();
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
  }, [sticker, viewer, closeViewer, onClose]);

  /**
   * Grouped by the phone's own day labels rather than by a raw timestamp, so a
   * section is "Yesterday" or "12 March" and never "17 hours ago". Runs of the
   * same label merge rather than being keyed by label, because the index is
   * newest-first and two separate runs can legitimately share a day.
   *
   * Search is over what has been loaded, and says so. Filtering the whole
   * MediaStore would need a query this bridge does not have, and pretending
   * otherwise would send the user looking for a photo that was never asked for.
   */
  const sections = useMemo<DaySection[]>(() => {
    const needle = query.trim().toLowerCase();
    const out: DaySection[] = [];
    items.forEach((item, at) => {
      if (bucket && (item.bucket || "Other") !== bucket) return;
      if (needle) {
        const name = item.name.toLowerCase();
        const bucket = item.bucket?.toLowerCase() ?? "";
        if (!name.includes(needle) && !bucket.includes(needle)) return;
      }
      const label = dayHeading(item.lastModified);
      const tail = out[out.length - 1];
      if (tail && tail.label === label) tail.cells.push({ item, at });
      else out.push({ label, cells: [{ item, at }] });
    });
    return out;
  }, [items, query, bucket]);

  /** The folders the loaded rows came from, hungriest first — the chips row. */
  const bucketChips = useMemo<Array<[string, number]>>(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      const b = it.bucket || "Other";
      m.set(b, (m.get(b) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const shown = sections.reduce((n, s) => n + s.cells.length, 0);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    /* A screen ahead rather than at the edge: by the time the user reaches the
       last row the next page is already there, so the bottom of the grid never
       shows a hole or a spinner while it waits. The in-flight ref inside
       loadPage is what makes firing this on every scroll event safe. */
    if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) {
      void loadPage(false);
    }
  }, [loadPage]);

  /* Derived rather than read off the ref: a ref changes without rendering, so
     anything that a reader can see has to come out of state. Equivalent to
     done.current everywhere the footer can actually appear. */
  const atEnd = items.length >= total;

  /* Google Files never narrates its own paging, and a "120 of 9,424" counter
     makes a photo library feel like a download. The library's own size is the
     one fact worth keeping, and it can wait until it is known. */
  const countLine =
    total > 0
      ? `${countLabel(total)} ${total === 1 ? noun.one : noun.many}`
      : ready
        ? undefined
        : "Reading the media library";

  /* ── states ─────────────────────────────────────────────────── */

  if (granted === null) {
    return (
      <Frame title={kind === "images" ? "Images" : "Videos"} onClose={onClose}>
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-ink-3">
          <Loader2 className="size-4 animate-spin" />
          Checking folder access
        </div>
      </Frame>
    );
  }

  if (!granted) {
    const native = nativeAvailable();
    return (
      <Frame title={kind === "images" ? "Images" : "Videos"} onClose={onClose}>
        <div className="flex flex-1 flex-col overflow-y-auto px-4 pt-4">
          <div className="px-1">
            <h3 className="text-[17px] font-semibold text-ink-1">
              {native
                ? `Open All files access to browse your ${noun.many}`
                : `This gallery needs the Android app`}
            </h3>
            <p className="mt-2 max-w-[46ch] text-[14px] leading-relaxed text-ink-2">
              {native
                ? "Android keeps other apps out of your storage by default. All files access is what lets this app read the media index, which is where every photo and clip on this phone is already listed, whichever folder it was saved into."
                : "Photos and videos are read from the phone's own media index. A browser preview has no way to reach it, so open the app on your phone to browse your library."}
            </p>
            <p className="mt-3 max-w-[46ch] text-[13px] leading-relaxed text-ink-3">
              {native
                ? "You can switch it off again in Android settings at any time. Nothing is uploaded."
                : "Everything in this app runs on the phone and stays there."}
            </p>
            {/* One primary action, and it is the same one FilesHome offers, so
                the way out of this state is the same wherever you meet it. */}
            {native && (
              <div className="mt-6">
                <button
                  onClick={() => {
                    setPrompted(true);
                    void requestAllFiles();
                  }}
                  className="sd-press px-5 text-[15px] font-semibold"
                  style={{ background: "var(--paper)", color: "var(--paper-ink)", height: 48, borderRadius: 10 }}
                >
                  {prompted ? "Turn it on, then come back" : "Open Android settings"}
                </button>
              </div>
            )}
          </div>
        </div>
      </Frame>
    );
  }

  return (
    <Frame title={kind === "images" ? "Images" : "Videos"} countLine={countLine} onClose={onClose}>
      <div className="flex shrink-0 items-center gap-2.5 px-4 pt-3">
        <div
          className="flex flex-1 items-center gap-2.5 rounded-full bg-surface-2 pl-4 pr-1.5 focus-within:ring-1 focus-within:ring-brand/40"
          style={{ height: 48 }}
        >
          <Search className="size-[18px] shrink-0" style={{ color: "var(--ink-2)" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search loaded ${noun.many}`}
            aria-label={`Search the ${noun.many} already loaded`}
            className="flex-1 min-w-0 bg-transparent text-[15px] outline-none placeholder:text-ink-2"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear search" className="sd-press grid size-9 shrink-0 place-items-center">
              <X className="size-4" style={{ color: "var(--ink-2)" }} />
            </button>
          )}
        </div>
      </div>

      {/* Source folders as chips — the row Google Files puts under its own
          header. It is a filter, not navigation: choosing one narrows the grid
          in place, and All brings the rest back. */}
      {bucketChips.length > 1 && (
        <div
          className="flex shrink-0 items-center gap-1 overflow-x-auto px-3"
          style={{ scrollbarWidth: "none" }}
        >
          <Chip active={bucket === null} onClick={() => setBucket(null)}>
            All
          </Chip>
          {bucketChips.map(([name]) => (
            <Chip key={name} active={bucket === name} onClick={() => setBucket(bucket === name ? null : name)}>
              {name}
            </Chip>
          ))}
        </div>
      )}

      <div
        ref={scroller}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 28px)" }}
      >
        {/* The one orchestrated moment on this screen. A grid that assembles is
            how a photo library says "these are photographs", and doing it once
            on first paint is enough — the tiles themselves never animate, which
            is what keeps a fast scroll from animating a hundred of them. */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduced ? 0 : 0.26, ease: [0.16, 1, 0.3, 1] }}
        >
          {!ready && <SkeletonGrid />}

          {ready && shown === 0 && <Nothing kind={kind} query={query} onClear={() => setQuery("")} />}

          {sections.map((sec, si) => (
            <section key={`${sec.label}-${si}`} className="mt-5 first:mt-2">
              {/* Sticky, because a grid this long loses its place otherwise: the
                  day you are looking at should stay on screen while you scroll
                  through it. Opaque, not translucent, or the tiles behind show
                  through the label and the label stops being readable. */}
              <h3
                className="sticky top-0 z-10 flex items-baseline gap-2 bg-background px-3 py-2 text-[12px] font-medium"
                style={{ color: "var(--ink-3)" }}
              >
                {sec.label}
                <span className="tnum">{sec.cells.length} items</span>
              </h3>
              {/* Tiles flush to a 2px gap with a 3px radius, which is what a
                  photo grid is: not a card grid with three corners rounded and
                  a shadow each, but pictures that sit next to one another.
                  Everything else on this screen is a card, so making this one
                  not a card is what stops it reading as a different app. */}
              <div className="grid grid-cols-3 gap-1.5 px-2.5">
                {sec.cells.map(({ item, at }) => (
                  <Tile
                    key={item.id}
                    item={item}
                    kind={kind}
                    thumbs={thumbs}
                    onOpen={() => void openAt(at)}
                  />
                ))}
              </div>
            </section>
          ))}

          {ready && shown > 0 && !atEnd && (
            /* Quiet, and only for a page that is actually on its way. A spinner
               per tile would be hundreds; one line under the last row is one. */
            <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-ink-3">
              <Loader2 className="size-4 animate-spin" />
              Loading more
            </div>
          )}
        </motion.div>
      </div>

      {viewer &&
        (kind === "images" ? (
          <ImageViewer
            items={items}
            index={viewer.index}
            onClose={closeViewer}
            onIndexChange={(i) => setViewer({ index: i })}
          />
        ) : (
          <VideoPlayer
            items={items}
            index={viewer.index}
            onClose={closeViewer}
            onIndexChange={(i) => setViewer({ index: i })}
          />
        ))}
      {sticker && (
        <StickerViewer name={sticker.name} data={sticker.data} onClose={() => setSticker(null)} />
      )}
    </Frame>
  );
}

/**
 * The chrome every state shares: a back control, the title, and the one line
 * under it that is data rather than decoration. It is the same header
 * DeviceBrowser uses, word for word, because a user who has just come from
 * /sdcard/Download should not have to learn a new screen.
 */
function Frame({
  title,
  countLine,
  onClose,
  children,
}: {
  title: string;
  countLine?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed inset-0 z-[45] flex flex-col overflow-hidden bg-background"
      style={{ paddingTop: "max(env(safe-area-inset-top), 10px)" }}
    >
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3">
        {/* 44px rather than DeviceBrowser's tighter box. The icon lands in the
            same place either way; the difference is the invisible edge a thumb
            actually lands on. */}
        <button onClick={onClose} className="sd-press -ml-2 flex size-11 shrink-0 items-center justify-center" aria-label="Back to files home">
          <ChevronLeft className="size-[18px]" style={{ color: "var(--ink-2)" }} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium text-ink-1">{title}</div>
          {countLine && <div className="tnum truncate text-[12px] text-ink-3">{countLine}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * One picture. The placeholder is a flat block rather than a spinner because a
 * grid of two hundred silent spinners is noise, and the tile underneath is
 * about to cover it anyway.
 *
 * Thumbnails resolve when the tile approaches the viewport and are remembered
 * by id, so a tile that scrolls away and back costs nothing the second time.
 */
function Tile({
  item,
  kind,
  thumbs,
  onOpen,
}: {
  item: MediaItem;
  kind: MediaGalleryProps["kind"];
  thumbs: React.RefObject<Map<string, string | null>>;
  onOpen: () => void;
}) {
  const holder = useRef<HTMLButtonElement | null>(null);
  /* undefined = still to come, null = the native side could not read it,
     string = resolved. The three are genuinely different states and only the
     third has anything to draw. */
  const cached = thumbs.current.get(item.id);
  const [url, setUrl] = useState<string | null | undefined>(cached === undefined ? undefined : cached);

  useEffect(() => {
    const el = holder.current;
    if (!el || url !== undefined) return;
    let alive = true;
    const stop = thumbWatchers.watch(el, () => {
      void mediaThumbUrl(item, THUMB_W).then((u) => {
        thumbs.current.set(item.id, u);
        if (alive) setUrl(u);
      });
    });
    return () => {
      alive = false;
      stop();
    };
  }, [item, url, thumbs]);

  const dur = kind === "videos" ? formatDuration(item.durationMs ?? 0) : "";

  return (
    <button
      ref={holder}
      onClick={onOpen}
      aria-label={dur ? `${item.name}, ${dur}` : item.name}
      className="sd-tap relative block aspect-square overflow-hidden rounded-[14px]"
      style={{ background: "var(--surface-1)" }}
    >
      {url ? (
        <img
          src={url}
          alt={item.name}
          loading="lazy"
          decoding="async"
          style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : url === null && /\.webp$/i.test(item.name) && item.path ? (
        // A dotLottie sticker — a failed thumbnail decode is the tell. The
        // animation is its own thumbnail.
        <StickerTile path={item.path} className="absolute inset-0" frameClassName="p-3" />
      ) : null}
      {/* Size on the tile, exactly where Google Files puts it: the one number a
          grid of lookalike screenshots can never show you is its weight. */}
      {item.size > 0 && (
        <span
          className="tnum pointer-events-none absolute right-1.5 top-1.5 rounded-[6px] px-1.5 py-0.5 text-[11px] leading-none text-white"
          style={{ background: "rgba(0, 0, 0, 0.5)" }}
        >
          {humanSize(item.size)}
        </span>
      )}
      {/* Duration as a chip in the corner, not a play triangle over the frame.
          A triangle on every video turns a gallery into a wall of identical
          icons that all say the same thing; the length is the part you cannot
          already tell from the frame. */}
      {dur && (
        <span
          className="tnum pointer-events-none absolute bottom-1 right-1 rounded-[3px] px-1 py-0.5 text-[11px] leading-none text-white/90"
          style={{ background: "rgba(0, 0, 0, 0.62)" }}
        >
          {dur}
        </span>
      )}
    </button>
  );
}

/**
 * One source-folder chip. Active is colour plus an underline bar, so the choice
 * survives greyscale the way the rest of the app's marks do.
 */
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className="relative shrink-0 px-2.5 pb-2 pt-2.5 text-[14px]"
      style={{ color: active ? "var(--brand)" : "var(--ink-2)" }}
    >
      {children}
      {active && (
        <span
          className="absolute inset-x-2 bottom-0 h-[2px] rounded-full"
          style={{ background: "var(--brand)" }}
        />
      )}
    </button>
  );
}

/** The shape of the grid, at the grid's own rhythm, so the first paint does not
 *  jump when the photographs arrive. `.sd-skeleton` is a flat surface block by
 *  design — a shimmer across nine tiles would be the second loudest thing on
 *  the screen. */
function SkeletonGrid() {
  return (
    <div className="grid grid-cols-3 gap-0.5 px-2 pt-2" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="sd-skeleton aspect-square rounded-[3px]" />
      ))}
    </div>
  );
}

/**
 * Two empties, not one. "Nothing here yet" and "nothing matches what you
 * typed" are different problems and a user in the second one is being told the
 * wrong thing if they are shown the first.
 */
function Nothing({
  kind,
  query,
  onClear,
}: {
  kind: MediaGalleryProps["kind"];
  query: string;
  onClear: () => void;
}) {
  const noun = KIND_NOUN[kind];
  const filtering = query.trim().length > 0;
  return (
    <div className="flex flex-col items-center px-8 pt-10" role="status">
      <GalleryMark />
      <p className="mt-4 text-center text-sm font-semibold text-ink-1">
        {filtering ? "Nothing matches that" : `No ${noun.many} on this phone`}
      </p>
      <p className="mt-1 max-w-[34ch] text-center text-xs leading-relaxed text-ink-2">
        {filtering
          ? `Search only covers the ${noun.many} already loaded, and this is every one of them that matched. Clear it to see the rest.`
          : `Anything the camera, the gallery or another app has saved shows up here, whichever folder it went into.`}
      </p>
      {filtering && (
        <button onClick={onClear} className="sd-press mt-4 rounded-[8px] px-4 text-[14px] font-medium" style={{ height: 44, background: "var(--surface-2)", color: "var(--ink-1)" }}>
          Clear search
        </button>
      )}
    </div>
  );
}

/**
 * The mark: this screen's own grid, with one picture found in it.
 *
 * The shared EmptyState art is a cartoon folder with a face, which answers a
 * question about saved documents and would be actively misleading here. This
 * is drawn in the same tokens and the same stroke weight as the rest of the app
 * and it does not move — a screen someone opens every day should not greet
 * them with an animation.
 */
function GalleryMark() {
  return (
    <svg width="112" height="80" viewBox="0 0 112 80" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="111" height="79" rx="10" stroke="var(--line-strong)" />
      <path d="M38 0.5v79M74 0.5v79M0.5 40h111" stroke="var(--line-strong)" />
      {/* one cell found */}
      <rect x="1" y="1" width="36" height="38" fill="var(--brand-soft)" />
      <circle cx="11" cy="11" r="2.5" stroke="var(--brand-ink)" strokeWidth="1.5" />
      <path
        d="M7 30l7.5-8.5 5 5 5.5-6.5L33 30"
        stroke="var(--brand-ink)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}