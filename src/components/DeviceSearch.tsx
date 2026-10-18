/**
 * DeviceSearch — the Files tab's search screen (§7 of the teardown).
 *
 * A back arrow plus a live field, the Category / Date / Sort chips under it,
 * and results from a device-wide name search (native `searchFiles`, which
 * rides the category walk's own cache). An empty field shows the local
 * "Recently opened" list instead of results — search history is a promise
 * the app keeps to itself, so nothing leaves the phone.
 *
 * The Category chip narrows to the walk's own buckets (Images, Videos,
 * Audio, Documents, Other); Date and Sort are spent in JavaScript on the
 * returned rows, because both are views of the same answer, not questions.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check, ChevronLeft, Download, FileText, Loader2, Music, Search, X,
} from "lucide-react";
import { DragSheet } from "./DragSheet";
import { EmptyState } from "./EmptyState";
import { SORTS, type SortId } from "./CategoryList";
import {
  hasRowThumb, humanSize, searchFiles, rowThumbUrl, whenLabel,
  type DfFile,
} from "../lib/deviceFiles";
import { recentlyOpened } from "../lib/recentOpened";

/** The walk's buckets, which are also the Category sheet's rows. */
const KINDS = [
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
  { id: "audio", label: "Audio" },
  { id: "documents", label: "Documents" },
  { id: "other", label: "Other" },
] as const;
type KindId = (typeof KINDS)[number]["id"];

const DATES = [
  { id: "any", label: "Any time" },
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
] as const;
type DateId = (typeof DATES)[number]["id"];

const startOfToday = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
};

const withinDate = (ms: number, id: DateId): boolean => {
  if (id === "any") return true;
  const t0 = startOfToday();
  if (id === "today") return ms >= t0;
  if (id === "yesterday") return ms >= t0 - 86_400_000 && ms < t0;
  if (id === "7d") return ms >= t0 - 6 * 86_400_000;
  return ms >= t0 - 29 * 86_400_000;
};

