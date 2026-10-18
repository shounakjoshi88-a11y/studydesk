/**
 * FolderPicker — pick a destination for Move to / Copy to.
 *
 * Two ways to answer "where": a row of shortcuts for the places people
 * actually keep files, and a browse-the-tree list for everywhere else. The
 * list shows folders only — the destination is always a folder, so files in
 * it are noise.
 *
 * Paths arrive in two spellings ("/sdcard/..." from the category roots,
 * "/storage/emulated/0/..." from File.getAbsolutePath), so every comparison
 * here goes through normPath().
 */

import { useEffect, useState } from "react";
import { ChevronLeft, Folder, Loader2 } from "lucide-react";
import { DragSheet } from "./DragSheet";
import { getDir, parentOf, type DfEntry } from "../lib/deviceFiles";

const ROOT = "/sdcard";

/** Both spellings of the shared volume mean the same folder. */
const normPath = (p: string) =>
  p.replace(/^\/sdcard(?=\/|$)/, "/storage/emulated/0").replace(/\/+$/, "");

const SHORTCUTS: { label: string; path: string }[] = [
  { label: "Internal storage", path: ROOT },
  { label: "Download", path: `${ROOT}/Download` },
  { label: "Documents", path: `${ROOT}/Documents` },
  { label: "DCIM", path: `${ROOT}/DCIM` },
  { label: "Pictures", path: `${ROOT}/Pictures` },
  { label: "Music", path: `${ROOT}/Music` },
  { label: "Movies", path: `${ROOT}/Movies` },
  {
    label: "WhatsApp",
    path: `${ROOT}/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Documents`,
  },
];

export function FolderPicker({
  title,
  confirmLabel,
  /** Move-only: the folder the files already live in, where a move is a no-op. */
  blockedDir,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  blockedDir?: string | null;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (dir: string) => void;
}) {
  const [cur, setCur] = useState(ROOT);
  const [entries, setEntries] = useState<DfEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void getDir(cur).then((r) => {
      if (!alive) return;
      setEntries(r.entries.filter((x) => x.isDir));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [cur]);

  const here = cur === ROOT ? "Internal storage" : cur.slice(cur.lastIndexOf("/") + 1);
  const up = cur === ROOT ? null : parentOf(cur);
  const sameAsSource = blockedDir != null && normPath(cur) === normPath(blockedDir);

  return (
    <DragSheet label={title} onClose={onClose}>
      <div className="text-[17px] font-semibold text-ink-1">{title}</div>

      <div className="mt-3 flex flex-wrap gap-2">
        {SHORTCUTS.map((s) => (
          <button
            key={s.path}
            onClick={() => setCur(s.path)}
            className="sd-press rounded-full px-3.5 py-2.5 text-[13px]"
            style={
              cur === s.path
                ? { background: "var(--brand)", color: "var(--background)" }
                : { background: "var(--surface-2)", color: "var(--ink-1)" }
            }
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-[12px] bg-surface-2 px-3 py-2">
        <button
          onClick={() => up && setCur(up)}
          disabled={!up}
          aria-label="Up one folder"
          className="sd-press grid size-9 shrink-0 place-items-center disabled:opacity-30"
        >
          <ChevronLeft className="size-[18px]" style={{ color: "var(--ink-2)" }} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-ink-1">{here}</div>
          <div className="truncate text-[11px] text-ink-3">{cur}</div>
        </div>
      </div>

      <div className="mt-1.5">
        {loading && (
          <div className="flex items-center gap-2 py-4 text-[13px] text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Reading folder
          </div>
        )}
        {!loading && entries.length === 0 && (
          <p className="py-4 text-[13px] text-ink-3">No folders inside this one.</p>
        )}
        {entries.map((d) => (
          <button
            key={d.path}
            onClick={() => setCur(d.path)}
            className="sd-press flex w-full items-center gap-3 py-2.5 text-left"
          >
            <Folder className="size-[18px] shrink-0" style={{ color: "var(--brand-ink)" }} />
            <span className="truncate text-[14px] text-ink-1">{d.name}</span>
          </button>
        ))}
      </div>

      <button
        onClick={() => onConfirm(cur)}
        disabled={busy || sameAsSource}
        className="sd-press bg-brand text-background mt-3 w-full rounded-card py-3.5 text-[15px] font-semibold disabled:opacity-40"
      >
        {busy ? "Working…" : sameAsSource ? "The files already live here" : confirmLabel}
      </button>
    </DragSheet>
  );
}
