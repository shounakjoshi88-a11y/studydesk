import { PDFDocument, degrees, rgb, StandardFonts } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Document, Packer, Paragraph, HeadingLevel } from "docx";
import * as XLSX from "xlsx";
import { createWorker } from "tesseract.js";
import { b64ToBytes, b64ToText } from "./store";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
  }
  return btoa(s);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

// ── Preview thumbnails (pickers) ───────────────────────
/** Small first-page JPEG for a PDF that only exists inside the app store. */
export async function renderPdfThumb(base64: string, maxDim = 160): Promise<string | null> {
  try {
    const doc = await pdfjsLib.getDocument({ data: b64ToBytes(base64) }).promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = maxDim / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport }).promise;
      return canvas.toDataURL("image/jpeg", 0.7);
    } finally {
      try { await (doc as any).destroy?.(); } catch { /* noop */ }
    }
  } catch {
    return null;
  }
}

/** Small JPEG for an image that only exists inside the app store. */
export async function renderImageThumb(base64: string, maxDim = 160): Promise<string | null> {
  const bytes = b64ToBytes(base64);
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Images → PDF (A4 pages, images fit + centered) ───────
export async function imagesToPdf(items: Array<{ data: string }>): Promise<string> {
  const pdf = await PDFDocument.create();
  for (const item of items) {
    const bytes = b64ToBytes(item.data);
    const blob = new Blob([bytes.buffer as ArrayBuffer]);
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0);
      const jpg = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.92));
      if (!jpg) throw new Error("Canvas export failed");
      const jpgBytes = new Uint8Array(await jpg.arrayBuffer());
      const embedded = await pdf.embedJpg(jpgBytes);
      const page = pdf.addPage([595, 842]);
      const scale = Math.min(595 / embedded.width, 842 / embedded.height);
      const w = embedded.width * scale;
      const h = embedded.height * scale;
      page.drawImage(embedded, { x: (595 - w) / 2, y: (842 - h) / 2, width: w, height: h });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return bytesToB64(await pdf.save());
}

/**
 * Photos → PDF from drawable URLs (streamed device paths, or data URLs for
 * app-store files), so a roll of 8 MB camera photos never crosses the bridge.
 * "fit" keeps each photo's own frame; "a4" lays every page out A4 portrait
 * and letterboxes the photo inside it with the chosen margin.
 */
export async function imagesToPdfFromUrls(
  urls: string[],
  opts: { pageSize?: "fit" | "a4"; margin?: number; quality?: number } = {}
): Promise<string> {
  const pdf = await PDFDocument.create();
  for (const url of urls) {
    const img = await loadImage(url);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    const jpg = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", opts.quality ?? 0.9));
    if (!jpg) throw new Error("Couldn't re-encode an image.");
    const embedded = await pdf.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
    if (opts.pageSize === "a4") {
      const PW = 595;
      const PH = 842;
      const margin = opts.margin ?? 24;
      const page = pdf.addPage([PW, PH]);
      const scale = Math.min((PW - margin * 2) / embedded.width, (PH - margin * 2) / embedded.height);
      const w = embedded.width * scale;
      const h = embedded.height * scale;
      page.drawImage(embedded, { x: (PW - w) / 2, y: (PH - h) / 2, width: w, height: h });
    } else {
      const margin = opts.margin ?? 0;
      const page = pdf.addPage([embedded.width + margin * 2, embedded.height + margin * 2]);
      page.drawImage(embedded, { x: margin, y: margin, width: embedded.width, height: embedded.height });
    }
  }
  return bytesToB64(await pdf.save());
}

// ── PDF → text ───────────────────────────────────────────
export async function pdfPageCount(base64: string): Promise<number> {
  const doc = await pdfjsLib.getDocument({ data: b64ToBytes(base64) }).promise;
  const n = doc.numPages;
  return n;
}

export async function extractPdfText(base64: string, filename: string): Promise<string> {
  const doc = await pdfjsLib.getDocument({ data: b64ToBytes(base64) }).promise;
  const parts: string[] = [`# ${filename} — extracted text`, ""];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map((it: any) => ("str" in it ? it.str : "")).join(" ");
    parts.push(`## Page ${i}`, "", text.trim() || "(no text on this page)", "");
  }
  return parts.join("\n");
}

