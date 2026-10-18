/**
 * File pickers for Tools — device-first, preview-first.
 *
 * A list of bare filenames is not a choice, it is a quiz. Every row here
 * shows what the file is — a PDF's real first page, a photo's real
 * thumbnail — plus the facts people sort by: pages and size, with tabular
 * figures so the columns never jitter while a count arrives.
 *
 * Three sources, one shape:
 *  - "Phone": the device itself. PDFs come from the storage walk (Documents +
 *    Downloads), photos from MediaStore. Nothing is imported first; the tool
 *    reads the chosen file directly, so merging two 20 MB scans never asks
 *    anyone to wait for a copy.
 *  - "My files": the app store, for things already saved into StudyDesk.
 *  - "From PC": the LAN browser; pulled files land in My files.
 *
 * A selection is a PickedFile either way, so a flow (merge, compress, …) can
 * mix sources and only ever calls readPicked().
 *
 * The visual grammar is the app's own: hairlines over boxes, tonal surfaces
 * instead of borders, one accent (the steel-blue brand) for selection and
 * progress, and the drawn circle carrying selection so colour is never the
 * only signal.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { Check, FileText, Image as ImageIcon } from "lucide-react";
import {
  humanSize, listMedia, listPdfs, mediaThumbUrl, nativeAvailable, pdfThumb,
  readFile, requestAllFiles, TOOL_READ_MAX,
  type DfRecent, type MediaItem,
} from "../lib/deviceFiles";
import { getFileData, type FileMeta } from "../lib/store";
import { pdfPageCount, renderImageThumb, renderPdfThumb } from "../lib/office";
import { PcBrowser } from "../screens/Files";

export const IMG_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

// ── the selection unit ──────────────────────────────────

export type PickedFile =
  | { kind: "device"; key: string; path: string; name: string; ext: string; size: number; lastModified: number }
  | { kind: "app"; key: string; id: string; name: string; ext: string; size: number; lastModified: number };

export const pickedFromDevice = (e: {
  path: string; name: string; ext: string; size: number; lastModified: number;
}): PickedFile => ({
  kind: "device", key: `d:${e.path}`, path: e.path, name: e.name, ext: e.ext,
  size: e.size, lastModified: e.lastModified,
});

export const pickedFromMeta = (m: FileMeta): PickedFile => ({
  kind: "app", key: `a:${m.id}`, id: m.id, name: m.name, ext: m.ext,
  size: m.size, lastModified: m.addedAt,
});

const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** The file's bytes, whichever shelf it came from. Deliberate and one file at
 *  a time — tool reads are the only callers allowed past 5 MB. */
export async function readPicked(f: PickedFile): Promise<string> {
  if (f.kind === "app") return getFileData(f.id);
  const r = await readFile(f.path, TOOL_READ_MAX);
  if (!r) throw new Error(`${f.name} could not be read.`);
  if (r.truncated) throw new Error(`${f.name} is larger than this tool can handle (44 MB).`);
  return r.data;
}

/** Something an <img> or canvas can draw without any bytes crossing the
 *  bridge: a streamed device path, or a data URL for app-store files. */
export async function pickedDataUrl(f: PickedFile): Promise<string> {
  if (f.kind === "device") return Capacitor.convertFileSrc(f.path);
  const mime =
    f.ext === "png" ? "image/png" : f.ext === "webp" ? "image/webp" : f.ext === "gif" ? "image/gif" : "image/jpeg";
  return `data:${mime};base64,${await getFileData(f.id)}`;
}

const appPagesCache = new Map<string, number>();

/** PDF page count for one picked file. Device PDFs answer natively (the same
 *  PdfRenderer pass that draws their thumbnail); app-store PDFs are parsed
 *  once and remembered for the session. */
export async function pickedPageCount(f: PickedFile): Promise<number> {
  if (f.kind === "device") return (await queuedThumb(() => pdfThumb(f.path, 160))).pages;
  const hit = appPagesCache.get(f.id);
  if (hit !== undefined) return hit;
  const n = await queuedThumb(async () => pdfPageCount(await getFileData(f.id)).catch(() => 0));
  if (n) appPagesCache.set(f.id, n);
  return n;
}

// ── thumbnail work queue ────────────────────────────────
/* A hundred-row list asks for a hundred thumbnails the moment it renders.
 * Device page renders and app-store decodes both run through this queue, two
 * at a time, so the first screenful fills in progressively instead of
 * stuttering while everything tries to decode at once. */

const thumbCachePdf = new Map<string, string | null>();
const thumbCacheImg = new Map<string, string | null>();

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
    if (thumbsRunning < 2) run();
    else thumbQueue.push(run);
  });
}

