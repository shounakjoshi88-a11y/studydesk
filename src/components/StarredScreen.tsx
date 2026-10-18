/**
 * StarredScreen — the device files marked with a star (§9), opened from the
 * home Collections card the way Google's opens from its own.
 *
 * The one thing this screen refuses to do is lie about files that moved on:
 * a star is only a path remembered, so on every visit the whole list is
 * checked against the disk in one native call, and anything gone wears that
 * plainly instead of opening to an error. Removing a star is always one tap.
 */

import { useEffect, useState } from "react";
import { ChevronLeft, Download, FileText, Loader2, Lock, Music, StarOff } from "lucide-react";
import { hasRowThumb, humanSize, statPaths, rowThumbUrl, whenLabel, type DfFile } from "../lib/deviceFiles";
import { starredEntries, starOff, type StarredEntry } from "../lib/starred";

type Row = StarredEntry & { live: boolean; sizeNow: number };

export function StarredScreen({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  /** Routed exactly like a home recent, minus the recents bookkeeping —
   *  a file opened from here is a deliberate revisit, not a browse. */
  onOpen: (e: DfFile) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const entries = starredEntries();
      const stats = await statPaths(entries.map((e) => e.path));
      if (!alive) return;
      setRows(
        entries.map((e, i) => {
          const s = stats[i];
          // No plugin (web build): assume live rather than mass-greying a list.
          const live = s ? s.exists : true;
          return { ...e, live, sizeNow: live && s && s.size > 0 ? s.size : e.size };
        }),
      );
    })();
    return () => {
      alive = false;
    };
  }, []);

  const drop = (r: Row, whyGone = false) => {
    starOff(r.path);
    setRows((xs) => (xs ? xs.filter((x) => x.path !== r.path) : xs));
    setNote(whyGone ? `Removed ${r.name} — it is no longer on the phone.` : `Removed ${r.name} from Starred.`);
  };

  const liveBytes = (rows ?? []).reduce((s, r) => s + (r.live ? r.sizeNow : 0), 0);

  return (
    <div className="fixed inset-0 z-[65] flex flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-[max(30px,env(safe-area-inset-top))]">
        <button onClick={onClose} className="sd-press sd-icon" aria-label="Back to files">
          <ChevronLeft className="size-[22px]" style={{ color: "var(--ink-2)" }} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[20px] font-semibold tracking-tight text-ink-1">Starred</div>
          {rows && (
            <div className="tnum text-[12px] text-ink-2">
              {rows.length} file{rows.length === 1 ? "" : "s"}
              {liveBytes > 0 ? ` • ${humanSize(liveBytes)}` : ""}
            </div>
          )}
        </div>
      </div>

      {note && (
        <div className="mx-3 mt-2 shrink-0 rounded-card border border-brand/30 bg-brand-soft px-3 py-2 text-xs">
          {note}
        </div>
      )}

      <div className="sd-fade-in flex-1 overflow-y-auto px-4 pb-8 pt-1">
        {rows === null && (
          <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            Checking your stars
          </div>
        )}
        {rows && rows.length === 0 && (
          <p className="px-1 py-8 text-center text-[14px] text-ink-2">
            Nothing starred yet. Any file&apos;s ⋮ menu has “Add to starred”, and its row lands here
            next to the others.
          </p>
        )}
        {(rows ?? []).map((r) => (
          <div key={r.path} className="flex items-center gap-3 py-2.5">
            <button
              onClick={() => {
                if (r.live) onOpen(r);
                else setNote("That file is gone from the phone — the ✕ drops the star.");
              }}
              className="sd-tap flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <StarThumb r={r} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] leading-tight text-ink-1">{r.name}</span>
                <span className="tnum mt-0.5 block truncate text-[13px] text-ink-2">
                  {r.live
                    ? `${humanSize(r.sizeNow)} • starred ${whenLabel(r.at)}`
                    : "No longer on this phone"}
                </span>
              </span>
            </button>
            <button
              onClick={() => drop(r, !r.live)}
              aria-label={`Remove ${r.name} from Starred`}
              className="sd-press -mr-2 p-2"
            >
              <StarOff className="size-[18px]" style={{ color: "var(--ink-3)" }} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function StarThumb({ r }: { r: Row }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!r.live || !hasRowThumb(r.ext)) return;
    void rowThumbUrl(r.path, r.ext, 160).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [r.path, r.ext, r.live]);

  if (url) {
    return (
      <img
        src={url}
        alt=""
        decoding="async"
        className="shrink-0 rounded-[12px]"
        style={{
          width: 44,
          height: 44,
          objectFit: "cover",
          background: "var(--surface-2)",
          opacity: r.live ? 1 : 0.45,
        }}
      />
    );
  }
  const Icon = ["mp3", "aac", "wav", "ogg", "m4a", "flac", "amr", "opus"].includes(r.ext)
    ? Music
    : r.ext === "apk"
      ? Download
      : r.ext === "crypt15" || r.ext === "crypt14"
        ? Lock
        : FileText;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[12px] bg-surface-2"
      style={{ width: 44, height: 44, opacity: r.live ? 1 : 0.45 }}
    >
      <Icon className="size-5" style={{ color: "var(--ink-3)" }} />
    </span>
  );
}
