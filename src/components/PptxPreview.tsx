// src/components/PptxPreview.tsx
// Enhanced In-house PPTX renderer — support for Tables, Lines, and Theme Colors
import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, X, Download, Loader2, AlertCircle, Presentation as PresentationIcon, ZoomIn, ZoomOut } from "lucide-react";
import JSZip from "jszip";

// ─── Types ────────────────────────────────────────────────────
interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;      // pt
  color?: string;     // hex
}

interface Paragraph {
  runs: TextRun[];
  align?: "l" | "ctr" | "r" | "just";
  indent?: number;
  bullet?: boolean;
}

interface TableCell {
  paragraphs: Paragraph[];
  fill?: string;
  vAlign?: "t" | "ctr" | "b";
}

interface TableRow {
  cells: TableCell[];
  height: number; // EMU
}

interface Shape {
  type: "text" | "image" | "rect" | "line" | "table";
  x: number; y: number; w: number; h: number; // 0–100
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  paragraphs?: Paragraph[];
  imageUrl?: string;
  borderRadius?: number;
  rotation?: number;
  shadow?: boolean;
  vAlign?: "t" | "ctr" | "b";
  rows?: TableRow[];
}

interface Slide {
  background: string;
  shapes: Shape[];
}

interface PresentationData {
  slides: Slide[];
  slideWidthEmu: number;
  slideHeightEmu: number;
}

// ─── Constants & Helpers ─────────────────────────────────────
const EMU_PER_PT = 12700;
const emuToPct = (emu: number, total: number) => (emu / total) * 100;

// Standard PPTX Theme Map (fallback)
const THEME_COLORS: Record<string, string> = {
  "bg1": "FFFFFF", "tx1": "000000", "bg2": "EEECE1", "tx2": "1F497D",
  "accent1": "4F81BD", "accent2": "C0504D", "accent3": "9BBB59",
  "accent4": "8064A2", "accent5": "4BACC6", "accent6": "F79646",
  "hlink": "0000FF", "folHlink": "800080"
};

function attr(el: Element | null, name: string): string {
  return el?.getAttribute(name) || "";
}

function resolveColor(el: Element | null): string | undefined {
  if (!el) return undefined;
  const solid = el.querySelector("solidFill, srgbClr, sysClr, schemeClr, prstClr");
  if (!solid) return undefined;

  const srgb = solid.querySelector("srgbClr") || (solid.tagName.includes("srgbClr") ? solid : null);
  if (srgb) return attr(srgb as Element, "val");

  const scheme = solid.querySelector("schemeClr") || (solid.tagName.includes("schemeClr") ? solid : null);
  if (scheme) {
    const val = attr(scheme as Element, "val");
    return THEME_COLORS[val] || "888888";
  }

  const sys = solid.querySelector("sysClr") || (solid.tagName.includes("sysClr") ? solid : null);
  if (sys) return attr(sys as Element, "lastClr") || "000000";

  return undefined;
}

function parseTextBody(txBody: Element | null) {
  const paragraphs: Paragraph[] = [];
  if (!txBody) return paragraphs;

  for (const p of Array.from(txBody.querySelectorAll("p"))) {
    const pPr = p.querySelector("pPr");
    const align = pPr ? (attr(pPr, "algn") as Paragraph["align"]) : undefined;
    
    const runs: TextRun[] = [];
    for (const r of Array.from(p.querySelectorAll("r"))) {
      const t = r.querySelector("t");
      if (!t) continue;
      const rPr = r.querySelector("rPr");
      const sz = rPr ? parseInt(attr(rPr, "sz") || "0") / 100 : undefined;
      const bold = rPr ? attr(rPr, "b") === "1" : false;
      const italic = rPr ? attr(rPr, "i") === "1" : false;
      const color = resolveColor(rPr);
      runs.push({ text: t.textContent || "", bold, italic, size: sz, color });
    }
    if (p.querySelector("br")) runs.push({ text: "\n" });
    if (runs.length || p.querySelector("br")) {
      paragraphs.push({ runs, align });
    }
  }
  return paragraphs;
}

