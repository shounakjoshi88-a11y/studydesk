import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight, Download, FileText, HardDrive, Image as ImageIcon, Loader2, Lock, Music,
  Search, Star, Video,
} from "lucide-react";
import {
  CATEGORY_LABEL, countLabel, getCachedOverview, getOverview, getVolumeInfo, hasAllFiles,
  hasRowThumb, humanSize, isEncryptedBackup, onFilesChanged, requestAllFiles, startWatching, stopWatching, rowThumbUrl,
  whenLabel, type CategoryId, type DfRecent, type Overview, type VolumeInfo,
} from "../lib/deviceFiles";

/** The grid reads in Google Files' own order, minus "Apps" (app sizes are the
 *  package manager's business, not this file browser's). */
const CATEGORY_ORDER: CategoryId[] = ["downloads", "images", "videos", "audio", "documents"];

const CATEGORY_ICON: Record<string, typeof Download> = {
  downloads: Download,
  images: ImageIcon,
  videos: Video,
  audio: Music,
  documents: FileText,
};

/**
 * The Files landing view, rebuilt to the shape Google Files uses: a search
 * pill, a rail of what you touched lately, category cards with their sizes,
 * two collections, and the storage card. Still a home and not a list, because
 * the first question on opening a file manager is never "show me everything in
 * alphabetical order", it is "where is that thing I was reading".
 */
