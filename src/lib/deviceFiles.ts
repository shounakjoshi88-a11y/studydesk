/**
 * Bridge to DeviceFilesPlugin.java.
 *
 * Three access paths:
 *  - "All files access", which the user grants once in Android settings and
 *    which is what the phone's own Documents app uses. Nothing to pick, and
 *    the whole filesystem is browsable.
 *  - A single shared folder via the Storage Access Framework, offered when the
 *    user would rather not grant blanket access.
 *  - MediaStore for images and videos, because a folder walk only sees what
 *    someone remembered to put in /sdcard/Pictures while the index holds every
 *    photo the camera and the gallery have taken.
 *
 * On web and iOS none of this exists, and callers fall back to importing.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import { Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

export type DfEntry = {
  path: string;
  name: string;
  isDir: boolean;
  ext: string;
  size: number;
  lastModified: number;
  mime: string;
};

/** What a file row needs to be drawn and opened — the shared floor under
 *  DfRecent, stored recents, and anything else that holds a device file. */
export type DfFile = {
  path: string;
  name: string;
  ext: string;
  size: number;
  lastModified: number;
};

export type DfRecent = DfFile & { mime: string };

export type DfCategory = { id: CategoryId; bytes: number; count: number };
export type CategoryId = "downloads" | "images" | "videos" | "audio" | "documents" | "other";

export type Overview = {
  allFiles?: boolean;
  denied?: boolean;
  total?: number;
  categories?: DfCategory[];
  recent?: DfRecent[];
  largest?: DfRecent[];
  /** Present on cachedOverview: was there a cache to read, and when was it written. */
  hit?: boolean;
  at?: number;
  /** How long the reconciliation took, and how many directories it touched. */
  ms?: number;
  dirs?: number;
};

/** Images and videos come from one table with two faces, and the kind is what
 *  tells a row id apart from a path. */
export type MediaKind = "images" | "videos";

export type MediaItem = {
  /** MediaStore _ID, as a string because JSON numbers lose the long ones. */
  id: string;
  /** Absolute filesystem path, empty when the row is not on disk. */
  path: string;
  /** DISPLAY_NAME, which is the name the phone's own gallery shows. */
  name: string;
  size: number;
  /** Epoch milliseconds. MediaStore counts in seconds but native has already
   *  converted, so nothing multiplies by 1000 a second time. */
  lastModified: number;
  mime: string;
  width?: number;
  height?: number;
  /** Videos only, and absent on a row that carries no duration. */
  durationMs?: number;
  /** How the phone groups them: "Camera", "Screenshots", "WhatsApp Images". */
  bucket?: string;
};

interface DeviceFilesPlugin {
  hasAccess(): Promise<{ allFiles: boolean; sdk: number }>;
  volumeInfo(): Promise<{ total: number; free: number; used: number }>;
  requestAccess(): Promise<void>;
  /** Reconciles the cache against the disk, re-reading only changed folders. */
  overview(o?: { full?: boolean }): Promise<Overview>;
  /** The last reconciled answer, with no filesystem access at all. */
  cachedOverview(): Promise<Overview>;
  startWatching(): Promise<void>;
  stopWatching(): Promise<void>;
  addListener(event: "deviceFilesChanged", cb: () => void): Promise<{ remove: () => void }>;
  listDir(o: { path: string }): Promise<{ entries?: DfEntry[]; name?: string; denied?: boolean }>;
  /** One category's files, gathered across the whole storage. */
  listCategory(o: { id: CategoryId; full?: boolean }): Promise<{
    id: string;
    total: number;
    entries?: DfRecent[];
    denied?: boolean;
  }>;
  readFile(o: { path: string; maxBytes?: number }): Promise<{
    data: string;
    name: string;
    mime: string;
    truncated: boolean;
  }>;
  thumb(o: { path: string; w?: number }): Promise<{ url?: string }>;
  /** First-page preview + page count for one PDF, all native. */
  pdfThumb(o: { path: string; w?: number; page?: number }): Promise<{ url?: string; pages?: number }>;
  /** Second copy of a tool result, into the phone's public Download folder. */
  exportDownload(o: { name: string; data: string }): Promise<{ path?: string; uri?: string }>;
  /** ACTION_VIEW chooser for one file; the type is derived natively when the
   *  caller does not supply one. */
  openWith(o: { path: string; mime?: string }): Promise<void>;
  /** Rename when one volume allows it, copy-plus-delete when it does not. */
  movePath(o: { from: string; to: string }): Promise<void>;
  copyPath(o: { from: string; to: string }): Promise<void>;
  /** Device-wide name search across the category walk's own cache. */
  searchFiles(o: { query: string; kinds?: string[]; limit?: number }): Promise<{
    entries?: DfRecent[];
    total?: number;
    denied?: boolean;
  }>;
  /** The Clean hub's one scan: junk, month-old Download/Screenshots files, and
   *  same-content duplicates, all off the category walk's cache. */
  cleanScan(): Promise<{
    junk?: { entries?: DfRecent[]; bytes?: number };
    old?: { entries?: DfRecent[]; bytes?: number };
    dupes?: { groups?: { hash: string; size: number; files: DfRecent[] }[]; files?: number; bytes?: number };
    denied?: boolean;
  }>;
  /** Android's own storage page, for the Clean screen's volume card. */
  openStorageSettings(): Promise<void>;
  /** One stat per path, aligned with the request; missing files answer false. */
  statPaths(o: { paths: string[] }): Promise<{
    items?: { exists: boolean; size: number; lastModified: number }[];
  }>;
  /** Paged over the media index rather than a directory, because the index is
   *  the only place that knows about every photo and clip on the phone. */
  listMedia(o: { kind: MediaKind; limit?: number; offset?: number }): Promise<{
    items?: MediaItem[];
    total?: number;
  }>;
  /** Every PDF on the phone, off Android's own file index rather than a
   *  folder walk. `denied` means all-files access is off. */
  listPdfs(): Promise<{
    items?: DfRecent[];
    total?: number;
    denied?: boolean;
  }>;
  /** Resolves to a small cached file, never base64, or an empty url. */
  mediaThumb(o: { id: string; kind: MediaKind; w?: number }): Promise<{ url?: string }>;
  /** The file's own path, so a video element can stream it rather than the
   *  bytes being dragged over the bridge first. */
  mediaUrl(o: { id: string; kind: MediaKind }): Promise<{ url?: string }>;
  pickFolder(): Promise<{ cancelled: boolean; name?: string }>;
  getGrantedFolder(): Promise<{ granted: boolean; name?: string }>;
}

