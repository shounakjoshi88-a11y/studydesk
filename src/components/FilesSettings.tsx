/**
 * FilesSettings — the drawer's Settings door.
 *
 * It is a short sheet on purpose. There is no scan schedule to tune, no
 * account to sign into, and nothing to sync, so the only honest switches are
 * the ones about what this app can see and what it remembers: storage
 * access, the recently-opened list, the bin, and the cleaned counter. Each
 * row says where its data lives, because "on this phone" is the feature.
 */

import { useEffect, useState } from "react";
import { DragSheet } from "./DragSheet";
import { hasAllFiles, humanSize, requestAllFiles } from "../lib/deviceFiles";
import { binBytes } from "../lib/fileBin";
import { cleanedBytes } from "../lib/cleanStats";
import { clearOpened } from "../lib/recentOpened";

export function FilesSettings({
  onClose,
  onOpenBin,
}: {
  onClose: () => void;
  onOpenBin: () => void;
}) {
  const [access, setAccess] = useState<boolean | null>(null);
  const [asked, setAsked] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [binSize, setBinSize] = useState(0);
  const [cleaned, setCleaned] = useState(0);

  const checkAccess = async () => setAccess(await hasAllFiles());

  useEffect(() => {
    void checkAccess();
    setBinSize(binBytes());
    setCleaned(cleanedBytes());
  }, []);

  const row = (title: string, body: string, action?: { label: string; onClick: () => void }) => (
    <div className="border-t border-line py-3.5 first:border-t-0">
      <div className="flex items-baseline gap-3">
        <div className="min-w-0 flex-1 text-[15px] text-ink-1">{title}</div>
        {action && (
          <button
            onClick={action.onClick}
            className="sd-press shrink-0 rounded-full bg-surface-2 px-3 py-1.5 text-[13px] font-medium"
            style={{ color: "var(--brand-ink)" }}
          >
            {action.label}
          </button>
        )}
      </div>
      <div className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
        {body}
      </div>
    </div>
  );

  return (
    <DragSheet onClose={onClose} label="Files settings" panelClassName="max-h-[80vh]">
      <div
        className="overflow-y-auto px-5"
        style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}
      >
        <div className="pb-2 text-[17px] font-semibold tracking-tight text-ink-1">
          Files settings
        </div>

        {note && (
          <div className="mb-2 rounded-card border border-brand/30 bg-brand-soft px-3 py-2 text-xs">
            {note}
          </div>
        )}

        {row(
          "All-files access",
          access === null
            ? "Checking…"
            : access
              ? "Granted. Files can read every folder on this phone, the same way Android's own file app does."
              : "Not granted. Files can only see a folder you picked by hand, so categories and search stay empty.",
          access === false
            ? {
                label: asked ? "Check again" : "Open Android settings",
                onClick: () => {
                  if (asked) {
                    void checkAccess();
                    setNote("If access is on now, everything here fills in on its own.");
                  } else {
                    setAsked(true);
                    void requestAllFiles();
                    setNote("Switch on All files access in Android settings, then come back and tap Check again.");
                  }
                },
              }
            : undefined,
        )}

        {row(
          "Recently opened",
          cleared
            ? "Cleared. The search screen starts from an empty slate again."
            : "The last twenty files you opened from Files, kept on this phone and shown by search when the field is empty. Nothing is uploaded.",
          cleared
            ? undefined
            : {
                label: "Clear",
                onClick: () => {
                  clearOpened();
                  setCleared(true);
                },
              },
        )}

        {row(
          "Bin",
          binSize > 0
            ? `${humanSize(binSize)} parked, leaving for good 30 days after each was binned. Restores are free and instant.`
            : "Empty right now. Files you move here wait 30 days before leaving for good.",
          { label: "Open", onClick: onOpenBin },
        )}

        {row(
          "Cleaned so far",
          cleaned > 0
            ? `${humanSize(cleaned)} in total, counting files Clean has moved toward the bin. A restore takes the bytes back off this number.`
            : "Nothing yet. This number only ever counts files that a Clean action moved — it cannot grow on its own.",
        )}

        <div
          className="mt-2 border-t border-line pt-3 text-[12px] leading-relaxed"
          style={{ color: "var(--ink-3)" }}
        >
          Files is part of StudyDesk. It has no account, no network code in this tab, and no
          telemetry: every list it keeps — recents, the bin, this counter — lives in this phone's
          own storage and dies with the app's data.
        </div>
      </div>
    </DragSheet>
  );
}