export function FilesHome({
  onOpenFile,
  onSeeAll,
  onOpenCategory,
  onOpenStarred,
  onOpenStorage,
  onSearch,
  starredCount,
}: {
  onOpenFile: (item: DfRecent) => void;
  onSeeAll: (list: DfRecent[], title: string) => void;
  onOpenCategory: (id: CategoryId) => void;
  onOpenStarred: () => void;
  onOpenStorage: () => void;
  /** Tapping the pill opens the device-wide search screen, as in Google Files. */
  onSearch: () => void;
  /** Device files wearing a star, for the collection card's subtitle. */
  starredCount: number;
}) {
  const [allFiles, setAllFiles] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [total, setTotal] = useState(0);
  const [cats, setCats] = useState<Record<string, { bytes: number; count: number }>>({});
  const [recent, setRecent] = useState<DfRecent[]>([]);
  const [largest, setLargest] = useState<DfRecent[]>([]);
  const [vol, setVol] = useState<VolumeInfo | null>(null);
  const [prompt, setPrompt] = useState(false);

  const apply = (o: Overview) => {
    if (o.denied) return;
    setTotal(o.total ?? 0);
    setRecent(o.recent ?? []);
    setLargest(o.largest ?? []);
    const map: Record<string, { bytes: number; count: number }> = {};
    for (const c of o.categories ?? []) map[c.id] = { bytes: c.bytes, count: c.count };
    setCats(map);
    setReady(true);
  };

  /**
   * Three layers, cheapest first.
   *
   * The cached answer is read from a file, so the screen paints on the first
   * frame with numbers that were correct last time. A reconciliation then runs
   * behind it, and because a directory's mtime changes whenever anything inside
   * it is added or removed, that pass re-reads only the folders that actually
   * moved and returns the cached total for everything else. Media changes push
   * in through MediaStore and simply trigger another reconciliation.
   *
   * A full re-inventory is one call away, for when the numbers have drifted
   * far enough to be worth the walk.
   */
  const reconcile = async (opts?: { full?: boolean }) => {
    setReconciling(true);
    const o = await getOverview(opts);
    setReconciling(false);
    if (!o.denied) apply(o);
  };

  const load = async (opts?: { full?: boolean }) => {
    const ok = await hasAllFiles();
    setAllFiles(ok);
    if (!ok) return;
    void getVolumeInfo().then((v) => {
      if (v) setVol(v);
    });
    if (!ready) {
      const cached = await getCachedOverview();
      if (cached) apply(cached);
    }
    await reconcile(opts);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The user comes back from Android settings having just switched the
  // permission on, so the screen re-reads the world on resume rather than
  // showing remembered state.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MediaStore pushes. One reconcile per burst, not one per file, because a
  // single camera shot can fire a dozen change events.
  useEffect(() => {
    void startWatching();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reconcile(), 900);
    };
    const off = onFilesChanged(bump);
    // The app's own writes — a tool export, a pull from the PC — announce
    // themselves on this window event, so a file this app just made shows up
    // in Recent files even when the MediaStore observer stays quiet.
    window.addEventListener("sd-files-changed", bump);
    return () => {
      if (timer) clearTimeout(timer);
      off();
      window.removeEventListener("sd-files-changed", bump);
      void stopWatching();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Search hints, in Google Files' own manner ("Search 'receipt'"): the words
   * are drawn from this phone's own recent files, so the placeholder always
   * advertises something that actually exists underneath it.
   */
  const hints = useMemo(() => {
    const skip = new Set([
      "img", "vid", "image", "video", "photo", "screenshot", "whatsapp", "document",
      "documents", "download", "downloads", "file", "files", "final", "copy", "edited",
      "scan", "merged", "untitled", "wa00",
    ]);
    const words: string[] = [];
    for (const r of recent) {
      const base = r.name.replace(/\.[a-z0-9]+$/i, "");
      for (const raw of base.split(/[^a-zA-Z]+/)) {
        const w = raw.toLowerCase();
        if (w.length >= 4 && w.length <= 14 && !skip.has(w) && !words.includes(w)) {
          words.push(w);
          if (words.length >= 3) return words;
        }
      }
    }
    return words;
  }, [recent]);

  const [hintIdx, setHintIdx] = useState(0);
  useEffect(() => {
    if (hints.length < 2) return;
    const t = setInterval(() => setHintIdx((i) => (i + 1) % hints.length), 4000);
    return () => clearInterval(t);
  }, [hints.length]);
  const hint = hints.length ? hints[hintIdx % hints.length] : null;

  if (allFiles === null) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-ink-3">
        <Loader2 className="size-4 animate-spin" />
        Checking folder access
      </div>
    );
  }

  if (!allFiles) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto px-4 pt-6">
        <div className="px-1">
          <h3 className="text-[17px] font-semibold text-ink-1">Browse the files on this phone</h3>
          <p className="mt-2 max-w-[46ch] text-[14px] leading-relaxed text-ink-2">
            Android keeps other apps out of your storage by default. Turning on
            &ldquo;All files access&rdquo; lets this app list real folders, so
            nothing has to be imported before you can open it.
          </p>
          <ul className="mt-4 max-w-[46ch] space-y-2 text-[13px] text-ink-3">
            <li>You can switch it off again in Android settings at any time.</li>
            <li>Nothing is uploaded. Reading a file never leaves the phone.</li>
            <li>
              Or share a single folder instead
              {prompt ? " — the system picker is opening." : "."}
            </li>
          </ul>
          <div className="mt-6 flex flex-col gap-2.5">
            <button
              onClick={() => {
                setPrompt(true);
                void requestAllFiles();
              }}
              className="sd-press px-5 text-[15px] font-semibold"
              style={{ background: "var(--paper)", color: "var(--paper-ink)", height: 48, borderRadius: 10 }}
            >
              {prompt ? "Turn it on, then come back" : "Open Android settings"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const catCards = CATEGORY_ORDER.filter((id) => (cats[id]?.count ?? 0) > 0);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-4 pt-4">
        {/* A pill, Google Files' own shape — and, like Google's, a door rather
            than a field: tapping it opens the search screen with the whole
            phone behind it, not a filter over the three recents below. The
            hint text is the loud part and the icon is the quiet one, which is
            why the magnifier sits at the trailing edge here. */}
        <button
          onClick={onSearch}
          className="sd-press flex w-full items-center gap-2.5 rounded-full bg-surface-2 pl-4 pr-3 text-left"
          style={{ height: 48 }}
          aria-label="Search files"
        >
          <span
            key={hint ?? "none"}
            className={`sd-fade-in min-w-0 flex-1 truncate text-[15px] ${hint ? "text-ink-2" : "text-ink-3"}`}
          >
            {hint ? `Search '${hint}'` : "Search files"}
          </span>
          <Search className="size-[18px] shrink-0" style={{ color: "var(--ink-2)" }} aria-hidden />
        </button>
      </div>

      <div className="sd-fade-in flex-1 overflow-y-auto pb-32">
        {!ready && (
          <div className="flex items-center gap-2 px-5 py-4 text-[13px] text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            Reading your storage
          </div>
        )}

        {ready && recent.length > 0 && (
          <section className="mt-8">
            <div className="px-4">
              <SectionHead>Recent files</SectionHead>
            </div>
            {/* Rows, the way Files by Google draws its home list: a small
                square preview, the name, and the size/date that tells two
                similar files apart. The rows settle in one after another
                on first paint — the section's only motion. */}
            <div className="mt-1.5">
              {recent.slice(0, 4).map((r, i) => (
                <RecentRow key={r.path} item={r} index={i} onClick={() => onOpenFile(r)} />
              ))}
            </div>
            <button
              onClick={() => onSeeAll(recent, "Recent files")}
              className="sd-tap flex min-h-[44px] items-center px-4 text-[14px] font-medium"
              style={{ color: "var(--brand-ink)" }}
            >
              View all
            </button>
          </section>
        )}

        {ready && catCards.length > 0 && (
          <section className="mt-8">
            <div className="px-4">
              <SectionHead>Categories</SectionHead>
            </div>
            {/* Cards, not rows: the size is the fact you are here for, and a
                card gives it a line of its own under the name instead of a
                right-aligned number the row has to be scanned across to read. */}
            <div className="mt-2.5 grid grid-cols-2 gap-2.5 px-4">
              {catCards.map((id) => {
                const stat = cats[id] ?? { bytes: 0, count: 0 };
                const Icon = CATEGORY_ICON[id];
                return (
                  <button
                    key={id}
                    onClick={() => onOpenCategory(id)}
                    className="sd-tap flex items-center gap-3 rounded-[20px] bg-surface-1 p-4 text-left"
                  >
                    <Icon className="size-5 shrink-0" style={{ color: "var(--ink-2)" }} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] leading-tight text-ink-1">
                        {CATEGORY_LABEL[id]}
                      </span>
                      <span className="tnum mt-1 block truncate text-[13px] leading-tight text-ink-2">
                        {humanSize(stat.bytes)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {ready && (
          <section className="mt-8">
            <div className="px-4">
              <SectionHead>Collections</SectionHead>
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-2.5 px-4">
              <button
                onClick={onOpenStarred}
                className="sd-tap flex items-center gap-3 rounded-[20px] bg-surface-1 p-4 text-left"
              >
                <Star className="size-5 shrink-0" style={{ color: "var(--ink-2)" }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] leading-tight text-ink-1">Starred</span>
                  <span className="tnum mt-1 block truncate text-[13px] leading-tight text-ink-2">
                    {starredCount > 0
                      ? `${starredCount} file${starredCount === 1 ? "" : "s"}`
                      : "Nothing yet"}
                  </span>
                </span>
              </button>
              <button
                onClick={() => onSeeAll(largest, "Large files")}
                disabled={!largest.length}
                className="sd-tap flex items-center gap-3 rounded-[20px] bg-surface-1 p-4 text-left disabled:opacity-50"
              >
                <HardDrive className="size-5 shrink-0" style={{ color: "var(--ink-2)" }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] leading-tight text-ink-1">Large files</span>
                  <span className="tnum mt-1 block truncate text-[13px] leading-tight text-ink-2">
                    {largest.length > 0 ? `${largest.length} biggest` : "Nothing yet"}
                  </span>
                </span>
              </button>
            </div>
          </section>
        )}

        {ready && (
          <section className="mt-8">
            <div className="px-4">
              <SectionHead>All storage</SectionHead>
            </div>
            <div className="mt-2.5 px-4">
              <button
                onClick={onOpenStorage}
                aria-label="Open internal storage"
                className="sd-tap flex w-full items-center gap-3 rounded-[20px] bg-surface-1 p-4 text-left"
              >
                <HardDrive className="size-5 shrink-0" style={{ color: "var(--ink-2)" }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] leading-tight text-ink-1">Internal storage</span>
                  <span className="tnum mt-1 block text-[13px] leading-tight text-ink-2">
                    {vol ? `${humanSize(vol.free)} free of ${humanSize(vol.total)}` : "On this phone"}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0" style={{ color: "var(--ink-3)" }} aria-hidden />
              </button>
              {/* The one line here that is data rather than chrome, so it
                  carries the refresh: the reconciliation that runs on every
                  open only reads folders that changed, and this is the escape
                  hatch for when even that has drifted. */}
              <button
                onClick={() => void load({ full: true })}
                className="tnum mt-2 block px-1 text-left text-[12px]"
                style={{ color: "var(--ink-3)", opacity: reconciling ? 0.5 : 1 }}
              >
                {countLabel(total)} files • {reconciling ? "checking…" : "check again"}
              </button>
            </div>
          </section>
        )}

        {ready && recent.length === 0 && (
          <p className="px-5 py-8 text-center text-[14px] text-ink-2">
            Nothing recent yet. Files you save or download will show up here.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Section headings carry the same weight Google Files gives them: a full step
 * louder than the metadata under them, because they are how the eye navigates
 * this screen.
 */
function SectionHead({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[16px] font-semibold tracking-tight text-ink-1">{children}</h3>;
}

/** One recent file, drawn as Files by Google draws it: a small square
 *  preview, the name, and the two facts that tell look-alike files apart —
 *  how big it is and when it was last touched. Rows settle in one after
 *  another while the section loads; that stagger is the only motion the
 *  list gets, so a page full of recents never looks busy on arrival. */
function RecentRow({ item, index, onClick }: { item: DfRecent; index: number; onClick: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!hasRowThumb(item.ext)) return;
    let alive = true;
    void rowThumbUrl(item.path, item.ext, 160).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [item.path, item.ext]);

  return (
    <button
      onClick={onClick}
      className="sd-tap sd-row-in flex w-full items-center gap-3.5 px-4 py-2 text-left"
      style={{ animationDelay: `${Math.min(index, 5) * 45}ms` }}
    >
      <span
        className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-[12px]"
        style={{ background: "var(--surface-2)" }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            decoding="async"
            style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : isEncryptedBackup(item.ext) ? (
          <Lock className="size-5" style={{ color: "var(--ink-3)" }} />
        ) : (
          <FileText className="size-5" style={{ color: "var(--ink-3)" }} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-tight text-ink-1">{item.name}</span>
        <span className="tnum mt-1 block truncate text-[12px] leading-tight text-ink-2">
          {humanSize(item.size)}
          <span style={{ color: "var(--ink-3)" }}> • </span>
          {whenLabel(item.lastModified)}
        </span>
      </span>
    </button>
  );
}
