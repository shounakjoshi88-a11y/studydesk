/**
 * BinScreen — the Bin, the way Files by Google keeps one (§10).
 *
 * Everything here is served by lib/fileBin: the manifest says what is parked,
 * the parked copies live in the app's own external storage, and thirty days
 * is enforced on every visit, so a long absence cannot leave stale files
 * behind. This screen is the human side of that: look at what is parked,
 * put something back, or send it off for good.
 *
 * Delete here is immediate — no second sheet. The file already survived one
 * deliberate step to get into the bin; asking again for every single one
 * would be ceremony, and "Empty" (the batch exit) does ask.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Download, FileText, Loader2, Lock, Music, RotateCcw, Trash2 } from "lucide-react";
import { DragSheet } from "./DragSheet";
import { binDelete, binEntries, purgeBin, restoreFromBin, type BinEntry } from "../lib/fileBin";
import { hasRowThumb, humanSize, rowThumbUrl, whenLabel } from "../lib/deviceFiles";

export function BinScreen({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<BinEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  useEffect(() => {
    let alive = true;
    void purgeBin().then((gone) => {
      if (!alive) return;
      const xs = binEntries().sort((a, b) => b.at - a.at);
      setEntries(xs);
      setReady(true);
      if (gone > 0) setNote(`Removed ${gone} item${gone === 1 ? "" : "s"} older than 30 days.`);
    });
    return () => {
      alive = false;
    };
  }, []);

  const bytes = useMemo(() => entries.reduce((s, e) => s + (e.size || 0), 0), [entries]);

  const restore = async (e: BinEntry) => {
    setBusy(true);
    const ok = await restoreFromBin(e.id);
    setBusy(false);
    if (!ok) return setNote("Android would not let this app put that file back.");
    setEntries((xs) => xs.filter((x) => x.id !== e.id));
    setNote(`Restored ${e.name}.`);
  };

  const removeOne = async (e: BinEntry) => {
    setBusy(true);
    const ok = await binDelete(e.id);
    setBusy(false);
    if (!ok) return setNote("That file was already gone.");
    setEntries((xs) => xs.filter((x) => x.id !== e.id));
    setNote(`Deleted ${e.name} for good.`);
  };

  const empty = async () => {
    setConfirmEmpty(false);
    setBusy(true);
    const list = entries;
    let gone = 0;
    for (const e of list) {
      if (await binDelete(e.id)) gone++;
    }
    setBusy(false);
    setEntries([]);
    setNote(
      gone === list.length
        ? `Emptied the bin: ${gone} file${gone === 1 ? "" : "s"} left this phone.`
        : `${gone} of ${list.length} files left this phone; the rest could not be removed.`,
    );
  };

  const row = (e: BinEntry) => (
    <div key={e.id} className="flex items-center gap-3 py-2.5">
      <BinThumb e={e} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-tight text-ink-1">{e.name}</span>
        <span className="tnum mt-0.5 block truncate text-[13px] text-ink-2">
          {humanSize(e.size)} • binned {whenLabel(e.at)}
        </span>
      </span>
      <button
        onClick={() => void restore(e)}
        aria-label={`Restore ${e.name}`}
        className="sd-press sd-icon"
      >
        <RotateCcw className="size-[18px]" style={{ color: "var(--ink-2)" }} />
      </button>
      <button
        onClick={() => void removeOne(e)}
        aria-label={`Delete ${e.name} for good`}
        className="sd-press -mr-2 p-2"
      >
        <Trash2 className="size-[18px]" style={{ color: "var(--att-critical-text)" }} />
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[65] flex flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-[max(30px,env(safe-area-inset-top))]">
        <button onClick={onClose} className="sd-press sd-icon" aria-label="Back to files">
          <ChevronLeft className="size-[22px]" style={{ color: "var(--ink-2)" }} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[20px] font-semibold tracking-tight text-ink-1">Bin</div>
          {ready && entries.length > 0 && (
            <div className="tnum text-[12px] text-ink-2">
              {entries.length} file{entries.length === 1 ? "" : "s"} • {humanSize(bytes)}
            </div>
          )}
        </div>
        {ready && entries.length > 0 && (
          <button
            onClick={() => setConfirmEmpty(true)}
            className="sd-press px-2 py-2 text-[14px] font-medium"
            style={{ color: "var(--att-critical-text)" }}
          >
            Empty
          </button>
        )}
      </div>

      <div className="shrink-0 px-4 pt-1 text-[12px]" style={{ color: "var(--ink-3)" }}>
        Files wait in the bin for 30 days, then leave this phone for good.
      </div>

      {note && (
        <div className="mx-3 mt-2 shrink-0 rounded-card border border-brand/30 bg-brand-soft px-3 py-2 text-xs">
          {note}
        </div>
      )}

      <div className="sd-fade-in flex-1 overflow-y-auto px-4 pb-8 pt-1">
        {!ready && (
          <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            Opening the bin
          </div>
        )}
        {ready && entries.length === 0 && (
          <p className="px-1 py-8 text-center text-[14px] text-ink-2">
            The bin is empty. Files you move here will wait thirty days before leaving for good.
          </p>
        )}
        {entries.map(row)}
        {busy && (
          <div className="flex items-center justify-center gap-2 py-4 text-[13px] text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            Working
          </div>
        )}
      </div>

      {confirmEmpty && (
        <DragSheet label="Empty the bin" onClose={() => setConfirmEmpty(false)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 text-[15px] font-medium text-ink-1">
              Empty the bin?
            </div>
            <div className="text-[13px] text-ink-3">
              {entries.length === 1 ? "The file" : `All ${entries.length} files`} leave this phone for
              good. This cannot be undone.
            </div>
            <button
              onClick={() => void empty()}
              className="sd-press mt-4 w-full rounded-card py-3.5 text-[15px] font-semibold"
              style={{
                background: "color-mix(in srgb, var(--att-critical-text) 16%, transparent)",
                color: "var(--att-critical-text)",
              }}
            >
              Empty bin
            </button>
          </div>
        </DragSheet>
      )}
    </div>
  );
}

/** The parked copy's thumb — the file itself is still on disk, so photos and
 *  clips decode from the binned path exactly as they did before. */
function BinThumb({ e }: { e: BinEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!hasRowThumb(e.ext)) return;
    void rowThumbUrl(e.binned.replace(/^file:\/\//, ""), e.ext, 160).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [e.binned, e.ext]);

  if (url) {
    return (
      <img
        src={url}
        alt=""
        decoding="async"
        className="shrink-0 rounded-[12px]"
        style={{ width: 44, height: 44, objectFit: "cover", background: "var(--surface-2)" }}
      />
    );
  }
  const Icon = ["mp3", "aac", "wav", "ogg", "m4a", "flac", "amr", "opus"].includes(e.ext)
    ? Music
    : e.ext === "apk"
      ? Download
      : e.ext === "crypt15" || e.ext === "crypt14"
        ? Lock
        : FileText;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[12px] bg-surface-2"
      style={{ width: 44, height: 44 }}
    >
      <Icon className="size-5" style={{ color: "var(--ink-3)" }} />
    </span>
  );
}
