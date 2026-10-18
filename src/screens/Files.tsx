import { useEffect, useRef, useState } from "react";
import { Upload, Trash2, Download, ChevronLeft, ChevronDown, Check, Loader2, Menu, Pin, PinOff, MonitorUp, X, Search, Plus, ScanText, Combine, Scissors, FilePlus2 } from "lucide-react";
import { fileToNoteMarkdown, noteTitleFor } from "../lib/convert";
import { Reader } from "../components/Reader";
import { ImageViewer } from "../components/ImageViewer";
import { VideoPlayer } from "../components/VideoPlayer";
import { StickerViewer } from "../components/StickerViewer";
import { EmptyState } from "../components/EmptyState";
import { DragSheet } from "../components/DragSheet";
import { DeviceBrowser } from "../components/DeviceBrowser";
import { DeviceSearch } from "../components/DeviceSearch";
import { FilesHome } from "../components/FilesHome";
import { CategoryList } from "../components/CategoryList";
import { MediaGallery } from "../components/MediaGallery";
import { BinScreen } from "../components/BinScreen";
import { CleanScreen } from "../components/CleanScreen";
import { FilesMenu } from "../components/FilesMenu";
import { FilesSettings } from "../components/FilesSettings";
import { StarredScreen } from "../components/StarredScreen";
import { VaultScreen } from "../components/VaultScreen";
import { AudioPlayer } from "../components/AudioPlayer";
import { DriveBrowser } from "../components/DriveBrowser";
import {
  CATEGORY_LABEL, isAudio, isImage, isVideo, isZipBase64, mediaItemFromPath, nativeAvailable, readFile,
  type CategoryId, type DfFile, type DfRecent, type FilterId, type MediaItem,
} from "../lib/deviceFiles";
import { pcBrowse, pcPull, pcPush, type PcEntry } from "../lib/pc";
import { shareFileData } from "../lib/share";
import { recordOpen } from "../lib/recentOpened";
import { binBytes } from "../lib/fileBin";
import { cleanedBytes } from "../lib/cleanStats";
import { starredCount } from "../lib/starred";
import { vaultBytes, vaultCount } from "../lib/vault";
import { loadBridge } from "../lib/ask";
import {
  imagesToPdf, extractPdfText, pdfPageCount, parseKeepSpec, keepPdfPages,
  mergePdfs, TEXT_EXTS, stampName, convertTargetsFor,
} from "../lib/office";
import {
  listFiles, getFileData, addFile, deleteFileEntry, setPinned, fileToBase64, fmtSize,
  saveNote, uid, type FileMeta,
} from "../lib/store";

const GROUP_ORDER = ["Documents", "Spreadsheets", "Presentations", "Media", "Archives", "Other"];

/** Where the file list is reading from. Short enough to live in the title line. */
const SOURCE_LABEL = { phone: "On phone", app: "In app", pc: "From PC", drive: "From Drive" } as const;

function groupOf(ext: string): string {
  if (["pdf", "doc", "docx", "txt", "md", "markdown"].includes(ext)) return "Documents";
  if (["xls", "xlsx", "csv", "tsv"].includes(ext)) return "Spreadsheets";
  if (["ppt", "pptx"].includes(ext)) return "Presentations";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "mp4", "webm"].includes(ext)) return "Media";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "Archives";
  return "Other";
}

/**
 * File-type label. The extension as text is all that identifies the type;
 * the filled colour tile that once sat in front of every row repeated what
 * the metadata line already said, so only the label remains.
 */
function extLabel(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "md" || e === "markdown") return "MD";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"].includes(e)) return "IMG";
  if (["zip", "rar", "7z", "tar", "gz"].includes(e)) return "ZIP";
  return (e || "?").slice(0, 4).toUpperCase();
}

function baseName(name: string, ext: string): string {
  if (ext && name.toLowerCase().endsWith("." + ext)) return name.slice(0, name.length - ext.length - 1);
  return name;
}

