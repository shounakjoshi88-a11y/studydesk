import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check, ChevronLeft, Download, FileText, LayoutGrid, List as ListIcon, Loader2, Lock, MoreVertical,
  Music, Search, Share2, Trash2, X,
} from "lucide-react";
import { Share } from "@capacitor/share";
import { DragSheet } from "./DragSheet";
import { EmptyState } from "./EmptyState";
import { FolderPicker } from "./FolderPicker";
import { FileInfo } from "./FileInfo";
import { StickerTile } from "./StickerTile";
import { shareFileData } from "../lib/share";
import { moveToBin, purgeBin } from "../lib/fileBin";
import { isStarred, starOff, starOn } from "../lib/starred";
import { addFile, type FileMeta } from "../lib/store";
import {
  copyPath, dayHeading, getDir, hasRowThumb, humanSize, isAudio, isEncryptedBackup, listCategory, movePath,
  openWithPath, parentOf, readFile, rowThumbUrl, uniqueName, whenLabel,
  type CategoryId, type DfRecent,
} from "../lib/deviceFiles";

/** Google Files' own sort sheet, in its own order. Shared with the search
 *  screen so the two sort controls can never drift apart. */
export const SORTS = [
  { id: "new", label: "Newest date first" },
  { id: "old", label: "Oldest date first" },
  { id: "big", label: "Largest first" },
  { id: "small", label: "Smallest first" },
  { id: "az", label: "Name A → Z" },
  { id: "za", label: "Name Z → A" },
] as const;
export type SortId = (typeof SORTS)[number]["id"];

const AUDIO_EXT = ["mp3", "aac", "wav", "ogg", "m4a", "flac", "amr", "opus"];

/**
 * A category as Google Files treats one: a claim about the whole phone, not a
 * single folder. Documents live in Download, in DCIM and in chat apps' media
 * folders all at once, so the list comes from one aggregated walk (native
 * listCategory) rather than from /sdcard/Documents, which on most phones holds
 * almost nothing.
 *
 * The chrome is the part of the Google screen people recognise: a source
 * filter row, date groups, a sort sheet, a list/grid toggle, and a ⋮ on every
 * row that opens an anchored menu rather than covering the list with a sheet.
 */
