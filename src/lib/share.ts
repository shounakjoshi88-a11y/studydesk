import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

export function textToB64(t: string): string {
  return btoa(unescape(encodeURIComponent(t)));
}

/** Shares any file (base64 bytes) through the Android share sheet. */
export async function shareFileData(name: string, base64: string, title?: string) {
  const safe = name.replace(/[\\/:*?"<>|]/g, "").slice(0, 80) || "file";
  const path = `share/${Date.now()}-${safe}`;
  await Filesystem.writeFile({ path, directory: Directory.Cache, data: base64, recursive: true });
  const uri = await Filesystem.getUri({ path, directory: Directory.Cache });
  await Share.share({ title: title || safe, files: [uri.uri], dialogTitle: `Share ${safe}` });
}