export function DeviceSearch({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (r: DfFile) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<DfFile[] | null>(null);
  const [total, setTotal] = useState(0);
  const [denied, setDenied] = useState(false);
  const [searching, setSearching] = useState(false);
  const [kinds, setKinds] = useState<Set<KindId>>(new Set());
  const [date, setDate] = useState<DateId>("any");
  const [sort, setSort] = useState<SortId>("new");
  const [sheet, setSheet] = useState<"cat" | "date" | "sort" | null>(null);
  const recent = useMemo(() => recentlyOpened(), []);
  // The walk behind a cold search can take a moment; results must never land
  // out of order, so only the newest request is allowed to paint.
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      seq.current++;
      setResults(null);
      setTotal(0);
      setDenied(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      void searchFiles(text, kinds.size ? [...kinds] : undefined).then((r) => {
        if (seq.current !== mine) return;
        setResults(r.entries);
        setTotal(r.total);
        setDenied(r.denied);
        setSearching(false);
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [q, kinds]);

  const sorted = useMemo(() => {
    const xs = (results ?? []).filter((r) => withinDate(r.lastModified, date));
    xs.sort((a, b) => {
      if (sort === "new") return b.lastModified - a.lastModified;
      if (sort === "old") return a.lastModified - b.lastModified;
      if (sort === "big") return b.size - a.size;
      if (sort === "small") return a.size - b.size;
      if (sort === "az") return a.name.localeCompare(b.name);
      return b.name.localeCompare(a.name);
    });
    return xs;
  }, [results, date, sort]);

  const catLabel = (() => {
    if (!kinds.size) return "Category";
    const first = KINDS.find((k) => kinds.has(k.id))!;
    return kinds.size > 1 ? `${first.label} +${kinds.size - 1}` : first.label;
  })();
  const dateLabel = DATES.find((d) => d.id === date)!.label;
  const sortLabel = SORTS.find((s) => s.id === sort)!.label;

  const chip = (label: string, on: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      className={`max-w-[180px] shrink-0 truncate border-b-2 pt-2 pb-2.5 text-[14px] transition-colors ${
        on ? "border-brand font-medium text-ink-1" : "border-transparent text-ink-2"
      }`}
    >
      {label}
    </button>
  );

  const row = (r: DfFile) => (
    <button key={r.path} onClick={() => onOpen(r)} className="sd-press flex w-full items-center gap-3 py-2.5 text-left">
      <ResultThumb r={r} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-tight text-ink-1">{r.name}</span>
        <span className="tnum mt-0.5 block truncate text-[13px] text-ink-2">
          {humanSize(r.size)} • {whenLabel(r.lastModified)}
        </span>
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[65] flex flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1.5 px-2 pt-[max(30px,env(safe-area-inset-top))]">
        <button onClick={onClose} className="sd-press sd-icon -ml-1" aria-label="Back to files">
          <ChevronLeft className="size-[22px]" style={{ color: "var(--ink-2)" }} />
        </button>
        <div
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-full bg-surface-2 pl-4 pr-1.5 focus-within:ring-1 focus-within:ring-brand/40"
          style={{ height: 48 }}
        >
          <Search className="size-[18px] shrink-0" style={{ color: "var(--ink-2)" }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search files"
            aria-label="Search files"
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-2"
          />
          {q && (
            <button onClick={() => setQ("")} aria-label="Clear search" className="sd-press grid size-9 shrink-0 place-items-center">
              <X className="size-[18px]" style={{ color: "var(--ink-2)" }} />
            </button>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-end gap-5 overflow-x-auto px-4 pt-3">
        {chip(catLabel, kinds.size > 0, () => setSheet("cat"))}
        {chip(dateLabel, date !== "any", () => setSheet("date"))}
        {chip(sortLabel, sort !== "new", () => setSheet("sort"))}
      </div>

      <div className="sd-fade-in mt-1 flex-1 overflow-y-auto px-4 pb-8">
        {!q.trim() ? (
          <>
            <h3 className="mt-3 text-[13px] font-medium" style={{ color: "var(--ink-3)" }}>
              Recently opened
            </h3>
            {recent.length === 0 && (
              <p className="px-1 py-6 text-[14px] text-ink-2">
                Files you open will show up here.
              </p>
            )}
            {recent.map(row)}
          </>
        ) : searching ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            Searching this phone
          </div>
        ) : denied ? (
          <p className="px-1 py-6 text-[14px] text-ink-2">
            Android is not letting the app read storage. Turn on All files access in settings.
          </p>
        ) : (
          <>
            {sorted.length === 0 && (
              <EmptyState
                variant="search"
                title="No matches"
                hint={`Nothing on this phone matches “${q.trim()}”.`}
              />
            )}
            {sorted.map(row)}
            {sorted.length > 0 && total > (results?.length ?? 0) && (
              <p className="tnum px-1 py-4 text-center text-[12px]" style={{ color: "var(--ink-3)" }}>
                Showing the newest {results?.length} of {total} matches
              </p>
            )}
          </>
        )}
      </div>

      {sheet === "cat" && (
        <DragSheet label="Category filter" onClose={() => setSheet(null)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 text-[15px] font-medium text-ink-1">Category</div>
            <div className="mt-2">
              {KINDS.map((k) => {
                const on = kinds.has(k.id);
                return (
                  <button
                    key={k.id}
                    role="menuitemcheckbox"
                    aria-checked={on}
                    onClick={() =>
                      setKinds((prev) => {
                        const next = new Set(prev);
                        if (next.has(k.id)) next.delete(k.id);
                        else next.add(k.id);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-3 border-t border-line py-3.5 text-left text-[15px] text-ink-1 first:border-t-0"
                  >
                    <span
                      className="flex size-[20px] shrink-0 items-center justify-center rounded-[6px] border"
                      style={
                        on
                          ? { background: "var(--brand)", borderColor: "var(--brand)", color: "var(--background)" }
                          : { borderColor: "var(--ink-3)", color: "transparent" }
                      }
                    >
                      <Check className="size-3.5" />
                    </span>
                    <span className="flex-1">{k.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </DragSheet>
      )}

      {sheet === "date" && (
        <DragSheet label="Date filter" onClose={() => setSheet(null)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 text-[15px] font-medium text-ink-1">Date</div>
            <div className="mt-2">
              {DATES.map((d) => (
                <button
                  key={d.id}
                  role="menuitemradio"
                  aria-checked={date === d.id}
                  onClick={() => {
                    setDate(d.id);
                    setSheet(null);
                  }}
                  className="flex w-full items-center gap-3 border-t border-line py-3.5 text-left text-[15px] text-ink-1 first:border-t-0"
                >
                  <span className="flex-1">{d.label}</span>
                  {date === d.id && <Check className="size-4 shrink-0" style={{ color: "var(--brand-ink)" }} />}
                </button>
              ))}
            </div>
          </div>
        </DragSheet>
      )}

      {sheet === "sort" && (
        <DragSheet label="Sort by" onClose={() => setSheet(null)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 text-[15px] font-medium text-ink-1">Sort by</div>
            <div className="mt-2">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  role="menuitemradio"
                  aria-checked={sort === s.id}
                  onClick={() => {
                    setSort(s.id);
                    setSheet(null);
                  }}
                  className="flex w-full items-center gap-3 border-t border-line py-3.5 text-left text-[15px] text-ink-1 first:border-t-0"
                >
                  <span className="flex-1">{s.label}</span>
                  {sort === s.id && <Check className="size-4 shrink-0" style={{ color: "var(--brand-ink)" }} />}
                </button>
              ))}
            </div>
          </div>
        </DragSheet>
      )}
    </div>
  );
}

/**
 * A search result's 40px leading thumb: the real decode for photos and
 * clips, an honest icon for everything the decoder cannot draw a frame of.
 */
function ResultThumb({ r }: { r: DfFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!hasRowThumb(r.ext)) return;
    void rowThumbUrl(r.path, r.ext, 160).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [r.path, r.ext]);

  if (url) {
    return (
      <img
        src={url}
        alt=""
        decoding="async"
        className="shrink-0 rounded-[10px]"
        style={{ width: 40, height: 40, objectFit: "cover", background: "var(--surface-2)" }}
      />
    );
  }
  const Icon = ["mp3", "aac", "wav", "ogg", "m4a", "flac", "amr", "opus"].includes(r.ext)
    ? Music
    : r.ext === "apk"
      ? Download
      : FileText;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[10px] bg-surface-2"
      style={{ width: 40, height: 40 }}
    >
      <Icon className="size-[18px]" style={{ color: "var(--ink-3)" }} />
    </span>
  );
}