// ── shared pieces ───────────────────────────────────────

type PickSource = "phone" | "app" | "pc";

/** Underline tabs. Quieter than a chip row and one more cue than colour: the
 *  active label darkens and a hairline of brand sits under it. */
export function Tabs<T extends string>({
  items, value, onChange,
}: {
  items: ReadonlyArray<{ id: T; label: string }>; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-6 border-b border-line">
      {items.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`sd-tap relative -mb-px pb-2.5 pt-1.5 text-[13px] font-medium ${value === t.id ? "text-ink-1" : "text-ink-3"}`}
        >
          {t.label}
          <span
            aria-hidden="true"
            className={`absolute inset-x-0 bottom-0 h-[2px] rounded-t-full ${value === t.id ? "bg-brand" : "bg-transparent"}`}
          />
        </button>
      ))}
    </div>
  );
}

const SOURCES = [
  { id: "phone", label: "Phone" },
  { id: "app", label: "My files" },
  { id: "pc", label: "From PC" },
] as const;

function PcBlock() {
  return (
    <>
      <div className="h-64 overflow-hidden rounded-card border border-line">
        <PcBrowser compact onPulled={() => window.dispatchEvent(new Event("sd-files-changed"))} />
      </div>
      <p className="mt-2 text-[12px] text-ink-3">Files pulled from your PC land in My files.</p>
    </>
  );
}

/** The drawn circle that carries selection, so colour is never the only
 *  signal. In ordered lists it wears the merge position instead of a check. */
export function SelMark({ sel, order = -1 }: { sel: boolean; order?: number }) {
  return (
    <span
      className={`grid size-[22px] shrink-0 place-items-center rounded-full border-[1.5px] ${
        sel ? "border-brand bg-brand text-primary-foreground" : "border-line-strong bg-transparent"
      }`}
    >
      {sel && (order >= 0 ? (
        <span className="tnum text-[11px] font-semibold leading-none">{order + 1}</span>
      ) : (
        <Check className="size-3.5" strokeWidth={3} />
      ))}
    </span>
  );
}

/** Empty and blocked states are the first thing a new user sees, so they get
 *  the product's own line-art: the document/folder outline draws itself in,
 *  the paper's rules fade up, and the final frame stands on its own. The art
 *  is aria-hidden; the text does the talking. */
function EmptyArt({ kind }: { kind: "doc" | "photo" }) {
  const draw = (delay: number, accent = false): { className: string; style: CSSProperties } => ({
    className: "sd-draw",
    style: { strokeDasharray: 1, "--dash": 1, animationDelay: `${delay}ms`, stroke: accent ? "var(--brand)" : "var(--ink-3)" } as CSSProperties,
  });
  return (
    <svg width="76" height="76" viewBox="0 0 96 96" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mb-3">
      {kind === "doc" ? (
        <>
          <path d="M30 12h26l14 14v58H30z" pathLength={1} {...draw(0)} />
          <path d="M56 12v14h14" pathLength={1} {...draw(140)} />
          <path d="M40 54h20M40 66h12" pathLength={1} {...draw(300, true)} />
        </>
      ) : (
        <>
          <rect x="16" y="22" width="64" height="52" rx="6" pathLength={1} {...draw(0)} />
          <circle cx="34" cy="40" r="6" pathLength={1} {...draw(140)} />
          <path d="M22 66l16-16 12 12 10-9 14 13" pathLength={1} {...draw(300, true)} />
        </>
      )}
    </svg>
  );
}

function EmptyBlock({
  art, title, line, action, onAction,
}: {
  art: "doc" | "photo"; title: string; line: string; action?: string; onAction?: () => void;
}) {
  return (
    <div className="px-6 py-8 text-center">
      <EmptyArt kind={art} />
      <div className="text-[15px] font-medium text-ink-1">{title}</div>
      <p className="mx-auto mt-1 max-w-[36ch] text-[13px] leading-relaxed text-ink-2">{line}</p>
      {action && (
        <button onClick={onAction} className="sd-tap mt-4 rounded-card bg-surface-3 px-4 py-2.5 text-[13px] font-medium text-ink-1">
          {action}
        </button>
      )}
    </div>
  );
}

/** Skeletons match the rows they replace, so nothing jumps when data lands. */
function LoadingPdfRows() {
  return (
    <div className="space-y-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3.5 px-2 py-2">
          <span className="sd-skeleton h-[58px] w-[46px] rounded-[7px]" />
          <span className="min-w-0 flex-1">
            <span className="sd-skeleton block h-3.5 w-3/5 rounded" />
            <span className="sd-skeleton mt-2 block h-3 w-2/5 rounded" />
          </span>
        </div>
      ))}
    </div>
  );
}

