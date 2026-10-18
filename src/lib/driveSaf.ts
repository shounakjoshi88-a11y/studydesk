/**
 * Google Drive through the phone's own Drive app — the route with no OAuth
 * client anywhere in it.
 *
 * The other route (lib/drive.ts) asks the user to create a client in Google's
 * Cloud console. This one asks Android instead: the system's folder picker
 * hands over one Drive tree — My Drive itself or any folder inside it — and
 * from then on the Drive app that is already on the phone answers every
 * listing and moves every byte. Whoever's Google account the Drive app knows
 * is who this browses; StudyDesk never sees a token.
 *
 * The trade is honest and worth naming:
 *
 *  - Scope: only the picked area is visible, because that is the only area
 *    Android granted. Pick My Drive to see all of it.
 *  - Google formats (Docs, Sheets, Slides) have no bytes to download; they
 *    hand off to the Drive app itself.
 *  - Everything else behaves like the OAuth route: folders open, files save
 *    into Downloads with a collision-safe name, uploads stream from disk.
 *
 * Revocation is two-way too: Disconnect releases the grant with Android, and
 * if the user removes it from Android's settings instead, the next listing
 * comes back as revoked and the screen shows the connect card again.
 */

import {
  driveAvailable, driveSafConnect, driveSafDownloadNative,
  driveSafForget as driveSafForgetNative, driveSafList as driveSafListNative,
  driveSafOpenNative, driveSafStatus, driveSafUploadNative,
} from "./deviceFiles";
import { DriveAuthError, mimeOf, type DriveEntry } from "./drive";

export type DriveSafStatus = { connected: boolean; name: string; treeId: string };

const NOT_CONNECTED: DriveSafStatus = { connected: false, name: "", treeId: "" };

/** Whether the Drive app route is usable at all: needs the Android build. */
export const driveSafAvailable = (): boolean => driveAvailable();

/** Reads the persisted grant, verified natively against Android's permission
 *  list — a grant revoked in Settings reads as not connected, not as an error
 *  the next time a folder is opened. */
export const driveSafState = async (): Promise<DriveSafStatus> => {
  if (!driveAvailable()) return NOT_CONNECTED;
  try {
    const r = await driveSafStatus();
    if (r.connected !== true) return NOT_CONNECTED;
    return { connected: true, name: r.name ?? "Drive", treeId: r.treeId ?? "" };
  } catch {
    return NOT_CONNECTED;
  }
};

/**
 * Opens Android's picker. Resolving with `cancelled` is a normal answer; a
 * re-pick replaces the previous grant natively, so "Change folder" is just
 * this again.
 */
export async function driveSafGrant(): Promise<{ cancelled: boolean; name: string; treeId: string }> {
  if (!driveAvailable()) throw new Error("Google Drive needs the Android build.");
  const r = await driveSafConnect();
  if (r.cancelled === true) return { cancelled: true, name: "", treeId: "" };
  return { cancelled: false, name: r.name ?? "Drive", treeId: r.treeId ?? "" };
}

/** One folder's children, dressed exactly like the OAuth listing: folders
 *  first, then names the way a human reads them. */
export async function driveSafList(folderId: string): Promise<{ entries: DriveEntry[]; truncated: boolean }> {
  const r = await driveSafListNative(folderId || undefined);
  if (r.revoked === true) {
    throw new DriveAuthError("Access to that Drive folder was removed. Connect it again.");
  }
  const entries = (r.entries ?? []).map((f): DriveEntry => {
    const mime = f.mimeType ?? "";
    return {
      id: f.id,
      name: f.name || "(untitled)",
      mimeType: mime,
      size: typeof f.size === "number" ? f.size : 0,
      modified: typeof f.modified === "number" ? f.modified : 0,
      folder: f.folder === true,
      googleDoc: mime.startsWith("application/vnd.google-apps.") && f.folder !== true,
    };
  });
  entries.sort((a, b) => {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return { entries, truncated: r.truncated === true };
}

/** One Drive file onto the phone, into Downloads unless told otherwise. */
export async function driveSafDownload(
  e: DriveEntry,
): Promise<{ path: string; name: string; bytes: number }> {
  const r = await driveSafDownloadNative(e.id, e.name);
  if (r.revoked === true) {
    throw new DriveAuthError("Access to that Drive folder was removed. Connect it again.");
  }
  if (!r.path || !r.name) throw new Error("The Drive app did not save that file.");
  return { path: r.path, name: r.name, bytes: r.bytes ?? 0 };
}

/** One phone file up into the folder on screen, off its path. */
export async function driveSafUpload(
  path: string,
  name: string,
  folderId: string,
): Promise<{ id: string; name: string }> {
  const r = await driveSafUploadNative(path, folderId, name, mimeOf(name));
  if (r.revoked === true) {
    throw new DriveAuthError("Access to that Drive folder was removed. Connect it again.");
  }
  return { id: r.id ?? "", name: r.name || name };
}

/** Hands one item to the app that claims it (the Drive app, for Google
 *  formats). False means nothing on the phone took it — the caller falls
 *  back to the browser. */
export async function driveSafOpenItem(e: DriveEntry): Promise<boolean> {
  try {
    await driveSafOpenNative(e.id, e.mimeType);
    return true;
  } catch {
    return false;
  }
}

/** Releases the grant with Android. There is nothing to revoke elsewhere —
 *  Google was never told about this app on this route. */
export async function driveSafForget(): Promise<void> {
  try {
    await driveSafForgetNative();
  } catch {
    /* the grant is gone from this phone either way; that was the point */
  }
}
