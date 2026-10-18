import { Capacitor, registerPlugin, WebPlugin } from "@capacitor/core";
import { noteFromExternalFile, noteFromSharedText } from "./noteImport";
import { setPendingNote } from "./pendingNote";

/**
 * Files that arrive through Android's "Open with" and the share sheet.
 *
 * The native side stashes the launch intent (cold start) and every
 * onNewIntent (warm start) and hands the payload over on demand, so this
 * module only has to drain it and turn the contents into notes. On the web
 * the plugin is a no-op — there is no share sheet to come from, and the
 * import sheet covers the same ground.
 */

export type IncomingItem = {
  kind: "file" | "text";
  name?: string;
  ext?: string;
  mime?: string;
  base64?: string;
  text?: string;
  error?: string;
};

interface IncomingFilePlugin {
  consume(): Promise<{ items: IncomingItem[] }>;
}

class IncomingFileWeb extends WebPlugin implements IncomingFilePlugin {
  async consume(): Promise<{ items: IncomingItem[] }> {
    return { items: [] };
  }
}

const IncomingFile = registerPlugin<IncomingFilePlugin>("IncomingFile", {
  web: () => Promise.resolve().then(() => new IncomingFileWeb()),
});

/**
 * Consume everything Android handed us since the last call and turn it into
 * notes. Runs at launch and every time the app comes back to the foreground.
 * Sequential on purpose: saveNote is a read-modify-write of the notes index,
 * so two imports overlapping would race each other.
 */
let draining = false;
export async function processIncoming(): Promise<void> {
  if (!Capacitor.isNativePlatform() || draining) return;
  draining = true;
  try {
    const { items } = await IncomingFile.consume();
    if (!items || items.length === 0) return;
    let last: { id: string; label: string } | null = null;
    let failed = 0;
    for (const it of items) {
      try {
        if (it.kind === "text" && it.text) {
          const id = await noteFromSharedText(it.text, "General");
          last = { id, label: "Saved from shared text." };
        } else if (it.kind === "file" && it.base64 && it.name) {
          const id = await noteFromExternalFile(it.name, (it.ext || "").toLowerCase(), it.base64, "General");
          last = { id, label: `Imported from ${it.name}` };
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
    // Silence would read as "the share did nothing". When nothing could be
    // converted, open a note that says why — it is visible, dismissable and
    // deletable like any other note.
    if (!last && failed > 0) {
      const id = await noteFromSharedText(
        "## Couldn't read that\n\nThe shared file couldn't be turned into a note — it may be an unsupported format, or unreadable by the app.\n\nSupported: markdown, text, PDF, DOCX, and images (OCR).",
        "General"
      );
      last = { id, label: "Import failed." };
    }
    if (last) {
      setPendingNote(last.id, last.label);
      window.dispatchEvent(new CustomEvent("sd-tab", { detail: { tab: "notes" } }));
      window.dispatchEvent(new CustomEvent("sd-open-note", { detail: last }));
    }
  } catch {
    /* nothing was shared, or the bridge has no plugin — both are no-ops */
  } finally {
    draining = false;
  }
}
