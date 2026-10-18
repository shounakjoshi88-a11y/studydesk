import { addFile, getFileData, initStore, saveNote, uid, type FileMeta } from "./store";
import { fileToNoteMarkdown, noteTitleFor } from "./convert";

/**
 * Creates notes from files that came from somewhere else. Kept out of the
 * screens because three entry points share it: the Notes import sheet, the
 * Files tab, and the Android Open With / share-sheet handler.
 *
 * Files that arrive from outside the app (picker, share) are also stored in
 * the app's Files tab first, so the note keeps a live link back to its source
 * — "Save to file" writes back to that copy. Storage is a doc-sized copy,
 * and it matches what "Import from phone" in the Files tab has always done.
 */

const onProgressOf = (cb?: (p: number, stage: string) => void) => cb || (() => {});

/** A file already in the app's Files tab → a note linked back to it. */
export async function noteFromAppFile(
  meta: FileMeta,
  folder: string,
  onProgress?: (p: number, stage: string) => void
): Promise<string> {
  await initStore();
  const data = await getFileData(meta.id);
  const text = await fileToNoteMarkdown(meta.name, meta.ext, data, onProgressOf(onProgress));
  return saveLinkedNote(meta, text, folder);
}

/**
 * A file from outside the app (system picker, share sheet). The conversion
 * runs before the file is stored, so a file that can't become a note leaves
 * nothing behind in the Files tab.
 */
export async function noteFromExternalFile(
  name: string,
  ext: string,
  base64: string,
  folder: string,
  onProgress?: (p: number, stage: string) => void
): Promise<string> {
  await initStore();
  const text = await fileToNoteMarkdown(name, ext, base64, onProgressOf(onProgress));
  const meta = await addFile(name, base64);
  return saveLinkedNote(meta, text, folder);
}

/** Shared text (browser snippet, quote, message) → a note. */
export async function noteFromSharedText(text: string, folder: string): Promise<string> {
  await initStore();
  const t = text.trim();
  if (!t) throw new Error("Nothing to import.");
  const first =
    t
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
      .find(Boolean) || "Shared note";
  const title = first.length > 60 ? first.slice(0, 60) + "…" : first;
  const id = uid();
  await saveNote({ id, title, folder, updatedAt: Date.now() }, t);
  return id;
}

async function saveLinkedNote(meta: FileMeta, text: string, folder: string): Promise<string> {
  const id = uid();
  await saveNote(
    {
      id,
      title: noteTitleFor(meta.name, meta.ext),
      folder,
      updatedAt: Date.now(),
      originFileId: meta.id,
      originExt: meta.ext,
    },
    text
  );
  return id;
}
