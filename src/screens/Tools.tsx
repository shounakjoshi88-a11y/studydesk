import { useEffect, useRef, useState } from "react";
import {
  Shrink, RotateCw, Scissors, ArrowUpDown, Images, Hash, Droplets, Tag,
  FileDiff, Expand, FilePlus2, X, ChevronUp, ChevronDown, Loader2, ArrowLeftRight, IdCard,
  Combine, CheckCircle2, Camera as CameraIcon, Plus, Trash2, ScanLine,
  PenLine, Eraser, ChevronLeft, ChevronRight,
} from "lucide-react";
import {
  listFiles, getFileData, addFile, fmtSize, fileToBase64, type FileMeta,
} from "../lib/store";
import { exportToDownloads } from "../lib/deviceFiles";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { PcBrowser } from "./Files";
import { ToolMascot } from "../components/ToolMascots";
import { Resume } from "./Resume";
import { Reader } from "../components/Reader";
import {
  compressPdf, rotatePdfPages, reorderPdfPages, numberPdfPages, watermarkPdf,
  setPdfMeta, pdfPagesToImages, parseKeepSpec, keepPdfPages,
  mergePdfs, imagesToPdfFromUrls, resizeImageSrc, comparePdfs, stampName,
  convertTargetsFor, convertFile, textToB64, signPdfPage, type ConvertTarget,
} from "../lib/office";
import {
  ImagePickMany, PdfPageThumb, PdfPickMany, PdfPickOne, SelMark, Tabs, pickedDataUrl, pickedPageCount, readPicked,
  type PickedFile,
} from "../components/FilePick";

const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Section label. Sentence case, one step down from body ink on purpose:
 *  the control under it is the content, the label is only its name. */
function Lbl({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] font-medium text-ink-2">{children}</div>;
}

const fieldCls = "h-12 w-full rounded-[10px] border border-line bg-surface-2 px-3.5 text-[15px] text-ink-1 outline-none transition-colors placeholder:text-ink-3 focus:border-brand/60";

function ToolShell({
  title, sub, onClose, onRun, runLabel, running, disabled, footer, children, mascot,
}: {
  title: string; sub?: string; onClose: () => void; onRun: () => void;
  runLabel: string; running: boolean; disabled?: boolean; footer?: React.ReactNode;
  children: React.ReactNode; mascot?: string;
}) {
  const blocked = running || !!disabled;
  return (
    <div className="sd-fade-in fixed inset-0 z-50 flex flex-col bg-background">
      <header className="shrink-0 border-b border-line px-4 pb-4 pt-[max(28px,env(safe-area-inset-top))]">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[22px] font-semibold">{title}</h2>
            {sub && <p className="mt-1 text-[13px] leading-snug text-ink-2">{sub}</p>}
          </div>
          {mascot && (
            <div className="-mt-0.5 shrink-0" aria-hidden="true">
              <ToolMascot id={mascot} />
            </div>
          )}
          <button onClick={onClose} className="sd-icon -mr-2 rounded-xl text-ink-2" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
      </header>
      <div className="flex-1 space-y-6 overflow-y-auto px-4 pb-6 pt-5">{children}</div>
      {/* One primary action, in the app's own register: the run bar is paper,
          the only near-white surface on the screen. It stays disabled until
          the flow can actually run, so the button never silently no-ops. */}
      <div className="shrink-0 border-t border-line p-3" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        {footer}
        <button
          onClick={onRun}
          disabled={blocked}
          className="sd-tap flex h-[52px] w-full items-center justify-center gap-2 rounded-card bg-paper text-[15px] font-semibold text-paper-ink disabled:opacity-40"
        >
          {running && <Loader2 className="size-4 animate-spin" />}
          {running ? "Working…" : runLabel}
        </button>
      </div>
    </div>
  );
}

/** A segmented control, not a row of chips. Options live in one container
 *  with a raised thumb on the choice, so the set reads as one control with a
 *  state instead of five buttons with a winner. */
