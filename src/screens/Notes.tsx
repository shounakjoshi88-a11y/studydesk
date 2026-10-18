import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Eye, Pencil, X, FileText, FileDown, Search, ChevronDown, ChevronUp, ChevronLeft, FolderPlus, Share2, MoreHorizontal, FolderOpen, Upload, Loader2, PenLine, FileUp } from "lucide-react";
import { MessageRenderer } from "../components/MessageRenderer";
import { Reader } from "../components/Reader";
import { EmptyState } from "../components/EmptyState";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  listNotes, getNoteBody, saveNote, deleteNote, uid, moveFolderNotes, updateFileData,
  listFiles, getFileData, setPinned, addFile, fileToBase64, fmtSize, type NoteMeta, type FileMeta,
} from "../lib/store";
import { noteToDocx, TEXT_EXTS } from "../lib/office";
import { shareFileData, textToB64 } from "../lib/share";
import { canConvertToNote } from "../lib/convert";
import { noteFromAppFile, noteFromExternalFile } from "../lib/noteImport";
import { takePendingNote } from "../lib/pendingNote";

const noop = () => {};
const FOLDERS_KEY = "sd_folders";
/* Same sheet shell as Campus, so the two surfaces in the app that use a
   bottom sheet are actually the same surface. */
const sheetCls = "fixed inset-0 z-50 flex flex-col justify-end bg-black/60";
const sheetInner = "bg-card border-t border-border rounded-t-3xl p-4 pb-8 max-h-[80%] flex flex-col";

