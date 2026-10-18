/**
 * FileInfo — the full-screen "File info" overlay (§6 of the teardown):
 * name, size and when, a large preview that opens the file on tap, and the
 * Last modified / Kind / Location rows.
 *
 * The preview is the real thing, not an icon: images go through the native
 * thumbnailer at a size worth looking at. Anything the decoder cannot draw a
 * frame for (videos, encrypted backups) shows its type icon instead of a
 * spinner that would never land.
 */

import { useEffect, useState } from "react";
import { Download, FileText, Film, Lock, Music, X } from "lucide-react";
import {
  hasRowThumb,
  humanSize,
  isEncryptedBackup,
  isVideo,
  rowThumbUrl,
  whenLabel,
  type DfRecent,
} from "../lib/deviceFiles";

const KIND: Record<string, string> = {
  jpg: "JPEG image",
  jpeg: "JPEG image",
  png: "PNG image",
  webp: "WebP image",
  gif: "GIF image",
  bmp: "BMP image",
  heic: "HEIC image",
  heif: "HEIF image",
  mp4: "MP4 video",
  mkv: "Matroska video",
  mov: "QuickTime video",
  avi: "AVI video",
  webm: "WebM video",
  "3gp": "3GP video",
  m4v: "M4V video",
  mp3: "MP3 audio",
  aac: "AAC audio",
  wav: "WAV audio",
  ogg: "Ogg audio",
  m4a: "M4A audio",
  flac: "FLAC audio",
  amr: "AMR audio",
  opus: "Opus audio",
  pdf: "PDF",
  doc: "Word document",
  docx: "Word document",
  odt: "OpenDocument text",
  rtf: "Rich text",
  txt: "Text file",
  md: "Markdown file",
  markdown: "Markdown file",
  csv: "CSV sheet",
  tsv: "TSV sheet",
  xls: "Excel spreadsheet",
  xlsx: "Excel spreadsheet",
  ods: "OpenDocument sheet",
  ppt: "PowerPoint presentation",
  pptx: "PowerPoint presentation",
  odp: "OpenDocument slides",
  epub: "EPUB book",
  zip: "ZIP archive",
  apk: "Android app",
  db: "SQLite database",
  sqlite: "SQLite database",
  json: "JSON file",
  xml: "XML file",
  html: "HTML page",
  htm: "HTML page",
  js: "JavaScript file",
};

const kindLabel = (ext: string): string =>
  KIND[ext] ?? (ext ? `${ext.toUpperCase()} file` : "File");

/** "Fri, 16 Oct 2026 • 16:55" — the teardown's own format. */
const fullWhen = (ms: number): string => {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} • ${time}`;
};

export function FileInfo({
  e,
  onClose,
  onOpen,
}: {
  e: DfRecent;
  onClose: () => void;
  onOpen: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setTried(false);
    if (!hasRowThumb(e.ext)) {
      setTried(true);
      return;
    }
    void rowThumbUrl(e.path, e.ext, 1000).then((u) => {
      if (!alive) return;
      setUrl(u);
      setTried(true);
    });
    return () => {
      alive = false;
    };
  }, [e.path, e.ext]);

  const Icon = isVideo(e.ext)
    ? Film
    : isEncryptedBackup(e.ext)
      ? Lock
      : e.ext === "apk"
        ? Download
        : ["mp3", "aac", "wav", "ogg", "m4a", "flac", "amr", "opus"].includes(e.ext)
          ? Music
          : FileText;

  const rows: { label: string; value: string; block?: boolean }[] = [
    { label: "Last modified", value: fullWhen(e.lastModified) },
    { label: "Kind", value: kindLabel(e.ext) },
    { label: "Location", value: e.path, block: true },
  ];

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-background">
      <div className="flex shrink-0 items-center justify-end px-2 pt-[max(30px,env(safe-area-inset-top))]">
        <button onClick={onClose} className="sd-press sd-icon" aria-label="Close file info">
          <X className="size-[22px]" style={{ color: "var(--ink-2)" }} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-10">
        <h2 className="break-words text-[22px] font-semibold leading-snug tracking-tight text-ink-1">
          {e.name}
        </h2>
        <div className="tnum mt-1 text-[14px] text-ink-2">
          {e.size ? `${humanSize(e.size)}, ` : ""}
          {whenLabel(e.lastModified)}
        </div>

        <button
          onClick={onOpen}
          className="sd-press mt-4 flex w-full items-center justify-center overflow-hidden rounded-[16px] bg-surface-2"
          style={{ height: "38vh" }}
          aria-label={`Open ${e.name}`}
        >
          {url ? (
            <img src={url} alt="" className="h-full w-full object-contain" />
          ) : (
            <span className="flex flex-col items-center gap-2" style={{ color: "var(--ink-3)" }}>
              <Icon className="size-12" />
              <span className="text-[12px]">
                {hasRowThumb(e.ext) && !tried ? "Reading preview…" : "Tap to open"}
              </span>
            </span>
          )}
        </button>

        <dl className="mt-5">
          {rows.map((r) => (
            <div key={r.label} className="border-t border-line py-3 first:border-t-0 first:pt-0">
              {r.block ? (
                <>
                  <dt className="text-[13px]" style={{ color: "var(--ink-3)" }}>
                    {r.label}
                  </dt>
                  <dd className="mt-0.5 break-all text-[14px] text-ink-1">{r.value}</dd>
                </>
              ) : (
                <div className="flex items-baseline justify-between gap-6">
                  <dt className="shrink-0 text-[13px]" style={{ color: "var(--ink-3)" }}>
                    {r.label}
                  </dt>
                  <dd className="tnum text-right text-[14px] text-ink-1">{r.value}</dd>
                </div>
              )}
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
