import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, Lock, TriangleAlert, ZoomIn, ZoomOut } from "lucide-react";
import mammoth from "mammoth";
import DOMPurify from "dompurify";
import { MessageRenderer } from "./MessageRenderer";
import { PdfPreview } from "./PdfPreview";
import { PptxPreview } from "./PptxPreview";
import { XlsxPreview } from "./XlsxPreview";
import { humanSize } from "../lib/deviceFiles";
import { b64ToBytes, b64ToText, type FileMeta } from "../lib/store";

const CODE_EXTS = new Set([
  "js", "jsx", "ts", "tsx", "py", "java", "c", "h", "cpp", "cc", "cs",
  "go", "rs", "php", "rb", "swift", "kt", "sql", "sh", "bash", "yaml",
  "yml", "json", "xml", "html", "css", "toml", "ini", "cfg", "log",
]);
const IMG_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"]);

const IMG_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml",
};

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function toCsvTable(text: string): string {
  const rows = text.trim().split(/\r?\n/).slice(0, 200).map((r) => r.split(","));
  if (!rows.length) return text;
  const head = `| ${rows[0]!.map((c) => c.trim()).join(" | ")} |`;
  const sep = `| ${rows[0]!.map(() => "---").join(" | ")} |`;
  const body = rows.slice(1).map((r) => `| ${r.map((c) => (c ?? "").trim()).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

/** How much of a file with no formatter gets shown as a hex dump. */
const HEX_BYTES = 4096;

/** First bytes of a base64 payload, as numbers — for sniffing signatures. */
function headBytes(base64: string, n: number): number[] {
  const bytes = b64ToBytes(base64);
  const out: number[] = [];
  for (let i = 0; i < Math.min(n, bytes.length); i += 1) out.push(bytes[i] ?? 0);
  return out;
}

/**
 * File signatures worth naming, matched against the first bytes rather than
 * the extension: a .db that was renamed is still a database, and extensionless
 * files (WhatsApp photos, .nomedia holders) are everywhere on a phone.
 * Longest signatures are listed first so weaker ones never shadow them.
 */
const MAGIC_SIGNS: Array<{ sig: number[]; label: string }> = [
  { sig: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74], label: "SQLite database" },
  { sig: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: "7-zip archive" },
  { sig: [0x50, 0x4b, 0x03, 0x04], label: "ZIP archive" },
  { sig: [0x1a, 0x45, 0xdf, 0xa3], label: "Matroska / WebM video" },
  { sig: [0x1f, 0x8b], label: "gzip file" },
  { sig: [0x7f, 0x45, 0x4c, 0x46], label: "ELF binary" },
  { sig: [0x64, 0x65, 0x78, 0x0a], label: "Dalvik bytecode" },
  { sig: [0x52, 0x61, 0x72, 0x21], label: "RAR archive" },
  { sig: [0x4f, 0x67, 0x67, 0x53], label: "Ogg media" },
  { sig: [0x66, 0x4c, 0x61, 0x43], label: "FLAC audio" },
  { sig: [0x49, 0x44, 0x33], label: "MP3 audio" },
  { sig: [0x25, 0x50, 0x44, 0x46], label: "PDF document" },
  { sig: [0x52, 0x49, 0x46, 0x46], label: "RIFF media" },
  { sig: [0x89, 0x50, 0x4e, 0x47], label: "PNG image" },
  { sig: [0xff, 0xd8, 0xff], label: "JPEG image" },
  { sig: [0x42, 0x4d], label: "BMP image" },
];

/** What a file with no reader turns out to be, in the plainest words. */
function describeBinary(base64: string, ext: string): string {
  const head = headBytes(base64, 16);
  for (const m of MAGIC_SIGNS) {
    if (m.sig.every((b, i) => head[i] === b)) {
      if (m.label === "ZIP archive") {
        if (ext === "apk") return "Android app package";
        if (ext === "jar") return "Java archive";
        if (ext === "epub") return "EPUB book";
        if (ext === "docx" || ext === "xlsx" || ext === "pptx") return "Office document";
      }
      return m.label;
    }
  }
  if (!head.length) return "Empty file";
  return "Binary file";
}

/**
 * The first few KB exactly as they sit on disk: offset, hex bytes, and the
 * ones that happen to be printable characters. This is the honest preview for
 * anything the app has no formatter for — a .db, a .so, a corrupted .log.
 */
function hexPreview(base64: string): string {
  const bytes = b64ToBytes(base64);
  const end = Math.min(bytes.length, HEX_BYTES);
  const lines: string[] = [];
  for (let i = 0; i < end; i += 16) {
    let hex = "";
    let ascii = "";
    for (let j = 0; j < 16; j += 1) {
      const at = i + j;
      if (at >= end) {
        hex += "   ";
        ascii += " ";
        continue;
      }
      const b = bytes[at] ?? 0;
      hex += `${b.toString(16).padStart(2, "0")} `;
      ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : "·";
    }
    lines.push(`${i.toString(16).padStart(6, "0")}  ${hex} ${ascii}`);
  }
  return lines.join("\n");
}

export function Reader({
  file,
  base64,
  onClose,
}: {
  file: FileMeta;
  base64: string;
  onClose: () => void;
}) {
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [docxErr, setDocxErr] = useState<string | null>(null);
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showHex, setShowHex] = useState(false);

  useEffect(() => {
    setZoom(1);
    setShowHex(false);
  }, [base64]);

  const kind = useMemo(() => {
    const e = file.ext;
    if (e === "md" || e === "markdown" || e === "txt") return "markdown";
    if (CODE_EXTS.has(e)) return "code";
    if (e === "csv" || e === "tsv") return "csv";
    if (e === "docx") return "docx";
    if (e === "pptx" || e === "ppt") return "pptx";
    if (e === "xlsx" || e === "xls") return "xlsx";
    if (e === "pdf") return "pdf";
    if (IMG_EXTS.has(e)) return "image";
    if (e === "mp4" || e === "webm") return "video";
    if (e === "crypt15" || e === "crypt14") return "backup";
    return "binary";
  }, [file.ext]);

  useEffect(() => {
    let url: string | null = null;
    if (kind === "image" || kind === "video") {
      const bytes = b64ToBytes(base64);
      const mime = kind === "video" ? "video/mp4" : IMG_MIME[file.ext] || "application/octet-stream";
      url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: mime }));
      setObjUrl(url);
    }
    if (kind === "docx") {
      setDocxHtml(null);
      setDocxErr(null);
      (async () => {
        try {
          const bytes = b64ToBytes(base64);
          const res = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
          setDocxHtml(DOMPurify.sanitize(res.value));
        } catch (e) {
          setDocxErr(String(e));
        }
      })();
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [base64, kind, file.ext]);

  const text = useMemo(() => b64ToText(base64), [base64]);

  const binaryLabel = useMemo(
    () => (kind === "binary" ? describeBinary(base64, file.ext) : ""),
    [kind, base64, file.ext],
  );
  const hexText = useMemo(
    () => (kind === "binary" || kind === "backup" ? hexPreview(base64) : ""),
    [kind, base64],
  );
  /** A sticker's encrypted backup, specifically — everything else under
   *  WhatsApp's Backups/ folder is a database of some kind. */
  const stickerBackup = useMemo(
    () => /\/sticker/i.test(file.id) || /\.(webp|png|jpg|was)\.crypt1[45]$/i.test(file.name),
    [file.id, file.name],
  );

  const download = () => {
    const bytes = b64ToBytes(base64);
    downloadBlob(new Blob([bytes.buffer as ArrayBuffer]), file.name);
  };

  const noop = () => {};

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex items-center gap-2 px-3 pb-2.5 border-b border-line shrink-0 bg-background pt-[max(30px,env(safe-area-inset-top))]">
        <button onClick={onClose} className="sd-press sd-icon -ml-2" aria-label="Back">
          <ArrowLeft className="size-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{file.name}</div>
          <div className="text-[11px] text-ink-2 uppercase tracking-wide">
            {kind === "binary" ? binaryLabel : kind === "backup" ? "encrypted backup" : kind}
          </div>
        </div>
        {kind === "pdf" && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} className="sd-press p-2.5 rounded-lg" aria-label="Zoom out">
              <ZoomOut className="size-4" />
            </button>
            <button onClick={() => setZoom(1)} className="tnum px-1 text-[11px] font-bold text-ink-2 min-w-9" aria-label="Reset zoom">
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} className="sd-press p-2.5 rounded-lg" aria-label="Zoom in">
              <ZoomIn className="size-4" />
            </button>
          </div>
        )}
        <button onClick={download} className="sd-press sd-icon" aria-label="Download">
          <Download className="size-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {kind === "markdown" && (
          <div className="px-4 py-3">
            <MessageRenderer content={text} onCitationClick={noop} sources={[]} />
          </div>
        )}
        {kind === "code" && (
          <div className="px-4 py-3">
            <MessageRenderer content={"```" + file.ext + "\n" + text + "\n```"} onCitationClick={noop} sources={[]} />
          </div>
        )}
        {kind === "csv" && (
          <div className="px-4 py-3">
            <MessageRenderer content={toCsvTable(text)} onCitationClick={noop} sources={[]} />
          </div>
        )}
        {kind === "docx" && (
          <div className="px-4 py-3">
            {docxHtml && (
              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: docxHtml }} />
            )}
            {docxErr && (
              <div className="flex items-start gap-2 text-sm text-caution-text bg-[var(--att-caution)]/10 border border-[var(--att-caution)]/30 rounded-card p-3">
                <TriangleAlert className="size-4 mt-0.5 shrink-0" />
                <span>Could not render this .docx: {docxErr}</span>
              </div>
            )}
            {!docxHtml && !docxErr && <p className="text-sm text-ink-2">Converting document…</p>}
          </div>
        )}
        {kind === "pptx" &&
          (file.ext === "pptx" ? (
            <PptxPreview base64={base64} filename={file.name} onClose={onClose} onDownload={download} />
          ) : (
            <div className="p-6 text-sm text-ink-2">
              Legacy .ppt files can't render in-app. Open with an Office app or convert to .pptx on your PC.
            </div>
          ))}
        {kind === "xlsx" && (
          <XlsxPreview base64={base64} filename={file.name} onClose={onClose} onDownload={download} />
        )}
        {kind === "pdf" && (
          <div className="bg-neutral-200 min-h-full px-2 py-2">
            <PdfPreview base64={base64} zoom={zoom} onZoomChange={setZoom} />
          </div>
        )}
        {kind === "image" && objUrl && (
          <div className="p-4 flex justify-center">
            <img src={objUrl} alt={file.name} className="max-w-full rounded-lg" />
          </div>
        )}
        {kind === "video" && objUrl && (
          <div className="p-4">
            <video src={objUrl} controls className="w-full rounded-lg" playsInline />
          </div>
        )}
        {kind === "backup" && (
          <div className="px-4 py-3">
            <div className="rounded-card border border-line bg-surface-1 p-4">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2">
                  <Lock className="size-4" style={{ color: "var(--ink-2)" }} />
                </span>
                <span className="text-[14px] font-semibold text-ink-1">WhatsApp encrypted backup</span>
              </div>
              <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">
                {stickerBackup
                  ? "WhatsApp keeps an end-to-end encrypted copy of each sticker here for its own backups. The long name is the reference WhatsApp assigned it, not something you are meant to read, and the contents are sealed with WhatsApp's backup key. The readable sticker, whenever it is still installed, lives in the WhatsApp Stickers folder."
                  : "This is one of WhatsApp's end-to-end encrypted backup files. Its contents are sealed with the backup key WhatsApp keeps in its private app storage, so no other app — this one included — can open or preview it."}
              </p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
                {file.size > 0 && <span>{humanSize(file.size)} on disk</span>}
                <span>Sealed with AES-256-GCM</span>
              </div>
              {hexText && (
                <button
                  onClick={() => setShowHex((v) => !v)}
                  className="sd-press mt-3 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink-1 hover:bg-surface-2"
                >
                  {showHex ? "Hide raw bytes" : "Show the first 4 KB as raw bytes"}
                </button>
              )}
            </div>
            {showHex && hexText && (
              <pre className="mt-3 overflow-x-auto rounded-card border border-line bg-surface-1 p-3 font-mono text-[10.5px] leading-[1.6] text-ink-1">
                {hexText}
              </pre>
            )}
          </div>
        )}
        {kind === "binary" && (
          <div className="px-4 py-3">
            <div className="rounded-card border border-line bg-surface-1 p-3">
              <div className="text-[13px] font-medium text-ink-1">
                {binaryLabel}
                {file.size > 0 && (
                  <span className="text-ink-2"> · {Math.round(file.size / 1024)} KB</span>
                )}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
                No formatted preview exists for this type, so this is the file's
                first {HEX_BYTES / 1024} KB exactly as stored on disk.
              </p>
            </div>
            {hexText ? (
              <pre className="mt-3 overflow-x-auto rounded-card border border-line bg-surface-1 p-3 font-mono text-[10.5px] leading-[1.6] text-ink-1">
                {hexText}
              </pre>
            ) : (
              <p className="mt-3 text-sm text-ink-2">This file is empty.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