export function parseKeepSpec(spec: string, total: number): number[] {
  const keep = new Set<number>();
  for (const chunk of spec.split(",")) {
    const c = chunk.trim();
    if (!c) continue;
    const m = c.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Math.max(1, Math.min(total, parseInt(m[1]!, 10)));
      const b = Math.max(1, Math.min(total, parseInt(m[2]!, 10)));
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) keep.add(i);
    } else if (/^\d+$/.test(c)) {
      const n = parseInt(c, 10);
      if (n >= 1 && n <= total) keep.add(n);
    }
  }
  return [...keep].sort((a, b) => a - b);
}

export async function keepPdfPages(base64: string, keep: number[]): Promise<string> {
  const src = await PDFDocument.load(b64ToBytes(base64), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, keep.map((n) => n - 1));
  pages.forEach((p) => out.addPage(p));
  return bytesToB64(await out.save());
}

export async function mergePdfs(list: string[]): Promise<string> {
  const out = await PDFDocument.create();
  for (const b64 of list) {
    const src = await PDFDocument.load(b64ToBytes(b64), { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return bytesToB64(await out.save());
}

// ── DOCX → text / note → DOCX ────────────────────────────
export function mdToDocxParagraphs(title: string, md: string) {
  const paras: InstanceType<typeof Paragraph>[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  ];
  let inCode = false;
  for (const raw of md.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      paras.push(new Paragraph({ text: line, style: "IntenseQuote" }));
      continue;
    }
    const h3 = line.match(/^###\s+(.*)/);
    const h2 = line.match(/^##\s+(.*)/);
    const h1 = line.match(/^#\s+(.*)/);
    const bullet = line.match(/^[-*]\s+(.*)/);
    const numbered = line.match(/^\d+[.)]\s+(.*)/);
    if (h1) paras.push(new Paragraph({ text: h1[1], heading: HeadingLevel.HEADING_1 }));
    else if (h2) paras.push(new Paragraph({ text: h2[1], heading: HeadingLevel.HEADING_2 }));
    else if (h3) paras.push(new Paragraph({ text: h3[1], heading: HeadingLevel.HEADING_3 }));
    else if (bullet) paras.push(new Paragraph({ text: bullet[1], bullet: { level: 0 } }));
    else if (numbered) paras.push(new Paragraph({ text: numbered[1], numbering: undefined }));
    else if (!line.trim()) paras.push(new Paragraph({ text: "" }));
    else paras.push(new Paragraph({ text: line.replace(/[*_`~#]/g, "") }));
  }
  return paras;
}

export async function noteToDocx(title: string, md: string): Promise<string> {
  const doc = new Document({ sections: [{ children: mdToDocxParagraphs(title, md) }] });
  const blob = await Packer.toBlob(doc);
  const buf = new Uint8Array(await blob.arrayBuffer());
  return bytesToB64(buf);
}

// ── OCR: image → text ────────────────────────────────────
export async function ocrImage(
  base64: string,
  ext: string,
  onProgress: (p: number, stage: string) => void
): Promise<string> {
  onProgress(0.05, "Loading text reader…");
  const worker: any = await createWorker("eng");
  try {
    await worker.setParameters({ tessedit_pageseg_mode: "6" } as any).catch(() => {});
    const bytes = b64ToBytes(base64);
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      onProgress(0.2, "First run downloads the reader (once), then reads…");
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = url;
      });
      const scale = Math.max(1, Math.min(2.5, 2000 / Math.max(img.naturalWidth, img.naturalHeight)));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.filter = "grayscale(1) contrast(1.2)";
      ctx.drawImage(img, 0, 0, c.width, c.height);
      ctx.filter = "none";
      onProgress(0.3, "Reading page…");
      const { data }: any = await worker.recognize(c);
      onProgress(1, "Done");
      const text = String(data?.text || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (!text) throw new Error("No text found in this image.");
      return text;
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    try { await worker.terminate(); } catch { /* noop */ }
  }
}

export function textOfFile(ext: string, base64: string): string {
  return b64ToText(base64);
}

export const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "css",
  "js", "jsx", "ts", "tsx", "py", "java", "c", "h", "cpp", "cc", "cs",
  "go", "rs", "php", "rb", "swift", "kt", "sql", "sh", "yaml", "yml",
  "toml", "ini", "log",
]);

export function stampName(name: string, suffix: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} ${suffix}`;
  return `${name.slice(0, dot)} ${suffix}${name.slice(dot)}`;
}

// ── Compress PDF (re-render pages as JPEG) ─────────────
// Level dictates the page's long edge in pixels; quality tunes the JPEG.
// The reference app's "Medium" produced ~1600 px pages — our default parity.
export async function compressPdf(
  base64: string,
  opts: { longEdge?: number; quality?: number; onProgress?: (done: number, total: number) => void }
): Promise<{ data: string; pages: number }> {
  const quality = opts.quality ?? 0.8;
  const doc = await pdfjsLib.getDocument({ data: b64ToBytes(base64) }).promise;
  const total = doc.numPages;
  const out = await PDFDocument.create();
  try {
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = opts.longEdge ? opts.longEdge / Math.max(base.width, base.height) : 1.4;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality));
      if (!blob) throw new Error(`Page ${i} render failed`);
      const jpg = new Uint8Array(await blob.arrayBuffer());
      const embedded = await out.embedJpg(jpg);
      const p = out.addPage([canvas.width, canvas.height]);
      p.drawImage(embedded, { x: 0, y: 0, width: canvas.width, height: canvas.height });
      opts.onProgress?.(i, total);
      await new Promise((r) => setTimeout(r, 0)); // let the progress line repaint
    }
  } finally {
    try { await (doc as any).destroy?.(); } catch { /* noop */ }
  }
  return { data: bytesToB64(await out.save()), pages: total };
}

// ── Rotate pages ───────────────────────────────────────
export async function rotatePdfPages(base64: string, deg: 90 | 180 | 270, pages: number[] | null): Promise<string> {
  const pdf = await PDFDocument.load(b64ToBytes(base64), { ignoreEncryption: true });
  pdf.getPages().forEach((p, i) => {
    if (!pages || pages.includes(i + 1)) {
      p.setRotation(degrees((p.getRotation().angle + deg) % 360));
    }
  });
  return bytesToB64(await pdf.save());
}

// ── Reorder pages ──────────────────────────────────────
export async function reorderPdfPages(base64: string, order: number[]): Promise<string> {
  const src = await PDFDocument.load(b64ToBytes(base64), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, order.map((n) => n - 1));
  pages.forEach((p) => out.addPage(p));
  return bytesToB64(await out.save());
}

// ── Page numbers ───────────────────────────────────────
export async function numberPdfPages(base64: string): Promise<string> {
  const pdf = await PDFDocument.load(b64ToBytes(base64), { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.getPages().forEach((p, i) => {
    const { width } = p.getSize();
    const label = `${i + 1}`;
    p.drawText(label, { x: width / 2 - font.widthOfTextAtSize(label, 9) / 2, y: 24, size: 9, font, color: rgb(0.45, 0.45, 0.45) });
  });
  return bytesToB64(await pdf.save());
}

// ── Watermark ──────────────────────────────────────────
export async function watermarkPdf(base64: string, text: string): Promise<string> {
  const pdf = await PDFDocument.load(b64ToBytes(base64), { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const size = 52;
  pdf.getPages().forEach((p) => {
    const { width, height } = p.getSize();
    const w = font.widthOfTextAtSize(text, size);
    p.drawText(text, {
      x: width / 2 - w / 2, y: height / 2, size, font,
      color: rgb(0.5, 0.5, 0.55), opacity: 0.16, rotate: degrees(45),
    });
  });
  return bytesToB64(await pdf.save());
}

// ── Metadata ───────────────────────────────────────────
export async function setPdfMeta(
  base64: string, meta: { title?: string; author?: string; subject?: string; keywords?: string }
): Promise<string> {
  const pdf = await PDFDocument.load(b64ToBytes(base64), { ignoreEncryption: true });
  if (meta.title !== undefined) pdf.setTitle(meta.title);
  if (meta.author !== undefined) pdf.setAuthor(meta.author);
  if (meta.subject !== undefined) pdf.setSubject(meta.subject);
  if (meta.keywords !== undefined) pdf.setKeywords(meta.keywords.split(/[,;]/).map((s) => s.trim()).filter(Boolean));
  return bytesToB64(await pdf.save());
}

// ── PDF pages → image files ────────────────────────────
export type PdfImageOpts = {
  /** JPG is the default: these exports almost always feed an upload form, and
   *  forms that accept PNG also accept JPEG. */
  kind?: "jpg" | "png";
  /** Long edge of the output in pixels, or 0 to keep the old 1.6x render. */
  longEdge?: number;
  /** JPEG quality; ignored for PNG. */
  quality?: number;
  onProgress?: (done: number, total: number) => void;
};

export async function pdfPagesToImages(
  base64: string,
  pages: number[],
  opts: PdfImageOpts = {}
): Promise<Array<{ page: number; data: string }>> {
  const mime = (opts.kind ?? "jpg") === "png" ? "image/png" : "image/jpeg";
  const doc = await pdfjsLib.getDocument({ data: b64ToBytes(base64) }).promise;
  const out: Array<{ page: number; data: string }> = [];
  try {
    let done = 0;
    for (const n of pages) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      // A long-edge target means one number covers portrait scans and
      // landscape slides alike; 0 keeps the old fixed 1.6x.
      const scale = opts.longEdge
        ? Math.max(0.1, opts.longEdge / Math.max(base.width, base.height))
        : 1.6;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, opts.quality ?? 0.92));
      if (!blob) throw new Error(`Page ${n} failed`);
      out.push({ page: n, data: bytesToB64(new Uint8Array(await blob.arrayBuffer())) });
      done++;
      opts.onProgress?.(done, pages.length);
    }
  } finally {
    try { await (doc as any).destroy?.(); } catch { /* noop */ }
  }
  return out;
}

// ── Sign a page ────────────────────────────────────────
/**
 * Stamps a drawn signature onto one page. `rect` is fractions of the page
 * measured from its top-left, the way the placement screen sees it; pdf-lib
 * measures points from the bottom-left, so the flip happens here and no
 * caller has to think in PDF coordinates. `pngDataUrl` may or may not carry
 * the data-URL prefix — both are accepted.
 */
export async function signPdfPage(
  base64: string,
  pageIndex: number,
  rect: { x: number; y: number; w: number; h: number },
  pngDataUrl: string
): Promise<string> {
  const pdf = await PDFDocument.load(b64ToBytes(base64), { ignoreEncryption: true });
  const pages = pdf.getPages();
  const page = pages[pageIndex];
  if (!page) throw new Error("That page is not in the document.");
  const { width: W, height: H } = page.getSize();
  const comma = pngDataUrl.indexOf(",");
  const sig = await pdf.embedPng(b64ToBytes(comma >= 0 ? pngDataUrl.slice(comma + 1) : pngDataUrl));
  const w = rect.w * W;
  const h = rect.h * H;
  page.drawImage(sig, {
    x: rect.x * W,
    y: H - rect.y * H - h,
    width: w,
    height: h,
  });
  return bytesToB64(await pdf.save());
}

// ── Image resize / compress ────────────────────────────
export async function resizeImage(
  base64: string, ext: string, opts: { maxDim?: number; quality?: number; targetKB?: number }
): Promise<{ data: string; width: number; height: number; bytes: number }> {
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return resizeImageSrc(`data:${mime};base64,${base64}`, opts);
}

/** Same resize/encode pipeline, but the caller supplies a drawable URL — a
 *  streamed device path or a data URL — so big photos are never dragged
 *  across the bridge as base64 only to be decoded back into pixels. */
export async function resizeImageSrc(
  url: string, opts: { maxDim?: number; quality?: number; targetKB?: number }
): Promise<{ data: string; width: number; height: number; bytes: number }> {
  {
    const img = await loadImage(url);
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const maxDim = opts.maxDim || Math.max(w, h);
    if (Math.max(w, h) > maxDim) {
      const s = maxDim / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    const toJpg = async (q: number): Promise<Uint8Array> => {
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", q));
      if (!blob) throw new Error("Encode failed");
      return new Uint8Array(await blob.arrayBuffer());
    };
    let out = await toJpg(opts.quality ?? 0.85);
    if (opts.targetKB) {
      const target = opts.targetKB * 1024;
      let q = opts.quality ?? 0.85;
      while (out.length > target && q > 0.25) {
        q -= 0.1;
        out = await toJpg(q);
      }
      let dim = Math.max(w, h);
      while (out.length > target && dim > 320) {
        dim = Math.round(dim * 0.8);
        const s = dim / Math.max(w, h);
        c.width = Math.round(w * s);
        c.height = Math.round(h * s);
        const c2 = c.getContext("2d")!;
        c2.drawImage(img, 0, 0, c.width, c.height);
        out = await toJpg(0.7);
      }
    }
    return { data: bytesToB64(out), width: w, height: h, bytes: out.length };
  }
}

// ── Compare two PDFs (line-set diff) ───────────────────
export async function comparePdfs(aB64: string, bB64: string): Promise<{ sim: number; onlyA: string[]; onlyB: string[] }> {
  const textA = (await extractPdfText(aB64, "a")).split("\n");
  const textB = (await extractPdfText(bB64, "b")).split("\n");
  const setB = new Set(textB.map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 3));
  const setA = new Set(textA.map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 3));
  const onlyA = [...setA].filter((l) => !setB.has(l)).slice(0, 40);
  const onlyB = [...setB].filter((l) => !setA.has(l)).slice(0, 40);
  const shared = [...setA].filter((l) => setB.has(l)).length;
  const sim = setA.size + setB.size === 0 ? 100 : Math.round((200 * shared) / (setA.size + setB.size));
  return { sim, onlyA, onlyB };
}

// ── Markdown → PDF (clean study layout) ────────────────
export async function mdToPdf(title: string, md: string): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const M = 48;
  const PW = 595;
  const PH = 842;
  const MAXW = PW - M * 2;
  let page = pdf.addPage([PW, PH]);
  let y = PH - M;
  const newPage = () => {
    page = pdf.addPage([PW, PH]);
    y = PH - M;
  };
  const wrap = (text: string, f: any, size: number): string[] => {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (f.widthOfTextAtSize(t, size) > MAXW && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = t;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  };
  const draw = (text: string, f: any, size: number, indent = 0) => {
    for (const ln of wrap(text, f, size)) {
      if (y < M + 16) newPage();
      page.drawText(ln, { x: M + indent, y: y - size, size, font: f, color: rgb(0.12, 0.12, 0.14) });
      y -= size + 5;
    }
  };
  for (const ln of wrap(title, bold, 20)) {
    if (y < M + 22) newPage();
    page.drawText(ln, { x: M, y: y - 20, size: 20, font: bold, color: rgb(0.1, 0.1, 0.12) });
    y -= 27;
  }
  y -= 6;
  let inCode = false;
  for (const raw of md.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^```/.test(line)) {
      inCode = !inCode;
      y -= 4;
      continue;
    }
    if (inCode) {
      draw("  " + line, mono, 8.5);
      continue;
    }
    const h1 = line.match(/^#\s+(.*)/);
    const h2 = line.match(/^##\s+(.*)/);
    const h3 = line.match(/^###\s+(.*)/);
    const b = line.match(/^[-*]\s+(.*)/);
    const n = line.match(/^\d+[.)]\s+(.*)/);
    if (h1) draw(h1[1]!, bold, 16);
    else if (h2) draw(h2[1]!, bold, 13.5);
    else if (h3) draw(h3[1]!, bold, 11.5);
    else if (b) draw("• " + b[1], font, 10, 10);
    else if (n) draw(n[1]!, font, 10, 10);
    else if (!line.trim()) y -= 6;
    else draw(line.replace(/[*_`~#]/g, ""), font, 10);
  }
  return bytesToB64(await pdf.save());
}

// ── DOCX → Markdown (structure kept) ───────────────────
export async function docxToMd(base64: string, title: string): Promise<string> {
  const bytes = b64ToBytes(base64);
  const mammoth = (await import("mammoth")).default;
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
  let md = html;
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n# ${stripTags(t)}\n`);
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${stripTags(t)}\n`);
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${stripTags(t)}\n`);
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, (_, __, t) => `**${stripTags(t)}**`);
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, (_, __, t) => `*${stripTags(t)}*`);
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${stripTags(t)}`);
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<\/(p|div|tr)>/gi, "\n");
  md = md.replace(/<td[^>]*>([\s\S]*?)<\/td>/gi, (_, t) => `${stripTags(t)} | `);
  md = stripTags(md);
  md = md.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  md = md.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return `# ${title}\n\n${md}\n`;
}

function stripTags(s: string): string {
  const div = document.createElement("div");
  div.innerHTML = s;
  return (div.textContent || "").trim();
}

// ── Spreadsheet swaps ──────────────────────────────────
export function sheetToMdTable(base64: string): string {
  const wb = XLSX.read(b64ToBytes(base64), { type: "array" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name]!, { header: 1 }) as any[][];
    if (!rows.length) continue;
    parts.push(`## ${name}`, "");
    const head = rows[0]!.map((c) => String(c ?? ""));
    parts.push(`| ${head.join(" | ")} |`);
    parts.push(`| ${head.map(() => "---").join(" | ")} |`);
    for (const r of rows.slice(1, 200)) {
      parts.push(`| ${head.map((_, i) => String(r[i] ?? "")).join(" | ")} |`);
    }
    parts.push("");
  }
  return parts.join("\n") || "(empty spreadsheet)";
}

export function textToXlsx(text: string, delimiter: "," | "\t" | ";" = ","): string {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .slice(0, 5000)
    .map((l) => l.split(delimiter).map((c) => c.trim()));
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const arr = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return bytesToB64(new Uint8Array(arr));
}

export type ConvertTarget = "docx" | "pdf" | "md" | "xlsx" | "csv";

export function convertTargetsFor(ext: string): Array<{ id: ConvertTarget; label: string }> {
  if (ext === "md" || ext === "markdown" || ext === "txt") {
    return [
      { id: "docx", label: "Word (.docx)" },
      { id: "pdf", label: "PDF" },
    ];
  }
  if (ext === "docx") {
    return [
      { id: "md", label: "Markdown (.md)" },
      { id: "pdf", label: "PDF" },
    ];
  }
  if (ext === "pdf") return [{ id: "md", label: "Text (.md)" }];
  if (ext === "csv" || ext === "tsv") {
    return [
      { id: "xlsx", label: "Excel (.xlsx)" },
      { id: "md", label: "Table (.md)" },
    ];
  }
  if (ext === "xls" || ext === "xlsx") {
    return [
      { id: "csv", label: "CSV" },
      { id: "md", label: "Table (.md)" },
    ];
  }
  return [];
}

export async function convertFile(
  ext: string, base64: string, name: string, target: ConvertTarget
): Promise<{ outName: string; data: string; asText?: string }> {
  const base = name.replace(/\.[^.]+$/, "") || name;
  if ((ext === "md" || ext === "markdown" || ext === "txt") && target === "docx") {
    return { outName: `${base}.docx`, data: await noteToDocx(base, b64ToText(base64)) };
  }
  if ((ext === "md" || ext === "markdown" || ext === "txt") && target === "pdf") {
    return { outName: `${base}.pdf`, data: await mdToPdf(base, b64ToText(base64)) };
  }
  if (ext === "docx" && target === "md") {
    const md = await docxToMd(base64, base);
    return { outName: `${base}.md`, data: "", asText: md };
  }
  if (ext === "docx" && target === "pdf") {
    const md = await docxToMd(base64, base);
    return { outName: `${base}.pdf`, data: await mdToPdf(base, md) };
  }
  if (ext === "pdf" && target === "md") {
    const md = await extractPdfText(base64, base);
    return { outName: `${base}.md`, data: "", asText: md };
  }
  if ((ext === "csv" || ext === "tsv") && target === "xlsx") {
    return { outName: `${base}.xlsx`, data: textToXlsx(b64ToText(base64), ext === "tsv" ? "\t" : ",") };
  }
  if ((ext === "csv" || ext === "tsv") && target === "md") {
    return { outName: `${base}.md`, data: "", asText: `# ${base}\n\n${toCsvTable(b64ToText(base64))}\n` };
  }
  if ((ext === "xls" || ext === "xlsx") && target === "csv") {
    const wb = XLSX.read(b64ToBytes(base64), { type: "array" });
    const first = wb.SheetNames[0]!;
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[first]!);
    return { outName: `${base}.csv`, data: "", asText: csv };
  }
  if ((ext === "xls" || ext === "xlsx") && target === "md") {
    return { outName: `${base}.md`, data: "", asText: `# ${base}\n\n${sheetToMdTable(base64)}\n` };
  }
  throw new Error("Conversion not supported.");
}

function toCsvTable(text: string): string {
  const rows = text.trim().split(/\r?\n/).slice(0, 200).map((r) => r.split(","));
  if (!rows.length) return text;
  const head = `| ${rows[0]!.map((c) => c.trim()).join(" | ")} |`;
  const sep = `| ${rows[0]!.map(() => "---").join(" | ")} |`;
  const body = rows.slice(1).map((r) => `| ${r.map((c) => (c ?? "").trim()).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

export function textToB64(t: string): string {
  const bytes = new TextEncoder().encode(t);
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
  }
  return btoa(s);
}