export function Files() {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [open, setOpen] = useState<{ meta: FileMeta; data: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [src, setSrc] = useState<"phone" | "app" | "pc" | "drive">("phone");
  /** A device selection waiting for a Drive folder to land in: set by the
   *  lists' "Upload to Google Drive", consumed by the Drive screen. */
  const [drivePick, setDrivePick] = useState<{ path: string; name: string }[] | null>(null);
  const [picking, setPicking] = useState<FileMeta | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<FileMeta | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [imgPick, setImgPick] = useState(false);
  const [imgSel, setImgSel] = useState<string[]>([]);
  const [ocrPick, setOcrPick] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeSel, setMergeSel] = useState<string[]>([]);
  const [delPages, setDelPages] = useState<{ meta: FileMeta; total: number } | null>(null);
  const [keepSpec, setKeepSpec] = useState("");
  const [ocrFor, setOcrFor] = useState<FileMeta | null>(null);
  const [ocrProg, setOcrProg] = useState<{ p: number; stage: string } | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  /**
   * A photo or a clip opened full screen. The phone's own viewers are what a
   * tap on one promises: a photo that can be pinched, panned and swiped, a
   * clip that actually plays. The Reader handles documents; a still <img> in
   * a document pane was neither of those.
   */
  const [mediaView, setMediaView] = useState<
    { items: MediaItem[]; index: number; kind: "images" | "videos" } | null
  >(null);
  /**
   * A sticker opened from its file. WhatsApp's newer stickers are dotLottie
   * ZIPs carrying a .webp name, and those need the Lottie player rather than
   * an <img>; the bytes decide which one shows.
   */
  const [sticker, setSticker] = useState<{ name: string; data: string } | null>(null);
  /**
   * A song or a recording, opened in the audio player. `path` is the device
   * file's absolute path; app-owned sounds travel as base64 in `data`, which
   * is the only form the WebView can play them from.
   */
  const [audioView, setAudioView] = useState<
    { path: string; name: string; ext: string; size: number; lastModified: number; data?: string } | null
  >(null);
  /** The device-wide search screen, opened from the home pill. */
  const [searchOpen, setSearchOpen] = useState(false);
  /** The bin screen, and the size the home row shows — re-read on every
   *  navigation, because files can enter or leave the bin from either side. */
  const [binOpen, setBinOpen] = useState(false);
  const [binSize, setBinSize] = useState(0);
  /** The drawer, the Clean hub, and the settings sheet. */
  const [menuOpen, setMenuOpen] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cleaned, setCleaned] = useState(0);
  /** Starred (device files) and the Safe folder, with their drawer numbers. */
  const [starredOpen, setStarredOpen] = useState(false);
  const [starCount, setStarCount] = useState(0);
  const [vaultOpen, setVaultOpen] = useState<{ move: DfRecent[] } | null>(null);
  const [vaultFiles, setVaultFiles] = useState(0);
  const [vaultSize, setVaultSize] = useState(0);
  /** Bumped when a vault move empties rows a mounted category list still shows. */
  const [reloadTick, setReloadTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Where the phone view currently is. Kept as one discriminated value so
   * "go back" is always a single assignment rather than a pile of booleans
   * that can disagree with each other.
   */
  const [view, setView] = useState<
    | { kind: "home" }
    | { kind: "folder"; path: string; title: string; filter?: FilterId }
    | { kind: "category"; id: CategoryId; title: string }
    | { kind: "recent"; list: DfRecent[]; title: string }
    | { kind: "gallery"; media: "images" | "videos" }
  >({ kind: "home" });

  // Rows in a browsed folder navigate by event rather than a prop, because a
  // folder can be many levels deep and threading a callback through every level
  // of a lazy list buys nothing.
  useEffect(() => {
    const go = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      setView({ kind: "folder", path, title: path.split("/").filter(Boolean).pop() ?? "Files" });
    };
    window.addEventListener("sd-files-open", go);
    const pick = () => setShowSource(true);
    window.addEventListener("sd-files-switch", pick);
    return () => {
      window.removeEventListener("sd-files-open", go);
      window.removeEventListener("sd-files-switch", pick);
    };
  }, []);

  const refresh = async () => setFiles(await listFiles());
  useEffect(() => { void refresh(); }, []);
  // The bin row on the home screen reads a local manifest; re-reading it on
  // each navigation keeps it honest without any polling. The drawer's two
  // numbers ride the same effect — a bin restore or a Clean pass changes both.
  useEffect(() => {
    setBinSize(binBytes());
    setCleaned(cleanedBytes());
    setStarCount(starredCount());
    setVaultFiles(vaultCount());
    setVaultSize(vaultBytes());
  }, [binOpen, cleanOpen, starredOpen, vaultOpen, view]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      for (const f of Array.from(list)) {
        const b64 = await fileToBase64(f);
        await addFile(f.name, b64);
      }
      await refresh();
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  };

  const filtered = files.filter((f) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return f.name.toLowerCase().includes(q);
  });
  const grouped: Record<string, FileMeta[]> = {};
  for (const f of filtered) {
    const g = groupOf(f.ext);
    (grouped[g] ||= []).push(f);
  }

  /**
   * A photo or a clip from the storage walk, opened the way the phone opens
   * one: full screen, pinchable, streamed off its path rather than carried
   * over the bridge as base64.
   */
  const openMediaPath = (
    path: string,
    name: string,
    ext: string,
    size: number,
    lastModified: number,
    /** The Safe folder's opens pass false — see openFromVault. */
    record = true,
  ) => {
    if (record) recordOpen({ path, name, ext, size, lastModified });
    setInfo(null);
    setMediaView({
      items: [mediaItemFromPath({ path, name, ext, size, lastModified })],
      index: 0,
      kind: isVideo(ext) ? "videos" : "images",
    });
  };

  const openFile = async (m: FileMeta) => {
    const data = await getFileData(m.id);
    // A sound living inside the app plays from those bytes directly; there
    // is no path for the element to stream.
    if (isAudio(m.ext)) {
      setAudioView({
        path: "",
        name: m.name,
        ext: m.ext,
        size: m.size,
        lastModified: m.addedAt,
        data: data ?? undefined,
      });
      return;
    }
    setOpen({ meta: m, data });
  };

  /**
   * A song or a recording from the storage walk opens in the audio player,
   * streamed off its path the way photos and clips are. The Reader can only
   * ever show sound as a hex dump.
   */
  const openAudio = (
    path: string,
    name: string,
    ext: string,
    size: number,
    lastModified: number,
    /** The Safe folder's opens pass false — see openFromVault. */
    record = true,
  ) => {
    if (record && path.startsWith("/")) recordOpen({ path, name, ext, size, lastModified });
    setInfo(null);
    setAudioView({ path, name, ext, size, lastModified });
  };

  /**
   * A file read straight off the device opens through the same Reader as an
   * imported one, because the Reader only ever needed a name, an extension and
   * the bytes. Nothing downstream had to learn that this file is not in the
   * sandbox. Large files are truncated by the native side to keep the bridge
   * sane, and that is stated rather than silently swallowed.
   */
  const openDevice = (meta: FileMeta, data: string, truncated: boolean, record = true) => {
    // Every device open lands on the search screen's "Recently opened" list.
    if (record && meta.id.startsWith("/")) {
      recordOpen({ path: meta.id, name: meta.name, ext: meta.ext, size: meta.size, lastModified: meta.addedAt });
    }
    // A ".webp" that is really a dotLottie ZIP goes to the sticker player;
    // an <img> would show it as a blank page.
    if (meta.ext === "webp" && data && isZipBase64(data)) {
      setInfo(null);
      setSticker({ name: meta.name, data });
      return;
    }
    // Sound opens in the player, off its path — a device file always has
    // one, while an app-owned sound arrives here as base64 and is handed
    // over in that form instead. Recording already happened above.
    if (isAudio(meta.ext)) {
      if (meta.id.startsWith("/")) {
        openAudio(meta.id, meta.name, meta.ext, meta.size, meta.addedAt, false);
      } else {
        setInfo(null);
        setAudioView({
          path: "",
          name: meta.name,
          ext: meta.ext,
          size: meta.size,
          lastModified: meta.addedAt,
          data,
        });
      }
      return;
    }
    // Photos and clips found by the storage walk open in the full-screen
    // viewers rather than the Reader — the same surfaces the Images and
    // Videos categories use. meta.id for a device file is its absolute path.
    if (meta.id.startsWith("/") && (isImage(meta.ext) || isVideo(meta.ext))) {
      openMediaPath(meta.id, meta.name, meta.ext, meta.size, meta.addedAt, record);
      return;
    }
    setInfo(
      truncated
        ? "That file is larger than 5 MB, so only the first part could be shown. Save a copy to work on it properly."
        : null
    );
    setOpen({ meta, data });
  };

  /** Tapping a card on the home screen opens the file straight away. */
  const openRecent = async (r: DfFile) => {
    setInfo(null);
    // A sticker leaves the decision to its bytes: its .webp name lies about
    // dotLottie packages, while an honest WebP streams straight off its path.
    if (r.ext === "webp") {
      const got = await readFile(r.path);
      if (got && isZipBase64(got.data)) {
        recordOpen({ path: r.path, name: r.name, ext: r.ext, size: r.size, lastModified: r.lastModified });
        setSticker({ name: r.name, data: got.data });
        return;
      }
      openMediaPath(r.path, r.name, r.ext, r.size, r.lastModified);
      return;
    }
    // A recent photo or clip never travels as base64 — it opens in the
    // viewer straight off its path.
    if (isImage(r.ext) || isVideo(r.ext)) {
      openMediaPath(r.path, r.name, r.ext, r.size, r.lastModified);
      return;
    }
    if (isAudio(r.ext)) {
      openAudio(r.path, r.name, r.ext, r.size, r.lastModified);
      return;
    }
    const got = await readFile(r.path);
    if (!got) {
      setInfo("Could not read that file. It may have moved.");
      return;
    }
    openDevice(
      { id: r.path, name: r.name, ext: r.ext, size: r.size, addedAt: r.lastModified, pinned: false },
      got.data,
      got.truncated
    );
  };

  /** The Safe folder's opener: the same routing as openRecent with every
   *  recordOpen switched off — a vaulted file must never surface in a list
   *  (search's Recently opened) that renders without the PIN. */
  const openFromVault = async (r: DfFile) => {
    setInfo(null);
    if (r.ext === "webp") {
      const got = await readFile(r.path);
      if (got && isZipBase64(got.data)) {
        setSticker({ name: r.name, data: got.data });
        return;
      }
      openMediaPath(r.path, r.name, r.ext, r.size, r.lastModified, false);
      return;
    }
    if (isImage(r.ext) || isVideo(r.ext)) {
      openMediaPath(r.path, r.name, r.ext, r.size, r.lastModified, false);
      return;
    }
    if (isAudio(r.ext)) {
      openAudio(r.path, r.name, r.ext, r.size, r.lastModified, false);
      return;
    }
    const got = await readFile(r.path);
    if (!got) {
      setInfo("Could not read that file. It may have moved.");
      return;
    }
    openDevice(
      { id: r.path, name: r.name, ext: r.ext, size: r.size, addedAt: r.lastModified, pinned: false },
      got.data,
      got.truncated,
      false,
    );
  };

  /** "Upload to Google Drive" from any device list: remember the selection,
   *  switch the source to Drive, and let that screen ask where. */
  const startDriveUpload = (list: DfRecent[]) => {
    if (!list.length) return;
    setDrivePick(list.map((f) => ({ path: f.path, name: f.name })));
    setView({ kind: "home" });
    setSrc("drive");
  };

  const remove = async (id: string) => {
    await deleteFileEntry(id);
    await refresh();
  };

  const togglePin = async (f: FileMeta) => {
    setFiles(await setPinned(f.id, !f.pinned));
  };

  const isImgExt = (e: string) => ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(e);
  const allImages = () => files.filter((f) => isImgExt(f.ext));
  const allPdfs = () => files.filter((f) => f.ext === "pdf");

  const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const runOcr = async (m: FileMeta) => {
    setOcrFor(m);
    setOcrText(null);
    setWorking("ocr");
    setInfo(null);
    try {
      const { ocrImage } = await import("../lib/office");
      const data = await getFileData(m.id);
      const text = await ocrImage(data, m.ext, (p, stage) => setOcrProg({ p, stage }));
      setOcrText(text);
    } catch (e) {
      setInfo(`Scan failed: ${fail(e)}`);
      setOcrFor(null);
    } finally {
      setWorking(null);
      setOcrProg(null);
    }
  };

  const saveOcrNote = async () => {
    if (!ocrFor || !ocrText) return;
    await saveNote(
      { id: uid(), title: `${baseName(ocrFor.name, ocrFor.ext)} scan`, folder: "General", updatedAt: Date.now() },
      ocrText
    );
    setOcrFor(null);
    setOcrText(null);
    setInfo("Scan saved to Notes.");
  };

  const makePdfFromImages = async () => {
    if (!imgSel.length) return;
    setWorking("pdf");
    setInfo(null);
    try {
      const items = [];
      for (const id of imgSel) items.push({ data: await getFileData(id) });
      const pdf = await imagesToPdf(items);
      const name = `scan-${new Date().toISOString().slice(0, 10)}-${imgSel.length}p.pdf`;
      await addFile(name, pdf);
      setImgSel([]);
      setImgPick(false);
      await refresh();
      setInfo(`PDF saved: ${name}`);
    } catch (e) {
      setInfo(`PDF failed: ${fail(e)}`);
    } finally {
      setWorking(null);
    }
  };

  const doMerge = async () => {
    if (mergeSel.length < 2) {
      setInfo("Pick at least 2 PDFs to merge.");
      return;
    }
    setWorking("merge");
    try {
      const datas = [];
      for (const id of mergeSel) datas.push(await getFileData(id));
      const out = await mergePdfs(datas);
      const name = `merged-${Date.now().toString(36)}.pdf`;
      await addFile(name, out);
      setMergeSel([]);
      setMerging(false);
      await refresh();
      setInfo(`Merged PDF saved: ${name}`);
    } catch (e) {
      setInfo(`Merge failed: ${fail(e)}`);
    } finally {
      setWorking(null);
    }
  };

  const doExtract = async (m: FileMeta) => {
    setWorking("extract");
    setInfo(null);
    try {
      const data = await getFileData(m.id);
      const md = await extractPdfText(data, baseName(m.name, m.ext));
      await saveNote(
        { id: uid(), title: `${baseName(m.name, m.ext)} text`, folder: "General", updatedAt: Date.now() },
        md
      );
      setInfo("PDF text saved to Notes.");
    } catch (e) {
      setInfo(`Extract failed: ${fail(e)}`);
    } finally {
      setWorking(null);
    }
  };

  const openDelPages = async (m: FileMeta) => {
    setInfo(null);
    try {
      const data = await getFileData(m.id);
      const total = await pdfPageCount(data);
      setKeepSpec(`1-${total}`);
      setDelPages({ meta: m, total });
    } catch (e) {
      setInfo(`Could not open PDF: ${fail(e)}`);
    }
  };

  const doDeletePages = async () => {
    if (!delPages) return;
    const keep = parseKeepSpec(keepSpec, delPages.total);
    if (!keep.length) {
      setInfo("Nothing to keep. Check the page list.");
      return;
    }
    setWorking("pages");
    try {
      const data = await getFileData(delPages.meta.id);
      const out = await keepPdfPages(data, keep);
      const name = stampName(delPages.meta.name, `(p${keep[0]}-${keep[keep.length - 1]})`);
      await addFile(name, out);
      setDelPages(null);
      await refresh();
      setInfo("New PDF saved. Original untouched.");
    } catch (e) {
      setInfo(`Edit failed: ${fail(e)}`);
    } finally {
      setWorking(null);
    }
  };

  const copyToNote = async (m: FileMeta) => {
    setWorking("note");
    setInfo(null);
    try {
      const data = await getFileData(m.id);
      const text = await fileToNoteMarkdown(m.name, m.ext, data);
      await saveNote(
        { id: uid(), title: noteTitleFor(m.name, m.ext), folder: "General", updatedAt: Date.now(), originFileId: m.id, originExt: m.ext },
        text
      );
      setInfo("Copied to Notes. Edit there freely.");
    } catch (e) {
      setInfo(`Copy failed: ${fail(e)}`);
    } finally {
      setWorking(null);
    }
  };

  const sheetRows = (f: FileMeta) => {
    const rows = [{ id: "open", label: "Open" }];
    if (f.ext === "pdf") {
      rows.push(
        { id: "extract", label: "Extract text to note" },
        { id: "pages", label: "Delete pages…" },
        { id: "merge", label: "Merge PDFs…" }
      );
    }
    if (isImgExt(f.ext)) rows.push({ id: "ocr", label: "Scan text (OCR)" });
    if (f.ext === "docx" || TEXT_EXTS.has(f.ext)) rows.push({ id: "copy", label: "Copy to editable note" });
    if (convertTargetsFor(f.ext).length) rows.push({ id: "convert", label: "Convert…" });
    rows.push(
      { id: "pin", label: f.pinned ? "Unpin from Notes" : "Pin to Notes" },
      { id: "send", label: "Send to PC" },
      { id: "share", label: "Share with friends" }
    );
    return rows;
  };

  const sheetAct = async (id: string) => {
    const f = menuFor;
    setMenuFor(null);
    if (!f) return;
    if (id === "open") void openFile(f);
    else if (id === "pin") void togglePin(f);
    else if (id === "send") { setInfo(null); setPicking(f); }
    else if (id === "share") {
      try {
        await shareFileData(f.name, await getFileData(f.id), baseName(f.name, f.ext));
      } catch (e) {
        setInfo(`Share failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    else if (id === "extract") void doExtract(f);
    else if (id === "pages") void openDelPages(f);
    else if (id === "merge") { setMergeSel([f.id]); setMerging(true); }
    else if (id === "ocr") void runOcr(f);
    else if (id === "copy") void copyToNote(f);
    else if (id === "convert") {
      window.dispatchEvent(new CustomEvent("sd-tab", { detail: { tab: "tools" } }));
      window.dispatchEvent(new CustomEvent("sd-convert", { detail: { convertFileId: f.id } }));
    }
  };

  const doPush = async (meta: FileMeta, folder: string) => {    setInfo(null);
    try {
      const b = loadBridge();
      if (!b.url || !b.token) throw new Error("Connect your PC first: Ask tab, gear icon, Scan QR.");
      const data = await getFileData(meta.id);
      const r = await pcPush(b.url, b.token, folder, meta.name, data);
      setPicking(null);
      setInfo(`Sent to PC: ${r.saved}`);
    } catch (e) {
      setInfo(e instanceof Error && e.message === "PC_AUTH"
        ? "Token rejected. Rescan the QR: Ask tab, gear icon, Scan QR."
        : `Send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Source lives in the title line, not in a row of its own. Three
          underlined tabs spent a whole band of vertical space on a choice you
          make a couple of times a session, and squeezed the list underneath.
          The name sits where you can read it, so the screen still says which
          source you are looking at, and it opens the same picker as the dock
          long press rather than being the only way in. */}
      <div className="relative flex shrink-0 items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
        {/* The drawer's handle, in the corner Google keeps it. Clean, Bin and
            Settings live behind it so the list gets the whole column. */}
        <button
          onClick={() => setMenuOpen(true)}
          className="sd-press sd-icon -ml-2.5"
          aria-label="Open the files menu"
        >
          <Menu className="size-[22px]" style={{ color: "var(--ink-2)" }} />
        </button>
        <h2 className="flex-1 text-xl font-semibold tracking-tight">Files</h2>
        {/* The source switcher floats over the list rather than sitting in a
            row of its own, so it borrows the dock's glass. It genuinely
            overlays scrolling content, which is the only condition under which
            blur is honest here. */}
        <button
          onClick={() => setShowSource(true)}
          className="sd-glass sd-press -mr-1 flex items-center gap-1.5 rounded-full py-2.5 pl-3.5 pr-2.5"
          aria-label={`Showing ${SOURCE_LABEL[src]}. Change source`}
        >
          <span className="text-[13px]" style={{ color: "var(--ink-2)" }}>{SOURCE_LABEL[src]}</span>
          <ChevronDown className="size-3.5" style={{ color: "var(--ink-3)" }} />
        </button>
        {/* The card lives inside the relative header on purpose. Anchored to
            the page root instead, `top-full` resolves against the full-height
            column and the card lands off the bottom of the screen. */}
        {showSource && (
          <>
            {/* Tap-outside catcher. A real button, so dismissing the card is
                reachable by keyboard and screen reader and not only by a
                lucky tap on the page behind. */}
            <button
              className="fixed inset-0 z-40 cursor-default"
              aria-label="Close source menu"
              onClick={() => setShowSource(false)}
            />
            {/* A small card under the pill, not a bottom sheet. The choice is
                three items long and the pill is right there; a sheet would
                cover the list to ask a question the pill is one glance from. */}
            <div
              className="sd-glass absolute right-0 top-full z-50 mt-2 w-[216px] overflow-hidden rounded-[14px]"
              role="menu"
              aria-label="Where files come from"
            >
              {(nativeAvailable() ? (["phone", "app", "pc", "drive"] as const) : (["app", "pc"] as const)).map(
                (id) => {
                  const active = src === id;
                  return (
                    <button
                      key={id}
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        setShowSource(false);
                        setSrc(id);
                        setView({ kind: "home" });
                        if (id !== "drive") setDrivePick(null);
                      }}
                      className="flex w-full items-center gap-2.5 border-t border-line px-3.5 py-2.5 text-left first:border-t-0"
                      style={{ color: active ? "var(--ink-1)" : "var(--ink-2)" }}
                    >
                      <span className="min-w-0 flex-1 text-[14px]">{SOURCE_LABEL[id]}</span>
                      {active && <Check className="size-4 shrink-0" style={{ color: "var(--brand-ink)" }} />}
                    </button>
                  );
                }
              )}
            </div>
          </>
        )}
      </div>
      {/* Kept mounted outside every branch: the add sheet and the OCR flow both
          drive this input from the app's own copies. */}
      <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => void onPick(e)} />
      {src === "app" && (
        <>
          {/* Search plus one primary action, the same shape Notes uses. Import
              and create moved into that one sheet: three filled buttons above
              the list was three primary actions, and the source of a file is a
              choice made once, not a control re-tapped every visit. */}
          <div className="flex items-center gap-2.5 px-4 pt-4 shrink-0">
            <div
              className="flex flex-1 items-center gap-2.5 rounded-full bg-surface-2 pl-4 pr-1.5 focus-within:ring-1 focus-within:ring-brand/40"
              style={{ height: 48 }}
            >
              <Search className="size-[18px] shrink-0" style={{ color: "var(--ink-2)" }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search files"
                aria-label="Search files"
                className="flex-1 min-w-0 bg-transparent text-[15px] outline-none placeholder:text-ink-2"
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="Clear search" className="sd-press grid size-9 shrink-0 place-items-center">
                  <X className="size-4" style={{ color: "var(--ink-2)" }} />
                </button>
              )}
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="sd-press flex size-11 shrink-0 items-center justify-center rounded-full"
              style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
              aria-label="Add a file"
            >
              <Plus className="size-5" />
            </button>
          </div>
        </>
      )}
      {info && (
        <div className="mx-3 mb-1 px-3 py-2 rounded-card bg-brand-soft border border-brand/30 text-xs">
          {info}
        </div>
      )}
      {src === "drive" ? (
        <DriveBrowser pickFiles={drivePick} onPicked={() => setDrivePick(null)} />
      ) : src === "pc" ? (
        <PcBrowser onPulled={refresh} />
      ) : src === "phone" ? (
        view.kind === "home" ? (
          <FilesHome
            onOpenFile={(r) => void openRecent(r)}
            onSeeAll={(list, title) => setView({ kind: "recent", list, title })}
            onOpenCategory={(id) =>
              // Images and Videos are not folders. /sdcard/Pictures holds a
              // fraction of the photos on the phone and /sdcard/Movies almost
              // none of the videos, because Camera, WhatsApp, Telegram and
              // Downloads all write to their own directories. Opening a single
              // directory is why "Videos" used to show one file on a phone full
              // of them. MediaStore already knows about every photo and video
              // regardless of where it lives, so those two go to the gallery —
              // and the rest open a category list with the same idea behind
              // it: one aggregated walk over the whole storage, not one folder.
              id === "images" || id === "videos"
                ? setView({ kind: "gallery", media: id })
                : setView({ kind: "category", id, title: CATEGORY_LABEL[id] })
            }
            onOpenStorage={() =>
              setView({ kind: "folder", path: "/sdcard", title: "Internal storage" })
            }
            onOpenStarred={() => setStarredOpen(true)}
            starredCount={starCount}
            onSearch={() => setSearchOpen(true)}
          />
        ) : view.kind === "folder" ? (
          <DeviceBrowser
            path={view.path}
            title={view.title}
            fixedFilter={view.filter}
            onOpen={openDevice}
            onBack={() => setView({ kind: "home" })}
            onDriveUpload={startDriveUpload}
          />
        ) : view.kind === "category" ? (
          <CategoryList
            key={`cat-${reloadTick}`}
            id={view.id}
            title={view.title}
            onOpen={openDevice}
            onBack={() => setView({ kind: "home" })}
            onVault={(list) => setVaultOpen({ move: list })}
            onDriveUpload={startDriveUpload}
          />
        ) : view.kind === "recent" ? (
          <DeviceBrowser
            path={null}
            title={view.title}
            fixedRecent={view.list}
            onOpen={openDevice}
            onBack={() => setView({ kind: "home" })}
            onDriveUpload={startDriveUpload}
          />
        ) : null
      ) : (
      <div className="sd-fade-in flex-1 overflow-y-auto px-4 pt-2 pb-32">
        {filtered.length === 0 && (
          <EmptyState variant="files" title={query ? "No matches" : "No files yet"} hint={query ? "Try a different search." : "Import study material, or pull it from your PC."} />
        )}
        {GROUP_ORDER.map((g) => {
          const items = grouped[g] || [];
          if (!items.length) return null;
          return (
            <section key={g} className="mt-6 first:mt-1">
              {/* Quiet and sentence case, set far enough below in tone that it
                  can never be read as a row. The old all-caps tracked heading
                  shouted at the same volume as the filenames under it. */}
              <h3 className="mb-1.5 text-[12px] font-medium" style={{ color: "var(--ink-3)" }}>
                {g} <span className="tnum">{items.length}</span>
              </h3>
              {items.map((f, i) => {
                const label = extLabel(f.ext);
                return (
                  <button
                    key={f.id}
                    onClick={() => void openFile(f)}
                    onContextMenu={(e) => {
                      // The row menu lives behind a long press, as it does in
                      // Notes. A "…" on every file was a control repeated per
                      // row for something you use once in twenty opens.
                      e.preventDefault();
                      setMenuFor(f);
                    }}
                    className="sd-tap flex w-full items-center gap-3 py-2.5 text-left"
                    style={{ borderTop: i > 0 ? "1px solid var(--line)" : "none" }}
                  >
                    {/* The extension as text in the metadata line, not a
                        filled tile. The tile was the same tell as the tool
                        grid, and it repeated the extension the metadata
                        already said. */}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] leading-tight text-ink-1">
                        {baseName(f.name, f.ext)}
                      </span>
                      <span className="tnum mt-0.5 block truncate text-[13px] text-ink-2">
                        {label} • {fmtSize(f.size)}
                        {f.pinned ? " • In Notes" : ""}
                      </span>
                    </span>
                  </button>
                );
              })}
            </section>
          );
        })}
      </div>
      )}
      {menuFor && (
        <DragSheet label={`Actions for ${menuFor.name}`} onClose={() => setMenuFor(null)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 truncate text-[15px] font-medium text-ink-1">{menuFor.name}</div>
            <div className="tnum text-[13px] text-ink-3">{fmtSize(menuFor.size)}</div>
            {/* Plain rows, not a stack of bordered cards. Nine actions each in
                its own box was a wall of rectangles, and it left "Open" —
                the one you tap almost every time — carrying exactly the same
                weight as "Delete pages…". */}
            <div className="mt-4">
              {sheetRows(menuFor).map((a) => (
                <button
                  key={a.id}
                  onClick={() => void sheetAct(a.id)}
                  className="sd-press w-full border-t border-line py-3.5 text-left text-[15px] text-ink-1"
                >
                  {a.label}
                </button>
              ))}
              {/* Destructive, last, and quiet: a hairline above it and red
                  text. A full-width red block shouts louder than the thing it
                  does. */}
              <button
                onClick={() => { const f = menuFor; setMenuFor(null); if (f) void remove(f.id); }}
                className="sd-press w-full border-t border-line py-3.5 text-left text-[15px] font-medium"
                style={{ color: "var(--att-critical-text)" }}
              >
                Delete from phone
              </button>
            </div>
          </div>
        </DragSheet>
      )}
      {showCreate && (
        <DragSheet label="Add a file" onClose={() => setShowCreate(false)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 text-[15px] font-medium text-ink-1">Add a file</div>
            <div className="text-[13px] text-ink-3">Everything stays on this phone.</div>
            <div className="mt-4">
              <button
                onClick={() => { setShowCreate(false); inputRef.current?.click(); }}
                disabled={busy}
                className="sd-press flex w-full items-center gap-3.5 border-t border-line py-3.5 text-left disabled:opacity-60"
              >
                <Upload className="size-[18px] shrink-0" style={{ color: "var(--ink-3)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] text-ink-1">{busy ? "Importing…" : "Import from phone"}</span>
                  <span className="mt-0.5 block text-[13px] text-ink-2">pdf, md, docx, pptx, xlsx</span>
                </span>
              </button>
              <button
                onClick={() => { setShowCreate(false); setImgSel([]); setImgPick(true); }}
                className="sd-press flex w-full items-center gap-3.5 border-t border-line py-3.5 text-left"
              >
                <FilePlus2 className="size-[18px] shrink-0" style={{ color: "var(--ink-3)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] text-ink-1">PDF from images</span>
                  <span className="mt-0.5 block text-[13px] text-ink-2">Pick photos, they become pages</span>
                </span>
              </button>
              <button
                onClick={() => { setShowCreate(false); setOcrPick(true); }}
                className="sd-press flex w-full items-center gap-3.5 border-t border-line py-3.5 text-left"
              >
                <ScanText className="size-[18px] shrink-0" style={{ color: "var(--ink-3)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] text-ink-1">Scan text (OCR)</span>
                  <span className="mt-0.5 block text-[13px] text-ink-2">Read a book page into a note</span>
                </span>
              </button>
            </div>
          </div>
        </DragSheet>
      )}
      {/* The gallery is an overlay rather than another branch of the view
          chain below, because it is a full-screen surface with its own header
          and its own viewer — it does not share the Files chrome, and when it
          closes the home screen underneath must still be exactly as it was. */}
      {view.kind === "gallery" && (
        <MediaGallery kind={view.media} onClose={() => setView({ kind: "home" })} />
      )}
      {/* The search screen is an overlay for the same reason the gallery is:
          a full-screen surface with its own chrome, and the home screen under
          it must be untouched when it closes. Results open through the same
          path a recent card uses, so stickers, photos and documents all land
          on the right viewer. */}
      {searchOpen && (
        <DeviceSearch onClose={() => setSearchOpen(false)} onOpen={(r) => void openRecent(r)} />
      )}
      {binOpen && <BinScreen onClose={() => setBinOpen(false)} />}
      {cleanOpen && (
        <CleanScreen
          onClose={() => setCleanOpen(false)}
          onOpenList={(list, title) => {
            setCleanOpen(false);
            setView({ kind: "recent", list, title });
          }}
          onOpenBin={() => {
            setCleanOpen(false);
            setBinOpen(true);
          }}
        />
      )}
      {starredOpen && (
        <StarredScreen onClose={() => setStarredOpen(false)} onOpen={(e) => void openRecent(e)} />
      )}
      {vaultOpen && (
        <VaultScreen
          intent={vaultOpen.move}
          onClose={(moved) => {
            setVaultOpen(null);
            if (moved > 0) setReloadTick((t) => t + 1);
          }}
          onOpen={(e) => void openFromVault(e)}
        />
      )}
      {menuOpen && (
        <FilesMenu
          onClose={() => setMenuOpen(false)}
          cleanedBytes={cleaned}
          binSize={binSize}
          vaultCount={vaultFiles}
          vaultBytes={vaultSize}
          onClean={() => {
            setMenuOpen(false);
            setCleanOpen(true);
          }}
          onBin={() => {
            setMenuOpen(false);
            setBinOpen(true);
          }}
          onVault={() => {
            setMenuOpen(false);
            setVaultOpen({ move: [] });
          }}
          onSettings={() => {
            setMenuOpen(false);
            setSettingsOpen(true);
          }}
        />
      )}
      {settingsOpen && (
        <FilesSettings
          onClose={() => setSettingsOpen(false)}
          onOpenBin={() => {
            setSettingsOpen(false);
            setBinOpen(true);
          }}
        />
      )}
      {imgPick && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <header className="px-4 pb-3 shrink-0 border-b border-line pt-[max(30px,env(safe-area-inset-top))]">
            <div className="text-sm font-semibold">Pick images</div>
            <div className="tnum text-[11px] text-ink-2">Tap in page order • {imgSel.length} picked</div>
          </header>
          <div className="flex-1 overflow-y-auto px-3 py-2">
            {allImages().length === 0 && (
              <p className="text-sm text-ink-2 text-center mt-10">No images in Files yet.</p>
            )}
            {allImages().map((f) => {
              const n = imgSel.indexOf(f.id);
              return (
                <button
                  key={f.id}
                  onClick={() => setImgSel(n >= 0 ? imgSel.filter((x) => x !== f.id) : [...imgSel, f.id])}
                  className={`sd-press w-full flex items-center gap-3 rounded-card px-3 py-2.5 mb-1.5 border text-left ${n >= 0 ? "border-brand/60 bg-brand-soft" : "border-line bg-surface-1"}`}
                >
                  <span className={`tnum size-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${n >= 0 ? "bg-brand text-background" : "bg-surface-3 text-ink-2"}`}>
                    {n >= 0 ? n + 1 : ""}
                  </span>
                  <span className="flex-1 min-w-0 text-sm truncate">{f.name}</span>
                </button>
              );
            })}
          </div>
          <div className="p-3 flex gap-2 shrink-0 border-t border-line">
            <button onClick={() => { setImgPick(false); setImgSel([]); }} className="sd-press flex-1 py-3 rounded-card bg-surface-3 text-sm font-semibold">
              Cancel
            </button>
            <button onClick={() => void makePdfFromImages()} disabled={!imgSel.length || working === "pdf"} className="sd-press flex-1 py-3 rounded-card bg-brand text-background text-sm font-semibold disabled:opacity-50">
              {working === "pdf" ? "Making…" : `Make PDF (${imgSel.length})`}
            </button>
          </div>
        </div>
      )}
      {ocrPick && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <header className="px-4 pb-3 shrink-0 border-b border-line pt-[max(30px,env(safe-area-inset-top))]">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <div className="text-sm font-semibold">Pick a photo to scan</div>
                <div className="text-[11px] text-ink-2">First run downloads the reader once</div>
              </div>
              <button onClick={() => setOcrPick(false)} className="sd-press sd-icon" aria-label="Close">
                <X className="size-4" />
              </button>
            </div>
          </header>
          <div className="flex-1 overflow-y-auto px-3 py-2">
            {allImages().length === 0 && (
              <p className="text-sm text-ink-2 text-center mt-10">No images in Files yet.</p>
            )}
            {allImages().map((f) => (
              <button
                key={f.id}
                onClick={() => { setOcrPick(false); void runOcr(f); }}
                className="sd-press w-full text-left rounded-card px-3.5 py-3 mb-1.5 border border-line bg-surface-1 text-sm truncate"
              >
                {f.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {ocrFor && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <header className="px-4 pb-3 shrink-0 border-b border-line pt-[max(30px,env(safe-area-inset-top))]">
            <div className="text-sm font-semibold truncate">Scan: {ocrFor.name}</div>
            <div className="text-[11px] text-ink-2">
              {ocrText ? `${ocrText.length} characters read` : ocrProg ? ocrProg.stage : "Starting…"}
            </div>
          </header>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {ocrText ? (
              <pre className="text-sm whitespace-pre-wrap font-sans">{ocrText}</pre>
            ) : (
              <div className="flex flex-col items-center mt-10">
                <div className="w-full max-w-[240px] h-2 rounded-full bg-surface-3 overflow-hidden">
                  <div
                    className="h-full bg-brand rounded-full transition-all"
                    style={{ width: `${Math.round((ocrProg?.p || 0) * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-ink-2 mt-3">{ocrProg?.stage || "Starting…"}</p>
              </div>
            )}
          </div>
          <div className="p-3 flex gap-2 shrink-0 border-t border-line">
            <button onClick={() => { setOcrFor(null); setOcrText(null); }} className="sd-press flex-1 py-3 rounded-card bg-surface-3 text-sm font-semibold">
              Close
            </button>
            {ocrText && (
              <button onClick={() => void saveOcrNote()} className="sd-press flex-1 py-3 rounded-card bg-brand text-background text-sm font-semibold">
                Save as note
              </button>
            )}
          </div>
        </div>
      )}
      {merging && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <header className="px-4 pb-3 shrink-0 border-b border-line pt-[max(30px,env(safe-area-inset-top))]">
            <div className="text-sm font-semibold">Merge PDFs</div>
            <div className="tnum text-[11px] text-ink-2">Tap in order • {mergeSel.length} picked</div>
          </header>
          <div className="flex-1 overflow-y-auto px-3 py-2">
            {allPdfs().map((f) => {
              const n = mergeSel.indexOf(f.id);
              return (
                <button
                  key={f.id}
                  onClick={() => setMergeSel(n >= 0 ? mergeSel.filter((x) => x !== f.id) : [...mergeSel, f.id])}
                  className={`sd-press w-full flex items-center gap-3 rounded-card px-3 py-2.5 mb-1.5 border text-left ${n >= 0 ? "border-brand/60 bg-brand-soft" : "border-line bg-surface-1"}`}
                >
                  <span className={`tnum size-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${n >= 0 ? "bg-brand text-background" : "bg-surface-3 text-ink-2"}`}>
                    {n >= 0 ? n + 1 : ""}
                  </span>
                  <span className="flex-1 min-w-0 text-sm truncate">{f.name}</span>
                </button>
              );
            })}
          </div>
          <div className="p-3 flex gap-2 shrink-0 border-t border-line">
            <button onClick={() => { setMerging(false); setMergeSel([]); }} className="sd-press flex-1 py-3 rounded-card bg-surface-3 text-sm font-semibold">
              Cancel
            </button>
            <button onClick={() => void doMerge()} disabled={mergeSel.length < 2 || working === "merge"} className="sd-press flex-1 py-3 rounded-card bg-brand text-background text-sm font-semibold disabled:opacity-50">
              {working === "merge" ? "Merging…" : "Merge"}
            </button>
          </div>
        </div>
      )}
      {delPages && (
        <DragSheet label="Keep pages" onClose={() => setDelPages(null)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 text-[15px] font-medium text-ink-1">Keep pages</div>
            <div className="text-[13px] text-ink-3">{delPages.total} pages total. The rest move to a new file.</div>
            <div className="mt-4 flex items-center gap-2">
              <input
                value={keepSpec}
                onChange={(e) => setKeepSpec(e.target.value)}
                placeholder="e.g. 1-3,5"
                aria-label="Pages to keep"
                className="flex-1 min-w-0 rounded-[6px] bg-surface-2 border border-line px-3 py-2.5 text-[15px] outline-none focus:border-brand placeholder:text-ink-2"
              />
              <button
                onClick={() => void doDeletePages()}
                disabled={working === "pages"}
                className="sd-press h-[46px] shrink-0 rounded-[8px] px-5 text-[15px] font-semibold disabled:opacity-50"
                style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
              >
                {working === "pages" ? "…" : "Apply"}
              </button>
            </div>
          </div>
        </DragSheet>
      )}
      {picking && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <header className="flex items-center gap-2 px-3 pb-2.5 border-b border-line shrink-0 bg-background pt-[max(30px,env(safe-area-inset-top))]">
            <button onClick={() => setPicking(null)} className="sd-press sd-icon -ml-1.5" aria-label="Close">
              <X className="size-5" />
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">Send to PC</div>
              <div className="text-[11px] text-ink-2 truncate">{picking.name}</div>
            </div>
          </header>
          <PcBrowser onPulled={refresh} pickName={picking.name} onPick={(folder) => void doPush(picking, folder)} />
        </div>
      )}
      {open && <Reader file={open.meta} base64={open.data} onClose={() => setOpen(null)} />}
      {mediaView?.kind === "images" && (
        <ImageViewer
          items={mediaView.items}
          index={mediaView.index}
          onIndexChange={(i) => setMediaView((v) => (v ? { ...v, index: i } : v))}
          onClose={() => setMediaView(null)}
        />
      )}
      {mediaView?.kind === "videos" && (
        <VideoPlayer
          items={mediaView.items}
          index={mediaView.index}
          onIndexChange={(i) => setMediaView((v) => (v ? { ...v, index: i } : v))}
          onClose={() => setMediaView(null)}
        />
      )}
      {sticker && (
        <StickerViewer name={sticker.name} data={sticker.data} onClose={() => setSticker(null)} />
      )}
      {audioView && (
        <AudioPlayer
          path={audioView.path}
          name={audioView.name}
          ext={audioView.ext}
          size={audioView.size}
          lastModified={audioView.lastModified}
          data={audioView.data}
          onClose={() => setAudioView(null)}
        />
      )}
    </div>
  );
}

export function PcBrowser({ onPulled, pickName, onPick, compact }: { onPulled: () => void; pickName?: string; onPick?: (folder: string) => void; compact?: boolean }) {
  const [cwd, setCwd] = useState<string | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [entries, setEntries] = useState<PcEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const load = async (p: string | null) => {
    setErr(null);
    try {
      const b = loadBridge();
      if (!b.url || !b.token) throw new Error("Set bridge URL + token in Ask PC → gear icon first.");
      const r = await pcBrowse(b.url, b.token, p);
      setRoots(r.roots || []);
      setEntries(r.entries || []);
      setCwd(r.cwd || null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { void load(null); }, []);

  const up = () => {
    if (!cwd) return;
    const i = Math.max(cwd.lastIndexOf("\\"), cwd.lastIndexOf("/"));
    void load(i > 2 ? cwd.slice(0, i) : null);
  };

  const pull = async (e: PcEntry) => {
    setBusyPath(e.path);
    setErr(null);
    try {
      const b = loadBridge();
      const f = await pcPull(b.url, b.token, e.path);
      await addFile(f.name, f.data);
      onPulled();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <div className={`flex-1 overflow-y-auto flex flex-col ${compact ? "px-1 pb-1" : "px-3 pb-24"}`}>
      <div className="flex flex-wrap gap-1.5 py-1">
        {roots.map((r) => (
          <button key={r} onClick={() => void load(r)} className="sd-press px-2.5 py-1 rounded-md bg-surface-3 text-[11px] font-mono truncate max-w-full">
            {r}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 py-1">
        <button onClick={up} disabled={!cwd} className="sd-press flex items-center gap-1 px-2.5 py-1 rounded-md bg-surface-3 text-[11px] disabled:opacity-40">
          <ChevronLeft className="size-3.5" /> Up
        </button>
        <span className="flex-1 text-[11px] text-ink-2 font-mono truncate">{cwd || "roots"}</span>
      </div>
      {pickName && (
        <button
          onClick={() => cwd && onPick?.(cwd)}
          disabled={!cwd}
          className="sd-press w-full py-2.5 mb-1 rounded-card bg-brand text-background text-sm font-semibold disabled:opacity-40"
        >
          Save "{pickName}" in this folder
        </button>
      )}
      {err && (
        <p className="text-xs text-critical py-1">!{" "}
          {err === "PC_AUTH"
            ? "Token rejected. Rescan the QR: Ask tab, gear icon, Scan QR."
            : `${err} (PC off or bridge not running?)`}
        </p>
      )}
      {entries.map((e) => (
        <div key={e.path} className="sd-card-in flex items-center gap-3 bg-surface-1 border border-line rounded-card p-3 mb-2">
          <div className="flex-1 min-w-0" onClick={() => e.dir && void load(e.path)}>
            <div className="text-sm font-medium truncate">{e.dir ? "📁 " : ""}{e.name}</div>
            <div className="text-[11px] text-ink-2">{e.dir ? "folder" : fmtSize(e.size)}</div>
          </div>
          {!e.dir && !pickName && (
            <button
              onClick={() => void pull(e)}
              disabled={busyPath === e.path}
              className="sd-press grid size-11 shrink-0 place-items-center rounded-full bg-brand text-background disabled:opacity-60"
              aria-label="Pull to phone"
            >
              {busyPath === e.path ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            </button>
          )}
        </div>
      ))}
      {entries.length === 0 && !err && (
        <EmptyState variant="files" title="Empty folder" hint="Nothing in here." />
      )}
    </div>
  );
}
