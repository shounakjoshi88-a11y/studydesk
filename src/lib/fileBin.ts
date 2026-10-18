import { Filesystem, Directory } from "@capacitor/filesystem";
import { movePath } from "./deviceFiles";
import { subtractCleaned } from "./cleanStats";

/**
 * The Files tab's Bin, the way Files by Google keeps one: a file leaves its
 * folder and parks in the app's own storage for thirty days, then goes for
 * good. The move is a rename into app-specific external storage — the same
 * volume as /sdcard, so it is instant, and no system permission can lapse
 * behind it.
 */

const KEY = "studydesk.fileBin.v1";
const KEEP_DAYS = 30;

export type BinEntry = {
  id: string;
  name: string;
  /** Where the file lived, which is where a restore puts it back. */
  path: string;
  size: number;
  ext: string;
  /** When it entered the bin. */
  at: number;
  /** file:// uri of the parked copy. */
  binned: string;
  /** True when a Clean action sent it here, so a restore can take the bytes
   *  back off the "cleaned so far" counter. */
  viaClean?: boolean;
};

function read(): BinEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const xs = raw ? (JSON.parse(raw) as BinEntry[]) : [];
    return Array.isArray(xs) ? xs : [];
  } catch {
    return [];
  }
}

function write(xs: BinEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(xs));
  } catch {
    /* a full quota is not worth raising over a manifest write */
  }
}

/** The parked copies live beside the app, on the same volume as /sdcard. */
async function binDir(): Promise<string> {
  await Filesystem.mkdir({ path: "bin", directory: Directory.External, recursive: true }).catch(() => {});
  const r = await Filesystem.getUri({ path: "bin", directory: Directory.External });
  return r.uri.replace(/\/$/, "");
}

export function binEntries(): BinEntry[] {
  return read();
}

export function binBytes(): number {
  return read().reduce((s, e) => s + (e.size || 0), 0);
}

export async function moveToBin(
  files: { name: string; path: string; size: number; ext: string }[],
  opts?: { viaClean?: boolean },
): Promise<{ moved: BinEntry[]; failed: string[] }> {
  const dir = await binDir();
  const manifest = read();
  const moved: BinEntry[] = [];
  const failed: string[] = [];
  for (const f of files) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const safe = f.name.replace(/[\\/]/g, "_");
    const dest = `${dir}/${id}-${safe}`;
    try {
      // The plugin owns the move: rename on one volume, copy plus unlink when
      // the destination sits on another. One implementation for the whole app.
      if (!(await movePath(f.path, dest))) throw new Error("move failed");
      const entry: BinEntry = {
        id, name: f.name, path: f.path, size: f.size, ext: f.ext,
        at: Date.now(), binned: dest, viaClean: opts?.viaClean === true,
      };
      manifest.push(entry);
      moved.push(entry);
    } catch {
      failed.push(f.name);
    }
  }
  write(manifest);
  return { moved, failed };
}

export async function restoreFromBin(id: string): Promise<boolean> {
  const manifest = read();
  const i = manifest.findIndex((e) => e.id === id);
  if (i < 0) return false;
  const e = manifest[i]!;
  if (!(await movePath(e.binned, e.path))) return false;
  manifest.splice(i, 1);
  write(manifest);
  // A file Clean sent to the bin was counted as cleaned; putting it back
  // uncounts it, or the drawer would keep claiming space that never left.
  if (e.viaClean) subtractCleaned(e.size);
  return true;
}

/** Permanent delete of one binned item — the Bin screen's business. */
export async function binDelete(id: string): Promise<boolean> {
  const manifest = read();
  const i = manifest.findIndex((e) => e.id === id);
  if (i < 0) return false;
  const e = manifest[i]!;
  try {
    await Filesystem.deleteFile({ path: e.binned });
  } catch {
    /* already gone is the outcome we wanted */
  }
  manifest.splice(i, 1);
  write(manifest);
  return true;
}

/** Thirty days is the whole deal; anything older leaves on the next visit. */
export async function purgeBin(days = KEEP_DAYS): Promise<number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const manifest = read();
  const keep: BinEntry[] = [];
  let gone = 0;
  for (const e of manifest) {
    if (e.at < cutoff) {
      try {
        await Filesystem.deleteFile({ path: e.binned });
      } catch {
        /* it can be missing already */
      }
      gone++;
    } else {
      keep.push(e);
    }
  }
  if (gone) write(keep);
  return gone;
}
