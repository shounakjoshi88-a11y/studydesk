/**
 * CleanScreen — the Clean hub (§9), StudyDesk's honest take on it.
 *
 * Files by Google offers to free space by digging through every app's cache.
 * No third-party app can see other apps' caches on modern Android — every
 * file manager that shows a number for them is guessing. So this screen only
 * ever counts what it can actually see: leftovers on shared storage, files a
 * month old in the two folders people fill without meaning to, and copies
 * that are byte-for-byte identical.
 *
 * Every clean action moves to the Bin, never deletes. That is the same deal
 * as everywhere else in Files: reversible for thirty days, and the drawer's
 * "cleaned" counter takes bytes back off if something is restored.
 *
 * One scan answers all three cards. The scan rides the same walk cache as
 * search, so opening Clean right after browsing is free; "Scan again" is
 * always in the header for the cases where it is not.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CalendarClock, Check, ChevronLeft, ChevronRight, Copy, HardDrive, Layers,
  Loader2, Sparkles, Trash2,
} from "lucide-react";
import { DragSheet } from "./DragSheet";
import {
  cleanScan, getCachedOverview, getVolumeInfo, humanSize, openStorageSettings,
  requestAllFiles, type CleanFindings, type DfRecent, type DupeGroup, type VolumeInfo,
} from "../lib/deviceFiles";
import { addCleaned } from "../lib/cleanStats";
import { binBytes, moveToBin } from "../lib/fileBin";

type Phase = "junk" | "dupes" | "old";

const PHASE_TITLE: Record<Phase, string> = {
  junk: "Junk files",
  dupes: "Duplicate copies",
  old: "Old downloads",
};

/** The folder a file sits in, for the "where is this thing" half of a row. */
function dirOf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2]! : "storage";
}

/** The copy a duplicate set would keep by default: the oldest one. */
function keeperOf(g: DupeGroup): DfRecent | undefined {
  return [...g.files].sort((a, b) => a.lastModified - b.lastModified)[0];
}