function loadCustomFolders(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDERS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function snippetOf(body: string): string {
  const line =
    body
      .split("\n")
      .map((l) => l.replace(/^[#>*`\-\+0-9.)\s]+/, "").trim())
      .find((l) => l.length > 0) || "";
  return line.length > 90 ? line.slice(0, 90) + "…" : line;
}

/**
 * "Today", "Yesterday", "3 Sep", then "3 Sep 2025" once the year stops being
 * obvious. A raw en-GB slash date is both harder to scan and inconsistent with
 * how every other date in the app is written.
 */
function shortDate(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function Notes() {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [pinned, setPinnedList] = useState<FileMeta[]>([]);
  const [openFile, setOpenFile] = useState<{ meta: FileMeta; data: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState("General");
  const [body, setBody] = useState("");
  const [origin, setOrigin] = useState<{ fileId: string; ext: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState(true);
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState<string[]>(() => loadCustomFolders());
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [showManage, setShowManage] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [renaming, setRenaming] = useState<{ old: string; val: string } | null>(null);
  // The "+" sheet: null when closed, otherwise which step of the flow is
  // showing. "new" is the first choice (write vs bring a file in), "import"
  // picks the source, "files" is the in-app picker. One state variable, so
  // two steps can never be open at the same time.
  const [impStage, setImpStage] = useState<null | "new" | "import" | "files">(null);
  const [impFiles, setImpFiles] = useState<FileMeta[]>([]);
  const [impQuery, setImpQuery] = useState("");
  const [impBusy, setImpBusy] = useState<string | null>(null);
  const [impProg, setImpProg] = useState<{ p: number; stage: string } | null>(null);
  const [impErr, setImpErr] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  // The editor's open id, readable from listeners that were registered on the
  // first render and would otherwise close over a stale null.
  const openIdRef = useRef<string | null>(null);
  const reduceMotion = useReducedMotion();

  const refresh = async () => {
    const ns = await listNotes();
    setNotes(ns);
    setPinnedList((await listFiles()).filter((f) => f.pinned));
    const b: Record<string, string> = {};
    await Promise.all(ns.map(async (n) => { b[n.id] = await getNoteBody(n.id); }));
    setBodies(b);
  };
  useEffect(() => { void refresh(); }, []);

  // Tells the shell a note is open so it can drop the dock. Navigation away
  // from a half-written note is not something to offer one tap away.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("sd-editor", { detail: { open: Boolean(openId) } }));
  }, [openId]);

  useEffect(() => {
    openIdRef.current = openId;
  }, [openId]);

  const persistCustom = (c: string[]) => {
    setCustom(c);
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(c));
  };

  const folders = useMemo(() => {
    const fromNotes = Array.from(new Set(notes.map((n) => n.folder))).filter((f) => f !== "General");
    const rest = Array.from(new Set([...custom, ...fromNotes])).sort((a, b) => a.localeCompare(b));
    return ["General", ...rest];
  }, [notes, custom]);

  const shown = notes.filter((n) => {
    if (filter !== "All" && n.folder !== filter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      n.title.toLowerCase().includes(q) ||
      n.folder.toLowerCase().includes(q) ||
      (bodies[n.id] || "").toLowerCase().includes(q)
    );
  });

  const openNew = () => {
    setOpenId("new");
    setTitle("");
    setFolder(filter === "All" ? "General" : filter);
    setBody("");
    setOrigin(null);
    setMsg(null);
    setPreview(false);
  };

  const openExisting = async (n: NoteMeta) => {
    setOpenId(n.id);
    setTitle(n.title);
    setFolder(n.folder);
    setBody(await getNoteBody(n.id));
    setOrigin(n.originFileId ? { fileId: n.originFileId, ext: n.originExt || "" } : null);
    setMsg(null);
    setPreview(true);
  };

  /**
   * Opens a note that was just created by an import. Guarded so a share that
   * lands while a different note is being edited never yanks the editor away
   * from unsaved work — the new note still exists in the list either way.
   */
  const openById = async (id: string, label?: string) => {
    if (openIdRef.current && openIdRef.current !== id) return;
    const meta = (await listNotes()).find((n) => n.id === id);
    if (!meta) return;
    await openExisting(meta);
    if (label) setMsg(label);
  };

  /**
   * Notes arriving from outside the screen: Android Open With / share sheet
   * creates the note first (in lib/incoming.ts) and then parks its id. The
   * pending id is picked up here on mount — that covers the case where the
   * share also caused this tab to be switched in — and the window event
   * covers the case where Notes was already on screen.
   */
  useEffect(() => {
    const p = takePendingNote();
    if (p) void openById(p.id, p.label);
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ id?: string; label?: string }>).detail;
      if (d && typeof d.id === "string") {
        takePendingNote(); // the event beat the mount path to it
        void openById(d.id, d.label);
      }
    };
    window.addEventListener("sd-open-note", h);
    return () => window.removeEventListener("sd-open-note", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const t = title.trim() || "Untitled";
    const id = openId === "new" ? uid() : openId!;
    const f = folder.trim() || "General";
    await saveNote(
      { id, title: t, folder: f, updatedAt: Date.now(), originFileId: origin?.fileId, originExt: origin?.ext },
      body
    );
    if (f !== "General" && !custom.includes(f) && !notes.some((n) => n.folder === f)) {
      persistCustom([...custom, f]);
    }
    setOpenId(null);
    await refresh();
  };

  const remove = async (id: string) => {
    await deleteNote(id);
    if (openId === id) setOpenId(null);
    await refresh();
  };

  const saveToFile = async () => {
    if (!origin || !openId || openId === "new") return;
    const t = title.trim() || "Untitled";
    const f = folder.trim() || "General";
    await saveNote(
      { id: openId, title: t, folder: f, updatedAt: Date.now(), originFileId: origin.fileId, originExt: origin.ext },
      body
    );
    await updateFileData(origin.fileId, body);
    setMsg("Saved back to the file.");
    await refresh();
  };

  const exportDocx = async () => {
    const t = title.trim() || "Untitled note";
    try {
      const data = await noteToDocx(t, body);
      const safe = t.replace(/[\\/:*?"<>|]/g, "").slice(0, 60) || "note";
      await addFile(`${safe}.docx`, data);
      setMsg("DOCX saved to Files.");
    } catch (e) {
      setMsg(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const shareCurrentNote = async () => {
    const t = (title.trim() || "note").replace(/[\\/:*?"<>|]/g, "").slice(0, 60) || "note";
    try {
      await shareFileData(`${t}.md`, textToB64(`# ${t}\n\n${body}`), t);
    } catch (e) {
      setMsg(`Share failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── The "+" menu: write or import ─────────────────────
  /** An import files the note where the user is standing, not in General. */
  const importFolder = () => (filter !== "All" ? filter : "General");

  const openMenu = () => {
    setImpStage("new");
    setImpErr(null);
    setImpQuery("");
    setImpBusy(null);
    setImpProg(null);
  };

  const closeSheet = () => {
    if (!impBusy) setImpStage(null);
  };

  /** Close the menu, then do the thing — the card collapsing into the button
   *  reads as the cause of whatever opens next. */
  const closeThen = (fn: () => void) => {
    setImpStage(null);
    if (reduceMotion) fn();
    else window.setTimeout(fn, 140);
  };

  const startAppImport = async () => {
    setImpStage("files");
    setImpErr(null);
    setImpFiles((await listFiles()).filter((f) => canConvertToNote(f.ext)));
  };

  const runAppImport = async (m: FileMeta) => {
    if (impBusy) return;
    setImpBusy(m.name);
    setImpErr(null);
    try {
      const id = await noteFromAppFile(m, importFolder(), (p, stage) => setImpProg({ p, stage }));
      setImpStage(null);
      await refresh();
      await openById(id, `Imported from ${m.name}`);
    } catch (e) {
      setImpErr(e instanceof Error ? e.message : String(e));
    } finally {
      setImpBusy(null);
      setImpProg(null);
    }
  };

  const onImportPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
    if (!canConvertToNote(ext)) {
      setImpErr(`Can't make a note from ${ext ? "." + ext : "that file"} yet. Try markdown, text, PDF, DOCX or an image.`);
      return;
    }
    setImpBusy(f.name);
    setImpErr(null);
    try {
      const b64 = await fileToBase64(f);
      const id = await noteFromExternalFile(f.name, ext, b64, importFolder(), (p, stage) => setImpProg({ p, stage }));
      setImpStage(null);
      await refresh();
      await openById(id, `Imported from ${f.name}`);
    } catch (e2) {
      setImpErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setImpBusy(null);
      setImpProg(null);
    }
  };

  const openPinned = async (m: FileMeta) => {
    const data = await getFileData(m.id);
    setOpenFile({ meta: m, data });
  };

  const unpin = async (id: string) => {
    await setPinned(id, false);
    await refresh();
  };

  const createFolder = () => {
    const name = newFolder.trim().slice(0, 24);
    if (!name || name === "All" || folders.includes(name)) {
      setCreating(false);
      setNewFolder("");
      return;
    }
    persistCustom([...custom, name]);
    setFilter(name);
    setCreating(false);
    setNewFolder("");
  };

  const renameFolder = async () => {
    if (!renaming) return;
    const val = renaming.val.trim().slice(0, 24);
    if (!val || val === renaming.old) {
      setRenaming(null);
      return;
    }
    await moveFolderNotes(renaming.old, val);
    persistCustom(custom.map((c) => (c === renaming.old ? val : c)));
    if (filter === renaming.old) setFilter(val);
    setRenaming(null);
    await refresh();
  };

  const deleteFolder = async (f: string) => {
    await moveFolderNotes(f, "General");
    persistCustom(custom.filter((c) => c !== f));
    if (filter === f) setFilter("All");
    await refresh();
  };

  if (openId) {
    return (
      <div className="flex flex-col h-full">
        {/* One row of controls, not two rows of chips. Six buttons in pairs
            gave the editor more chrome than content and made it impossible to
            tell which one mattered. Save is the only primary; the four
            occasional things live behind one overflow. */}
        <div className="flex items-center gap-2 px-3 pt-3">
          <button
            onClick={() => setOpenId(null)}
            className="sd-press flex size-9 items-center justify-center rounded-[6px]"
            style={{ color: "var(--ink-2)" }}
            aria-label="Close note"
          >
            <X className="size-5" />
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setPreview(!preview)}
            className="sd-press flex items-center gap-1.5 px-1 text-[13px]"
            style={{ color: "var(--ink-2)" }}
          >
            {preview ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
            {preview ? "Edit" : "Preview"}
          </button>
          <button
            onClick={() => setShowMore(true)}
            className="sd-press flex size-9 items-center justify-center rounded-[6px]"
            style={{ color: "var(--ink-2)" }}
            aria-label="More actions"
          >
            <MoreHorizontal className="size-5" />
          </button>
          <button
            onClick={save}
            className="sd-press rounded-[8px] px-4 py-2 text-[14px] font-semibold"
            style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
          >
            Save
          </button>
        </div>

        {/* The title is the document's own heading, not a field in a box. */}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Note title"
          aria-label="Note title"
          className="mx-3 mt-2 bg-transparent text-[22px] font-semibold leading-tight tracking-tight outline-none placeholder:text-ink-3 px-0"
        />
        {/* Folder sits with the metadata. It is how the note files itself, not
            a control you steer. Changing it is in the overflow. */}
        <div className="mx-3 mt-1.5 flex items-center gap-2 text-[13px]" style={{ color: "var(--ink-3)" }}>
          <span className="truncate">{folder || "General"}</span>
          {msg && (
            <>
              <span>·</span>
              <span className="truncate">{msg}</span>
            </>
          )}
        </div>

        <div className="mx-3 mt-3 border-t border-line" />

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {preview ? (
            <MessageRenderer content={body || "*Nothing to preview yet*"} onCitationClick={noop} sources={[]} />
          ) : (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write markdown… # heading, - list, ```code```, $$math$$"
              className="w-full h-full min-h-[50vh] p-3 rounded-card bg-surface-2 border border-line font-mono text-sm outline-none focus:border-brand resize-none"
            />
          )}
        </div>

        {showMore && (
          <div className={sheetCls} onClick={() => setShowMore(false)}>
            <div className={sheetInner} onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 text-sm font-semibold">Note</div>
              <label className="mb-1 block text-[11px] font-medium" style={{ color: "var(--ink-2)" }}>
                Folder
              </label>
              <input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="Folder"
                list="sd-folder-list"
                className="w-full rounded-[6px] bg-surface-2 border border-line px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
              <datalist id="sd-folder-list">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <div className="mt-3 flex flex-col">
                {origin && TEXT_EXTS.has(origin.ext) && (
                  <button
                    onClick={() => {
                      setShowMore(false);
                      void saveToFile();
                    }}
                    className="sd-press flex items-center gap-2 border-b border-line py-3 text-left text-[14px]"
                  >
                    <FileText className="size-4" style={{ color: "var(--ink-3)" }} />
                    Save to file
                  </button>
                )}
                <button
                  onClick={() => {
                    setShowMore(false);
                    void exportDocx();
                  }}
                  className="sd-press flex items-center gap-2 border-b border-line py-3 text-left text-[14px]"
                >
                  <FileDown className="size-4" style={{ color: "var(--ink-3)" }} />
                  Export DOCX
                </button>
                <button
                  onClick={() => {
                    setShowMore(false);
                    void shareCurrentNote();
                  }}
                  className="sd-press flex items-center gap-2 py-3 text-left text-[14px]"
                >
                  <Share2 className="size-4" style={{ color: "var(--ink-3)" }} />
                  Share
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex flex-col h-full">
      {/* Filled and borderless rather than a full boxed field: on a list this
          short, a heavy input above it is the loudest thing on screen and it
          is not what anyone came for. */}
      <div className="px-3 pt-1 shrink-0">
        <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-[6px] bg-surface-2">
          <Search className="size-4 shrink-0" style={{ color: "var(--ink-3)" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes"
            aria-label="Search notes"
            className="flex-1 min-w-0 bg-transparent text-[15px] outline-none placeholder:text-ink-3"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear search" className="-mr-1 p-1">
              <X className="size-4" style={{ color: "var(--ink-3)" }} />
            </button>
          )}
        </div>
      </div>
      {/* Folders as an underlined text tab strip, matching Campus. A row of
          filled pills gave every folder the same weight as the notes below
          and made the section look like a toolbar. */}
      <div className="flex items-end gap-1 px-3 pt-4 pb-1 shrink-0">
        <div className="flex gap-4 overflow-x-auto flex-1" data-hscroll>
          {["All", ...folders].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`shrink-0 whitespace-nowrap border-b-2 pb-2 text-[14px] transition-colors ${
                filter === f
                  ? "border-brand text-ink-1 font-medium"
                  : "border-transparent text-ink-2"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setCreating(true);
            setShowManage(true);
          }}
          className="sd-press shrink-0 px-1 pb-2 text-[13px] font-medium"
          style={{ color: "var(--ink-2)" }}
        >
          New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pt-3 pb-32">
        {pinned.length > 0 && (
          <div className="mb-4">
            <button onClick={() => setPinnedOpen(!pinnedOpen)} className="flex items-center gap-1 px-1 mb-1">
              <span className="text-[13px] text-ink-2 font-medium">Pinned files</span>
              {pinnedOpen ? <ChevronUp className="size-3.5 text-ink-3" /> : <ChevronDown className="size-3.5 text-ink-3" />}
            </button>
            {pinnedOpen &&
              pinned.map((f, i) => (
                <div
                  key={f.id}
                  onClick={() => void openPinned(f)}
                  className="sd-fade-in sd-tap flex items-center gap-3 py-3"
                  style={{ borderTop: i > 0 ? "1px solid var(--line)" : "none", animationDelay: `${Math.min(i, 6) * 40}ms` }}
                >
                  <FileText className="size-4 shrink-0" style={{ color: "var(--ink-3)" }} />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-[15px] text-ink-1">{f.name}</div>
                    <div className="truncate text-[12px] text-ink-3">{f.ext || "file"}</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); void unpin(f.id); }}
                    className="p-2 -mr-2 rounded-lg"
                    style={{ color: "var(--ink-3)" }}
                    aria-label="Unpin file"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
          </div>
        )}
        {shown.length === 0 &&
          (query ? (
            <EmptyState variant="search" title="No matches" hint="Try different words." />
          ) : (
            pinned.length === 0 && (
              <EmptyState variant="notes" title="No notes yet" hint="Tap + to write a note or import a .md file." />
            )
          ))}
        {shown.map((n, i) => {
          const snip = snippetOf(bodies[n.id] || "");
          return (
            <div
              key={n.id}
              onClick={() => void openExisting(n)}
              onContextMenu={(e) => {
                // Delete lives behind a long press. A trash icon on every row
                // is the single loudest thing on a list whose job is to be
                // read, and it is one mis-tap away from losing someone's work.
                e.preventDefault();
                void remove(n.id);
              }}
              className="sd-fade-in sd-tap flex items-start gap-3 py-3"
              style={{ borderTop: i > 0 ? "1px solid var(--line)" : "none", animationDelay: `${Math.min(i, 6) * 40}ms` }}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium text-ink-1">{n.title}</div>
                <div className="mt-0.5 flex items-baseline gap-2">
                  {/* Metadata only. The body preview used to sit on this line
                      at the same size as the title, which made every row read
                      as two competing headings. */}
                  <span className="tnum shrink-0 text-[12px] text-ink-3">{shortDate(n.updatedAt)}</span>
                  {snip && <span className="min-w-0 truncate text-[13px] text-ink-2">{snip}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Anchored to the bottom of the content area, which already ends where
          the dock begins — so a plain offset puts it right on top of the dock.
          No env() here on purpose: it lives inside calc() for the safe area,
          and an env() that fails to resolve takes the whole declaration with
          it, leaving the button unanchored.

          The button is the menu: it spins into an × and the card grows out of
          its corner. No .sd-press here — that keyframe animation fills
          forwards on transform, and a filled animation outranks framer's
          inline transform, which would pin the rotation at zero. whileTap
          plays the same press feedback instead. */}
      <motion.button
        onClick={() => (impStage !== null ? closeSheet() : openMenu())}
        className="absolute bottom-5 right-4 z-20 size-14 rounded-full flex items-center justify-center"
        style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
        animate={{ rotate: impStage !== null ? 45 : 0 }}
        whileTap={{ scale: 0.92 }}
        transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 32 }}
        aria-label={impStage !== null ? "Close menu" : "New note or import"}
        aria-expanded={impStage !== null}
      >
        <Plus className="size-6" />
      </motion.button>

      {showManage && (
        <div className={sheetCls} onClick={() => { setShowManage(false); setRenaming(null); }}>
          <div className={sheetInner} onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-1">Manage folders</div>
            <p className="text-[11px] text-ink-2 mb-3">Deleting a folder moves its notes to General.</p>
            {/* Creating a folder lives here rather than in the tab strip: it
                is a once-in-a-while action, and inline in the strip it looked
                like a fourth folder. */}
            {creating ? (
              <input
                autoFocus
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                onBlur={createFolder}
                onKeyDown={(e) => e.key === "Enter" && createFolder()}
                placeholder="Folder name"
                className="mb-3 w-full px-3 py-2.5 rounded-[6px] bg-surface-2 border border-brand text-sm outline-none"
              />
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="sd-press mb-3 flex w-full items-center gap-2 rounded-[6px] border border-dashed border-line px-3 py-2.5 text-[14px]"
                style={{ color: "var(--ink-2)" }}
              >
                <FolderPlus className="size-4" /> New folder
              </button>
            )}
            <div className="overflow-y-auto">
              {folders.map((f, i) => {
                const count = notes.filter((n) => n.folder === f).length;
                return (
                  <div key={f} className="sd-card-in flex items-center gap-2 px-1 py-2 border-b border-line last:border-0" style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}>
                    {renaming?.old === f ? (
                      <input
                        autoFocus
                        value={renaming.val}
                        onChange={(e) => setRenaming({ old: f, val: e.target.value })}
                        onBlur={() => void renameFolder()}
                        onKeyDown={(e) => e.key === "Enter" && void renameFolder()}
                        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-surface-2 border border-brand text-sm outline-none"
                      />
                    ) : (
                      <button onClick={() => setRenaming({ old: f, val: f })} className="sd-press flex-1 min-w-0 text-left">
                        <div className="text-sm font-medium truncate">{f}</div>
                        <div className="tnum text-[11px] text-ink-2">{count} note{count === 1 ? "" : "s"} · tap to rename</div>
                      </button>
                    )}
                    {f !== "General" && (
                      <button onClick={() => void deleteFolder(f)} className="p-2 rounded-lg text-ink-3 hover:text-critical" aria-label={`Delete ${f}`}>
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* The menu is the FAB's other half: a scrim to swallow the tap-out,
          and a card that grows out of the button's corner while the button
          spins into an ×. Dismissing reverses both in the same spring. */}
      <AnimatePresence>
        {impStage !== null && (
          <motion.div
            key="menu-scrim"
            className="fixed inset-0 z-10 bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.18 }}
            onClick={closeSheet}
          />
        )}
        {impStage !== null && (
          <motion.div
            key="menu-card"
            role="dialog"
            aria-label="New note"
            className="absolute right-4 z-20 rounded-3xl border p-4"
            style={{
              bottom: 88,
              width: "min(20rem, calc(100vw - 2rem))",
              background: "#08090d",
              borderColor: "var(--line-strong)",
              boxShadow: "0 24px 60px rgba(0, 0, 0, 0.55)",
              transformOrigin: "100% 100%",
            }}
            initial={reduceMotion ? false : { opacity: 0, scale: 0.5, y: 28 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.55, y: 32 }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 38, mass: 0.9 }}
          >
            <div className="mb-1 flex items-center gap-1">
              {impStage !== "new" && (
                <button
                  onClick={() => {
                    setImpStage(impStage === "files" ? "import" : "new");
                    setImpErr(null);
                  }}
                  className="sd-press -ml-2 flex size-8 shrink-0 items-center justify-center rounded-lg"
                  aria-label="Back"
                >
                  <ChevronLeft className="size-4" style={{ color: "var(--ink-2)" }} />
                </button>
              )}
              <div className="text-[15px] font-medium text-ink-1">
                {impStage === "new" ? "New note" : impStage === "import" ? "From a file" : "From Files"}
              </div>
            </div>
            <div className="text-[13px] text-ink-3">
              {impStage === "new"
                ? "Start blank, or bring something in."
                : impStage === "import"
                  ? "It becomes an editable note on this phone."
                  : "Pick something already in the app."}
            </div>
            <input
              ref={importRef}
              type="file"
              accept=".md,.markdown,.txt,.csv,.json,.log,.pdf,.docx,text/*,application/pdf,image/*"
              className="hidden"
              onChange={(e) => void onImportPick(e)}
            />
            {impBusy ? (
              <div className="flex flex-col items-center gap-2.5 py-8">
                <Loader2 className="size-5 animate-spin" style={{ color: "var(--ink-3)" }} />
                <div className="text-center text-[13px] text-ink-2">
                  {impProg ? impProg.stage : "Reading…"}
                  {impProg && impProg.p >= 1 ? "" : impProg && impProg.p > 0.02 ? ` · ${Math.round(impProg.p * 100)}%` : ""}
                </div>
                <div className="max-w-[75vw] truncate text-[11px] text-ink-3">{impBusy}</div>
              </div>
            ) : impStage === "new" ? (
              <div className="mt-4">
                <button
                  onClick={() => closeThen(openNew)}
                  className="sd-press flex w-full items-center gap-3.5 border-t border-line py-3.5 text-left"
                >
                  <PenLine className="size-[18px] shrink-0" style={{ color: "var(--ink-3)" }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] text-ink-1">Write it out</span>
                    <span className="mt-0.5 block text-[13px] text-ink-2">A blank note, start typing</span>
                  </span>
                </button>
                <button
                  onClick={() => setImpStage("import")}
                  className="sd-press flex w-full items-center gap-3.5 border-t border-line py-3.5 text-left"
                >
                  <FileUp className="size-[18px] shrink-0" style={{ color: "var(--ink-3)" }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] text-ink-1">From a file</span>
                    <span className="mt-0.5 block text-[13px] text-ink-2">Markdown, text, PDF, DOCX, or a photo</span>
                  </span>
                </button>
              </div>
            ) : impStage === "import" ? (
              <div className="mt-4">
                <button
                  onClick={() => void startAppImport()}
                  className="sd-press flex w-full items-center gap-3.5 border-t border-line py-3.5 text-left"
                >
                  <FolderOpen className="size-[18px] shrink-0" style={{ color: "var(--ink-3)" }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] text-ink-1">From Files</span>
                    <span className="mt-0.5 block text-[13px] text-ink-2">A file already in the app</span>
                  </span>
                </button>
                <button
                  onClick={() => importRef.current?.click()}
                  className="sd-press flex w-full items-center gap-3.5 border-t border-line py-3.5 text-left"
                >
                  <Upload className="size-[18px] shrink-0" style={{ color: "var(--ink-3)" }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] text-ink-1">From phone</span>
                    <span className="mt-0.5 block text-[13px] text-ink-2">Pick any .md, PDF, DOCX or photo</span>
                  </span>
                </button>
              </div>
            ) : (
              <div className="mt-4">
                <div className="flex items-center gap-2 rounded-[6px] bg-surface-2 px-3 py-2">
                  <Search className="size-4 shrink-0" style={{ color: "var(--ink-3)" }} />
                  <input
                    value={impQuery}
                    onChange={(e) => setImpQuery(e.target.value)}
                    placeholder="Search files"
                    aria-label="Search files to import"
                    className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3"
                  />
                </div>
                <div className="mt-1 overflow-y-auto" style={{ maxHeight: "46vh" }}>
                  {impFiles.filter((f) => f.name.toLowerCase().includes(impQuery.trim().toLowerCase())).length === 0 ? (
                    <p className="py-6 text-center text-xs text-ink-2">
                      {impFiles.length === 0 ? "No importable files in the app yet." : "No matches."}
                    </p>
                  ) : (
                    impFiles
                      .filter((f) => f.name.toLowerCase().includes(impQuery.trim().toLowerCase()))
                      .map((f) => (
                        <button
                          key={f.id}
                          onClick={() => void runAppImport(f)}
                          className="sd-press flex w-full items-center gap-3 border-b border-line px-1 py-3 text-left last:border-0"
                        >
                          <FileText className="size-4 shrink-0" style={{ color: "var(--ink-3)" }} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[14px] text-ink-1">{f.name}</span>
                            <span className="text-[11px] text-ink-3">{(f.ext || "file").toUpperCase()} · {fmtSize(f.size)}</span>
                          </span>
                        </button>
                      ))
                  )}
                </div>
                <button
                  onClick={() => importRef.current?.click()}
                  className="sd-press mt-2 w-full rounded-[6px] border border-dashed border-line px-3 py-2.5 text-[13px]"
                  style={{ color: "var(--ink-2)" }}
                >
                  Import from phone instead
                </button>
              </div>
            )}
            {impErr && <p className="mt-2 text-xs text-critical">! {impErr}</p>}
          </motion.div>
        )}
      </AnimatePresence>

      {openFile && <Reader file={openFile.meta} base64={openFile.data} onClose={() => setOpenFile(null)} />}
    </div>
  );
}