const DeviceFiles = registerPlugin<DeviceFilesPlugin>("DeviceFiles");

export function nativeAvailable(): boolean {
  try {
    return Capacitor.isPluginAvailable("DeviceFiles");
  } catch {
    return false;
  }
}

export const hasAllFiles = async (): Promise<boolean> => {
  if (!nativeAvailable()) return false;
  try {
    return (await DeviceFiles.hasAccess()).allFiles;
  } catch {
    return false;
  }
};

/** Opens the Android screen where "All files access" is switched on. */
export const requestAllFiles = async (): Promise<void> => {
  if (!nativeAvailable()) return;
  await DeviceFiles.requestAccess();
};

export type VolumeInfo = { total: number; free: number; used: number };

/**
 * Free and total bytes on the shared volume, straight from the kernel. The
 * Files home shows this on the storage card; nothing else needs it.
 */
export const getVolumeInfo = async (): Promise<VolumeInfo | null> => {
  if (!nativeAvailable()) return null;
  try {
    const r = await DeviceFiles.volumeInfo();
    return r.total > 0 ? r : null;
  } catch {
    return null;
  }
};

/**
 * Every file in one category, across the whole storage — the same set the
 * overview counted, so a category's size and its list can never disagree.
 * Comes back newest first; the caller re-sorts for the other orders.
 */
export const listCategory = async (
  id: CategoryId,
  full = false
): Promise<{ entries: DfRecent[]; total: number; denied: boolean }> => {
  if (!nativeAvailable()) return { entries: [], total: 0, denied: true };
  try {
    const r = await DeviceFiles.listCategory({ id, full });
    return { entries: r.entries ?? [], total: r.total ?? 0, denied: r.denied === true };
  } catch {
    return { entries: [], total: 0, denied: true };
  }
};

export const getOverview = async (opts?: { full?: boolean }): Promise<Overview> => {
  if (!nativeAvailable()) return { denied: true };
  try {
    return await DeviceFiles.overview({ full: opts?.full === true });
  } catch {
    return { denied: true };
  }
};

/**
 * The previous answer with no filesystem access whatsoever, so the Files home
 * paints on the first frame instead of after a full inventory. The numbers on
 * screen are then confirmed or corrected by getOverview(), which only has to
 * look at folders whose contents actually changed.
 */
export const getCachedOverview = async (): Promise<Overview | null> => {
  if (!nativeAvailable()) return null;
  try {
    const r = await DeviceFiles.cachedOverview();
    return r.hit === true ? r : null;
  } catch {
    return null;
  }
};

/**
 * MediaStore pushes a notification the instant a photo, video or sound file
 * changes, which is the same feed Google Files listens on. Documents are not
 * indexed by MediaStore, so this covers the media half of the problem and
 * getOverview() covers the rest.
 */
export const startWatching = async (): Promise<void> => {
  if (!nativeAvailable()) return;
  try {
    await DeviceFiles.startWatching();
  } catch {
    /* watching is an optimisation, never a requirement */
  }
};

