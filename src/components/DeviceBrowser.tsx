import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronUp, Loader2, Search, X } from "lucide-react";
import { EmptyState } from "./EmptyState";
import { DragSheet } from "./DragSheet";
import { StickerTile } from "./StickerTile";
import { shareFileData } from "../lib/share";
import { addFile, type FileMeta } from "../lib/store";
import {
  baseName, dayHeading, FILTER_LABEL, filterOf, getDir, hasRowThumb, humanSize, isAudio, parentOf,
  readFile, rowThumbUrl, whenLabel, type DfEntry, type DfRecent, type FilterId,
} from "../lib/deviceFiles";

/**
 * A real folder on the phone, listed the way the Documents app lists one: type
 * filters across the top, then files grouped by day with a thumbnail beside
 * each name.
 *
 * Folders are walked lazily. A phone can hold a hundred thousand files and the
 * only honest way to show a tree is one directory at a time.
 */
export function DeviceBrowser({
  path,
  title,
  fixedRecent,
  fixedFilter,
  pinnedList,
  onOpen,
  onBack,
  onDriveUpload,
}: {
  path: string | null;
  /** Overrides the folder title. Used when showing a filtered set. */
  title?: string;
  /** A pre-filtered list to show instead of walking a directory. */
  fixedRecent?: DfRecent[] | null;
  fixedFilter?: FilterId;
  /** Pinned/imported files, which live in the app rather than on disk. */
  pinnedList?: FileMeta[] | null;
  onOpen: (meta: FileMeta, data: string, truncated: boolean) => void;
  onBack: () => void;
  /** Straight from a row's sheet to the Drive screen, which asks where. */
  onDriveUpload?: (list: DfRecent[]) => void;
}) {
  const [entries, setEntries] = useState<DfEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterId>("all");
  const [q, setQ] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [menu, setMenu] = useState<DfEntry | null>(null);
  const [busy, setBusy] = useState(false);

  /** The scrolling file list. A context switch — new folder, new type filter —
   *  has to land at the top, because keeping the old offset made the new
   *  content invisible above the fold and every filter looked identical. */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const toTop = () => scrollRef.current?.scrollTo({ top: 0 });

  useEffect(() => {
    if (fixedRecent || pinnedList) {
      setEntries([]);
      return;
    }
    if (path === null) return;
    let alive = true;
    setLoading(true);
    void getDir(path).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (r.denied) {
        setNote("Android is not letting the app read storage. Turn on All files access in settings.");
      }
      setEntries(r.entries);
    });
    return () => {
      alive = false;
    };
  }, [path, fixedRecent, pinnedList]);

  // A new place is a new context: filters and search belong to where you are.
  useEffect(() => {
    setFilter(fixedFilter ?? "all");
    setQ("");
    toTop();
  }, [path, fixedFilter, fixedRecent, pinnedList]);

  const useFilter = filter;

  // A new filter is a new list even when the folder is the same.
  useEffect(() => {
    toTop();
  }, [useFilter]);

  const files = useMemo(() => {
    if (pinnedList) {
      return pinnedList.map((f) => ({
        path: `app:${f.id}`,
        name: f.name,
        isDir: false,
        ext: f.ext,
        size: f.size,
        lastModified: f.addedAt,
        mime: "",
      }));
    }
    if (fixedRecent) {
      return fixedRecent.map((r) => ({ ...r, isDir: false, mime: r.mime ?? "" }));
    }
    return entries.filter((e) => !e.isDir);
  }, [entries, fixedRecent, pinnedList]);

  const folders = useMemo(() => {
    if (fixedRecent || pinnedList) return [] as DfEntry[];
    return entries.filter((e) => e.isDir);
  }, [entries, fixedRecent, pinnedList]);

  const shownFiles = useMemo(() => {
    const query = q.trim().toLowerCase();
    let list = files;
    if (useFilter !== "all") list = list.filter((f) => filterOf(f.ext) === useFilter);
    if (query) list = list.filter((f) => f.name.toLowerCase().includes(query));
    return [...list].sort((a, b) => b.lastModified - a.lastModified);
  }, [files, useFilter, q]);

  const filters = useMemo(() => {
    const present = new Set(files.map((f) => filterOf(f.ext)));
    const ids: FilterId[] = ["all"];
    for (const id of Object.keys(FILTER_LABEL) as FilterId[]) {
      if (id !== "all" && present.has(id)) ids.push(id);
    }
    return ids;
  }, [files]);

  // Day grouping only in the unfiltered view. Once a type filter is on, the
  // filter is the organising idea and a second axis would compete with it.
  const groups = useMemo(() => {
    if (useFilter !== "all" || q.trim()) return [{ heading: null as string | null, files: shownFiles }];
    const out: { heading: string | null; files: typeof shownFiles }[] = [];
    let last: string | null = null;
    for (const f of shownFiles) {
      const h = dayHeading(f.lastModified);
      if (h !== last) {
        out.push({ heading: h, files: [] });
        last = h;
      }
      out[out.length - 1]!.files.push(f);
    }
    return out;
  }, [shownFiles, useFilter, q]);

  const open = async (e: DfEntry) => {
    if (e.isDir) return;
    if (pinnedList) {
      const meta = pinnedList.find((f) => `app:${f.id}` === e.path);
      if (meta) onOpenAt(meta);
      return;
    }
    setNote(null);
    // A song plays off its path like media does; reading it over the bridge
    // as base64 would truncate it into noise. The Files screen routes the
    // empty data to the audio player.
    if (isAudio(e.ext)) {
      onOpen({ id: e.path, name: e.name, ext: e.ext, size: e.size, addedAt: e.lastModified, pinned: false }, "", false);
      return;
    }
    setBusy(true);
    const r = await readFile(e.path);
    setBusy(false);
    if (!r) {
      setNote("Could not read that file. It may have moved.");
      return;
    }
    onOpen({ id: e.path, name: e.name, ext: e.ext, size: e.size, addedAt: e.lastModified, pinned: false }, r.data, r.truncated);
  };

  const onOpenAt = (meta: FileMeta) => {
    import("../lib/store").then(({ getFileData }) =>
      void getFileData(meta.id).then((data) => onOpen(meta, data, false))
    );
  };

  const saveCopy = async (e: DfEntry) => {
    setMenu(null);
    setNote(null);
    if (pinnedList) {
      setNote("This one already lives in the app.");
      return;
    }
    setBusy(true);
    const r = await readFile(e.path);
    setBusy(false);
    if (!r) return setNote("Could not read that file.");
    if (r.truncated) return setNote("That file is too large to copy. Open it in another app instead.");
    await addFile(e.name, r.data);
    setNote(`Copied ${e.name} into Files. It can now be converted, scanned or pinned.`);
  };

  const share = async (e: DfEntry) => {
    setMenu(null);
    setNote(null);
    if (pinnedList) return setNote("Sharing works from the copy on this phone.");
    setBusy(true);
    const r = await readFile(e.path);
    setBusy(false);
    if (!r) return setNote("Could not read that file.");
    const dot = e.name.lastIndexOf(".");
    await shareFileData(e.name, r.data, dot > 0 ? e.name.slice(0, dot) : e.name);
  };

  const up = path ? parentOf(path) : null;

  /* One gutter for the whole list, or none. If even one file in here can show a
     picture, every row reserves the same 40px so the names stay on one left
     edge; a list of nothing but PDFs gets no gutter at all rather than a column
     of empty squares. A gutter that appears on some rows is misalignment. The
     decision rides on the files actually being shown, so a PDF-only filter
     does not carry a column of empty squares from the folder's other files. */
  const gutter = shownFiles.some((f) => hasRowThumb(f.ext));

  const row = (e: DfEntry, i: number) => (
    <button
      key={e.path}
      onClick={() => {
        if (e.isDir) window.dispatchEvent(new CustomEvent("sd-files-open", { detail: e.path }));
        else void open(e);
      }}
      onContextMenu={(ev) => {
        if (e.isDir) return;
        ev.preventDefault();
        setMenu(e);
      }}
      className="sd-tap flex w-full items-center gap-3 py-2.5 text-left"
      style={{ borderTop: i > 0 ? "1px solid var(--line)" : "none" }}
    >
      {/* A picture only where the picture is the content. Putting a square in
          front of every row, tinted or not, turns a list into a grid of tiles,
          and the metadata line already says what each file is. */}
      {gutter ? <Thumb ext={e.ext} path={e.path} /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-tight text-ink-1">{e.name}</span>
        <span className="tnum mt-0.5 block truncate text-[13px] text-ink-2">
          {e.isDir ? "Folder" : whenLabel(e.lastModified)}
        </span>
      </span>
      {e.isDir ? (
        <ChevronRight className="size-4 shrink-0" style={{ color: "var(--ink-3)" }} />
      ) : e.size ? (
        <span className="tnum shrink-0 text-[13px]" style={{ color: "var(--ink-3)" }}>{humanSize(e.size)}</span>
      ) : null}
    </button>
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {note && (
        <div className="mx-3 mb-1 px-3 py-2 rounded-card bg-brand-soft border border-brand/30 text-xs">{note}</div>
      )}

      <div className="flex shrink-0 items-center gap-1 px-1 pt-2">
        <button onClick={onBack} className="sd-press sd-icon" aria-label="Back to files home">
          <ChevronLeft className="size-[22px]" style={{ color: "var(--ink-2)" }} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[20px] font-semibold tracking-tight text-ink-1">{title ?? baseName(path ?? "")}</div>
          {!fixedRecent && !pinnedList && (
            <div className="tnum text-[12px] text-ink-2">
              {loading
                ? "Reading folder"
                : useFilter !== "all"
                  ? `${shownFiles.length} ${FILTER_LABEL[useFilter]} files`
                  : q.trim()
                    ? `${shownFiles.length} matches`
                    : `${folders.length} folders, ${files.length} files`}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2.5 px-4 pt-3">
        <div
          className="flex flex-1 items-center gap-2.5 rounded-full bg-surface-2 pl-4 pr-1.5 focus-within:ring-1 focus-within:ring-brand/40"
          style={{ height: 48 }}
        >
          <Search className="size-[18px] shrink-0" style={{ color: "var(--ink-2)" }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search this folder"
            aria-label="Search this folder"
            className="flex-1 min-w-0 bg-transparent text-[15px] outline-none placeholder:text-ink-2"
          />
          {q && (
            <button onClick={() => setQ("")} aria-label="Clear search" className="sd-press grid size-9 shrink-0 place-items-center">
              <X className="size-4" style={{ color: "var(--ink-2)" }} />
            </button>
          )}
        </div>
      </div>

      {filters.length > 2 && (
        <div className="flex shrink-0 items-end gap-5 overflow-x-auto px-4 pt-3">
          {filters.map((id) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={`shrink-0 border-b-2 pt-2 pb-2.5 text-[14px] transition-colors ${
                useFilter === id ? "border-brand text-ink-1 font-medium" : "border-transparent text-ink-2"
              }`}
            >
              {FILTER_LABEL[id]}
            </button>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="sd-fade-in flex-1 overflow-y-auto px-4 pt-2 pb-32">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            Reading folder
          </div>
        )}

        {up && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("sd-files-open", { detail: up }))}
            className="sd-tap flex w-full items-center gap-3 py-2.5 text-left"
          >
            <ChevronUp className="size-[18px] shrink-0" style={{ color: "var(--ink-3)" }} />
            <span className="min-w-0 flex-1 truncate text-[15px] text-ink-1">Up to {baseName(up)}</span>
          </button>
        )}

        {/* A type filter is about files, and a folder has no type. Leaving
            folders in every filtered view made all the chips look like they
            did nothing — the one visible section never changed. */}
        {useFilter === "all" && folders.length > 0 && (
          <section className={up ? "mt-4" : ""}>{folders.map(row)}</section>
        )}

        {groups.map((g, gi) => (
          <section key={g.heading ?? `g${gi}`} className="mt-6 first:mt-1">
            {g.heading && (
              <h3 className="mb-1.5 flex items-baseline gap-2 text-[12px] font-medium" style={{ color: "var(--ink-3)" }}>
                {g.heading}
                <span className="tnum">{g.files.length} items</span>
              </h3>
            )}
            {g.files.map(row)}
          </section>
        ))}

        {!loading &&
          shownFiles.length === 0 &&
          (useFilter !== "all" || folders.length === 0) && (
            <EmptyState
              variant="files"
              title={
                useFilter !== "all"
                  ? `No ${FILTER_LABEL[useFilter]} files here`
                  : q
                    ? "No matches"
                    : "Nothing here yet"
              }
              hint={
                useFilter !== "all"
                  ? "Try another type, or All to see everything."
                  : q
                    ? "Try a different search."
                    : "Files saved to this folder on your phone will appear here."
              }
            />
          )}
      </div>

      {menu && (
        <DragSheet label={`Actions for ${menu.name}`} onClose={() => setMenu(null)} dismissable={!busy}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 truncate text-[15px] font-medium text-ink-1">{menu.name}</div>
            <div className="tnum text-[13px] text-ink-3">
              {humanSize(menu.size)}{menu.lastModified ? `, ${whenLabel(menu.lastModified)}` : ""}
            </div>
            <div className="mt-4">
              <button
                onClick={() => { const m = menu; setMenu(null); void open(m); }}
                className="sd-press w-full border-t border-line py-3.5 text-left text-[15px] text-ink-1"
              >
                Open
              </button>
              <button
                onClick={() => void saveCopy(menu)}
                disabled={busy}
                className="sd-press w-full border-t border-line py-3.5 text-left text-[15px] text-ink-1 disabled:opacity-60"
              >
                Save a copy into Files
              </button>
              <button
                onClick={() => void share(menu)}
                disabled={busy}
                className="sd-press w-full border-t border-line py-3.5 text-left text-[15px] text-ink-1 disabled:opacity-60"
              >
                Share with friends
              </button>
              <button
                onClick={() => { const m = menu; setMenu(null); onDriveUpload?.([m]); }}
                disabled={busy || !!pinnedList}
                className="sd-press w-full border-t border-line py-3.5 text-left text-[15px] text-ink-1 disabled:opacity-60"
              >
                Upload to Google Drive
              </button>
            </div>
          </div>
        </DragSheet>
      )}
    </div>
  );
}

/**
 * A real thumbnail for media, and a type square for everything else. Rendering
 * page one of fifty PDFs to fill this column would mean reading fifty files,
 * which is not something a list should do while you are scrolling it.
 */
/**
 * Reserved width so a row that is still decoding its thumbnail does not shift
 * the names next to it when the image arrives. A reserved gutter that is blank
 * for a moment is invisible; a list that reflows while you are reading it is
 * not.
 */
function Thumb({ ext, path }: { ext: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    setUrl(null);
    setTried(false);
    if (!hasRowThumb(ext)) {
      setTried(true);
      return;
    }
    let alive = true;
    void rowThumbUrl(path, ext, 160).then((u) => {
      if (alive) {
        setUrl(u);
        setTried(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [path, ext]);

  if (!url) {
    if (tried && ext === "webp") {
      // A dotLottie sticker: render the animation where a thumbnail would go.
      return (
        <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-[6px] bg-surface-2">
          <StickerTile path={path} className="h-full w-full" frameClassName="p-0.5" />
        </span>
      );
    }
    return <span className="w-10 shrink-0" />;
  }
  return (
    <img
      src={url}
      alt=""
      decoding="async"
      className="shrink-0 rounded-[6px]"
      style={{ width: 40, height: 40, objectFit: "cover", background: "var(--surface-2)" }}
    />
  );
}
