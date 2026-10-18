import mammoth from "mammoth";
import { extractPdfText, ocrImage, TEXT_EXTS } from "./office";
import { b64ToBytes, b64ToText } from "./store";

/**
 * One place that knows how a stored file becomes a note. Three callers rely
 * on it agreeing with itself: the Files tab's "Copy to editable note", the
 * Notes tab's import sheet, and files arriving through the Android share
 * sheet / Open With. They all get the same bytes → markdown behaviour, so a
 * .md imported from any door is byte-identical.
 */

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

/** Extensions the app knows how to turn into a note. */
export function canConvertToNote(ext: string): boolean {
  const e = ext.toLowerCase();
  return TEXT_EXTS.has(e) || e === "docx" || e === "pdf" || IMAGE_EXTS.has(e);
}

/** "module-1-lab-cram.md" → "module-1-lab-cram". */
export function noteTitleFor(name: string, ext: string): string {
  const e = ext.toLowerCase();
  if (e && name.toLowerCase().endsWith("." + e)) return name.slice(0, name.length - e.length - 1);
  return name;
}

/**
 * A stored file → the markdown body of a note.
 *
 * Text-like files pass through verbatim — the point of importing a .md is
 * that it is already markdown, so reinterpreting it would only corrupt it.
 * DOCX loses its formatting by design (mammoth reads the text layer); PDFs
 * keep the per-page section markers extractPdfText already produces; images
 * go through OCR. Anything else throws a message worth showing the user.
 */
export async function fileToNoteMarkdown(
  name: string,
  ext: string,
  base64: string,
  onProgress?: (p: number, stage: string) => void
): Promise<string> {
  const e = ext.toLowerCase();
  const title = noteTitleFor(name, e);

  if (TEXT_EXTS.has(e)) {
    // The BOM is an artifact of Windows editors; left in, it renders as a
    // stray glyph at the top of the note.
    const text = b64ToText(base64).replace(/^\uFEFF/, "");
    if (!text.trim()) throw new Error("That file is empty.");
    return text;
  }

  if (e === "docx") {
    const bytes = b64ToBytes(base64);
    const res = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
    const div = document.createElement("div");
    div.innerHTML = res.value;
    const text = (div.innerText || "").trim();
    if (!text) throw new Error("No readable text inside that DOCX.");
    return `# ${title}\n\n${text}`;
  }

  if (e === "pdf") {
    const md = await extractPdfText(base64, title);
    const pages = (md.match(/^## Page \d+$/gm) || []).length;
    const empty = (md.match(/^\(no text on this page\)$/gm) || []).length;
    if (pages > 0 && empty === pages) {
      throw new Error("That PDF is all scans — no selectable text. Take photos of the pages and use Scan text instead.");
    }
    return md;
  }

  if (IMAGE_EXTS.has(e)) {
    return ocrImage(base64, e, onProgress || (() => {}));
  }

  throw new Error(`Can't turn a .${e || "file"} into a note yet.`);
}