export const stopWatching = async (): Promise<void> => {
  if (!nativeAvailable()) return;
  try {
    await DeviceFiles.stopWatching();
  } catch {
    /* already gone */
  }
};

/** Subscribe to change pushes. Returns an unsubscribe function. */
export const onFilesChanged = (cb: () => void): (() => void) => {
  if (!nativeAvailable()) return () => {};
  let handle: { remove: () => void } | null = null;
  let cancelled = false;
  void DeviceFiles.addListener("deviceFilesChanged", cb).then((h) => {
    if (cancelled) h.remove();
    else handle = h;
  });
  return () => {
    cancelled = true;
    handle?.remove();
  };
};

export const getDir = async (
  path: string
): Promise<{ entries: DfEntry[]; name: string; denied: boolean }> => {
  if (!nativeAvailable()) return { entries: [], name: "", denied: true };
  try {
    const r = await DeviceFiles.listDir({ path });
    return { entries: r.entries ?? [], name: r.name ?? "", denied: r.denied === true };
  } catch {
    return { entries: [], name: "", denied: true };
  }
};

/**
 * Capped so a 200 MB video cannot be dragged across the bridge as a base64
 * string. Native truncates and says so rather than failing outright.
 */
export const readFile = async (
  path: string,
  maxBytes = 5 * 1024 * 1024
): Promise<{ data: string; name: string; mime: string; truncated: boolean } | null> => {
  if (!nativeAvailable()) return null;
  try {
    return await DeviceFiles.readFile({ path, maxBytes });
  } catch {
    return null;
  }
};

/**
 * Thumbnails come back as a cached file path, not base64, and are turned into
 * something the WebView can load. A dozen photos as base64 would be megabytes
 * of JSON strings fighting the rest of the app for the WebView heap.
 */
/**
 * Thumbnails are decoded natively, and a screen of tiles asks for twenty of
 * them the moment it scrolls into view. Twenty parallel decodes on a phone is
 * exactly what turns a flick into a stutter, so bridge thumb calls are queued
 * a few deep: enough to keep the pipeline busy, few enough that the main
 * thread still has a core to draw with.
 */
const THUMB_PARALLEL = 4;
let thumbsRunning = 0;
const thumbQueue: Array<() => void> = [];
function queuedThumb<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      thumbsRunning += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          thumbsRunning -= 1;
          const next = thumbQueue.shift();
          if (next) next();
        });
    };
    if (thumbsRunning < THUMB_PARALLEL) run();
    else thumbQueue.push(run);
  });
}