function LoadingTiles() {
  return (
    <div className="grid grid-cols-3 gap-1.5" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className="sd-skeleton aspect-square rounded-[10px]" />
      ))}
    </div>
  );
}

// ── PDF pickers ─────────────────────────────────────────

function useDevicePdfs(active: boolean) {
  const [list, setList] = useState<DfRecent[] | null>(null);
  const [denied, setDenied] = useState(false);
  const load = useCallback(async () => {
    const r = await listPdfs();
    r.items.sort((a, b) => b.lastModified - a.lastModified);
    setList(r.items);
    setDenied(r.denied);
  }, []);
  useEffect(() => {
    if (active && list === null) void load();
  }, [active, list, load]);
  // Coming back from the all-files-access settings page: the list was loaded
  // while access was still off, so it deserves one more look on resume.
  useEffect(() => {
    const h = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, [load]);
  const reload = useCallback(() => setList(null), []);
  return { list, denied, reload };
}

function PdfThumb({ f }: { f: PickedFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      if (f.kind === "device") {
        const t = await queuedThumb(() => pdfThumb(f.path, 160));
        if (live && t.url) setUrl(t.url);
      } else {
        let u = thumbCachePdf.get(f.id);
        if (u === undefined) {
          u = await queuedThumb(async () => renderPdfThumb(await getFileData(f.id), 160));
          thumbCachePdf.set(f.id, u);
        }
        if (live && u) setUrl(u);
      }
    })();
    return () => { live = false; };
  }, [f.key]);
  return url ? (
    <img src={url} alt="" className="h-full w-full object-cover" />
  ) : (
    <FileText className="size-5 text-ink-3" />
  );
}

/** One page of a PDF, drawn natively. App-store files fall back to a plain
 *  sheet icon — rendering their pages in JS is a whole-document cost the
 *  shuffle doesn't need. */
export function PdfPageThumb({ f, page, w = 120 }: { f: PickedFile; page: number; w?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (f.kind !== "device") return;
    let live = true;
    void queuedThumb(() => pdfThumb(f.path, w, page)).then((t) => { if (live && t.url) setUrl(t.url); });
    return () => { live = false; };
  }, [f.key, page, w]);
  return url ? (
    <img src={url} alt="" className="h-full w-full object-cover" />
  ) : (
    <FileText className="size-4 text-ink-3" />
  );
}

function PdfRow({ f, sel, order, onPress }: { f: PickedFile; sel: boolean; order: number; onPress: () => void }) {
  const [pages, setPages] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void pickedPageCount(f).then((n) => { if (live && n) setPages(n); });
    return () => { live = false; };
  }, [f.key]);
  const meta = `${pages ? `${pages} pages · ` : ""}${humanSize(f.size)}`;
  return (
    <button
      onClick={onPress}
      className={`sd-tap flex w-full items-center gap-3.5 rounded-card px-2 py-2 text-left ${sel ? "bg-brand-soft" : ""}`}
    >
      <span className="grid h-[58px] w-[46px] shrink-0 place-items-center overflow-hidden rounded-[7px] border border-line bg-surface-2">
        <PdfThumb f={f} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-ink-1">{f.name}</span>
        <span className="tnum mt-0.5 block truncate text-[12.5px] text-ink-2">{meta}</span>
      </span>
      <SelMark sel={sel} order={order} />
    </button>
  );
}

const PDF_PAGE = 60;

