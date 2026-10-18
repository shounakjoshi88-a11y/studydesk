/**
 * The Safe folder — a PIN-gated corner of the app's own storage, the way
 * Files by Google keeps one.
 *
 * What is true here, stated once so the UI never has to dress it up: files
 * moved in are renamed into StudyDesk's app-specific external storage on the
 * same volume as /sdcard, so the move is instant and no system permission
 * can lapse behind it. The PIN gates *this app's* door to that folder — it is
 * stored as a salted SHA-256 hash, never as digits. At rest the files sit
 * under Android's own file-based encryption like everything else on the
 * phone; StudyDesk does not stack a second cipher on top and does not claim
 * to. Forgetting the PIN means the content is unreachable: there is no
 * recovery hash, no backdoor, and resetting the folder deletes what it held.
 */

import { Filesystem, Directory } from "@capacitor/filesystem";
import { movePath } from "./deviceFiles";

const KEY = "studydesk.vault.v1";

export type VaultEntry = {
  id: string;
  name: string;
  /** Where the file lived before it was moved in. */
  path: string;
  size: number;
  ext: string;
  /** When it entered the Safe folder. */
  at: number;
  /** file:// uri of the parked copy. */
  vaulted: string;
};

type VaultState = {
  /** Hex salt, per install. */
  salt: string;
  /** Hex SHA-256 of `salt:pin`. */
  hash: string;
  files: VaultEntry[];
};

function read(): VaultState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as VaultState;
    if (!s || typeof s.salt !== "string" || typeof s.hash !== "string") return null;
    if (!Array.isArray(s.files)) s.files = [];
    return s;
  } catch {
    return null;
  }
}

function write(s: VaultState | null) {
  try {
    if (s === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* a full quota is not worth raising over a manifest write */
  }
}

/** True when a PIN was ever set; the Safe folder screen only exists then. */
export function vaultExists(): boolean {
  return read() !== null;
}

export function vaultEntries(): VaultEntry[] {
  return read()?.files ?? [];
}

export function vaultCount(): number {
  return read()?.files.length ?? 0;
}

export function vaultBytes(): number {
  return (read()?.files ?? []).reduce((s, e) => s + (e.size || 0), 0);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPin(pin: string, salt: string): Promise<string | null> {
  try {
    if (!crypto?.subtle) return null;
    const data = new TextEncoder().encode(`${salt}:${pin}`);
    return toHex(await crypto.subtle.digest("SHA-256", data));
  } catch {
    return null;
  }
}

/** Sets the PIN for a folder that does not have one yet. Returns false when
 *  a folder already exists or this webview has no WebCrypto at all. */
export async function setPin(pin: string): Promise<boolean> {
  if (read() !== null) return false;
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = [...saltBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await hashPin(pin, salt);
  if (hash === null) return false;
  write({ salt, hash, files: [] });
  return true;
}

export async function verifyPin(pin: string): Promise<boolean> {
  const s = read();
  if (s === null) return false;
  const hash = await hashPin(pin, s.salt);
  return hash !== null && hash === s.hash;
}

/** The parked copies live beside the app, on the same volume as /sdcard. */
async function vaultDir(): Promise<string> {
  await Filesystem.mkdir({ path: "vault", directory: Directory.External, recursive: true }).catch(() => {});
  const r = await Filesystem.getUri({ path: "vault", directory: Directory.External });
  return r.uri.replace(/\/$/, "");
}

export async function moveToVault(
  files: { name: string; path: string; size: number; ext: string }[],
): Promise<{ moved: VaultEntry[]; failed: string[] }> {
  const s = read();
  if (s === null) return { moved: [], failed: files.map((f) => f.name) };
  const dir = await vaultDir();
  const moved: VaultEntry[] = [];
  const failed: string[] = [];
  for (const f of files) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const safe = f.name.replace(/[\\/]/g, "_");
    const dest = `${dir}/${id}-${safe}`;
    try {
      if (!(await movePath(f.path, dest))) throw new Error("move failed");
      const entry: VaultEntry = {
        id, name: f.name, path: f.path, size: f.size, ext: f.ext, at: Date.now(), vaulted: dest,
      };
      s.files.push(entry);
      moved.push(entry);
    } catch {
      failed.push(f.name);
    }
  }
  if (moved.length) write(s);
  return { moved, failed };
}

/** Take a file back out, to where it lived before. The folder is recreated
 *  by the move itself when it no longer exists. */
export async function restoreFromVault(id: string): Promise<boolean> {
  const s = read();
  if (s === null) return false;
  const i = s.files.findIndex((e) => e.id === id);
  if (i < 0) return false;
  const e = s.files[i]!;
  if (!(await movePath(e.vaulted, e.path))) return false;
  s.files.splice(i, 1);
  write(s);
  return true;
}

export async function vaultDelete(id: string): Promise<boolean> {
  const s = read();
  if (s === null) return false;
  const i = s.files.findIndex((e) => e.id === id);
  if (i < 0) return false;
  const e = s.files[i]!;
  try {
    await Filesystem.deleteFile({ path: e.vaulted });
  } catch {
    /* already gone is the outcome we wanted */
  }
  s.files.splice(i, 1);
  write(s);
  return true;
}

/** The forgotten-PIN exit, and the only one. Everything inside is deleted —
 *  that is the price of no recovery, and the sheet that calls this says so
 *  before it does. */
export async function resetVault(): Promise<number> {
  const s = read();
  if (s === null) return 0;
  let gone = 0;
  for (const e of s.files) {
    try {
      await Filesystem.deleteFile({ path: e.vaulted });
      gone++;
    } catch {
      /* already gone */
    }
  }
  write(null);
  return gone;
}