export function CleanScreen({
  onClose,
  onOpenList,
  onOpenBin,
}: {
  onClose: () => void;
  /** Large files leaves the hub for the Files list, which already knows how
   *  to page big lists. The hub closes so the list is not buried behind it. */
  onOpenList: (list: DfRecent[], title: string) => void;
  onOpenBin: () => void;
}) {
  const [scan, setScan] = useState<CleanFindings | null>(null);
  const [scanning, setScanning] = useState(true);
  const [vol, setVol] = useState<VolumeInfo | null>(null);
  const [largest, setLargest] = useState<DfRecent[]>([]);
  const [binSize, setBinSize] = useState(0);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accessAsked, setAccessAsked] = useState(false);

  const load = async () => {
    setScanning(true);
    const [f, v, o] = await Promise.all([cleanScan(), getVolumeInfo(), getCachedOverview()]);
    setScan(f);
    setScanning(false);
    setVol(v);
    setLargest(o?.largest ?? []);
    setBinSize(binBytes());
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openPhase = (p: Phase) => {
    if (!scan) return;
    setNote(null);
    if (p === "junk") {
      setPicked(new Set(scan.junk.entries.map((e) => e.path)));
    } else if (p === "old") {
      setPicked(new Set(scan.old.entries.map((e) => e.path)));
    } else {
      // One copy survives by default: the oldest, which is usually the
      // original. The rest are pre-ticked; any of it can be unticked.
      const s = new Set<string>();
      for (const g of scan.dupes.groups) {
        for (const f of g.files) if (f !== keeperOf(g)) s.add(f.path);
      }
      setPicked(s);
    }
    setPhase(p);
  };

  const phaseEntries = useMemo(() => {
    if (!scan || !phase) return [] as DfRecent[];
    if (phase === "junk") return scan.junk.entries;
    if (phase === "old") return scan.old.entries;
    return scan.dupes.groups.flatMap((g) => g.files);
  }, [scan, phase]);

  const pickedBytes = useMemo(() => {
    const size = new Map(phaseEntries.map((e) => [e.path, e.size]));
    let s = 0;
    for (const p of picked) s += size.get(p) ?? 0;
    return s;
  }, [phaseEntries, picked]);

  const toggle = (path: string) => {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  };

  const allPicked = picked.size === phaseEntries.length && phaseEntries.length > 0;

  /** Move the ticked files to the bin, then trust nothing — the manifest is
   *  the only thing that knows a move really happened, so both the cards and
   *  the counter are rebuilt from what moveToBin reports back. */
  const run = async () => {
    setConfirming(false);
    const chosen = phaseEntries.filter((e) => picked.has(e.path));
    if (!chosen.length) return;
    setBusy(true);
    const { moved, failed } = await moveToBin(
      chosen.map((e) => ({ name: e.name, path: e.path, size: e.size, ext: e.ext })),
      { viaClean: true },
    );
    setBusy(false);
    const gone = new Set(moved.map((m) => m.path));
    const movedBytes = moved.reduce((s, m) => s + m.size, 0);
    addCleaned(movedBytes);
    setScan((s) => {
      if (!s) return s;
      const keep = (xs: DfRecent[]) => xs.filter((e) => !gone.has(e.path));
      const sum = (xs: DfRecent[]) => xs.reduce((a, e) => a + e.size, 0);
      const junk = keep(s.junk.entries);
      const old = keep(s.old.entries);
      const groups = s.dupes.groups
        .map((g) => ({ ...g, files: keep(g.files) }))
        .filter((g) => g.files.length > 1);
      return {
        ...s,
        junk: { entries: junk, bytes: sum(junk) },
        old: { entries: old, bytes: sum(old) },
        dupes: {
          groups,
          files: groups.reduce((a, g) => a + g.files.length, 0),
          bytes: groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0),
        },
      };
    });
    setBinSize(binBytes());
    setPhase(null);
    setPicked(new Set());
    setNote(
      failed.length === 0
        ? `Moved ${moved.length} file${moved.length === 1 ? "" : "s"} (${humanSize(movedBytes)}) to the bin. Restore within 30 days.`
        : `Moved ${moved.length} of ${chosen.length} files; Android blocked ${failed.length}.`,
    );
  };

  const failedName = (xs: DfRecent[]) =>
    xs.length > 0 ? `${xs.length} file${xs.length === 1 ? "" : "s"} • ${humanSize(xs.reduce((a, e) => a + e.size, 0))}` : null;

  const card = (
    opts: {
      icon: ReactNode; title: string; subtitle: string;
      muted?: boolean; onClick?: () => void; busy?: boolean;
    },
  ) => (
    <button
      onClick={opts.onClick}
      disabled={!opts.onClick}
      className="sd-tap flex w-full items-center gap-3 rounded-[20px] bg-surface-1 p-4 text-left disabled:opacity-70"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2">
        {opts.busy ? (
          <Loader2 className="size-5 animate-spin" style={{ color: "var(--ink-3)" }} />
        ) : (
          opts.icon
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] leading-tight text-ink-1">{opts.title}</span>
        <span
          className="tnum mt-1 block truncate text-[13px] leading-tight"
          style={{ color: opts.muted ? "var(--ink-3)" : "var(--ink-2)" }}
        >
          {opts.subtitle}
        </span>
      </span>
      {opts.onClick && <ChevronRight className="size-4 shrink-0" style={{ color: "var(--ink-3)" }} aria-hidden />}
    </button>
  );

  const icon = (Icon: typeof Sparkles, tint: string) => (
    <Icon className="size-5" style={{ color: tint }} aria-hidden />
  );

  /* ── review phase: pick what goes, move it all at once ─────────────── */

  if (phase && scan) {
    const keepBadges = new Set<string>();
    if (phase === "dupes") {
      for (const g of scan.dupes.groups) {
        const k = keeperOf(g);
        if (k) keepBadges.add(k.path);
      }
    }
    return (
      <div className="fixed inset-0 z-[65] flex flex-col bg-background">
        <div className="flex shrink-0 items-center gap-1 px-2 pt-[max(30px,env(safe-area-inset-top))]">
          <button onClick={() => setPhase(null)} className="sd-press sd-icon" aria-label="Back to clean summary">
            <ChevronLeft className="size-[22px]" style={{ color: "var(--ink-2)" }} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[20px] font-semibold tracking-tight text-ink-1">
              {PHASE_TITLE[phase]}
            </div>
            <div className="tnum text-[12px] text-ink-2">
              {picked.size} of {phaseEntries.length} selected
              {pickedBytes > 0 ? ` • ${humanSize(pickedBytes)}` : ""}
            </div>
          </div>
          {phaseEntries.length > 0 && (
            <button
              onClick={() =>
                allPicked ? setPicked(new Set()) : setPicked(new Set(phaseEntries.map((e) => e.path)))
              }
              className="sd-press px-2 py-2 text-[14px] font-medium"
              style={{ color: "var(--brand-ink)" }}
            >
              {allPicked ? "None" : "All"}
            </button>
          )}
        </div>

        <div className="shrink-0 px-4 pt-1 text-[12px]" style={{ color: "var(--ink-3)" }}>
          {phase === "dupes"
            ? "Identical copies, found by hashing. The oldest is left unticked — that is the one worth keeping."
            : "Everything selected moves to the bin, where it waits 30 days before leaving for good."}
        </div>

        <div className="sd-fade-in flex-1 overflow-y-auto px-4 pb-6 pt-1">
          {phaseEntries.length === 0 && (
            <p className="px-1 py-8 text-center text-[14px] text-ink-2">
              Nothing left here — this pile is already as small as it gets.
            </p>
          )}
          {phase === "dupes"
            ? scan.dupes.groups.map((g) => (
                <div key={g.hash} className="mt-3">
                  <div className="tnum px-1 pb-1 text-[12px] font-medium" style={{ color: "var(--ink-3)" }}>
                    {g.files.length} identical copies • {humanSize(g.size)} each
                  </div>
                  {g.files.map((e) => reviewRow(e, keepBadges.has(e.path) && !picked.has(e.path)))}
                </div>
              ))
            : phaseEntries.map((e) => reviewRow(e, false))}
          {busy && (
            <div className="flex items-center justify-center gap-2 py-4 text-[13px] text-ink-3">
              <Loader2 className="size-4 animate-spin" />
              Moving to the bin
            </div>
          )}
        </div>

        <div
          className="shrink-0 border-t px-4 pt-3"
          style={{
            borderColor: "color-mix(in srgb, var(--ink-3) 18%, transparent)",
            paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
          }}
        >
          <button
            onClick={() => setConfirming(true)}
            disabled={picked.size === 0 || busy}
            className="sd-press w-full rounded-card py-3.5 text-[15px] font-semibold disabled:opacity-40"
            style={{ background: "var(--brand)", color: "var(--background)" }}
          >
            {picked.size === 0
              ? "Nothing selected"
              : `Move ${picked.size} to bin${pickedBytes > 0 ? ` • ${humanSize(pickedBytes)}` : ""}`}
          </button>
        </div>

        {confirming && (
          <DragSheet label="Move to the bin" onClose={() => setConfirming(false)}>
            <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
              <div className="mb-1 text-[15px] font-medium text-ink-1">Move to the bin?</div>
              <div className="text-[13px] text-ink-3">
                {picked.size} file{picked.size === 1 ? "" : "s"}
                {pickedBytes > 0 ? ` (${humanSize(pickedBytes)})` : ""} leave their folders now. For 30
                days you can put any of them back from the bin.
              </div>
              <button
                onClick={() => void run()}
                className="sd-press mt-4 w-full rounded-card py-3.5 text-[15px] font-semibold"
                style={{ background: "var(--brand)", color: "var(--background)" }}
              >
                Move to bin
              </button>
            </div>
          </DragSheet>
        )}
      </div>
    );

    function reviewRow(e: DfRecent, keepSuggested: boolean) {
      const sel = picked.has(e.path);
      return (
        <button
          key={e.path}
          onClick={() => toggle(e.path)}
          className="flex w-full items-center gap-3 py-2.5 text-left"
        >
          <span
            aria-hidden="true"
            className="flex size-[22px] shrink-0 items-center justify-center rounded-full border"
            style={
              sel
                ? { background: "var(--brand)", borderColor: "var(--brand)", color: "var(--background)" }
                : { borderColor: "var(--ink-3)", color: "transparent" }
            }
          >
            <Check className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] leading-tight text-ink-1">{e.name}</span>
            <span className="tnum mt-0.5 block truncate text-[13px] text-ink-2">
              {humanSize(e.size)} • {dirOf(e.path)}
            </span>
          </span>
          {keepSuggested && (
            <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-ink">
              Keep this one
            </span>
          )}
        </button>
      );
    }
  }

  /* ── hub ────────────────────────────────────────────────────────────── */

  const used = vol?.used ?? 0;
  const total = vol?.total ?? 0;
  const pct = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
  const junkCount = scan?.junk.entries.length ?? 0;
  const dupeGroups = scan?.dupes.groups.length ?? 0;
  const oldCount = scan?.old.entries.length ?? 0;

  return (
    <div className="fixed inset-0 z-[65] flex flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-[max(30px,env(safe-area-inset-top))]">
        <button onClick={onClose} className="sd-press sd-icon" aria-label="Back to files">
          <ChevronLeft className="size-[22px]" style={{ color: "var(--ink-2)" }} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[20px] font-semibold tracking-tight text-ink-1">Clean</div>
          <div className="text-[12px] text-ink-2">What can go without losing anything you need</div>
        </div>
        <button
          onClick={() => void load()}
          disabled={scanning}
          className="sd-press px-2 py-2 text-[14px] font-medium disabled:opacity-40"
          style={{ color: "var(--brand-ink)" }}
        >
          Scan again
        </button>
      </div>

      {note && (
        <div className="mx-3 mt-2 shrink-0 rounded-card border border-brand/30 bg-brand-soft px-3 py-2 text-xs">
          {note}
        </div>
      )}

      <div className="sd-fade-in flex-1 overflow-y-auto px-4 pb-10 pt-2">
        {/* Volume card — the one number Android itself controls. */}
        <button
          onClick={() => void openStorageSettings()}
          className="sd-tap flex w-full flex-col gap-2 rounded-[20px] bg-surface-1 p-4 text-left"
        >
          <span className="flex w-full items-center gap-3">
            <HardDrive className="size-5 shrink-0" style={{ color: "var(--ink-2)" }} aria-hidden />
            <span className="min-w-0 flex-1 text-[15px] text-ink-1">
              {vol ? `${humanSize(used)} of ${humanSize(total)} used` : "Reading storage…"}
            </span>
            <ChevronRight className="size-4 shrink-0" style={{ color: "var(--ink-3)" }} aria-hidden />
          </span>
          <span
            className="block h-[6px] w-full overflow-hidden rounded-full"
            style={{ background: "color-mix(in srgb, var(--ink-3) 22%, transparent)" }}
          >
            <span
              className="block h-full rounded-full"
              style={{ width: `${Math.round(pct * 100)}%`, background: "var(--brand)" }}
            />
          </span>
          <span className="tnum text-[13px] text-ink-2">
            {vol ? `${humanSize(vol.free)} free` : " "}
          </span>
        </button>

        {/* The Bin gets a line here as in Google's Clean screen. */}
        <button
          onClick={onOpenBin}
          className="sd-tap mt-2 flex w-full items-center gap-3 rounded-[20px] bg-surface-1 p-4 text-left"
        >
          <Trash2 className="size-5 shrink-0" style={{ color: "var(--ink-2)" }} aria-hidden />
          <span className="min-w-0 flex-1 text-[15px] text-ink-1">Bin</span>
          <span className="tnum shrink-0 text-[13px] text-ink-2">
            {binSize > 0 ? humanSize(binSize) : "Empty"}
          </span>
          <ChevronRight className="size-4 shrink-0" style={{ color: "var(--ink-3)" }} aria-hidden />
        </button>

        <div className="mt-4 flex flex-col gap-2">
          {card({
            icon: icon(Sparkles, "var(--brand-ink)"),
            title: "Junk files",
            subtitle: scanning
              ? "Looking for leftovers…"
              : !scan
                ? "Scan dodged the question"
                : junkCount > 0
                  ? failedName(scan.junk.entries) ?? "Nothing worth clearing"
                  : "Nothing worth clearing",
            muted: !scanning && junkCount === 0,
            onClick: junkCount > 0 ? () => openPhase("junk") : undefined,
            busy: scanning,
          })}
          {card({
            icon: icon(Copy, "var(--ink-2)"),
            title: "Duplicates",
            subtitle: scanning
              ? "Hashing same-size files…"
              : !scan
                ? "Scan dodged the question"
                : dupeGroups > 0
                  ? `${scan.dupes.files} copies in ${dupeGroups} set${dupeGroups === 1 ? "" : "s"} • ${humanSize(scan.dupes.bytes)} could come back`
                  : "No identical copies found",
            muted: !scanning && dupeGroups === 0,
            onClick: dupeGroups > 0 ? () => openPhase("dupes") : undefined,
            busy: scanning,
          })}
          {card({
            icon: icon(CalendarClock, "var(--ink-2)"),
            title: "Old downloads & screenshots",
            subtitle: scanning
              ? "A month of history…"
              : !scan
                ? "Scan dodged the question"
                : oldCount > 0
                  ? failedName(scan.old.entries) ?? "Nothing older than a month"
                  : "Nothing older than a month",
            muted: !scanning && oldCount === 0,
            onClick: oldCount > 0 ? () => openPhase("old") : undefined,
            busy: scanning,
          })}
          {card({
            icon: icon(Layers, "var(--ink-2)"),
            title: "Large files",
            subtitle: scanning
              ? "Measuring…"
              : largest.length > 0
                ? `${largest.length} of the biggest • ${humanSize(largest.reduce((a, e) => a + e.size, 0))}`
                : "Nothing big in sight",
            muted: !scanning && largest.length === 0,
            onClick: largest.length > 0 ? () => onOpenList(largest, "Large files") : undefined,
            busy: scanning,
          })}
        </div>

        {scan?.denied && (
          <div className="mt-4 rounded-[20px] border border-brand/30 bg-brand-soft p-4">
            <div className="text-[14px] font-medium text-ink-1">StudyDesk cannot see your files yet</div>
            <p className="mt-1 text-[13px] text-ink-2">
              All-files access was not granted, so there is nothing truthful to show here.
            </p>
            <button
              onClick={() => {
                setAccessAsked(true);
                void requestAllFiles();
              }}
              className="sd-press mt-3 rounded-card px-4 py-2.5 text-[14px] font-medium"
              style={{ background: "var(--brand)", color: "var(--background)" }}
            >
              {accessAsked ? "Granted it? Tap Scan again" : "Open Android settings"}
            </button>
          </div>
        )}

        <p className="mt-4 px-1 text-[12px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
          Cleaning never deletes. Everything you clear here waits in the bin for 30 days first, and
          only files on shared storage are ever counted — no app&apos;s private cache is readable by
          any file manager, so this screen refuses to invent a number for it.
        </p>
      </div>
    </div>
  );
}