function PdfList({
  appFiles, value, onToggle, multi,
}: {
  appFiles: FileMeta[]; value: PickedFile[]; onToggle: (f: PickedFile) => void; multi: boolean;
}) {
  const [src, setSrc] = useState<PickSource>("phone");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PDF_PAGE);
  const { list, denied, reload } = useDevicePdfs(src === "phone" && nativeAvailable());
  const appPdfs = appFiles.filter((f) => f.ext === "pdf");
  const isSel = (k: string) => value.some((v) => v.key === k);
  const orderOf = (k: string) => value.findIndex((v) => v.key === k);
  const rowFor = (f: PickedFile) => (
    <PdfRow key={f.key} f={f} sel={isSel(f.key)} order={multi ? orderOf(f.key) : -1} onPress={() => onToggle(f)} />
  );
  const needle = q.trim().toLowerCase();
  const all = list ?? [];
  const matches = needle ? all.filter((e) => e.name.toLowerCase().includes(needle)) : all;
  const visible = needle ? matches.slice(0, 200) : matches.slice(0, shown);
  // Scroll-to-load. The sentinel sits after the loaded rows; when the finger
  // gets within 400px of it, the next page slips in above the fold. A button
  // here was the wrong shape: tapping it appends rows inside the scroller,
  // which is above your finger, so the tap looks like it did nothing.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || needle) return;
    const io = new IntersectionObserver(
      (ents) => {
        if (ents.some((e) => e.isIntersecting)) {
          setShown((s) => Math.min(s + PDF_PAGE, all.length));
        }
      },
      { root: el.parentElement, rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [list, shown, needle]);
  return (
    <div>
      <div className="mb-3">
        <Tabs items={SOURCES} value={src} onChange={(s) => { setSrc(s); setQ(""); setShown(PDF_PAGE); }} />
      </div>
      {src === "pc" ? (
        <PcBlock />
      ) : src === "phone" ? (
        denied ? (
          <EmptyBlock
            art="doc"
            title="See the PDFs on your phone"
            line="StudyDesk needs all-files access to list every PDF — chat downloads and the SD card included. Nothing leaves the phone."
            action="Allow file access"
            onAction={() => void requestAllFiles().then(reload)}
          />
        ) : list === null ? (
          <LoadingPdfRows />
        ) : list.length === 0 ? (
          <EmptyBlock
            art="doc"
            title="No PDFs on this phone"
            line="Android's file index has not caught any PDFs yet. New files appear here once the system scans them."
          />
        ) : (
          <>
            {list.length > 12 && (
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setShown(PDF_PAGE); }}
                placeholder="Search by name"
                className="mb-2 h-10 w-full rounded-[10px] bg-surface-2 px-3 text-[13px] text-ink-1 outline-none placeholder:text-ink-3"
              />
            )}
            <p className="tnum mb-2 text-[12px] text-ink-3">
              {needle ? `${matches.length} of ${list.length} match` : `${list.length} PDFs · newest first`}
            </p>
            <div className="-mx-2 max-h-[22rem] space-y-0.5 overflow-y-auto">
              {visible.map((e) => rowFor(pickedFromDevice(e)))}
              {!needle && list.length > shown && (
                <div ref={sentinelRef} aria-hidden="true" className="h-px" />
              )}
              {visible.length === 0 && (
                <p className="px-2 py-3 text-[13px] text-ink-2">Nothing matches “{q.trim()}”.</p>
              )}
            </div>
          </>
        )
      ) : appPdfs.length === 0 ? (
        <EmptyBlock
          art="doc"
          title="No PDFs in My files"
          line="Files you save from other tools or pull from your PC show up here."
        />
      ) : (
        <div className="-mx-2 max-h-[19rem] space-y-0.5 overflow-y-auto">{appPdfs.map((m) => rowFor(pickedFromMeta(m)))}</div>
      )}
    </div>
  );
}

export function PdfPickOne({
  appFiles, value, onChange,
}: {
  appFiles: FileMeta[]; value: PickedFile | null; onChange: (f: PickedFile | null) => void;
}) {
  return (
    <PdfList
      appFiles={appFiles}
      multi={false}
      value={value ? [value] : []}
      onToggle={(f) => onChange(value && value.key === f.key ? null : f)}
    />
  );
}

export function PdfPickMany({
  appFiles, value, onToggle,
}: {
  appFiles: FileMeta[]; value: PickedFile[]; onToggle: (f: PickedFile) => void;
}) {
  return <PdfList appFiles={appFiles} multi value={value} onToggle={onToggle} />;
}

// ── image picker (photo grid) ───────────────────────────

const IMG_PAGE = 60;

function useDeviceImages(active: boolean) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [more, setMore] = useState(false);
  const loadingRef = useRef(false);
  useEffect(() => {
    if (!active || items !== null) return;
    let live = true;
    void listMedia("images", IMG_PAGE, 0).then((r) => {
      if (!live) return;
      setItems(r.items);
      setTotal(r.total);
    });
    return () => { live = false; };
  }, [active, items]);
  const loadMore = async () => {
    // The ref is the real lock; the state flag is what the UI reads. Without
    // it, two quick intersection callbacks append the same page twice and the
    // grid grows duplicate keys.
    if (loadingRef.current || items === null) return;
    loadingRef.current = true;
    setMore(true);
    try {
      const r = await listMedia("images", IMG_PAGE, items.length);
      setItems([...items, ...r.items]);
      setTotal(r.total);
    } finally {
      loadingRef.current = false;
      setMore(false);
    }
  };
  return { items, total, more, loadMore };
}