export function CategoryList({
  id,
  title,
  onBack,
  onOpen,
  onVault,
  onDriveUpload,
}: {
  id: CategoryId;
  title: string;
  onBack: () => void;
  onOpen: (meta: FileMeta, data: string, truncated: boolean) => void;
  /** "Move to Safe folder" hands the batch upward: the PIN door lives in
   *  Files.tsx, which can raise the vault screen above this list. */
  onVault?: (list: DfRecent[]) => void;
  /** "Upload to Google Drive": the folder choice lives on the Drive screen,
   *  so the selection is handed up and that source takes over. */
  onDriveUpload?: (list: DfRecent[]) => void;
}) {
  const [entries, setEntries] = useState<DfRecent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sort, setSort] = useState<SortId>("new");
  const [view, setView] = useState<"list" | "grid">("list");
  const [chip, setChip] = useState<string | null>(null);
  const [showSort, setShowSort] = useState(false);
  const [menu, setMenu] = useState<{ e: DfRecent; x: number; y: number } | null>(null);
  const [confirmBin, setConfirmBin] = useState<DfRecent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** Non-null while the list is pickable; the set holds the chosen paths. */
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [bulkMenu, setBulkMenu] = useState<{ x: number; y: number } | null>(null);
  /** The rename sheet's draft name while it is open. */
  const [rename, setRename] = useState<{ e: DfRecent; value: string } | null>(null);
  /** A Move to / Copy to in progress, or one waiting on the folder picker. */
  const [transfer, setTransfer] = useState<{ mode: "move" | "copy"; list: DfRecent[] } | null>(null);
  const [info, setInfo] = useState<DfRecent | null>(null);
  /** A long press must not also fire the tap that opens the file. */
  const suppressClick = useRef(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);

  const load = async (full = false) => {
    setLoading(true);
    setDenied(false);
    const r = await listCategory(id, full);
    setLoading(false);
    if (r.denied) {
      setDenied(true);
      return;
    }
    setEntries(r.entries);
    setTotal(r.total);
  };

  useEffect(() => {
    setChip(null);
    setQ("");
    setSearchOpen(false);
    setSel(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /* The Bin's thirty days are enforced here, where a visit is guaranteed. */
  useEffect(() => {
    void purgeBin();
  }, []);

  /** The folders contributing to this category, biggest contributor first —
   *  Google Files' source chips carry the same meaning. */
  const chips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) {
      const f = folderOf(e.path);
      if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name);
  }, [entries]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return entries.filter((e) => {
      if (chip && folderOf(e.path) !== chip) return false;
      if (query && !e.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [entries, chip, q]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (sort) {
        case "old": return a.lastModified - b.lastModified;
        case "big": return b.size - a.size;
        case "small": return a.size - b.size;
        case "az": return a.name.localeCompare(b.name);
        case "za": return b.name.localeCompare(a.name);
        default: return b.lastModified - a.lastModified;
      }
    });
    return arr;
  }, [filtered, sort]);

  // Date headers only while the list reads in date order; once the sort is by
  // name or size, a second axis would compete with the one the user chose.
  const groups = useMemo(() => {
    const byDate = sort === "new" || sort === "old";
    const out: { heading: string | null; files: DfRecent[] }[] = [];
    let last: string | null = null;
    for (const f of sorted) {
      const h = byDate ? dayHeading(f.lastModified) : null;
      if (h !== last || out.length === 0) {
        out.push({ heading: h, files: [] });
        last = h;
      }
      out[out.length - 1]!.files.push(f);
    }
    return out;
  }, [sorted, sort]);

  /* ── selection ──────────────────────────────────────────────── */

  const selectedEntries = useMemo(
    () => (sel ? sorted.filter((e) => sel.has(e.path)) : []),
    [sel, sorted],
  );
  const selBytes = useMemo(() => selectedEntries.reduce((s, e) => s + (e.size || 0), 0), [selectedEntries]);

  /* A filter that hides every chosen row should also end the picking — a bar
     that moves nothing when tapped is worse than no bar. */
  useEffect(() => {
    if (sel && selectedEntries.length === 0) setSel(null);
  }, [sel, selectedEntries]);

  const toggle = (e: DfRecent) => {
    setSel((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(e.path)) next.delete(e.path);
      else next.add(e.path);
      return next.size ? next : null;
    });
  };

  /* Google Files picks rows by holding them down; the same hold works here.
     A drag past the slop is a scroll, not a hold, so it cancels. */
  const beginPress = (e: DfRecent, ev: React.PointerEvent) => {
    if (sel) return;
    const x = ev.clientX;
    const y = ev.clientY;
    const timer = window.setTimeout(() => {
      press.current = null;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 700);
      try {
        navigator.vibrate?.(12);
      } catch {
        /* no haptics on this phone */
      }
      setSel(new Set([e.path]));
    }, 450);
    press.current = { timer, x, y };
  };
  const movePress = (ev: React.PointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 12) endPress();
  };
  const endPress = () => {
    if (press.current) {
      window.clearTimeout(press.current.timer);
      press.current = null;
    }
  };

  const closeSel = () => {
    setSel(null);
    setBulkMenu(null);
  };

  const groupAll = (files: DfRecent[], on: boolean) => {
    setSel((prev) => {
      const next = new Set(prev ?? []);
      for (const f of files) {
        if (on) next.add(f.path);
        else next.delete(f.path);
      }
      return next.size ? next : null;
    });
  };

  const uriOf = (p: string) => (/^[a-z][a-z0-9+.-]*:/i.test(p) ? p : `file://${p}`);

  /** The share sheet takes real paths, so nothing is copied or truncated first. */
  const shareMany = async (list: DfRecent[]) => {
    const first = list[0];
    if (!first) return;
    try {
      await Share.share({
        files: list.map((e) => uriOf(e.path)),
        dialogTitle: list.length === 1 ? `Share ${first.name}` : `Share ${list.length} files`,
      });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/cancel/i.test(msg)) return;
      // A path the provider cannot hand out still has the copy route.
      const r = await readFile(first.path);
      if (r && !r.truncated) {
        await shareFileData(first.name, r.data, first.name.slice(0, Math.max(0, first.name.lastIndexOf("."))));
        return;
      }
      setNote("Could not open the share sheet for that selection.");
    }
  };

  const open = async (e: DfRecent) => {
    setNote(null);
    // A song takes the shortcut photos and clips take: it plays straight off
    // its path, and base64 over the bridge would only be truncated noise.
    // The empty data is part of that contract — the player reads the path.
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

  /* One file shares the same road as a selection of them: real paths first,
     and the read-into-cache route only when the provider refuses the path. */
  const share = async (e: DfRecent) => {
    setMenu(null);
    await shareMany([e]);
  };

  const saveCopy = async (e: DfRecent) => {
    setMenu(null);
    setNote(null);
    setBusy(true);
    const r = await readFile(e.path);
    setBusy(false);
    if (!r) return setNote("Could not read that file.");
    if (r.truncated) return setNote("That file is too large to copy. Open it in another app instead.");
    await addFile(e.name, r.data);
    setNote(`Copied ${e.name} into Files. It can now be converted, scanned or pinned.`);
  };

  const del = async () => {
    const list = confirmBin;
    setConfirmBin(null);
    if (!list?.length) return;
    setBusy(true);
    const r = await moveToBin(list.map((e) => ({ name: e.name, path: e.path, size: e.size, ext: e.ext })));
    setBusy(false);
    if (r.moved.length) {
      const gone = new Set(r.moved.map((m) => m.path));
      setEntries((xs) => xs.filter((x) => !gone.has(x.path)));
      setTotal((t) => Math.max(0, t - r.moved.length));
      setNote(
        r.failed.length
          ? `Moved ${r.moved.length} to the bin; ${r.failed.length} could not be moved.`
          : `Moved ${r.moved.length === 1 ? r.moved[0]!.name : `${r.moved.length} files`} to the bin.`,
      );
      closeSel();
    } else {
      setNote("Android would not let this app move those files.");
    }
  };

  /** The chooser route: the phone decides which app opens the file. */
  const doOpenWith = async (e: DfRecent) => {
    setMenu(null);
    setBulkMenu(null);
    const ok = await openWithPath(e.path);
    if (!ok) setNote("Nothing on this phone can open that kind of file.");
  };

  const doRename = async () => {
    const r = rename;
    setRename(null);
    if (!r) return;
    const name = r.value.trim();
    if (!name || name === r.e.name) return;
    if (name.includes("/")) return setNote("A file name cannot contain a slash.");
    const dir = parentOf(r.e.path);
    if (!dir) return setNote("This file has no folder to rename it in.");
    const listing = await getDir(dir);
    const taken = new Set(
      listing.entries.filter((x) => x.path !== r.e.path).map((x) => x.name.toLowerCase()),
    );
    if (taken.has(name.toLowerCase())) return setNote("A file with that name already lives here.");
    setBusy(true);
    const target = `${dir}/${name}`;
    const ok = await movePath(r.e.path, target);
    setBusy(false);
    if (!ok) return setNote("Android would not let this app rename that file.");
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    setEntries((xs) => xs.map((x) => (x.path === r.e.path ? { ...x, name, path: target, ext } : x)));
    setNote(`Renamed to ${name}.`);
  };

  /** Move to / Copy to, once the picker has named a destination folder. */
  const doTransfer = async (dir: string) => {
    const t = transfer;
    setTransfer(null);
    if (!t?.list.length) return;
    const mode = t.mode;
    setBusy(true);
    const listing = await getDir(dir);
    // Names are claimed as they are handed out, so a batch of same-named
    // files cannot collide with each other, only with what is already here.
    const names = new Set(listing.entries.map((x) => x.name.toLowerCase()));
    const gone: string[] = [];
    let ok = 0;
    let fail = 0;
    for (const e of t.list) {
      const target = uniqueName(names, e.name);
      names.add(target.toLowerCase());
      const done =
        mode === "move"
          ? await movePath(e.path, `${dir}/${target}`)
          : await copyPath(e.path, `${dir}/${target}`);
      if (done) {
        ok++;
        if (mode === "move") gone.push(e.path);
      } else {
        fail++;
      }
    }
    setBusy(false);
    if (gone.length) {
      const g = new Set(gone);
      setEntries((xs) => xs.filter((x) => !g.has(x.path)));
      setTotal((n) => Math.max(0, n - gone.length));
      closeSel();
    }
    if (!ok) {
      return setNote(
        `Android would not let this app ${mode} ${t.list.length === 1 ? "that file" : "those files"}.`,
      );
    }
    const where = dir === "/sdcard" ? "Internal storage" : dir.slice(dir.lastIndexOf("/") + 1);
    const verb = mode === "move" ? "Moved" : "Copied";
    setNote(
      fail
        ? `${verb} ${ok} of ${t.list.length} to ${where}; ${fail} stayed behind.`
        : `${verb} ${ok === 1 ? t.list[0]!.name : `${ok} files`} to ${where}.`,
    );
  };

  /** An anchored menu, the way Google Files opens one: next to the ⋮ that
   *  asked for it, flipped up when it would run off the bottom. */
  const openMenu = (e: DfRecent, ev: React.MouseEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const h = menuItems.length * 50 + 10;
    const vh = window.innerHeight;
    const up = r.bottom + 8 + h > vh - 16;
    const x = Math.max(8, Math.min(r.right - 236, window.innerWidth - 244));
    const y = up ? Math.max(8, r.top - 8 - h) : r.bottom + 8;
    setMenu({ e, x, y });
  };

  /** The selection bar's ⋮ — same anchored popup, the list-wide verbs. */
  const openBulk = (ev: React.MouseEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const h = bulkItems.length * 50 + 10;
    const vh = window.innerHeight;
    const up = r.bottom + 8 + h > vh - 16;
    const x = Math.max(8, Math.min(r.right - 200, window.innerWidth - 208));
    const y = up ? Math.max(8, r.top - 8 - h) : r.bottom + 8;
    setBulkMenu({ x, y });
  };

  const menuItems: {
    id: "open" | "share" | "openWith" | "rename" | "select" | "star" | "vault" | "copy" | "drive" | "del" | "move" | "copyTo" | "info";
    label: string;
    danger?: boolean;
  }[] = [
    { id: "open", label: "Open" },
    { id: "share", label: "Share" },
    { id: "openWith", label: "Open with" },
    { id: "rename", label: "Rename" },
    { id: "select", label: "Select" },
    { id: "star", label: menu && isStarred(menu.e.path) ? "Remove from starred" : "Add to starred" },
    { id: "vault", label: "Move to Safe folder" },
    { id: "copy", label: "Save a copy into Files" },
    { id: "drive", label: "Upload to Google Drive" },
    { id: "del", label: "Move to bin", danger: true },
    { id: "move", label: "Move to…" },
    { id: "copyTo", label: "Copy to…" },
    { id: "info", label: "File info" },
  ];

  const toggleStar = (e: DfRecent) => {
    if (isStarred(e.path)) {
      starOff(e.path);
      setNote(`Removed ${e.name} from Starred.`);
    } else {
      starOn(e);
      setNote(`Added ${e.name} to Starred.`);
    }
  };

  /** The selection bar's ⋮. Open with needs exactly one file; the rest act on
   *  the whole selection. */
  const bulkItems = [
    { id: "all" as const, label: "Select all" },
    { id: "none" as const, label: "Select none" },
    ...(selectedEntries.length === 1 ? [{ id: "openWith" as const, label: "Open with" }] : []),
    { id: "star" as const, label: "Add to starred" },
    { id: "vault" as const, label: "Move to Safe folder" },
    { id: "drive" as const, label: "Upload to Google Drive" },
    { id: "move" as const, label: "Move to…" },
    { id: "copyTo" as const, label: "Copy to…" },
  ];

  const thumbGutter = entries.some((e) => hasRowThumb(e.ext));

  const row = (e: DfRecent) => (
    <div
      key={e.path}
      className={`flex w-full items-center gap-3 py-2.5 ${sel?.has(e.path) ? "-mx-2 rounded-[12px] px-2" : ""}`}
      style={sel?.has(e.path) ? { background: "var(--brand-soft)" } : undefined}
    >
      <button
        onClick={() => {
          if (suppressClick.current) return;
          if (sel) toggle(e);
          else void open(e);
        }}
        onPointerDown={(ev) => beginPress(e, ev)}
        onPointerMove={movePress}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        className="sd-tap flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        {thumbGutter && <RowThumb e={e} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] leading-tight text-ink-1">{e.name}</span>
          <span className="tnum mt-0.5 block truncate text-[13px] text-ink-2">
            {humanSize(e.size)} • {whenLabel(e.lastModified)}
          </span>
        </span>
      </button>
      {sel ? (
        <span
          aria-hidden="true"
          className="flex size-[22px] shrink-0 items-center justify-center rounded-full border"
          style={
            sel.has(e.path)
              ? { background: "var(--brand)", borderColor: "var(--brand)", color: "var(--background)" }
              : { borderColor: "var(--ink-3)", color: "transparent" }
          }
        >
          <Check className="size-3.5" />
        </span>
      ) : (
        <button
          onClick={(ev) => openMenu(e, ev)}
          aria-label={`Actions for ${e.name}`}
          className="sd-press -mr-2 p-2"
        >
          <MoreVertical className="size-[18px]" style={{ color: "var(--ink-3)" }} />
        </button>
      )}
    </div>
  );

  const tile = (e: DfRecent) => (
    <button
      key={e.path}
      onClick={() => {
        if (suppressClick.current) return;
        if (sel) toggle(e);
        else void open(e);
      }}
      onPointerDown={(ev) => beginPress(e, ev)}
      onPointerMove={movePress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      className="sd-press relative flex flex-col overflow-hidden rounded-[14px] bg-surface-1 text-left"
      style={sel?.has(e.path) ? { boxShadow: "inset 0 0 0 2px var(--brand)" } : undefined}
    >
      <span className="flex aspect-square w-full items-center justify-center overflow-hidden">
        <TileThumb e={e} />
      </span>
      <span className="line-clamp-2 px-2 pb-2 pt-1.5 text-[11px] leading-tight text-ink-2">{e.name}</span>
      {sel && (
        <span
          aria-hidden="true"
          className="absolute right-1.5 top-1.5 flex size-[22px] items-center justify-center rounded-full border"
          style={
            sel.has(e.path)
              ? { background: "var(--brand)", borderColor: "var(--brand)", color: "var(--background)" }
              : { borderColor: "#fff", color: "transparent", background: "rgba(0,0,0,0.35)" }
          }
        >
          <Check className="size-3.5" />
        </span>
      )}
    </button>
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {sel ? (
        <div className="flex shrink-0 items-center gap-1 px-1 pt-2">
          <button onClick={closeSel} className="sd-press sd-icon" aria-label="Close selection">
            <X className="size-[22px]" style={{ color: "var(--ink-2)" }} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[20px] font-semibold tracking-tight text-ink-1">
              {selectedEntries.length} selected
            </div>
            {selBytes > 0 && <div className="tnum text-[12px] text-ink-2">{humanSize(selBytes)}</div>}
          </div>
          <button
            onClick={() => void shareMany(selectedEntries)}
            className="sd-press sd-icon"
            aria-label="Share selection"
          >
            <Share2 className="size-[20px]" style={{ color: "var(--ink-2)" }} />
          </button>
          <button
            onClick={() => setConfirmBin(selectedEntries)}
            className="sd-press sd-icon"
            aria-label="Move selection to bin"
          >
            <Trash2 className="size-[20px]" style={{ color: "var(--ink-2)" }} />
          </button>
          <button onClick={openBulk} className="sd-press sd-icon" aria-label="More options">
            <MoreVertical className="size-[20px]" style={{ color: "var(--ink-2)" }} />
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1 px-1 pt-2">
          <button onClick={onBack} className="sd-press sd-icon" aria-label="Back to files home">
            <ChevronLeft className="size-[22px]" style={{ color: "var(--ink-2)" }} />
          </button>
          <div className="min-w-0 flex-1 truncate text-[20px] font-semibold tracking-tight text-ink-1">{title}</div>
          <button
            onClick={() => setSearchOpen((s) => !s)}
            className="sd-press sd-icon"
            aria-label={searchOpen ? "Close search" : "Search"}
          >
            {searchOpen
              ? <X className="size-[20px]" style={{ color: "var(--ink-2)" }} />
              : <Search className="size-[20px]" style={{ color: "var(--ink-2)" }} />}
          </button>
          <button
            onClick={() => setView((v) => (v === "list" ? "grid" : "list"))}
            className="sd-press sd-icon"
            aria-label={view === "list" ? "Switch to grid view" : "Switch to list view"}
          >
            {view === "list"
              ? <LayoutGrid className="size-[20px]" style={{ color: "var(--ink-2)" }} />
              : <ListIcon className="size-[20px]" style={{ color: "var(--ink-2)" }} />}
          </button>
          <button onClick={() => setShowSort(true)} className="sd-press sd-icon" aria-label="More options">
            <MoreVertical className="size-[20px]" style={{ color: "var(--ink-2)" }} />
          </button>
        </div>
      )}

      {searchOpen && (
        <div className="shrink-0 px-4 pt-3">
          <div
            className="flex items-center gap-2.5 rounded-full bg-surface-2 pl-4 pr-1.5 focus-within:ring-1 focus-within:ring-brand/40"
            style={{ height: 48 }}
          >
            <Search className="size-[18px] shrink-0" style={{ color: "var(--ink-2)" }} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
              aria-label={`Search ${title.toLowerCase()}`}
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
      )}

      {chips.length > 0 && (
        <div className="flex shrink-0 items-end gap-5 overflow-x-auto px-4 pt-3">
          <button
            onClick={() => setChip(null)}
            className={`shrink-0 border-b-2 pt-2 pb-2.5 text-[14px] transition-colors ${
              chip === null ? "border-brand font-medium text-ink-1" : "border-transparent text-ink-2"
            }`}
          >
            All
          </button>
          {chips.map((c) => (
            <button
              key={c}
              onClick={() => setChip(chip === c ? null : c)}
              className={`max-w-[180px] shrink-0 truncate border-b-2 pt-2 pb-2.5 text-[14px] transition-colors ${
                chip === c ? "border-brand font-medium text-ink-1" : "border-transparent text-ink-2"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {note && (
        <div className="mx-3 mt-2 px-3 py-2 rounded-card bg-brand-soft border border-brand/30 text-xs shrink-0">{note}</div>
      )}

      <div className="sd-fade-in flex-1 overflow-y-auto px-4 pt-2 pb-32">
        {(loading || busy) && (
          <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            {loading ? `Reading ${title.toLowerCase()}` : "Working"}
          </div>
        )}

        {!loading && denied && (
          <p className="px-1 py-6 text-[14px] text-ink-2">
            Android is not letting the app read storage. Turn on All files access in settings.
          </p>
        )}

        {!loading && !denied && view === "grid" && (
          <div className="grid grid-cols-3 gap-2">
            {sorted.map(tile)}
          </div>
        )}

        {!loading && !denied && view === "list" && groups.map((g, gi) => (
          <section key={g.heading ?? `g${gi}`} className="mt-4 first:mt-1">
            {g.heading && (
              <h3 className="mb-1.5 flex items-center gap-2.5 text-[13px] font-medium" style={{ color: "var(--ink-3)" }}>
                {sel && (
                  <button
                    onClick={() => groupAll(g.files, !g.files.every((f) => sel.has(f.path)))}
                    aria-label={`Select every file under ${g.heading}`}
                    className="sd-press flex size-[22px] shrink-0 items-center justify-center rounded-full border"
                    style={
                      g.files.every((f) => sel.has(f.path))
                        ? { background: "var(--brand)", borderColor: "var(--brand)", color: "var(--background)" }
                        : { borderColor: "var(--ink-3)", color: "transparent" }
                    }
                  >
                    <Check className="size-3.5" />
                  </button>
                )}
                {g.heading}
              </h3>
            )}
            {g.files.map(row)}
          </section>
        ))}

        {!loading && !denied && sorted.length === 0 && (q || chip ? (
          <EmptyState variant="search" title="No matches" hint="Try a shorter word, or a different filter." />
        ) : (
          <EmptyState
            variant="files"
            title={`No ${title.toLowerCase()} yet`}
            hint="Files you save to this phone will show up here."
          />
        ))}

        {!loading && !denied && sorted.length > 0 && total > entries.length && (
          <p className="tnum px-1 py-4 text-center text-[12px]" style={{ color: "var(--ink-3)" }}>
            Showing {entries.length} of {total}
          </p>
        )}
      </div>

      {showSort && (
        <DragSheet label="Sort by" onClose={() => setShowSort(false)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 text-[15px] font-medium text-ink-1">Sort by</div>
            <div className="mt-3">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => { setSort(s.id); setShowSort(false); }}
                  className="sd-press flex w-full items-center gap-3 border-t border-line py-3.5 text-left text-[15px] text-ink-1 first:border-t-0"
                >
                  <span className="flex-1">{s.label}</span>
                  {sort === s.id && <Check className="size-4 shrink-0" style={{ color: "var(--brand-ink)" }} />}
                </button>
              ))}
            </div>
          </div>
        </DragSheet>
      )}

      {menu && (
        <>
          <button className="fixed inset-0 z-40 cursor-default" aria-label="Close menu" onClick={() => setMenu(null)} />
          <div
            className="sd-glass fixed z-50 w-[236px] overflow-hidden rounded-[14px]"
            style={{ left: menu.x, top: menu.y }}
            role="menu"
            aria-label={`Actions for ${menu.e.name}`}
          >
            {menuItems.map((it) => (
              <button
                key={it.id}
                role="menuitem"
                onClick={() => {
                  const e = menu.e;
                  if (it.id === "open") { setMenu(null); void open(e); }
                  else if (it.id === "share") void share(e);
                  else if (it.id === "openWith") void doOpenWith(e);
                  else if (it.id === "rename") { setMenu(null); setRename({ e, value: e.name }); }
                  else if (it.id === "select") { setMenu(null); setSel(new Set([e.path])); }
                  else if (it.id === "star") { setMenu(null); toggleStar(e); }
                  else if (it.id === "vault") { setMenu(null); onVault?.([e]); }
                  else if (it.id === "copy") void saveCopy(e);
                  else if (it.id === "drive") { setMenu(null); onDriveUpload?.([e]); }
                  else if (it.id === "del") { setMenu(null); setConfirmBin([e]); }
                  else if (it.id === "move") { setMenu(null); setTransfer({ mode: "move", list: [e] }); }
                  else if (it.id === "copyTo") { setMenu(null); setTransfer({ mode: "copy", list: [e] }); }
                  else { setMenu(null); setInfo(e); }
                }}
                className="flex w-full items-center border-t border-line px-4 py-3 text-left text-[15px] first:border-t-0"
                style={it.danger ? { color: "var(--att-critical-text)" } : { color: "var(--ink-1)" }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}

      {bulkMenu && (
        <>
          <button className="fixed inset-0 z-40 cursor-default" aria-label="Close menu" onClick={() => setBulkMenu(null)} />
          <div
            className="sd-glass fixed z-50 w-[200px] overflow-hidden rounded-[14px]"
            style={{ left: bulkMenu.x, top: bulkMenu.y }}
            role="menu"
            aria-label="Selection actions"
          >
            {bulkItems.map((it) => (
              <button
                key={it.id}
                role="menuitem"
                onClick={() => {
                  const list = selectedEntries;
                  setBulkMenu(null);
                  if (it.id === "all") setSel(new Set(sorted.map((e) => e.path)));
                  else if (it.id === "none") setSel(null);
                  else if (it.id === "openWith") { if (list[0]) void doOpenWith(list[0]); }
                  else if (it.id === "star") {
                    let added = 0;
                    for (const e of list) if (!isStarred(e.path)) { starOn(e); added++; }
                    setNote(
                      added > 0
                        ? `Added ${added} file${added === 1 ? "" : "s"} to Starred.`
                        : "Those files were already starred.",
                    );
                  }
                  else if (it.id === "vault") { if (list.length) onVault?.(list); }
                  else if (it.id === "drive") { if (list.length) onDriveUpload?.(list); }
                  else if (it.id === "move") { if (list.length) setTransfer({ mode: "move", list }); }
                  else if (list.length) setTransfer({ mode: "copy", list });
                }}
                className="flex w-full items-center border-t border-line px-4 py-3 text-left text-[15px] first:border-t-0"
                style={{ color: "var(--ink-1)" }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}

      {rename && (
        <DragSheet label="Rename file" onClose={() => setRename(null)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 text-[15px] font-medium text-ink-1">Rename</div>
            <div className="truncate text-[13px] text-ink-3">{rename.e.name}</div>
            <input
              value={rename.value}
              onChange={(ev) => setRename({ e: rename.e, value: ev.target.value })}
              onFocus={(ev) => ev.currentTarget.select()}
              autoFocus
              aria-label="New file name"
              className="mt-3 w-full rounded-[12px] bg-surface-2 px-4 text-[15px] outline-none"
              style={{ height: 48 }}
            />
            <button
              onClick={() => void doRename()}
              className="sd-press bg-brand text-background mt-4 w-full rounded-card py-3.5 text-[15px] font-semibold"
            >
              Rename
            </button>
          </div>
        </DragSheet>
      )}

      {transfer && (
        <FolderPicker
          title={transfer.mode === "move" ? "Move to" : "Copy to"}
          confirmLabel={transfer.mode === "move" ? "Move here" : "Copy here"}
          blockedDir={
            transfer.mode === "move" && transfer.list.length === 1
              ? parentOf(transfer.list[0]!.path)
              : null
          }
          busy={busy}
          onClose={() => setTransfer(null)}
          onConfirm={(dir) => void doTransfer(dir)}
        />
      )}

      {info && (
        <FileInfo
          e={info}
          onClose={() => setInfo(null)}
          onOpen={() => {
            const e = info;
            setInfo(null);
            void open(e);
          }}
        />
      )}

      {confirmBin && (
        <DragSheet label="Move to bin" onClose={() => setConfirmBin(null)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 truncate text-[15px] font-medium text-ink-1">
              {confirmBin.length === 1 ? confirmBin[0]!.name : `${confirmBin.length} files`}
            </div>
            <div className="text-[13px] text-ink-3">
              {confirmBin.length === 1 ? "It moves" : "They move"} into the Bin, where files stay for 30 days
              before leaving this phone for good.
            </div>
            <button
              onClick={() => void del()}
              className="sd-press bg-brand text-background mt-4 w-full rounded-card py-3.5 text-[15px] font-semibold"
            >
              Move to bin
            </button>
          </div>
        </DragSheet>
      )}
    </div>
  );
}

function iconFor(e: DfRecent) {
  if (AUDIO_EXT.includes(e.ext)) return Music;
  if (e.ext === "apk") return Download;
  // WhatsApp's encrypted backup payloads: a lock says more than a page does.
  if (isEncryptedBackup(e.ext)) return Lock;
  return FileText;
}

function RowThumb({ e }: { e: DfRecent }) {
  const [url, setUrl] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    setUrl(null);
    setTried(false);
    if (!hasRowThumb(e.ext)) {
      setTried(true);
      return;
    }
    let alive = true;
    void rowThumbUrl(e.path, e.ext, 160).then((u) => {
      if (alive) {
        setUrl(u);
        setTried(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [e.path, e.ext]);

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
  const Icon = iconFor(e);
  if (tried && e.ext === "webp") {
    // A dotLottie sticker: the animation is its own thumbnail.
    return (
      <span
        className="relative shrink-0 overflow-hidden rounded-[12px] bg-surface-2"
        style={{ width: 44, height: 44 }}
      >
        <StickerTile
          path={e.path}
          className="h-full w-full"
          frameClassName="p-0.5"
          fallback={<Icon className="size-5" style={{ color: "var(--ink-3)" }} />}
        />
      </span>
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[12px] bg-surface-2"
      style={{ width: 44, height: 44 }}
    >
      <Icon className="size-5" style={{ color: "var(--ink-3)" }} />
    </span>
  );
}

function TileThumb({ e }: { e: DfRecent }) {
  const [url, setUrl] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    setUrl(null);
    setTried(false);
    if (!hasRowThumb(e.ext)) {
      setTried(true);
      return;
    }
    let alive = true;
    void rowThumbUrl(e.path, e.ext, 320).then((u) => {
      if (alive) {
        setUrl(u);
        setTried(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [e.path, e.ext]);

  if (url) {
    return <img src={url} alt="" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
  }
  const Icon = iconFor(e);
  if (tried && e.ext === "webp") {
    return (
      <StickerTile
        path={e.path}
        className="h-full w-full"
        frameClassName="p-3"
        fallback={<Icon className="size-7" style={{ color: "var(--ink-3)" }} />}
      />
    );
  }
  return <Icon className="size-7" style={{ color: "var(--ink-3)" }} />;
}

/** The folder a file sits in — Google Files labels and chips by where a file
 *  lives, which is the fact that tells two near-identical names apart. */
function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  if (cut <= 0) return "";
  const parent = path.slice(0, cut);
  const name = parent.slice(parent.lastIndexOf("/") + 1);
  if (!name || name === "0" || name === "emulated" || name === "sdcard" || name === "self") return "";
  return name;
}