function Seg<T extends string | number>({ options, value, onChange }: { options: Array<{ v: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 rounded-xl bg-surface-2 p-1">
      {options.map((o) => {
        const on = value === o.v;
        return (
          <button
            key={String(o.v)}
            onClick={() => onChange(o.v)}
            className={`sd-tap h-10 min-w-0 flex-1 truncate rounded-lg px-2 text-[13px] font-medium ${
              on ? "border border-line-strong bg-surface-3 text-ink-1" : "border border-transparent text-ink-2"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

type FlowProps = { files: FileMeta[]; reload: () => void; close: () => void };

function useResult() {
  const [msg, setMsg] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  return { msg, setMsg, working, setWorking };
}

/** The output is the point of a tool, so it goes on screen the moment it
 *  exists instead of sitting behind another tap. A flow announces its file;
 *  the Tools screen hosts the one Reader that shows it. */
const announceResult = (meta: FileMeta, data: string) =>
  window.dispatchEvent(new CustomEvent("sd-tool-result", { detail: { meta, data } }));

async function saveOutput(name: string, data: string, reload: () => void): Promise<string> {
  const meta = await addFile(name, data);
  reload();
  // Every result lands twice on purpose: in the app's own shelf, and in the
  // phone's Download/StudyDesk folder where any other app can pick it up.
  const where = await exportToDownloads(meta.name, data);
  announceResult(meta, data);
  return `Saved: ${meta.name} (${fmtSize(meta.size)})${where ? ` · on phone: ${where}` : ""}`;
}

/** Success card for tools whose outcome is a number the user came for
 *  ("20 MB → 4.1 MB", "2 files → 21 pages"). Plain-text results stay text. */
function ResultCard({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="sd-card-in flex items-start gap-3 rounded-card bg-surface-1 px-4 py-3.5">
      <CheckCircle2 className="mt-0.5 size-5 shrink-0" style={{ color: "var(--att-safe-text)" }} />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-medium text-ink-1">{title}</div>
        {lines.map((l, i) => (
          <div key={i} className="tnum mt-1 truncate text-[13px] leading-snug text-ink-2">{l}</div>
        ))}
      </div>
    </div>
  );
}

function CompressFlow({ files, reload, close }: FlowProps) {
  const [sel, setSel] = useState<PickedFile | null>(null);
  const [level, setLevel] = useState(1600);
  const [res, setRes] = useState<{ name: string; size: number; pages: number; before: number; where: string | null } | null>(null);
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const { msg, setMsg, working, setWorking } = useResult();
  const qualityFor: Record<number, number> = { 2000: 0.82, 1600: 0.8, 1200: 0.7 };
  const delta = res ? res.before - res.size : 0;
  return (
    <ToolShell title="Compress PDF" sub="Shrink scans for portal submissions" onClose={close} runLabel="Compress" running={working} disabled={!sel} mascot="compress"
      onRun={() => {
        if (!sel) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          setRes(null);
          setProg(null);
          try {
            const r = await compressPdf(await readPicked(sel), {
              longEdge: level,
              quality: qualityFor[level],
              onProgress: (done, total) => setProg({ done, total }),
            });
            const meta = await addFile(stampName(sel.name, "(compressed)"), r.data);
            reload();
            const where = await exportToDownloads(meta.name, r.data);
            announceResult(meta, r.data);
            setRes({ name: meta.name, size: meta.size, pages: r.pages, before: sel.size, where });
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); setProg(null); }
        })();
      }}>
      <div><Lbl>PDF</Lbl><div className="mt-1.5">
        <PdfPickOne appFiles={files} value={sel} onChange={(f) => { setSel(f); setRes(null); setMsg(null); }} />
      </div></div>
      <div><Lbl>Strength</Lbl><div className="mt-1.5">
        <Seg
          options={[{ v: 2000, label: "Light" }, { v: 1600, label: "Medium" }, { v: 1200, label: "Strong" }]}
          value={level}
          onChange={(v) => { setLevel(v); setRes(null); }}
        />
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">Pages are re-rendered as JPEG. Medium ≈ 1600 px — the reference app's look; Light keeps more detail, Strong squeezes hardest.</p>
      </div></div>
      {prog && !res && (
        <div>
          <div className="h-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-[var(--dur-2)]"
              style={{ width: `${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%` }}
            />
          </div>
          <p className="tnum mt-1.5 text-[12px] text-ink-2">Page {prog.done} of {prog.total}</p>
        </div>
      )}
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
      {res && (
        <ResultCard
          title="Compressed"
          lines={[
            `${fmtSize(res.before)} → ${fmtSize(res.size)}${delta !== 0 ? ` (${delta > 0 ? "reduced" : "grew"} ${fmtSize(Math.abs(delta))})` : ""}`,
            `Saved: ${res.name}`,
            `${res.pages} pages`,
            ...(res.where ? [`On phone: ${res.where}`] : []),
          ]}
        />
      )}
    </ToolShell>
  );
}

function MergeFlow({ files, reload, close }: FlowProps) {
  const [sel, setSel] = useState<PickedFile[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [orders, setOrders] = useState<Record<string, number[]>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [res, setRes] = useState<{ name: string; size: number; pages: number; where: string | null } | null>(null);
  const { msg, setMsg, working, setWorking } = useResult();
  const totalBytes = sel.reduce((n, f) => n + f.size, 0);
  const knownPages = sel.every((f) => counts[f.key] !== undefined);
  const totalPages = sel.reduce((n, f) => n + (counts[f.key] ?? 0), 0);
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const autoName = `Merged PDF ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}`;
  useEffect(() => {
    for (const f of sel) {
      if (counts[f.key] !== undefined) continue;
      void pickedPageCount(f)
        .then((n) => setCounts((c) => ({ ...c, [f.key]: n })))
        .catch(() => setCounts((c) => ({ ...c, [f.key]: 0 })));
    }
    // counts are intentionally out of deps — this runs when the selection changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);
  // A file's page order is created on first expand and kept afterwards, so a
  // collapse/expand round trip never throws away an arrangement the user made.
  useEffect(() => {
    if (!open) return;
    const n = counts[open];
    if (!n || orders[open]) return;
    setOrders((o) => ({ ...o, [open]: Array.from({ length: n }, (_, i) => i + 1) }));
  }, [open, counts, orders]);
  useEffect(() => {
    if (open && !sel.some((f) => f.key === open)) setOpen(null);
  }, [sel, open]);
  const toggle = (f: PickedFile) => {
    setRes(null);
    setMsg(null);
    setSel(sel.some((x) => x.key === f.key) ? sel.filter((x) => x.key !== f.key) : [...sel, f]);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= sel.length) return;
    const next = [...sel];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setSel(next);
    setRes(null);
  };
  const movePage = (key: string, i: number, dir: -1 | 1) => {
    setOrders((o) => {
      const ord = o[key];
      if (!ord) return o;
      const j = i + dir;
      if (j < 0 || j >= ord.length) return o;
      const next = [...ord];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...o, [key]: next };
    });
    setRes(null);
  };
  const shuffled = (f: PickedFile) => {
    const ord = orders[f.key];
    const n = counts[f.key];
    return !!ord && !!n && ord.length === n && ord.some((p, i) => p !== i + 1);
  };
  return (
    <ToolShell title="Merge PDF" sub="Combine PDFs into one document" onClose={close} runLabel={sel.length >= 2 ? `Merge (${sel.length})` : "Merge"} running={working} disabled={sel.length < 2} mascot="merge"
      footer={
        <div className="mb-2.5">
          <div className="mb-1.5 text-[12px] font-medium text-ink-3">Save as</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={autoName} className={fieldCls} />
        </div>
      }
      onRun={() => {
        if (sel.length < 2) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          setRes(null);
          try {
            const list: string[] = [];
            let pages = 0;
            for (const f of sel) {
              let data = await readPicked(f);
              const n = counts[f.key] ?? (await pickedPageCount(f).catch(() => 0));
              // A shuffled file is rewritten in its new order before the merge
              // concatenates; a file left alone keeps its exact original bytes.
              if (shuffled(f) && n) data = await reorderPdfPages(data, orders[f.key]!);
              list.push(data);
              pages += n;
            }
            const out = await mergePdfs(list);
            const typed = name.trim();
            const finalName = typed ? (/\.pdf$/i.test(typed) ? typed : `${typed}.pdf`) : `${autoName}.pdf`;
            const meta = await addFile(finalName, out);
            reload();
            const where = await exportToDownloads(meta.name, out);
            announceResult(meta, out);
            setRes({ name: meta.name, size: meta.size, pages, where });
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}>
      <div><Lbl>PDFs</Lbl><div className="mt-1.5"><PdfPickMany appFiles={files} value={sel} onToggle={toggle} /></div></div>
      {sel.length > 0 && (
        <div>
          <Lbl>Merge order</Lbl>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-2">Top file first. Tap a file to shuffle its pages.</p>
          <div className="mt-1.5 space-y-1.5">
            {sel.map((f, i) => {
              const isOpen = open === f.key;
              const ord = orders[f.key];
              return (
                <div key={f.key} className="rounded-card bg-surface-1">
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <span className="tnum grid size-6 shrink-0 place-items-center rounded-full bg-surface-3 text-[11px] font-semibold text-ink-2">{i + 1}</span>
                    <button onClick={() => setOpen(isOpen ? null : f.key)} aria-expanded={isOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-ink-1">{f.name}</span>
                        <span className="tnum block text-[12px] text-ink-2">
                          {counts[f.key] !== undefined ? `${counts[f.key]} pages · ` : ""}{fmtSize(f.size)}{shuffled(f) ? " · shuffled" : ""}
                        </span>
                      </span>
                      <ChevronDown className={`size-4 shrink-0 text-ink-3 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
                    </button>
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="grid size-10 shrink-0 place-items-center rounded-lg text-ink-2 disabled:opacity-25" aria-label="Move file up"><ChevronUp className="size-[18px]" /></button>
                    <button onClick={() => move(i, 1)} disabled={i === sel.length - 1} className="grid size-10 shrink-0 place-items-center rounded-lg text-ink-2 disabled:opacity-25" aria-label="Move file down"><ChevronDown className="size-[18px]" /></button>
                    <button onClick={() => toggle(f)} className="grid size-10 shrink-0 place-items-center rounded-lg text-ink-3" aria-label="Remove file"><X className="size-[18px]" /></button>
                  </div>
                  {isOpen && (
                    <div className="border-t border-line px-3 pb-2.5 pt-2">
                      {!ord ? (
                        <p className="py-1 text-[12px] text-ink-2">Counting pages…</p>
                      ) : (
                        <>
                          <div className="max-h-60 space-y-0.5 overflow-y-auto">
                            {ord.map((p, pi) => (
                              <div key={`${p}-${pi}`} className="flex items-center gap-3 rounded-lg bg-surface-2 px-2 py-1.5">
                                <span className="grid h-[46px] w-[36px] shrink-0 place-items-center overflow-hidden rounded-[5px] border border-line bg-surface-1">
                                  <PdfPageThumb f={f} page={p - 1} />
                                </span>
                                <span className="tnum flex-1 text-[13px] text-ink-1">Page {p}</span>
                                <button onClick={() => movePage(f.key, pi, -1)} disabled={pi === 0} className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-2 disabled:opacity-25" aria-label={`Move page ${p} up`}><ChevronUp className="size-4" /></button>
                                <button onClick={() => movePage(f.key, pi, 1)} disabled={pi === ord.length - 1} className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-2 disabled:opacity-25" aria-label={`Move page ${p} down`}><ChevronDown className="size-4" /></button>
                              </div>
                            ))}
                          </div>
                          {shuffled(f) && (
                            <button
                              onClick={() => setOrders((o) => ({ ...o, [f.key]: Array.from({ length: counts[f.key] ?? 0 }, (_, i) => i + 1) }))}
                              className="sd-tap mt-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium text-ink-2"
                            >
                              Reset page order
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <p className="tnum text-[12px] text-ink-2">{sel.length} {sel.length === 1 ? "file" : "files"} · {knownPages ? `${totalPages} pages` : "counting pages…"} · {fmtSize(totalBytes)}</p>
          </div>
        </div>
      )}
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
      {res && (
        <ResultCard
          title="Merged"
          lines={[`${sel.length} files → ${res.pages} pages`, `Saved: ${res.name} (${fmtSize(res.size)})`, ...(res.where ? [`On phone: ${res.where}`] : [])]}
        />
      )}
    </ToolShell>
  );
}

function RotateFlow({ files, reload, close }: FlowProps) {
  const [sel, setSel] = useState<PickedFile | null>(null);
  const [deg, setDeg] = useState<90 | 180 | 270>(90);
  const [spec, setSpec] = useState("");
  const [total, setTotal] = useState(0);
  const { msg, setMsg, working, setWorking } = useResult();
  useEffect(() => {
    if (!sel) { setTotal(0); return; }
    void pickedPageCount(sel).then(setTotal).catch(() => setTotal(0));
  }, [sel]);
  return (
    <ToolShell title="Rotate pages" sub="Fix sideways scans" onClose={close} runLabel="Rotate" running={working} disabled={!sel} mascot="rotate"
      onRun={() => {
        if (!sel) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          try {
            const pages = spec.trim() ? parseKeepSpec(spec, total || 9999) : null;
            const out = await rotatePdfPages(await readPicked(sel), deg, pages);
            setMsg(await saveOutput(stampName(sel.name, "(rotated)"), out, reload));
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}>
      <div><Lbl>PDF</Lbl><div className="mt-1.5"><PdfPickOne appFiles={files} value={sel} onChange={setSel} /></div></div>
      <div><Lbl>Turn</Lbl><div className="mt-1.5">
        <Seg options={[{ v: 90 as const, label: "90°" }, { v: 180 as const, label: "180°" }, { v: 270 as const, label: "270°" }]} value={deg} onChange={setDeg} />
      </div></div>
      <div><Lbl>Pages (blank = all{total ? `, ${total} total` : ""})</Lbl>
        <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="e.g. 2-4" className={`${fieldCls} mt-1.5`} />
      </div>
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
    </ToolShell>
  );
}

function SplitFlow({ files, reload, close }: FlowProps) {
  const [sel, setSel] = useState<PickedFile | null>(null);
  const [spec, setSpec] = useState("1-3;4-6");
  const [total, setTotal] = useState(0);
  const { msg, setMsg, working, setWorking } = useResult();
  useEffect(() => {
    if (!sel) { setTotal(0); return; }
    void pickedPageCount(sel).then(setTotal).catch(() => setTotal(0));
  }, [sel]);
  return (
    <ToolShell title="Split PDF" sub="One file per range" onClose={close} runLabel="Split" running={working} disabled={!sel} mascot="split"
      onRun={() => {
        if (!sel) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          try {
            const data = await readPicked(sel);
            const groups = spec.split(";").map((s) => parseKeepSpec(s, total)).filter((g) => g.length);
            if (!groups.length) throw new Error("No valid ranges.");
            const names: string[] = [];
            let onPhone = 0;
            let first: { meta: FileMeta; data: string } | null = null;
            for (let i = 0; i < groups.length; i++) {
              const out = await keepPdfPages(data, groups[i]!);
              const meta = await addFile(stampName(sel.name, `(part${i + 1})`), out);
              if (!first) first = { meta, data: out };
              names.push(meta.name);
              if (await exportToDownloads(meta.name, out)) onPhone++;
            }
            reload();
            if (first) announceResult(first.meta, first.data);
            setMsg(`Saved ${names.length} files: ${names.join(", ")}${onPhone ? ` · on phone: Download/StudyDesk (${onPhone})` : ""}`);
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}>
      <div><Lbl>PDF{total ? ` (${total} pages)` : ""}</Lbl><div className="mt-1.5"><PdfPickOne appFiles={files} value={sel} onChange={setSel} /></div></div>
      <div><Lbl>Ranges</Lbl>
        <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="1-3;4-6" className={`${fieldCls} mt-1.5`} />
      </div>
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
    </ToolShell>
  );
}

function SortFlow({ files, reload, close }: FlowProps) {
  const [sel, setSel] = useState<PickedFile | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const { msg, setMsg, working, setWorking } = useResult();
  useEffect(() => {
    if (!sel) { setOrder([]); return; }
    void pickedPageCount(sel).then((n) => setOrder(Array.from({ length: n }, (_, i) => i + 1))).catch(() => setOrder([]));
  }, [sel]);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setOrder(next);
  };
  return (
    <ToolShell title="Sort pages" sub="Reorder, then save" onClose={close} runLabel="Save order" running={working} disabled={!sel || !order.length} mascot="sort"
      onRun={() => {
        if (!sel || !order.length) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          try {
            const out = await reorderPdfPages(await readPicked(sel), order);
            setMsg(await saveOutput(stampName(sel.name, "(sorted)"), out, reload));
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}>
      <div><Lbl>PDF</Lbl><div className="mt-1.5"><PdfPickOne appFiles={files} value={sel} onChange={setSel} /></div></div>
      {order.length > 0 && (
        <div className="-mx-2 max-h-[19rem] space-y-0.5 overflow-y-auto px-2">
          {order.map((p, i) => (
            <div key={`${p}-${i}`} className="flex items-center gap-3 rounded-card bg-surface-1 px-3 py-1.5">
              <span className="tnum flex-1 text-[14px] text-ink-1">Page {p}</span>
              <button onClick={() => move(i, -1)} disabled={i === 0} className="grid size-10 shrink-0 place-items-center rounded-lg text-ink-2 disabled:opacity-25" aria-label="Move up"><ChevronUp className="size-[18px]" /></button>
              <button onClick={() => move(i, 1)} disabled={i === order.length - 1} className="grid size-10 shrink-0 place-items-center rounded-lg text-ink-2 disabled:opacity-25" aria-label="Move down"><ChevronDown className="size-[18px]" /></button>
            </div>
          ))}
        </div>
      )}
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
    </ToolShell>
  );
}

function ToImagesFlow({ files, reload, close }: FlowProps) {
  const [sel, setSel] = useState<PickedFile | null>(null);
  const [spec, setSpec] = useState("");
  const [kind, setKind] = useState<"jpg" | "png">("jpg");
  const [size, setSize] = useState(2048);
  const [quality, setQuality] = useState(0.92);
  const [total, setTotal] = useState(0);
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const [res, setRes] = useState<{ count: number; bytes: number; onPhone: number } | null>(null);
  const { msg, setMsg, working, setWorking } = useResult();
  useEffect(() => {
    if (!sel) { setTotal(0); return; }
    void pickedPageCount(sel).then(setTotal).catch(() => setTotal(0));
  }, [sel]);
  const EXT_CAP = 100;
  return (
    <ToolShell title="PDF to images" sub={`Each page becomes a ${kind === "jpg" ? "JPG" : "PNG"} file`} onClose={close} runLabel="Export" running={working} disabled={!sel} mascot="toimages"
      onRun={() => {
        if (!sel) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          setRes(null);
          setProg(null);
          try {
            const data = await readPicked(sel);
            const pages = spec.trim()
              ? parseKeepSpec(spec, total).slice(0, EXT_CAP)
              : Array.from({ length: Math.min(total, EXT_CAP) }, (_, i) => i + 1);
            if (!pages.length) throw new Error("No pages picked.");
            setProg({ done: 0, total: pages.length });
            const imgs = await pdfPagesToImages(data, pages, {
              kind, longEdge: size, quality,
              onProgress: (done, t) => setProg({ done, total: t }),
            });
            const base = sel.name.replace(/\.[^.]+$/, "");
            let onPhone = 0;
            let bytes = 0;
            let first: { meta: FileMeta; data: string } | null = null;
            for (const im of imgs) {
              const nm = `${base}-p${im.page}.${kind}`;
              bytes += Math.round((im.data.length * 3) / 4);
              const meta = await addFile(nm, im.data);
              if (!first) first = { meta, data: im.data };
              if (await exportToDownloads(nm, im.data)) onPhone++;
            }
            reload();
            if (first) announceResult(first.meta, first.data);
            setRes({ count: imgs.length, bytes, onPhone });
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); setProg(null); }
        })();
      }}>
      <div><Lbl>PDF{total ? ` (${total} pages)` : ""}</Lbl><div className="mt-1.5"><PdfPickOne appFiles={files} value={sel} onChange={(f) => { setSel(f); setRes(null); setMsg(null); }} /></div></div>
      <div><Lbl>Format</Lbl><div className="mt-1.5">
        <Seg options={[{ v: "jpg" as const, label: "JPG" }, { v: "png" as const, label: "PNG" }]} value={kind} onChange={(v) => { setKind(v); setRes(null); }} />
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">JPG is what upload forms take, at a fraction of the size; PNG stays lossless.</p>
      </div></div>
      <div><Lbl>Size</Lbl><div className="mt-1.5">
        <Seg options={[{ v: 2048, label: "Large" }, { v: 1600, label: "Medium" }, { v: 1200, label: "Small" }]} value={size} onChange={(v) => { setSize(v); setRes(null); }} />
      </div></div>
      {kind === "jpg" && (
        <div><Lbl>Quality</Lbl><div className="mt-1.5">
          <Seg options={[{ v: 0.92, label: "Best" }, { v: 0.82, label: "Balanced" }, { v: 0.68, label: "Smallest" }]} value={quality} onChange={(v) => { setQuality(v); setRes(null); }} />
        </div></div>
      )}
      <div><Lbl>Pages (blank = all, max {EXT_CAP})</Lbl>
        <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="e.g. 1,3,5" className={`${fieldCls} mt-1.5`} />
      </div>
      {prog && !res && (
        <div>
          <div className="h-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-[var(--dur-2)]"
              style={{ width: `${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%` }}
            />
          </div>
          <p className="tnum mt-1.5 text-[12px] text-ink-2">Page {prog.done} of {prog.total}</p>
        </div>
      )}
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
      {res && (
        <ResultCard
          title={`${res.count} ${kind === "jpg" ? "JPG" : "PNG"} ${res.count === 1 ? "file" : "files"}`}
          lines={[
            `${res.count} ${res.count === 1 ? "page" : "pages"} → ${fmtSize(res.bytes)}`,
            ...(res.onPhone ? [`On phone: Download/StudyDesk (${res.onPhone})`] : []),
          ]}
        />
      )}
    </ToolShell>
  );
}

function NumbersFlow({ files, reload, close }: FlowProps) {
  const [sel, setSel] = useState<PickedFile | null>(null);
  const { msg, setMsg, working, setWorking } = useResult();
  return (
    <ToolShell title="Page numbers" sub="Adds 1, 2, 3… at the bottom" onClose={close} runLabel="Add numbers" running={working} disabled={!sel} mascot="numbers"
      onRun={() => {
        if (!sel) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          try {
            const out = await numberPdfPages(await readPicked(sel));
            setMsg(await saveOutput(stampName(sel.name, "(numbered)"), out, reload));
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}>
      <div><Lbl>PDF</Lbl><div className="mt-1.5"><PdfPickOne appFiles={files} value={sel} onChange={setSel} /></div></div>
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
    </ToolShell>
  );
}

function WatermarkFlow({ files, reload, close }: FlowProps) {
  const [sel, setSel] = useState<PickedFile | null>(null);
  const [text, setText] = useState("StudyDesk");
  const { msg, setMsg, working, setWorking } = useResult();
  return (
    <ToolShell title="Watermark" sub="Diagonal mark on every page" onClose={close} runLabel="Apply" running={working} disabled={!sel || !text.trim()} mascot="watermark"
      onRun={() => {
        if (!sel || !text.trim()) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          try {
            const out = await watermarkPdf(await readPicked(sel), text.trim().slice(0, 40));
            setMsg(await saveOutput(stampName(sel.name, "(watermarked)"), out, reload));
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}>
      <div><Lbl>PDF</Lbl><div className="mt-1.5"><PdfPickOne appFiles={files} value={sel} onChange={setSel} /></div></div>
      <div><Lbl>Text</Lbl>
        <input value={text} onChange={(e) => setText(e.target.value)} className={`${fieldCls} mt-1.5`} />
      </div>
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
    </ToolShell>
  );
}

function MetaFlow({ files, reload, close }: FlowProps) {
  const [sel, setSel] = useState<PickedFile | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [subject, setSubject] = useState("");
  const [keywords, setKeywords] = useState("");
  const { msg, setMsg, working, setWorking } = useResult();
  return (
    <ToolShell title="Edit metadata" sub="Title, author, subject, keywords" onClose={close} runLabel="Save copy" running={working} disabled={!sel} mascot="meta"
      onRun={() => {
        if (!sel) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          try {
            const out = await setPdfMeta(await readPicked(sel), { title, author, subject, keywords });
            setMsg(await saveOutput(stampName(sel.name, "(meta)"), out, reload));
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}>
      <div><Lbl>PDF</Lbl><div className="mt-1.5"><PdfPickOne appFiles={files} value={sel} onChange={setSel} /></div></div>
      <div><Lbl>Title</Lbl><input value={title} onChange={(e) => setTitle(e.target.value)} className={`${fieldCls} mt-1.5`} /></div>
      <div><Lbl>Author</Lbl><input value={author} onChange={(e) => setAuthor(e.target.value)} className={`${fieldCls} mt-1.5`} /></div>
      <div><Lbl>Subject</Lbl><input value={subject} onChange={(e) => setSubject(e.target.value)} className={`${fieldCls} mt-1.5`} /></div>
      <div><Lbl>Keywords (comma separated)</Lbl><input value={keywords} onChange={(e) => setKeywords(e.target.value)} className={`${fieldCls} mt-1.5`} /></div>
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
    </ToolShell>
  );
}

function CompareFlow({ files, close }: { files: FileMeta[]; reload: () => void; close: () => void }) {
  const [a, setA] = useState<PickedFile | null>(null);
  const [b, setB] = useState<PickedFile | null>(null);
  const [res, setRes] = useState<{ sim: number; onlyA: string[]; onlyB: string[] } | null>(null);
  const [working, setWorking] = useState(false);
  return (
    <ToolShell title="Compare PDFs" sub="How alike are they?" onClose={close} runLabel="Compare" running={working} disabled={!a || !b || a.key === b.key} mascot="compare"
      onRun={() => {
        if (!a || !b || a.key === b.key) return;
        void (async () => {
          setWorking(true);
          setRes(null);
          try {
            setRes(await comparePdfs(await readPicked(a), await readPicked(b)));
          } catch (e) {
            setRes({ sim: 0, onlyA: [`Failed: ${fail(e)}`], onlyB: [] });
          } finally { setWorking(false); }
        })();
      }}>
      <div><Lbl>First PDF</Lbl><div className="mt-1.5"><PdfPickOne appFiles={files} value={a} onChange={setA} /></div></div>
      <div><Lbl>Second PDF</Lbl><div className="mt-1.5"><PdfPickOne appFiles={files} value={b} onChange={setB} /></div></div>
      {res && (
        <div className="space-y-2">
          {/* Similarity carries a number and the word "alike", so the ramp
              colour is reinforcement rather than the only signal. */}
          <div className="text-center text-[28px] font-semibold tnum" style={{ color: res.sim >= 85 ? "var(--att-safe-text)" : res.sim >= 50 ? "var(--att-caution-text)" : "var(--att-risk-text)" }}>
            {res.sim}% <span className="text-[13px] font-normal text-ink-2">alike</span>
          </div>
          <div><Lbl>Only in first</Lbl>
            {res.onlyA.length === 0 ? <p className="text-xs text-ink-2 mt-1">Nothing unique.</p> :
              res.onlyA.map((l, i) => <p key={i} className="text-xs mt-1 px-2.5 py-1.5 rounded-card bg-[var(--att-critical)]/10 text-critical-text">− {l}</p>)}
          </div>
          <div><Lbl>Only in second</Lbl>
            {res.onlyB.length === 0 ? <p className="text-xs text-ink-2 mt-1">Nothing unique.</p> :
              res.onlyB.map((l, i) => <p key={i} className="text-xs mt-1 px-2.5 py-1.5 rounded-card bg-[var(--att-safe)]/10 text-safe-text">+ {l}</p>)}
          </div>
        </div>
      )}
    </ToolShell>
  );
}

function ResizeFlow({ files, reload, close }: FlowProps) {
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [sel, setSel] = useState<PickedFile | null>(null);
  const [selBulk, setSelBulk] = useState<PickedFile[]>([]);
  const [targetKB, setTargetKB] = useState(200);
  const [maxDim, setMaxDim] = useState(1600);
  const { msg, setMsg, working, setWorking } = useResult();
  return (
    <ToolShell title="Resize image" sub="Hit portal upload limits" onClose={close} runLabel={mode === "bulk" ? `Compress (${selBulk.length})` : "Compress"} running={working} disabled={mode === "bulk" ? selBulk.length === 0 : !sel} mascot="resize"
      onRun={() => {
        const picked = mode === "bulk" ? selBulk : sel ? [sel] : [];
        if (!picked.length) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          try {
            const names: string[] = [];
            let onPhone = 0;
            let first: { meta: FileMeta; data: string } | null = null;
            for (const f of picked) {
              const r = await resizeImageSrc(await pickedDataUrl(f), { maxDim, targetKB });
              const base = f.name.replace(/\.[^.]+$/, "");
              const meta = await addFile(`${base} (${Math.round(r.bytes / 1024)}KB).jpg`, r.data);
              if (!first) first = { meta, data: r.data };
              names.push(meta.name);
              if (await exportToDownloads(meta.name, r.data)) onPhone++;
            }
            reload();
            if (first) announceResult(first.meta, first.data);
            const ok = names.length === 1 ? `Saved: ${names[0]}` : `Saved ${names.length} images.`;
            setMsg(ok + (onPhone ? ` On phone: Download/StudyDesk (${onPhone}).` : ""));
            if (mode === "bulk") setSelBulk([]);
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}>
      <div><Lbl>Mode</Lbl><div className="mt-1.5">
        <Seg options={[{ v: "single" as const, label: "Single" }, { v: "bulk" as const, label: "Bulk" }]} value={mode} onChange={setMode} />
      </div></div>
      <div><Lbl>{mode === "bulk" ? "Images" : "Image"}</Lbl><div className="mt-1.5">
        {mode === "bulk" ? (
          <ImagePickMany appFiles={files} value={selBulk} onToggle={(f) => setSelBulk(selBulk.some((x) => x.key === f.key) ? selBulk.filter((x) => x.key !== f.key) : [...selBulk, f])} />
        ) : (
          <ImagePickMany appFiles={files} value={sel ? [sel] : []} onToggle={(f) => setSel(sel && sel.key === f.key ? null : f)} />
        )}
      </div></div>
      <div><Lbl>Target size</Lbl><div className="mt-1.5">
        <Seg options={[{ v: 100, label: "<100KB" }, { v: 200, label: "<200KB" }, { v: 500, label: "<500KB" }, { v: 1024, label: "<1MB" }]} value={targetKB} onChange={setTargetKB} />
      </div></div>
      <div><Lbl>Max side</Lbl><div className="mt-1.5">
        <Seg options={[{ v: 1024, label: "1024" }, { v: 1600, label: "1600" }, { v: 2048, label: "2048" }, { v: 99999, label: "Keep" }]} value={maxDim} onChange={setMaxDim} />
      </div></div>
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
    </ToolShell>
  );
}

function ImgToPdfFlow({ files, reload, close }: FlowProps) {
  const [sel, setSel] = useState<PickedFile[]>([]);
  const [pageSize, setPageSize] = useState<"fit" | "a4">("fit");
  const [margin, setMargin] = useState(24);
  const [res, setRes] = useState<{ name: string; size: number; where: string | null } | null>(null);
  const { msg, setMsg, working, setWorking } = useResult();
  return (
    <ToolShell title="Images to PDF" sub="Tap photos in page order" onClose={close} runLabel={sel.length ? `Make PDF (${sel.length})` : "Make PDF"} running={working} disabled={!sel.length} mascot="imgtopdf"
      onRun={() => {
        if (!sel.length) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          setRes(null);
          try {
            const urls: string[] = [];
            for (const f of sel) urls.push(await pickedDataUrl(f));
            const out = await imagesToPdfFromUrls(urls, { pageSize, margin });
            const d = new Date();
            const p2 = (n: number) => String(n).padStart(2, "0");
            const one = sel.length === 1 ? sel[0]! : null;
            const name = one
              ? `${one.name.replace(/\.[^.]+$/, "")}.pdf`
              : `Image to PDF ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.pdf`;
            const meta = await addFile(name, out);
            reload();
            const where = await exportToDownloads(meta.name, out);
            announceResult(meta, out);
            setRes({ name: meta.name, size: meta.size, where });
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}>
      <div><Lbl>Photos — tap in page order</Lbl><div className="mt-1.5">
        <ImagePickMany appFiles={files} value={sel} onToggle={(f) => setSel(sel.some((x) => x.key === f.key) ? sel.filter((x) => x.key !== f.key) : [...sel, f])} />
      </div></div>
      <div><Lbl>Page size</Lbl><div className="mt-1.5">
        <Seg options={[{ v: "fit" as const, label: "Fit photo" }, { v: "a4" as const, label: "A4 page" }]} value={pageSize} onChange={(v) => { setPageSize(v); setRes(null); }} />
      </div></div>
      {pageSize === "a4" && (
        <div><Lbl>Margin</Lbl><div className="mt-1.5">
          <Seg options={[{ v: 0, label: "None" }, { v: 24, label: "Small" }, { v: 56, label: "Wide" }]} value={margin} onChange={(v) => { setMargin(v); setRes(null); }} />
        </div></div>
      )}
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
      {res && (
        <ResultCard
          title="PDF created"
          lines={[`${sel.length} ${sel.length === 1 ? "photo" : "photos"} → ${sel.length} ${sel.length === 1 ? "page" : "pages"}`, `Saved: ${res.name} (${fmtSize(res.size)})`, ...(res.where ? [`On phone: ${res.where}`] : [])]}
        />
      )}
    </ToolShell>
  );
}

const CONVERT_SOURCES = [
  { id: "lib", label: "My files" },
  { id: "pc", label: "From PC" },
  { id: "phone", label: "Phone" },
] as const;

function ConvertFlow({ files, reload, close, initialId }: FlowProps & { initialId?: string | null }) {
  const convertible = files.filter((f) => convertTargetsFor(f.ext).length > 0);
  const [sel, setSel] = useState<string | null>(initialId || null);
  const [target, setTarget] = useState<ConvertTarget | null>(null);
  const [src, setSrc] = useState<"lib" | "pc" | "phone">("lib");
  const { msg, setMsg, working, setWorking } = useResult();
  const meta = files.find((f) => f.id === sel) || null;
  const targets = meta ? convertTargetsFor(meta.ext) : [];
  useEffect(() => { setTarget(null); }, [sel]);
  const inputRef = useRef<HTMLInputElement>(null);
  const importPhone = async (list: FileList | null) => {
    if (!list?.length) return;
    for (const f of Array.from(list)) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (!convertTargetsFor(ext).length) continue;
      try {
        const m = await addFile(f.name, await fileToBase64(f));
        setSel(m.id);
      } catch { /* skip unreadable file */ }
    }
    window.dispatchEvent(new Event("sd-files-changed"));
    setSrc("lib");
    if (inputRef.current) inputRef.current.value = "";
  };
  return (
    <ToolShell title="Convert files" sub="md docx pdf xlsx csv, both ways" onClose={close} runLabel="Convert" running={working} disabled={!meta || !target} mascot="convert"
      onRun={() => {
        if (!meta || !target) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          try {
            const r = await convertFile(meta.ext, await getFileData(meta.id), meta.name, target);
            const payload = r.asText !== undefined ? textToB64(r.asText) : r.data;
            const saved = await addFile(r.outName, payload);
            reload();
            const where = await exportToDownloads(saved.name, payload);
            announceResult(saved, payload);
            setMsg(`Saved: ${saved.name} (${fmtSize(saved.size)})${where ? ` · on phone: ${where}` : ""}`);
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}>
      <div>
        <Lbl>File</Lbl>
        <div className="mt-2">
          <Tabs items={CONVERT_SOURCES} value={src} onChange={setSrc} />
        </div>
        <div className="mt-3">
          {src === "phone" ? (
            <>
              <button onClick={() => inputRef.current?.click()} className="sd-tap w-full rounded-card bg-surface-2 py-3.5 text-[13px] font-medium text-ink-1">
                Choose a file from your phone
              </button>
              <input ref={inputRef} type="file" accept=".md,.markdown,.txt,.docx,.pdf,.csv,.tsv,.xls,.xlsx" className="hidden" onChange={(e) => void importPhone(e.target.files)} />
              <p className="mt-2 text-[12px] text-ink-2">Picked files land in My files too.</p>
            </>
          ) : src === "pc" ? (
            <div className="h-64 overflow-hidden rounded-card border border-line">
              <PcBrowser compact onPulled={() => window.dispatchEvent(new Event("sd-files-changed"))} />
            </div>
          ) : (
            <div className="-mx-2 max-h-60 space-y-0.5 overflow-y-auto">
              {convertible.length === 0 && (
                <p className="px-2 py-2 text-[13px] text-ink-2">No convertible files in My files yet.</p>
              )}
              {convertible.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setSel(f.id)}
                  className={`sd-tap flex w-full items-center gap-3.5 rounded-card px-2 py-2.5 text-left ${sel === f.id ? "bg-brand-soft" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-ink-1">{f.name}</span>
                    <span className="mt-0.5 block text-[12px] text-ink-2">{f.ext} · {fmtSize(f.size)}</span>
                  </span>
                  <SelMark sel={sel === f.id} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {meta && (
        <div><Lbl>Convert to</Lbl><div className="mt-1.5">
          <Seg options={targets.map((t) => ({ v: t.id, label: t.label }))} value={target as ConvertTarget} onChange={setTarget} />
        </div></div>
      )}
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
    </ToolShell>
  );
}

// ── Smart Scan — camera pages, cleaned up, one PDF ──────

type ScanFilter = "orig" | "enhance" | "gray" | "bw";
type ScanPage = { id: string; raw: string; preview: string; filter: ScanFilter; rot: number };
const SCAN_CAP = 25;

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Could not read that photo."));
    im.src = src;
  });
}

/**
 * One page through the scanner's own pipeline: rotate, then a document
 * filter. "Enhance" is the default because phone shots of paper come back
 * grey and low-contrast; "B&W" thresholds the page for forms that want
 * crisp black text. `long` caps the long edge (0 keeps the camera's own
 * pixels) — previews pass ~420, the PDF pass keeps full size.
 */
function renderScanPage(im: HTMLImageElement, filter: ScanFilter, rot: number, long: number): HTMLCanvasElement {
  const swap = rot === 90 || rot === 270;
  const w0 = swap ? im.naturalHeight : im.naturalWidth;
  const h0 = swap ? im.naturalWidth : im.naturalHeight;
  const scale = long ? Math.min(1, long / Math.max(w0, h0)) : 1;
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rot * Math.PI) / 180);
  const iw = im.naturalWidth * scale;
  const ih = im.naturalHeight * scale;
  if (filter === "enhance") ctx.filter = "contrast(1.35) saturate(0.95) brightness(1.07)";
  else if (filter === "gray" || filter === "bw") ctx.filter = "grayscale(1) contrast(1.28) brightness(1.06)";
  ctx.drawImage(im, -iw / 2, -ih / 2, iw, ih);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  if (filter === "bw") {
    // Global threshold relative to the page's own average: a fixed cutoff
    // turns a shadowed corner solid black, the relative one does not.
    const d = ctx.getImageData(0, 0, w, h);
    const px = d.data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i]!;
    const thr = Math.max(110, Math.min(205, (sum / (px.length / 4)) * 0.86));
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i]! >= thr ? 255 : 0;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
  }
  return c;
}

function ScanFlow({ reload, close }: { reload: () => void; close: () => void }) {
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [camBusy, setCamBusy] = useState(false);
  const [name, setName] = useState("");
  const [res, setRes] = useState<{ name: string; size: number; where: string | null } | null>(null);
  const { msg, setMsg, working, setWorking } = useResult();
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const autoName = `Scan ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}`;
  const active = pages.find((p) => p.id === activeId) ?? pages[pages.length - 1] ?? null;

  const preview420 = (im: HTMLImageElement, f: ScanFilter, r: number) =>
    renderScanPage(im, f, r, 420).toDataURL("image/jpeg", 0.8);

  const addPage = async () => {
    if (camBusy) return;
    if (pages.length >= SCAN_CAP) {
      setMsg(`${SCAN_CAP} pages is as much as one scan holds.`);
      return;
    }
    setMsg(null);
    setRes(null);
    setCamBusy(true);
    try {
      const photo = await Camera.getPhoto({
        quality: 92,
        allowEditing: false,
        correctOrientation: true,
        width: 2600,
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
        saveToGallery: false,
      });
      const src = photo.webPath || photo.dataUrl;
      if (!src) throw new Error("No photo came back.");
      const im = await loadImg(src);
      const id = `${Date.now().toString(36)}-${pages.length}`;
      setPages((ps) => [
        ...ps,
        { id, raw: renderScanPage(im, "orig", 0, 0).toDataURL("image/jpeg", 0.92), preview: preview420(im, "enhance", 0), filter: "enhance", rot: 0 },
      ]);
      setActiveId(id);
    } catch (e) {
      // Backing out of the camera is not an error worth a red line.
      const m = fail(e);
      if (!/cancel/i.test(m)) setMsg(`Camera: ${m}`);
    } finally {
      setCamBusy(false);
    }
  };

  const restyle = (f: ScanFilter, rot: number) => {
    if (!active) return;
    void loadImg(active.raw).then((im) => {
      setPages((ps) => ps.map((p) => (p.id === active.id ? { ...p, filter: f, rot, preview: preview420(im, f, rot) } : p)));
    });
    setRes(null);
  };

  const remove = () => {
    if (!active) return;
    const rest = pages.filter((p) => p.id !== active.id);
    setPages(rest);
    setActiveId(rest[rest.length - 1]?.id ?? null);
    setRes(null);
    setMsg(null);
  };

  return (
    <ToolShell
      title="Smart Scan"
      sub="Camera pages into one clean PDF"
      onClose={close}
      runLabel={pages.length ? `Make PDF (${pages.length})` : "Make PDF"}
      running={working}
      disabled={!pages.length}
      mascot="scan"
      footer={
        <div className="mb-2.5">
          <div className="mb-1.5 text-[12px] font-medium text-ink-3">Save as</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={autoName} className={fieldCls} />
        </div>
      }
      onRun={() => {
        if (!pages.length) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          setRes(null);
          try {
            const urls: string[] = [];
            for (const p of pages) {
              const im = await loadImg(p.raw);
              urls.push(renderScanPage(im, p.filter, p.rot, 0).toDataURL("image/jpeg", 0.9));
            }
            const out = await imagesToPdfFromUrls(urls, { pageSize: "a4", margin: 24 });
            const typed = name.trim();
            const finalName = typed ? (/\.pdf$/i.test(typed) ? typed : `${typed}.pdf`) : `${autoName}.pdf`;
            const meta = await addFile(finalName, out);
            reload();
            const where = await exportToDownloads(meta.name, out);
            announceResult(meta, out);
            setRes({ name: meta.name, size: meta.size, where });
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}
    >
      <div>
        <Lbl>Pages{pages.length ? ` (${pages.length} of ${SCAN_CAP})` : ""}</Lbl>
        {pages.length === 0 ? (
          <button onClick={() => void addPage()} className="sd-tap mt-1.5 flex w-full items-center gap-3.5 rounded-card bg-surface-2 px-4 py-4 text-left">
            <CameraIcon className="size-5 shrink-0 text-ink-3" strokeWidth={1.75} />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-ink-1">{camBusy ? "Opening the camera…" : "Scan the first page"}</span>
              <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-2">Fill the frame with the paper — every shot lands as one page, cleaned up.</span>
            </span>
          </button>
        ) : (
          <>
            <div className="-mx-1 mt-1.5 flex gap-2 overflow-x-auto px-1 pb-1">
              {pages.map((p, i) => (
                <button
                  key={p.id}
                  onClick={() => setActiveId(p.id)}
                  aria-label={`Page ${i + 1}`}
                  className={`sd-tap relative h-[88px] w-[66px] shrink-0 overflow-hidden rounded-[8px] border ${p.id === active?.id ? "border-brand" : "border-line"}`}
                >
                  <img src={p.preview} alt="" className="h-full w-full object-cover" />
                  <span className="tnum absolute bottom-1 left-1 grid size-5 place-items-center rounded-full bg-black/55 text-[10px] font-medium text-white">{i + 1}</span>
                </button>
              ))}
              <button onClick={() => void addPage()} aria-label="Scan another page" className="sd-tap grid h-[88px] w-[66px] shrink-0 place-items-center rounded-[8px] border border-dashed border-line text-ink-3">
                <Plus className="size-5" />
              </button>
            </div>
            {active && (
              <div className="mt-1.5">
                <img src={active.preview} alt="" className="max-h-[38vh] w-full rounded-card border border-line bg-surface-1 object-contain" />
                <div className="mt-2">
                  <Seg
                    options={[
                      { v: "enhance" as const, label: "Enhance" },
                      { v: "gray" as const, label: "Grayscale" },
                      { v: "bw" as const, label: "B&W" },
                      { v: "orig" as const, label: "Original" },
                    ]}
                    value={active.filter}
                    onChange={(v) => restyle(v, active.rot)}
                  />
                </div>
                <div className="mt-2 flex gap-2">
                  <button onClick={() => restyle(active.filter, (active.rot + 90) % 360)} className="sd-tap flex h-11 flex-1 items-center justify-center gap-2 rounded-[10px] bg-surface-2 text-[13px] font-medium text-ink-1">
                    <RotateCw className="size-4 text-ink-3" strokeWidth={1.75} /> Rotate
                  </button>
                  <button onClick={() => void addPage()} className="sd-tap flex h-11 flex-1 items-center justify-center gap-2 rounded-[10px] bg-surface-2 text-[13px] font-medium text-ink-1">
                    <CameraIcon className="size-4 text-ink-3" strokeWidth={1.75} /> Add page
                  </button>
                  <button onClick={remove} aria-label="Remove this page" className="sd-tap grid h-11 w-11 shrink-0 place-items-center rounded-[10px] bg-surface-2">
                    <Trash2 className="size-4 text-ink-3" strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
      {res && (
        <ResultCard
          title="PDF created"
          lines={[
            `${pages.length} ${pages.length === 1 ? "page" : "pages"} → ${fmtSize(res.size)}`,
            `Saved: ${res.name}`,
            ...(res.where ? [`On phone: ${res.where}`] : []),
          ]}
        />
      )}
    </ToolShell>
  );
}

// ── Sign PDF — draw once, drop it on any page ──────────

const SIG_STORE_KEY = "sd-signature";
/** Signature ink on paper: near-black and the two blues people sign in. */
const SIG_INKS = [
  { v: "#12161f", label: "Black" },
  { v: "#1b3a8f", label: "Blue" },
  { v: "#8f1b1b", label: "Red" },
];

const clamp01 = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/** Crops a drawn signature down to its own ink (plus a little air), so the
 *  stroke lands where it is placed instead of inside a canvas-sized void. */
function trimSignature(source: HTMLCanvasElement): string | null {
  const { width: w, height: h } = source;
  const px = source.getContext("2d")!.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3]! > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d")!.drawImage(source, minX, minY, cw, ch, 0, 0, cw, ch);
  return out.toDataURL("image/png");
}

/** Finger drawing on a white pad, at the size the signature will keep. The
 *  pad hands over its ink as a trimmed PNG only when the user commits. */
function SignaturePad({ onCommit }: { onCommit: (png: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stroking = useRef(false);
  const [ink, setInk] = useState(SIG_INKS[0]!.v);
  const inkRef = useRef(ink);
  inkRef.current = ink;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = inkRef.current;
  }, []);

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="h-[164px] w-full rounded-card border border-line bg-white"
        style={{ touchAction: "none" }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const ctx = e.currentTarget.getContext("2d")!;
          ctx.strokeStyle = inkRef.current;
          const p = at(e);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          stroking.current = true;
        }}
        onPointerMove={(e) => {
          if (!stroking.current) return;
          const ctx = e.currentTarget.getContext("2d")!;
          const p = at(e);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }}
        onPointerUp={() => { stroking.current = false; }}
        onPointerCancel={() => { stroking.current = false; }}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => {
            const c = canvasRef.current;
            if (c) c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
          }}
          className="sd-tap flex h-11 shrink-0 items-center gap-2 rounded-[10px] bg-surface-2 px-3.5 text-[13px] font-medium text-ink-1"
        >
          <Eraser className="size-4 text-ink-3" strokeWidth={1.75} /> Clear
        </button>
        <div className="min-w-0 flex-1">
          <Seg options={SIG_INKS.map((s) => ({ v: s.v, label: s.label }))} value={ink} onChange={setInk} />
        </div>
      </div>
      <button
        onClick={() => {
          const c = canvasRef.current;
          if (!c) return;
          const png = trimSignature(c);
          if (png) onCommit(png);
        }}
        className="sd-tap mt-2 h-12 w-full rounded-card bg-surface-2 text-[14px] font-semibold text-ink-1"
      >
        Use this signature
      </button>
    </div>
  );
}

function SignFlow({ files, reload, close }: FlowProps) {
  const [sel, setSel] = useState<PickedFile | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [imgs, setImgs] = useState<Record<number, string>>({});
  const [sig, setSig] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(true);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [name, setName] = useState("");
  const [res, setRes] = useState<{ name: string; size: number; page: number; where: string | null } | null>(null);
  const { msg, setMsg, working, setWorking } = useResult();
  const dataRef = useRef<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const aspectRef = useRef(1);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const sizeRef = useRef<{ x0: number; w0: number } | null>(null);

  // A signature drawn once is worth keeping: it is offered again next time,
  // on this phone only.
  useEffect(() => {
    try {
      const s = window.localStorage.getItem(SIG_STORE_KEY);
      if (s) {
        setSig(s);
        setDrawing(false);
      }
    } catch { /* storage unavailable */ }
  }, []);

  useEffect(() => {
    if (!sel) { setTotal(0); return; }
    void pickedPageCount(sel).then(setTotal).catch(() => setTotal(0));
  }, [sel]);

  // The signature's own aspect ratio drives every resize; load it once.
  useEffect(() => {
    if (!sig) return;
    const im = new Image();
    im.onload = () => {
      aspectRef.current = im.naturalWidth / Math.max(1, im.naturalHeight);
      // The page may have settled before the ink's shape was known.
      settleRect();
    };
    im.src = sig;
  }, [sig]);

  // Placement works on pixels of the page, rendered once per page and kept.
  useEffect(() => {
    if (!sel || !sig || imgs[page]) return;
    let live = true;
    void (async () => {
      try {
        if (!dataRef.current) dataRef.current = await readPicked(sel);
        const r = await pdfPagesToImages(dataRef.current, [page], { kind: "png", longEdge: 1400 });
        const first = r[0];
        if (live && first) setImgs((m) => ({ ...m, [page]: `data:image/png;base64,${first.data}` }));
      } catch (e) {
        if (live) setMsg(`Could not draw page ${page}: ${fail(e)}`);
      }
    })();
    return () => { live = false; };
  }, [sel, sig, page, imgs]);

  const pageUrl = imgs[page] ?? null;

  /** Resting place when a page appears: lower right, the way a signature
   *  block sits on a form. Runs on every page load so the height fraction
   *  stays true when pages differ in shape. */
  const settleRect = () => {
    const box = boxRef.current;
    if (!box || !aspectRef.current) return;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    if (!bw || !bh) return;
    const hFor = (w: number) => clamp01((w * bw) / Math.max(0.01, aspectRef.current) / bh, 0.04, 1);
    setRect((r) => {
      const w = r?.w ?? 0.32;
      const h = hFor(w);
      return { x: r?.x ?? 0.6, y: clamp01(r?.y ?? 0.8 - h, 0, 1 - h), w, h };
    });
  };

  const commitSig = (png: string) => {
    setSig(png);
    setDrawing(false);
    setRect(null);
    try { window.localStorage.setItem(SIG_STORE_KEY, png); } catch { /* full or private */ }
  };

  const startDrag = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!rect || !boxRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const b = boxRef.current.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - b.left - rect.x * b.width, dy: e.clientY - b.top - rect.y * b.height };
  };

  const moveDrag = (e: React.PointerEvent<HTMLImageElement>) => {
    const d = dragRef.current;
    const box = boxRef.current;
    if (!d || !box || !rect) return;
    const b = box.getBoundingClientRect();
    setRect({ ...rect, x: clamp01((e.clientX - b.left - d.dx) / b.width, 0, 1 - rect.w), y: clamp01((e.clientY - b.top - d.dy) / b.height, 0, 1 - rect.h) });
  };

  const startResize = (e: React.PointerEvent<HTMLElement>) => {
    if (!rect) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    sizeRef.current = { x0: e.clientX, w0: rect.w };
  };

  const moveResize = (e: React.PointerEvent<HTMLElement>) => {
    const s = sizeRef.current;
    const box = boxRef.current;
    if (!s || !box || !rect) return;
    const b = box.getBoundingClientRect();
    const maxW = Math.max(0.06, Math.min(0.9, 1 - rect.x));
    const w = clamp01(s.w0 + (e.clientX - s.x0) / b.width, 0.06, maxW);
    const h = clamp01((w * b.width) / Math.max(0.01, aspectRef.current) / b.height, 0.04, Math.max(0.04, 1 - rect.y));
    setRect({ ...rect, w, h });
  };

  const autoName = sel ? stampName(sel.name, "(signed)") : "";

  return (
    <ToolShell
      title="Sign PDF"
      sub="Draw once, drop it onto any page"
      onClose={close}
      runLabel="Sign"
      running={working}
      disabled={!sel || !sig || !rect}
      mascot="sign"
      footer={
        <div className="mb-2.5">
          <div className="mb-1.5 text-[12px] font-medium text-ink-3">Save as</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={autoName || "Signed PDF"} className={fieldCls} />
        </div>
      }
      onRun={() => {
        if (!sel || !sig || !rect) return;
        void (async () => {
          setWorking(true);
          setMsg(null);
          setRes(null);
          try {
            const data = dataRef.current ?? await readPicked(sel);
            const out = await signPdfPage(data, page - 1, rect, sig);
            const typed = name.trim();
            const finalName = typed ? (/\.pdf$/i.test(typed) ? typed : `${typed}.pdf`) : stampName(sel.name, "(signed)");
            const meta = await addFile(finalName, out);
            reload();
            const where = await exportToDownloads(meta.name, out);
            announceResult(meta, out);
            setRes({ name: meta.name, size: meta.size, page, where });
          } catch (e) { setMsg(`Failed: ${fail(e)}`); } finally { setWorking(false); }
        })();
      }}
    >
      <div>
        <Lbl>PDF{total ? ` (${total} pages)` : ""}</Lbl>
        <div className="mt-1.5">
          <PdfPickOne
            appFiles={files}
            value={sel}
            onChange={(f) => {
              if (f?.key === sel?.key) return;
              setSel(f);
              dataRef.current = null;
              setImgs({});
              setRect(null);
              setPage(1);
              setRes(null);
              setMsg(null);
            }}
          />
        </div>
      </div>
      <div>
        <Lbl>Your signature</Lbl>
        {drawing || !sig ? (
          <div className="mt-1.5">
            <SignaturePad onCommit={commitSig} />
          </div>
        ) : (
          <div className="mt-1.5 rounded-card border border-line bg-white p-3">
            <img src={sig} alt="Your signature" className="mx-auto max-h-[110px] w-auto" />
            <div className="mt-2.5 flex items-center justify-between gap-3">
              <span className="text-[12px] leading-snug" style={{ color: "var(--ink-2)" }}>Kept on this phone only, and reused next time.</span>
              <button onClick={() => setDrawing(true)} className="sd-tap shrink-0 text-[13px] font-medium" style={{ color: "var(--brand-ink)" }}>
                Draw again
              </button>
            </div>
          </div>
        )}
      </div>
      {sig && sel && (
        <div>
          <div className="flex items-center justify-between">
            <Lbl>Sign on page</Lbl>
            {total > 1 && (
              <div className="flex items-center gap-3">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="sd-icon rounded-lg text-ink-2 disabled:opacity-40" aria-label="Previous page">
                  <ChevronLeft className="size-4" />
                </button>
                <span className="tnum text-[12px] text-ink-2">{page} of {total}</span>
                <button onClick={() => setPage((p) => Math.min(total, p + 1))} disabled={page >= total} className="sd-icon rounded-lg text-ink-2 disabled:opacity-40" aria-label="Next page">
                  <ChevronRight className="size-4" />
                </button>
              </div>
            )}
          </div>
          {total > 1 && (
            <div className="-mx-1 mt-1.5 flex gap-2 overflow-x-auto px-1 pb-1">
              {Array.from({ length: Math.min(total, 60) }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  onClick={() => setPage(n)}
                  aria-label={`Page ${n}`}
                  className={`relative h-[78px] w-[58px] shrink-0 overflow-hidden rounded-[8px] border bg-surface-2 ${n === page ? "border-brand" : "border-line"}`}
                >
                  <PdfPageThumb f={sel} page={n - 1} w={120} />
                  <span className="tnum absolute bottom-1 left-1 grid size-5 place-items-center rounded-full bg-black/55 text-[10px] font-medium text-white">{n}</span>
                </button>
              ))}
            </div>
          )}
          <div ref={boxRef} className="relative mt-1.5 overflow-hidden rounded-card border border-line bg-surface-1" style={{ touchAction: "none" }}>
            {pageUrl ? (
              <img src={pageUrl} onLoad={settleRect} draggable={false} alt={`Page ${page}`} className="block w-full select-none" />
            ) : (
              <div className="grid h-[38vh] place-items-center">
                <Loader2 className="size-5 animate-spin text-ink-3" />
              </div>
            )}
            {pageUrl && rect && (
              <img
                src={sig}
                alt=""
                draggable={false}
                onPointerDown={startDrag}
                onPointerMove={moveDrag}
                onPointerUp={() => { dragRef.current = null; }}
                onPointerCancel={() => { dragRef.current = null; }}
                className="absolute select-none"
                style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, touchAction: "none" }}
              />
            )}
            {pageUrl && rect && (
              <span
                onPointerDown={startResize}
                onPointerMove={moveResize}
                onPointerUp={() => { sizeRef.current = null; }}
                onPointerCancel={() => { sizeRef.current = null; }}
                className="absolute grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-line-strong bg-surface-1"
                style={{ left: `${(rect.x + rect.w) * 100}%`, top: `${(rect.y + rect.h) * 100}%`, touchAction: "none" }}
              >
                <span className="size-2.5 rounded-full bg-brand" />
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">Drag the signature where it belongs; pull the dot to resize.</p>
        </div>
      )}
      {msg && <p className="text-[13px] leading-relaxed text-ink-2">{msg}</p>}
      {res && (
        <ResultCard
          title="Signed"
          lines={[
            `Page ${res.page} of ${total || res.page} → ${fmtSize(res.size)}`,
            `Saved: ${res.name}`,
            ...(res.where ? [`On phone: ${res.where}`] : []),
          ]}
        />
      )}
    </ToolShell>
  );
}

const TOOLS = [
  { id: "resume", label: "Resume maker", icon: IdCard },
  { id: "scan", label: "Smart Scan", icon: ScanLine },
  { id: "sign", label: "Sign PDF", icon: PenLine },
  { id: "convert", label: "Convert files", icon: ArrowLeftRight },
  { id: "merge", label: "Merge PDF", icon: Combine },
  { id: "compress", label: "Compress PDF", icon: Shrink },
  { id: "imgtopdf", label: "Images to PDF", icon: FilePlus2 },
  { id: "resize", label: "Resize image", icon: Expand },
  { id: "rotate", label: "Rotate pages", icon: RotateCw },
  { id: "split", label: "Split PDF", icon: Scissors },
  { id: "sort", label: "Sort pages", icon: ArrowUpDown },
  { id: "toimages", label: "PDF to images", icon: Images },
  { id: "numbers", label: "Page numbers", icon: Hash },
  { id: "watermark", label: "Watermark", icon: Droplets },
  { id: "meta", label: "Edit metadata", icon: Tag },
  { id: "compare", label: "Compare PDFs", icon: FileDiff },
] as const;

type ToolId = (typeof TOOLS)[number]["id"];
type Tool = (typeof TOOLS)[number];
const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t])) as Record<ToolId, Tool>;

/**
 * Three headings for thirteen tools. The earlier version used five, which
 * meant a heading every three rows — the structure cost more than the content
 * it organised. Fewer, larger groups also match how the screen is actually
 * used: you arrive with one problem, not a browsing mood.
 *
 * Resume maker sits outside the groups on purpose. Every other tool takes a
 * file you already have; that one starts from nothing, and burying it in a
 * list of file operations was hiding the only tool that makes something.
 */
const GROUPS: Array<{ title: string; ids: ToolId[] }> = [
  { title: "Make it fit", ids: ["compress", "resize", "imgtopdf"] },
  { title: "Scan and sign", ids: ["scan", "sign"] },
  { title: "Convert and reorder", ids: ["convert", "merge", "toimages", "split", "sort", "rotate"] },
  { title: "Finish", ids: ["numbers", "watermark", "meta", "compare"] },
];

/** One tool, one line. The icon is texture at the edge of the eye, not a
 *  feature: a filled tile in front of every row was the tell that made the
 *  old hub read as a template. */
function Row({ id, onOpen, divider }: { id: ToolId; onOpen: (id: string) => void; divider?: boolean }) {
  const t = TOOL_BY_ID[id];
  const Icon = t.icon;
  return (
    <button
      onClick={() => onOpen(id)}
      className="sd-tap flex w-full items-center gap-4 py-3.5 text-left"
      style={{ borderTop: divider ? "1px solid var(--line)" : "none" }}
    >
      <Icon className="size-[17px] shrink-0 text-ink-3" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-[15px] text-ink-1">{t.label}</span>
    </button>
  );
}

export function Tools() {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [pendingConvert, setPendingConvert] = useState<string | null>(null);
  /** The one result viewer. Flows announce finished files through the
   *  sd-tool-result event; this screen, which outlives every open tool,
   *  is where the Reader lives — so a merge result is on screen the moment
   *  the merge ends, wherever the tool was opened from. */
  const [openRes, setOpenRes] = useState<{ meta: FileMeta; data: string } | null>(null);

  const reload = async () => setFiles(await listFiles());
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    const h = (e: Event) => {
      const id = (e as CustomEvent).detail?.convertFileId;
      if (typeof id === "string") {
        setPendingConvert(id);
        setActive("convert");
        void reload();
      }
    };
    const r = () => void reload();
    const onResult = (e: Event) => {
      const d = (e as CustomEvent<{ meta?: FileMeta; data?: string }>).detail;
      if (d?.meta && typeof d.data === "string") setOpenRes({ meta: d.meta, data: d.data });
    };
    window.addEventListener("sd-convert", h);
    window.addEventListener("sd-files-changed", r);
    window.addEventListener("sd-tool-result", onResult);
    return () => {
      window.removeEventListener("sd-convert", h);
      window.removeEventListener("sd-files-changed", r);
      window.removeEventListener("sd-tool-result", onResult);
    };
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 shrink-0">
        <h2 className="text-xl font-semibold tracking-tight">Tools</h2>
      </div>
      {/* A list, not a grid of tiles. The two-column card wall was the worst
          thing in the app: an icon tile in front of every entry, and half a
          screen of width per item, which truncated every description
          mid-word and wrapped every other title onto two lines.

          One line per row, no description. Thirteen titles and thirteen lines
          of "Reorder freely" / "Pages as PNGs" / "Diagonal mark" was the
          clutter that survived the cards — filler restating the title. The
          headings carry the meaning instead, and they are set quiet enough
          that a row can never be mistaken for one. */}
      <div className="sd-fade-in flex-1 overflow-y-auto px-4 pt-1 pb-32">
        <Row id="resume" onOpen={setActive} />
        {GROUPS.map((g) => (
          <section key={g.title} className="mt-9">
            <h3 className="mb-2 text-[12px] font-medium text-ink-3">
              {g.title}
            </h3>
            {g.ids.map((id, i) => (
              <Row key={id} id={id} onOpen={setActive} divider={i > 0} />
            ))}
          </section>
        ))}
      </div>
      {active === "resume" && <Resume onClose={() => setActive(null)} />}
      {active === "scan" && <ScanFlow reload={reload} close={() => setActive(null)} />}
      {active === "sign" && <SignFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "convert" && <ConvertFlow key={pendingConvert || "c"} files={files} reload={reload} close={() => { setActive(null); setPendingConvert(null); }} initialId={pendingConvert} />}
      {active === "compress" && <CompressFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "merge" && <MergeFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "rotate" && <RotateFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "split" && <SplitFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "sort" && <SortFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "toimages" && <ToImagesFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "numbers" && <NumbersFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "watermark" && <WatermarkFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "meta" && <MetaFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "compare" && <CompareFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "imgtopdf" && <ImgToPdfFlow files={files} reload={reload} close={() => setActive(null)} />}
      {active === "resize" && <ResizeFlow files={files} reload={reload} close={() => setActive(null)} />}
      {openRes && <Reader file={openRes.meta} base64={openRes.data} onClose={() => setOpenRes(null)} />}
    </div>
  );
}