function MediaThumb({ item }: { item: MediaItem }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void mediaThumbUrl(item, 200).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [item.id]);
  return url ? (
    <img src={url} alt="" className="h-full w-full object-cover" />
  ) : (
    <span className="block h-full w-full bg-surface-3" />
  );
}

function AppImgThumb({ m }: { m: FileMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      let u = thumbCacheImg.get(m.id);
      if (u === undefined) {
        u = await queuedThumb(async () => renderImageThumb(await getFileData(m.id), 200));
        thumbCacheImg.set(m.id, u);
      }
      if (live && u) setUrl(u);
    })();
    return () => { live = false; };
  }, [m.id]);
  return (
    <>
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="grid h-full w-full place-items-center bg-surface-3">
          <ImageIcon className="size-5 text-ink-3" />
        </span>
      )}
    </>
  );
}

function Tile({
  name, sel, order, onPress, children,
}: {
  name: string; sel: boolean; order: number; onPress: () => void; children: ReactNode;
}) {
  return (
    <button
      onClick={onPress}
      aria-label={name}
      className={`sd-tap relative aspect-square overflow-hidden rounded-[10px] border-2 ${sel ? "border-brand" : "border-transparent"}`}
    >
      {children}
      <span
        aria-hidden="true"
        className={`absolute right-1.5 top-1.5 grid size-[22px] place-items-center rounded-full ${
          sel ? "bg-brand text-primary-foreground" : "border-[1.5px] border-white/75 bg-black/25"
        }`}
      >
        {sel ? <span className="tnum text-[11px] font-semibold leading-none">{order + 1}</span> : null}
      </span>
    </button>
  );
}

export function ImagePickMany({
  appFiles, value, onToggle,
}: {
  appFiles: FileMeta[]; value: PickedFile[]; onToggle: (f: PickedFile) => void;
}) {
  const [src, setSrc] = useState<PickSource>("phone");
  const { items, total, more, loadMore } = useDeviceImages(src === "phone" && nativeAvailable());
  const appImgs = appFiles.filter((f) => IMG_EXTS.includes(f.ext));
  const isSel = (k: string) => value.some((v) => v.key === k);
  const orderOf = (k: string) => value.findIndex((v) => v.key === k);
  const device = (items ?? []).filter((it) => it.path);
  const imgSentinelRef = useRef<HTMLSpanElement | null>(null);
  // Same scroll-to-load contract as the PDF list: the next page arrives as the
  // finger nears the end of the loaded tiles, not after a button tap.
  useEffect(() => {
    const el = imgSentinelRef.current;
    if (!el || more || items === null || items.length >= total) return;
    const io = new IntersectionObserver(
      (ents) => { if (ents.some((e) => e.isIntersecting)) void loadMore(); },
      { root: el.parentElement, rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // loadMore closes over the current items; re-arming on each page keeps it honest.
  }, [items, total, more]);
  return (
    <div>
      <div className="mb-3">
        <Tabs items={SOURCES} value={src} onChange={setSrc} />
      </div>
      {src === "pc" ? (
        <PcBlock />
      ) : src === "phone" ? (
        items === null && nativeAvailable() ? (
          <LoadingTiles />
        ) : device.length === 0 ? (
          <EmptyBlock
            art="photo"
            title="No photos on this phone"
            line="Photos from your camera and gallery will appear here."
          />
        ) : (
          <>
            <div className="grid max-h-[21rem] grid-cols-3 gap-1.5 overflow-y-auto">{device.map((it) => {
              const f = pickedFromDevice({
                path: it.path, name: it.name, ext: extOf(it.name), size: it.size, lastModified: it.lastModified,
              });
              return (
                <Tile key={it.id} name={it.name} sel={isSel(f.key)} order={orderOf(f.key)} onPress={() => onToggle(f)}>
                  <MediaThumb item={it} />
                </Tile>
              );
            })}
              {device.length < total && (
                <span ref={imgSentinelRef} aria-hidden="true" className="col-span-3 h-px" />
              )}
            </div>
          </>
        )
      ) : appImgs.length === 0 ? (
        <EmptyBlock
          art="photo"
          title="No images in My files"
          line="Photos you import or save from other tools show up here."
        />
      ) : (
        <div className="grid max-h-[21rem] grid-cols-3 gap-1.5 overflow-y-auto">{appImgs.map((m) => {
          const f = pickedFromMeta(m);
          return (
            <Tile key={m.id} name={m.name} sel={isSel(f.key)} order={orderOf(f.key)} onPress={() => onToggle(f)}>
              <AppImgThumb m={m} />
            </Tile>
          );
        })}</div>
      )}
    </div>
  );
}
