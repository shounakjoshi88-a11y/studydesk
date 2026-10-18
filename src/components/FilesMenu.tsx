/**
 * FilesMenu — the drawer Google's Files keeps in its top-left corner (§8):
 * Clean, Bin, Safe folder and Settings, with the live numbers Google puts
 * beside them.
 *
 * StudyDesk keeps the same doors rather than inventing a tab bar, because
 * the Files tab already lives inside a dock and a second navigation layer
 * under it would be a hall of doors. The footer line is not decoration:
 * the whole app's claim is that nothing here leaves the phone, and this is
 * where a person can read it.
 *
 * The dress is deliberately the app's own: plain ink icons instead of
 * colored tiles, the same 28px corner the sheets use on the edge it
 * shares with the page, and the rows trailing the panel in. Nothing here
 * should look borrowed from another product.
 */

import { FolderLock, Settings, Sparkles, Trash2 } from "lucide-react";
import { humanSize } from "../lib/deviceFiles";

export function FilesMenu({
  onClose,
  onClean,
  onBin,
  onVault,
  onSettings,
  cleanedBytes,
  binSize,
  vaultCount,
  vaultBytes,
}: {
  onClose: () => void;
  onClean: () => void;
  onBin: () => void;
  onVault: () => void;
  onSettings: () => void;
  /** Bytes a Clean action has sent toward the bin (drawer subtitle). */
  cleanedBytes: number;
  /** Bytes currently parked in the bin (drawer subtitle). */
  binSize: number;
  /** Files in the Safe folder, if one was ever set up (0 with no PIN). */
  vaultCount: number;
  vaultBytes: number;
}) {
  const row = (
    Icon: typeof Sparkles,
    title: string,
    subtitle: string,
    onClick: () => void,
    delay: number,
  ) => (
    <button
      onClick={onClick}
      role="menuitem"
      className="sd-tap sd-drawer-row flex w-full items-center gap-3.5 rounded-[14px] px-4 py-3 text-left active:bg-surface-2"
      style={{ animationDelay: `${delay}ms` }}
    >
      <Icon className="size-5 shrink-0" style={{ color: "var(--ink-2)" }} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] leading-tight text-ink-1">{title}</span>
        <span className="tnum mt-1 block truncate text-[12px] leading-tight text-ink-2">
          {subtitle}
        </span>
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[70]">
      <button
        className="sd-fade-in absolute inset-0 cursor-default bg-black/50"
        aria-label="Close menu"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Files menu"
        className="sd-drawer-in absolute left-0 top-0 flex h-full w-[292px] max-w-[85vw] flex-col overflow-hidden rounded-r-[28px] bg-surface-1 shadow-2xl"
      >
        <div className="shrink-0 px-5 pb-3 pt-[max(1.5rem,env(safe-area-inset-top))]">
          <div className="text-[20px] font-semibold tracking-tight text-ink-1">Files</div>
          <div className="mt-1 text-[12px] leading-relaxed text-ink-2">
            One phone, one place for it all
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2.5" role="menu" aria-label="Files destinations">
          {row(
            Sparkles,
            "Clean",
            cleanedBytes > 0
              ? `${humanSize(cleanedBytes)} cleaned so far`
              : "Junk, duplicates, big files",
            onClean,
            40,
          )}
          {row(
            Trash2,
            "Bin",
            binSize > 0 ? `${humanSize(binSize)} waiting for 30 days` : "Nothing in the bin",
            onBin,
            95,
          )}
          {row(
            FolderLock,
            "Safe folder",
            vaultCount > 0
              ? `${vaultCount} file${vaultCount === 1 ? "" : "s"} • ${humanSize(vaultBytes)} behind a PIN`
              : "A PIN-gated corner of this app",
            onVault,
            150,
          )}
          {row(Settings, "Settings", "Access, recent list, privacy", onSettings, 205)}
        </div>
        <div
          className="shrink-0 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 text-[12px] leading-relaxed"
          style={{ color: "var(--ink-3)" }}
        >
          Everything this screen knows stays on this phone.
        </div>
      </div>
    </div>
  );
}