const thumbCache = new Map<string, string>();
export const thumbUrl = async (path: string, w = 320): Promise<string | null> => {
  const key = `${path}|${w}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  if (!nativeAvailable()) return null;
  try {
    const r = await queuedThumb(() => DeviceFiles.thumb({ path, w }));
    if (!r.url) return null;
    const url = Capacitor.convertFileSrc(r.url);
    thumbCache.set(key, url);
    return url;
  } catch {
    return null;
  }
};

/** Tool reads are deliberate and one-at-a-time; this is the biggest file the
 *  bridge will carry whole (native clamps its own ceiling a little higher). */
export const TOOL_READ_MAX = 44 * 1024 * 1024;

const pdfThumbCache = new Map<string, { url: string | null; pages: number }>();

/**
 * A PDF row wants two facts before it can be drawn: what a page looks like,
 * and how many pages there are. Both come from one native PdfRenderer pass,
 * cached beside the image thumbs — a 20 MB scan never crosses the bridge to
 * answer either question. `page` is zero-based and rides in the cache key, so
 * the merge screen's page shuffle can ask for any page it is showing.
 */
export const pdfThumb = async (
  path: string,
  w = 320,
  page = 0
): Promise<{ url: string | null; pages: number }> => {
  const key = `${path}|${w}|${page}`;
  const hit = pdfThumbCache.get(key);
  if (hit) return hit;
  if (!nativeAvailable()) return { url: null, pages: 0 };
  try {
    const r = await queuedThumb(() => DeviceFiles.pdfThumb({ path, w, page }));
    const out = { url: r.url ? Capacitor.convertFileSrc(r.url) : null, pages: r.pages ?? 0 };
    if (out.url || out.pages) pdfThumbCache.set(key, out);
    return out;
  } catch {
    return { url: null, pages: 0 };
  }
};

/**
 * Hands a finished result to the phone's own storage — a second copy in
 * public Download/StudyDesk, where every file manager, chat app and browser
 * can see it. The in-app copy stays the source of truth; this only makes the
 * result feel like it actually landed on the phone. Resolves to the visible
 * path, or null when there is no native side or the write was refused.
 */
export const exportToDownloads = async (name: string, data: string): Promise<string | null> => {
  if (!nativeAvailable()) return null;
  try {
    const r = await DeviceFiles.exportDownload({ name, data });
    if (typeof r.path === "string") {
      // The Files home listens for this. Native pushes its own event too; the
      // two together cover both a mounted listener and a MediaStore observer
      // that never saw the insert.
      window.dispatchEvent(new Event("sd-files-changed"));
      return r.path;
    }
    return null;
  } catch {
    return null;
  }
};

export const pickSharedFolder = async (): Promise<{ cancelled: boolean; name?: string }> => {
  if (!nativeAvailable()) return { cancelled: true };
  try {
    return await DeviceFiles.pickFolder();
  } catch {
    return { cancelled: true };
  }
};

export const getSharedFolder = async (): Promise<{ granted: boolean; name?: string }> => {
  if (!nativeAvailable()) return { granted: false };
  try {
    return await DeviceFiles.getGrantedFolder();
  } catch {
    return { granted: false };
  }
};

// ── media ────────────────────────────────────────────────

/**
 * A gallery has to survive a broken row, a revoked permission and an id the
 * index no longer recognises, so nothing on this path throws: a query that
 * fails comes back as an empty page rather than an exception under the grid.
 */
export const listMedia = async (
  kind: MediaKind,
  limit = 200,
  offset = 0
): Promise<{ items: MediaItem[]; total: number }> => {
  if (!nativeAvailable()) return { items: [], total: 0 };
  try {
    const r = await DeviceFiles.listMedia({ kind, limit, offset });
    return { items: r.items ?? [], total: r.total ?? 0 };
  } catch {
    return { items: [], total: 0 };
  }
};

/**
 * Every PDF on the device, off Android's own file index. The difference is
 * not a nicety: a folder walk found four PDFs on a phone that has seventeen
 * hundred, because chat apps park documents under Android/media/…, browsers
 * download wherever, and a walk fails quiet on the directories it cannot
 * open. `denied` means all-files access is off, so callers show the grant
 * card instead of a misleading "no PDFs".
 */
export const listPdfs = async (): Promise<{ items: DfRecent[]; denied: boolean }> => {
  if (!nativeAvailable()) return { items: [], denied: false };
  try {
    const r = await DeviceFiles.listPdfs();
    const items = (r.items ?? []).map((it) => {
      const dot = it.name.lastIndexOf(".");
      return { ...it, ext: dot >= 0 ? it.name.slice(dot + 1).toLowerCase() : "" };
    });
    return { items, denied: !!r.denied };
  } catch {
    return { items: [], denied: false };
  }
};

/**
 * MediaStore knows the row's kind and a MediaItem does not carry it, so mime
 * decides. A row that came back without one still has a duration to go on.
 */
const kindOf = (item: MediaItem): MediaKind => {
  if (item.mime) return item.mime.startsWith("video/") ? "videos" : "images";
  return item.durationMs ? "videos" : "images";
};

/**
 * Mime by extension, for files that never went through MediaStore. Small on
 * purpose: only the prefix (image/ or video/) is load-bearing here; the rest
 * is a label the decoder re-derives from the bytes anyway.
 */
const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
  avi: "video/x-msvideo", webm: "video/webm", "3gp": "video/3gpp",
};

/**
 * A file the storage walk found, dressed as a MediaItem so the same
 * full-screen viewer opens it. MediaStore does not have to know about a file
 * for the phone's own photo surface to be the right place to open it. The
 * `path:` id prefix is what tells the resolvers below that the id is not a
 * MediaStore row and the path is the only address there is.
 */
export const mediaItemFromPath = (f: {
  path: string; name: string; ext?: string; size?: number; lastModified?: number;
}): MediaItem => {
  const ext = f.ext || f.name.slice(f.name.lastIndexOf(".") + 1).toLowerCase();
  return {
    id: `path:${f.path}`,
    path: f.path,
    name: f.name,
    size: f.size ?? 0,
    lastModified: f.lastModified ?? 0,
    mime: EXT_MIME[ext] || "",
    bucket: "",
  };
};

const isPathItem = (item: MediaItem): boolean => item.id.startsWith("path:");

/**
 * A thumbnail is a bridge call plus a disk read, and a scrolling grid asks for
 * the same row over and over. Successes live for the session; a failure lives
 * only a moment, so one unreadable row costs one call instead of one per render
 * and a row the next reload can fix is still retried.
 */
const MEDIA_MISS_TTL = 30_000;

type CachedUrl = { url: string | null; at: number };

const mediaThumbCache = new Map<string, CachedUrl>();
const mediaFullCache = new Map<string, CachedUrl>();

const cachedUrl = (cache: Map<string, CachedUrl>, key: string): CachedUrl | null => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.url === null && Date.now() - hit.at > MEDIA_MISS_TTL) {
    cache.delete(key);
    return null;
  }
  return hit;
};

/**
 * Same deal as thumbUrl, and the reason a scrolling grid feels like a grid and
 * not a stutter: the row's path is not asked about twice.
 */
export const mediaThumbUrl = async (item: MediaItem, w = 400): Promise<string | null> => {
  const key = `${item.id}|${w}`;
  const hit = cachedUrl(mediaThumbCache, key);
  if (hit) return hit.url;
  if (!nativeAvailable()) return null;
  const miss = { url: null, at: Date.now() };
  /* A path item has no MediaStore row to ask, so its thumbnail comes from the
     same native decoder the folder browser and category lists already use. */
  if (isPathItem(item)) {
    try {
      const r = await queuedThumb(() => DeviceFiles.thumb({ path: item.path, w }));
      if (!r.url) {
        mediaThumbCache.set(key, miss);
        return null;
      }
      const url = Capacitor.convertFileSrc(r.url);
      mediaThumbCache.set(key, { url, at: Date.now() });
      return url;
    } catch {
      mediaThumbCache.set(key, miss);
      return null;
    }
  }
  try {
    const r = await queuedThumb(() => DeviceFiles.mediaThumb({ id: item.id, kind: kindOf(item), w }));
    if (!r.url) {
      mediaThumbCache.set(key, miss);
      return null;
    }
    const url = Capacitor.convertFileSrc(r.url);
    mediaThumbCache.set(key, { url, at: Date.now() });
    return url;
  } catch {
    mediaThumbCache.set(key, miss);
    return null;
  }
};

/**
 * The row's own path is normally right, but a photo moved or cleaned up behind
 * the index's back leaves it stale, so the index gets the last word and the row
 * is the fallback for when the index cannot answer at all.
 */
const nativeMediaPath = async (item: MediaItem): Promise<string> => {
  // A walk-found file carries its own address; there is no row to look up.
  if (isPathItem(item)) return item.path;
  try {
    const r = await DeviceFiles.mediaUrl({ id: item.id, kind: kindOf(item) });
    if (r.url) return r.url;
  } catch {
    /* an older native build has no mediaUrl; the row still has a path */
  }
  return item.path || "";
};

/**
 * This is what a plain <img> or <video> streams from, which is why it is a
 * converted path and never base64: a 200 MB clip as a string would want a third
 * of its size again in WebView heap before the first frame.
 */
export const mediaFullUrl = async (item: MediaItem): Promise<string | null> => {
  const hit = cachedUrl(mediaFullCache, item.id);
  if (hit) return hit.url;
  if (!nativeAvailable()) return null;
  const path = await nativeMediaPath(item);
  if (!path) {
    mediaFullCache.set(item.id, { url: null, at: Date.now() });
    return null;
  }
  const url = Capacitor.convertFileSrc(path);
  mediaFullCache.set(item.id, { url, at: Date.now() });
  return url;
};

/** The share sheet and the Filesystem plugin both want a file:// URI rather
 *  than a bare absolute path, which is the form a media row arrives in. */
const asFileUri = (path: string): string =>
  /^[a-z][a-z0-9+.-]*:/i.test(path) ? path : `file://${path}`;

/**
 * Shared by path, not by bytes. shareFileData() cannot be used because it wants
 * base64 in JavaScript, and reading a video into a string to hand it to another
 * app is the one thing this whole layer exists to avoid.
 *
 * The share sheet needs the file:// URI: a convertFileSrc() link would arrive
 * as an http string and go out as plain text, which the receiving app cannot
 * open.
 */
export const shareMedia = async (item: MediaItem): Promise<void> => {
  if (!nativeAvailable()) return;
  try {
    const path = (await nativeMediaPath(item)) || item.path;
    if (!path) return;
    await Share.share({
      url: asFileUri(path),
      title: item.name,
      dialogTitle: `Share ${item.name}`,
    });
  } catch {
    /* a dismissed sheet, or nothing that accepts files, is not worth raising */
  }
};

/**
 * Unlinking is not something the media index was asked to do, and the Filesystem
 * plugin can delete a path we are already holding. Scoped storage makes this
 * fail for anything outside what the app may write, so the boolean says so
 * rather than pretending the photo is gone.
 */
export const deleteMedia = async (item: MediaItem): Promise<boolean> => {
  if (!nativeAvailable()) return false;
  if (!item.path) return false;
  try {
    await Filesystem.deleteFile({ path: asFileUri(item.path) });
    return true;
  } catch {
    return false;
  }
};

/**
 * The chooser route for "Open with". The web layer cannot launch an
 * ACTION_VIEW itself, and a convertFileSrc link would reach the target app as
 * plain text, so the handoff happens natively.
 */
export const openWithPath = async (path: string, mime?: string): Promise<boolean> => {
  if (!nativeAvailable()) return false;
  try {
    await DeviceFiles.openWith({ path, mime });
    return true;
  } catch {
    return false;
  }
};

/** One volume → rename; two volumes → copy plus unlink, all native. The
 *  Filesystem plugin is the fallback for a web build without the plugin. */
export const movePath = async (from: string, to: string): Promise<boolean> => {
  if (nativeAvailable()) {
    try {
      await DeviceFiles.movePath({ from, to });
      return true;
    } catch {
      /* fall through to the web filesystem route */
    }
  }
  try {
    await Filesystem.rename({ from: asFileUri(from), to });
    return true;
  } catch {
    try {
      await Filesystem.copy({ from: asFileUri(from), to });
      await Filesystem.deleteFile({ path: asFileUri(from) });
      return true;
    } catch {
      return false;
    }
  }
};

export const copyPath = async (from: string, to: string): Promise<boolean> => {
  if (nativeAvailable()) {
    try {
      await DeviceFiles.copyPath({ from, to });
      return true;
    } catch {
      /* fall through to the web filesystem route */
    }
  }
  try {
    await Filesystem.copy({ from: asFileUri(from), to });
    return true;
  } catch {
    return false;
  }
};

/** Names only, newest first, one row per file even when a download is also a
 *  document. The walk behind it is the same one a category open pays. */
export const searchFiles = async (
  query: string,
  kinds?: string[],
  limit = 400
): Promise<{ entries: DfRecent[]; total: number; denied: boolean }> => {
  if (!nativeAvailable()) return { entries: [], total: 0, denied: true };
  try {
    const r = await DeviceFiles.searchFiles({ query, kinds, limit });
    return { entries: r.entries ?? [], total: r.total ?? 0, denied: r.denied === true };
  } catch {
    return { entries: [], total: 0, denied: false };
  }
};

/** One set of identical copies. `size` is per-file; `files` holds them all. */
export type DupeGroup = { hash: string; size: number; files: DfRecent[] };

/** The Clean hub's three answers, always in this shape so the screen never
 *  has to tell "none found" apart from "not scanned yet" by accident. */
export type CleanFindings = {
  junk: { entries: DfRecent[]; bytes: number };
  old: { entries: DfRecent[]; bytes: number };
  dupes: { groups: DupeGroup[]; files: number; bytes: number };
  /** True when storage permission is missing, so the screen can say why the
   *  cards are empty instead of claiming the phone is spotless. */
  denied: boolean;
};

const NO_FINDINGS: CleanFindings = {
  junk: { entries: [], bytes: 0 },
  old: { entries: [], bytes: 0 },
  dupes: { groups: [], files: 0, bytes: 0 },
  denied: false,
};

/** Junk, month-old Download/Screenshots files, and duplicates in one pass —
 *  same walk as search, so opening Clean after browsing costs nothing. */
export const cleanScan = async (): Promise<CleanFindings> => {
  if (!nativeAvailable()) return { ...NO_FINDINGS, denied: true };
  try {
    const r = await DeviceFiles.cleanScan();
    if (r.denied === true) return { ...NO_FINDINGS, denied: true };
    return {
      junk: { entries: r.junk?.entries ?? [], bytes: r.junk?.bytes ?? 0 },
      old: { entries: r.old?.entries ?? [], bytes: r.old?.bytes ?? 0 },
      dupes: {
        groups: r.dupes?.groups ?? [],
        files: r.dupes?.files ?? 0,
        bytes: r.dupes?.bytes ?? 0,
      },
      denied: false,
    };
  } catch {
    return NO_FINDINGS;
  }
};

/** The Clean screen's volume card hands off to Android's own storage page. */
export const openStorageSettings = async (): Promise<void> => {
  if (!nativeAvailable()) return;
  try {
    await DeviceFiles.openStorageSettings();
  } catch {
    /* courtesy arrow; a settings app that refuses is not an app error */
  }
};

/** Existence and current stats for paths the caller already knows about.
 *  A null entry means the question could not be asked (no plugin); a false
 *  `exists` is Android's own answer that the file is gone. */
export const statPaths = async (
  paths: string[]
): Promise<({ exists: boolean; size: number; lastModified: number } | null)[]> => {
  if (!nativeAvailable() || paths.length === 0) return paths.map(() => null);
  try {
    const r = await DeviceFiles.statPaths({ paths });
    return paths.map((_, i) => {
      const it = r.items?.[i];
      return it ? { exists: it.exists === true, size: it.size ?? 0, lastModified: it.lastModified ?? 0 } : null;
    });
  } catch {
    return paths.map(() => null);
  }
};

/**
 * "photo.jpg" beside an existing "photo.jpg" becomes "photo (1).jpg" — the
 * same thing the phone's own file manager does, so a move that lands on a
 * folder already holding that name never silently overwrites it. The set is
 * lowercased names; the caller adds each returned name back into it.
 */
export function uniqueName(existing: Set<string>, name: string): string {
  if (!existing.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const tail = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 500; i++) {
    const candidate = `${stem} (${i})${tail}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${Date.now()})${tail}`;
}

// ── formatting ────────────────────────────────────────────

export function humanSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function countLabel(n: number): string {
  return n.toLocaleString();
}

/** A clip from an event runs past the hour, and MediaStore reports in
 *  milliseconds. A row with no duration gets a blank, never "0:00", because a
 *  zero on a photo reads as a broken player rather than as an absence. */
export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif"];
const VIDEO_EXT = ["mp4", "mkv", "mov", "avi", "webm", "3gp", "m4v"];
const AUDIO_EXT = [
  "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac",
  "amr", "mka", "wma", "caf", "mid", "midi", "xmf",
];
const DOC_EXT = [
  "pdf", "doc", "docx", "odt", "rtf", "txt", "md", "markdown",
  "xls", "xlsx", "ods", "csv", "tsv", "ppt", "pptx", "odp", "epub",
];

export const isImage = (ext: string) => IMAGE_EXT.includes(ext);
export const isVideo = (ext: string) => VIDEO_EXT.includes(ext);
export const isAudio = (ext: string) => AUDIO_EXT.includes(ext);
export const isDoc = (ext: string) => DOC_EXT.includes(ext);

/**
 * A dotLottie sticker package is a plain ZIP wearing a ".webp" name, and every
 * ZIP made by these tools starts with "PK\u0003\u0004" — "UEsDB" in base64. A
 * four-character prefix check is enough to tell the two apart before an image
 * viewer promises something it cannot draw. WhatsApp's newer stickers are
 * stored this way; a real sticker WebP never matches.
 */
export const isZipBase64 = (base64: string) => base64.startsWith("UEsDB");

/**
 * WhatsApp's end-to-end encrypted backup payloads (everything under its
 * `Backups/` folder carries a `.crypt15` — or legacy `.crypt14` — suffix).
 * They are AES-256-GCM under a key WhatsApp keeps in app-private storage, so
 * no other app can read the contents; the only honest surface for one is an
 * explanation, not a preview.
 */
export const isEncryptedBackup = (ext: string) => ext === "crypt15" || ext === "crypt14";

/** Real thumbnails only for media. Rendering a PDF's first page for a list of
 *  fifty files would mean reading fifty files, which is not a list scroll. */
export const hasThumb = (ext: string) => isImage(ext) || isVideo(ext);

export const isPdf = (ext: string) => ext === "pdf";

/**
 * The one question a list row actually asks: what does this file look like?
 * Images and videos come from the media thumbnailer (the native side pulls a
 * frame out of videos), PDFs from the platform's document renderer, and
 * everything else honestly answers nothing rather than pretending.
 */
export const rowThumbUrl = async (path: string, ext: string, w = 160): Promise<string | null> => {
  if (isPdf(ext)) return (await pdfThumb(path, w)).url;
  if (hasThumb(ext)) return thumbUrl(path, w);
  return null;
};

/** Whether rowThumbUrl can draw anything for this type — lists use it to
 *  decide whether the rows keep a thumbnail column at all. */
export const hasRowThumb = (ext: string) => isImage(ext) || isVideo(ext) || isPdf(ext);

export function whenLabel(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return hr === 1 ? "1 hour ago" : `${hr} hours ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "Yesterday";
  if (day < 7) return `${day} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function dayHeading(ms: number): string {
  if (!ms) return "Date unknown";
  const day = Math.floor((Date.now() - ms) / 86400000);
  if (day <= 0) return "Today";
  if (day === 1) return "Yesterday";
  if (day < 7) return `${day} days ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Where each category actually lives on a standard Android layout. */
export const CATEGORY_ROOT: Record<CategoryId, string> = {
  downloads: "/sdcard/Download",
  documents: "/sdcard/Documents",
  images: "/sdcard/Pictures",
  videos: "/sdcard/Movies",
  audio: "/sdcard/Music",
  other: "",
};

export const CATEGORY_LABEL: Record<CategoryId, string> = {
  downloads: "Downloads",
  documents: "Documents",
  images: "Images",
  videos: "Videos",
  audio: "Audio",
  other: "Other",
};

/** Type-filter buckets, matching the Documents app's All/DOC/XLS/PPT/PDF/TXT row. */
export type FilterId = "all" | "pdf" | "doc" | "sheet" | "slides" | "text" | "media" | "other";

export const FILTER_LABEL: Record<FilterId, string> = {
  all: "All",
  pdf: "PDF",
  doc: "DOC",
  sheet: "XLS",
  slides: "PPT",
  text: "TXT",
  media: "Media",
  other: "Other",
};

export function filterOf(ext: string): FilterId {
  if (ext === "pdf") return "pdf";
  if (["doc", "docx", "odt", "rtf"].includes(ext)) return "doc";
  if (["xls", "xlsx", "ods", "csv", "tsv"].includes(ext)) return "sheet";
  if (["ppt", "pptx", "odp"].includes(ext)) return "slides";
  if (["txt", "md", "markdown", "log"].includes(ext)) return "text";
  if (isImage(ext) || isVideo(ext)) return "media";
  return "other";
}

export const parentOf = (path: string): string | null => {
  if (!path || path === "/sdcard") return null;
  const cut = path.lastIndexOf("/");
  if (cut <= 0) return null;
  const parent = path.slice(0, cut);
  return parent.length === 0 ? "/" : parent;
};

export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/* ── Google Drive bridge ──────────────────────────────────────────
   The Drive plugin owns everything that touches Google's servers: the
   loopback listener sign-in comes back through, the token POSTs, and the
   two streaming transfers. These wrappers are deliberately thin — the
   policy (what to store, when to refresh, what to say) lives in
   lib/drive.ts, on the JavaScript side where it can be read. */

interface DrivePluginShape {
  oauthListen(o: { port: number }): Promise<{ url: string }>;
  oauthCancel(): Promise<void>;
  httpForm(o: { url: string; body: string }): Promise<{ status: number; body: string }>;
  httpGet(o: { url: string; bearer: string }): Promise<{ status: number; body: string }>;
  downloadFile(o: { url: string; bearer: string; name: string; dir?: string }): Promise<{
    path: string;
    name: string;
    bytes: number;
  }>;
  uploadFile(o: {
    path: string;
    folderId: string;
    bearer: string;
    name: string;
    mime: string;
  }): Promise<{ id: string; name: string }>;
  /** Opens Android's picker for a Drive tree; resolves when one is chosen or
   *  the user backs out. */
  safConnect(): Promise<{ cancelled: boolean; name?: string; treeId?: string }>;
  safStatus(): Promise<{ connected: boolean; name?: string; treeId?: string }>;
  /** Drops the persisted grant (nothing to revoke with Google — Android held
   *  the permission, not the account). */
  safForget(): Promise<void>;
  safList(o: { documentId?: string }): Promise<{
    entries?: SafEntry[];
    truncated?: boolean;
    revoked?: boolean;
  }>;
  safDownload(o: { documentId: string; name: string; dir?: string }): Promise<{
    path?: string;
    name?: string;
    bytes?: number;
    revoked?: boolean;
  }>;
  safUpload(o: {
    path: string;
    parentId: string;
    name: string;
    mime: string;
  }): Promise<{ id?: string; name?: string; revoked?: boolean }>;
  /** ACTION_VIEW on the document itself, so Google formats land in the Drive
   *  app that owns them. */
  safOpen(o: { documentId: string; mime?: string }): Promise<void>;
}

/** A row the Drive app's provider returned, before lib/driveSaf.ts dresses it
 *  as a DriveEntry. */
export type SafEntry = {
  id: string;
  name: string;
  mimeType: string;
  folder: boolean;
  size?: number;
  modified?: number;
};

const Drive = registerPlugin<DrivePluginShape>("Drive");

export function driveAvailable(): boolean {
  try {
    return Capacitor.isPluginAvailable("Drive");
  } catch {
    return false;
  }
}

/** Waits for the browser to deliver the OAuth redirect; resolves with the
 *  full loopback URL, query string intact. */
export const driveOauthListen = (port: number): Promise<string> =>
  Drive.oauthListen({ port }).then((r) => r.url);

/** Ends the wait for the redirect (the browser tab is still Google's to close). */
export const driveOauthCancel = (): Promise<void> => Drive.oauthCancel();

export const driveFormPost = (url: string, body: string) => Drive.httpForm({ url, body });

export const driveHttpGet = (url: string, bearer: string) => Drive.httpGet({ url, bearer });

export const driveDownloadNative = (url: string, bearer: string, name: string, dir?: string) =>
  Drive.downloadFile({ url, bearer, name, dir });

export const driveUploadNative = (
  path: string,
  folderId: string,
  bearer: string,
  name: string,
  mime: string,
) => Drive.uploadFile({ path, folderId, bearer, name, mime });

/* The Drive-app route: Android's picker grants one tree, and the phone's
   Drive app answers everything behind it. Raw bridge only — lib/driveSaf.ts
   holds the policy, same split as the OAuth wrappers above. */

export const driveSafConnect = () => Drive.safConnect();
export const driveSafStatus = () => Drive.safStatus();
export const driveSafForget = () => Drive.safForget();
export const driveSafList = (documentId?: string) => Drive.safList({ documentId });
export const driveSafDownloadNative = (documentId: string, name: string, dir?: string) =>
  Drive.safDownload({ documentId, name, dir });
export const driveSafUploadNative = (path: string, parentId: string, name: string, mime: string) =>
  Drive.safUpload({ path, parentId, name, mime });
export const driveSafOpenNative = (documentId: string, mime?: string) =>
  Drive.safOpen({ documentId, mime });