// ─── PARSER ──────────────────────────────────────────────────
async function parsePptx(base64: string): Promise<PresentationData> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const zip = await JSZip.loadAsync(bytes.buffer);
  const parser = new DOMParser();

  let slideWidthEmu  = 9144000;
  let slideHeightEmu = 6858000;
  const presFile = zip.file("ppt/presentation.xml");
  if (presFile) {
    const presXml = parser.parseFromString(await presFile.async("text"), "text/xml");
    const sldSz = presXml.querySelector("sldSz");
    if (sldSz) {
      slideWidthEmu  = parseInt(attr(sldSz, "cx")) || slideWidthEmu;
      slideHeightEmu = parseInt(attr(sldSz, "cy")) || slideHeightEmu;
    }
  }

  const slideRels: string[] = [];
  const presRelFile = zip.file("ppt/_rels/presentation.xml.rels");
  if (presRelFile) {
    const relsXml = parser.parseFromString(await presRelFile.async("text"), "text/xml");
    const rels = Array.from(relsXml.querySelectorAll("Relationship"))
      .filter(r => attr(r, "Type").endsWith("/slide"))
      .sort((a, b) => {
        const ai = parseInt(attr(a, "Id").replace(/\D/g, ""));
        const bi = parseInt(attr(b, "Id").replace(/\D/g, ""));
        return ai - bi;
      });
    rels.forEach(r => slideRels.push("ppt/" + attr(r, "Target").replace(/^\.\//, "")));
  }

  const slides: Slide[] = [];
  for (const slidePath of slideRels) {
    const slideFile = zip.file(slidePath);
    if (!slideFile) continue;
    const slideXml = parser.parseFromString(await slideFile.async("text"), "text/xml");
    const relPath = `${slidePath.replace(/\/[^/]+$/, "")}/_rels/${slidePath.split("/").pop()}.rels`;
    const relMap: Record<string, string> = {};
    const relFile = zip.file(relPath);
    if (relFile) {
      const relXml = parser.parseFromString(await relFile.async("text"), "text/xml");
      for (const r of Array.from(relXml.querySelectorAll("Relationship"))) {
        let target = attr(r, "Target").replace(/^\.\.\//, "ppt/");
        if (!target.startsWith("ppt/")) target = "ppt/" + target;
        relMap[attr(r, "Id")] = target;
      }
    }

    const shapes: Shape[] = [];
    const spTree = slideXml.querySelector("spTree");
    if (spTree) {
      for (const el of Array.from(spTree.querySelectorAll("sp, pic, graphicFrame, cxnSp"))) {
        const xfrm = el.querySelector("xfrm") || el.parentElement?.querySelector("xfrm");
        if (!xfrm && el.tagName !== "graphicFrame") continue;

        let x=0, y=0, w=0, h=0;
        const off = el.querySelector("off") || xfrm?.querySelector("off");
        const ext = el.querySelector("ext") || xfrm?.querySelector("ext");
        if (off && ext) {
          x = emuToPct(parseInt(attr(off, "x")), slideWidthEmu);
          y = emuToPct(parseInt(attr(off, "y")), slideHeightEmu);
          w = emuToPct(parseInt(attr(ext, "cx")), slideWidthEmu);
          h = emuToPct(parseInt(attr(ext, "cy")), slideHeightEmu);
        }

        if (el.tagName === "graphicFrame") {
          const tbl = el.querySelector("tbl");
          if (tbl) {
            const rows: TableRow[] = [];
            for (const tr of Array.from(tbl.querySelectorAll("tr"))) {
              const cells: TableCell[] = [];
              for (const tc of Array.from(tr.querySelectorAll("tc"))) {
                cells.push({
                  paragraphs: parseTextBody(tc.querySelector("txBody")),
                  fill: resolveColor(tc.querySelector("tcPr")),
                  vAlign: attr(tc.querySelector("tcPr"), "anchor") as any
                });
              }
              rows.push({ cells, height: parseInt(attr(tr, "h")) || 0 });
            }
            shapes.push({ type: "table", x, y, w, h, rows });
          }
        } else if (el.tagName === "pic") {
          const blip = el.querySelector("blip");
          const rId = blip ? attr(blip, "r:embed") || attr(blip, "embed") : "";
          if (rId && relMap[rId]) {
            const imgFile = zip.file(relMap[rId]);
            if (imgFile) {
              const b64 = await imgFile.async("base64");
              shapes.push({ type: "image", x, y, w, h, imageUrl: `data:image/png;base64,${b64}` });
            }
          }
        } else {
          const paragraphs = parseTextBody(el.querySelector("txBody"));
          const fill = resolveColor(el.querySelector("spPr"));
          const stroke = resolveColor(el.querySelector("ln"));
          const vAlign = attr(el.querySelector("bodyPr"), "anchor") as any;
          shapes.push({ type: "text", x, y, w, h, fill, stroke, paragraphs, vAlign });
        }
      }
    }
    slides.push({ background: resolveColor(slideXml.querySelector("bgPr")) || "FFFFFF", shapes });
  }
  return { slides, slideWidthEmu, slideHeightEmu };
}

// ─── Renderers ───────────────────────────────────────────────
function TableRenderer({ rows }: { rows: TableRow[] }) {
  return (
    <table className="w-full h-full border-collapse" style={{ tableLayout: "fixed" }}>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            {row.cells.map((cell, ci) => (
              <td key={ci} className="p-1 border border-black/10 overflow-hidden"
                style={{ 
                  background: cell.fill ? `#${cell.fill}` : "transparent",
                  verticalAlign: cell.vAlign === "ctr" ? "middle" : cell.vAlign === "b" ? "bottom" : "top"
                }}>
                {cell.paragraphs.map((p, pi) => (
                  <div key={pi} style={{ textAlign: p.align === "ctr" ? "center" : p.align === "r" ? "right" : "left" }}>
                    {p.runs.map((r, ri) => (
                      <span key={ri} style={{ 
                        fontWeight: r.bold ? "bold" : "normal", fontSize: r.size ? `${r.size * 0.12}vw` : "0.8vw",
                        color: r.color ? `#${r.color}` : "inherit"
                      }}>{r.text}</span>
                    ))}
                  </div>
                ))}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SlideRenderer({ slide, aspect }: { slide: Slide; aspect: number }) {
  return (
    <div className="relative w-full overflow-hidden shadow-lg border border-black/5" style={{ paddingBottom: `${(1 / aspect) * 100}%`, background: `#${slide.background}` }}>
      {slide.shapes.map((shape, i) => {
        const style: React.CSSProperties = {
          position: "absolute",
          left: `${shape.x}%`, top: `${shape.y}%`, width: `${shape.w}%`, height: `${shape.h}%`,
          background: shape.fill ? `#${shape.fill}` : "transparent",
          border: shape.stroke ? `1px solid #${shape.stroke}` : "none",
          display: "flex", flexDirection: "column",
          justifyContent: shape.vAlign === "ctr" ? "center" : shape.vAlign === "b" ? "flex-end" : "flex-start"
        };
        if (shape.type === "image") return <img key={i} src={shape.imageUrl} style={{...style, objectFit: "contain"}} alt="" />;
        if (shape.type === "table" && shape.rows) return <div key={i} style={style}><TableRenderer rows={shape.rows} /></div>;
        return (
          <div key={i} style={style} className="p-[1%] overflow-hidden">
            {shape.paragraphs?.map((p, pi) => (
              <div key={pi} style={{ textAlign: p.align === "ctr" ? "center" : p.align === "r" ? "right" : "left" }}>
                {p.runs.map((r, ri) => (
                  <span key={ri} style={{ 
                    fontWeight: r.bold ? "bold" : "normal", fontStyle: r.italic ? "italic" : "normal",
                    fontSize: r.size ? `${r.size * 0.15}vw` : `${shape.h * 0.2}vw`,
                    color: r.color ? `#${r.color}` : "inherit"
                  }}>{r.text}</span>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function PptxPreview({ base64, filename, onClose, onDownload }: { base64: string, filename: string, onClose: () => void, onDownload: () => void }) {
  const [pres, setPres] = useState<PresentationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [slide, setSlide] = useState(0);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    parsePptx(base64).then(setPres).finally(() => setLoading(false));
  }, [base64]);

  const aspect = useMemo(() => pres ? pres.slideWidthEmu / pres.slideHeightEmu : 16/9, [pres]);

  if (loading) return <div className="flex-1 flex items-center justify-center bg-surface-1"><Loader2 className="size-8 animate-spin text-ink-3/40" /></div>;
  if (!pres || pres.slides.length === 0) return <div className="flex-1 flex items-center justify-center text-critical-text">Failed to render presentation</div>;

  return (
    <div className="flex-1 flex flex-col bg-surface-1 h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-line shrink-0">
        <div className="flex items-center gap-2 truncate">
          <PresentationIcon className="size-4 text-brand" />
          <span className="text-sm font-medium truncate">{filename}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} className="sd-press p-2.5 rounded-card" aria-label="Zoom out"><ZoomOut className="size-4" /></button>
          <button onClick={() => setZoom(1)} className="tnum px-1 text-[11px] font-bold text-ink-2 min-w-9" aria-label="Reset zoom">{Math.round(zoom * 100)}%</button>
          <button onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} className="sd-press p-2.5 rounded-card" aria-label="Zoom in"><ZoomIn className="size-4" /></button>
          <button onClick={onDownload} className="sd-press p-2.5 rounded-card" aria-label="Download"><Download className="size-4" /></button>
          <button onClick={onClose} className="sd-press p-2.5 rounded-card" aria-label="Close preview"><X className="size-4" /></button>
        </div>
      </div>
      
      <div className="flex-1 flex overflow-hidden">
        <div className="w-32 border-r border-line overflow-y-auto p-2 space-y-2 shrink-0 bg-surface-1">
          {pres.slides.map((s, i) => (
            <button key={i} onClick={() => setSlide(i)} className={`sd-press w-full rounded-card overflow-hidden border-2 transition-all ${i === slide ? "border-brand" : "border-transparent opacity-50 hover:opacity-100"}`}>
              <SlideRenderer slide={s} aspect={aspect} />
            </button>
          ))}
        </div>
        
        <div className="flex-1 overflow-auto p-4 bg-background">
          <div className="mx-auto" style={{ width: zoom <= 1 ? "100%" : `${zoom * 100}%`, maxWidth: zoom <= 1 ? "56rem" : "none" }}>
            <AnimatePresence mode="wait">
              <motion.div key={slide} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.2 }}>
                {pres.slides[slide] && <SlideRenderer slide={pres.slides[slide]} aspect={aspect} />}
              </motion.div>
            </AnimatePresence>
            <div className="flex items-center justify-center gap-4 mt-6">
              <button disabled={slide === 0} onClick={() => setSlide(s => s - 1)} className="sd-press sd-icon rounded-full disabled:opacity-20" aria-label="Previous slide"><ChevronLeft /></button>
              <span className="tnum text-xs font-medium">{slide + 1} / {pres.slides.length}</span>
              <button disabled={slide === pres.slides.length - 1} onClick={() => setSlide(s => s + 1)} className="sd-press sd-icon rounded-full disabled:opacity-20" aria-label="Next slide"><ChevronRight /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
