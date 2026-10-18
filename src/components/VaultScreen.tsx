/**
 * VaultScreen — the Safe folder (§9): set a PIN once, then move files in
 * from any list and open them only from here.
 *
 * The PIN pad is hand-rolled for the same reason Google's is: the system
 * keyboard on a PIN screen invites the clipboard, autocorrect and a
 * prediction bar into a place whose whole point is that nobody else looks
 * in. Four digits, dots, ten keys, one backspace.
 *
 * What this screen will not do is over-promise. The copy says the folder is
 * inside StudyDesk's own storage and gated by this PIN; it does not claim a
 * private cipher, because there is none. Forgetting the PIN is fatal to the
 * content and the sheet that resets says so in as many words.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft, Delete, Download, FileText, FolderLock, Loader2, Lock, Music, RotateCcw, Trash2,
} from "lucide-react";
import { DragSheet } from "./DragSheet";
import { hasRowThumb, humanSize, rowThumbUrl, whenLabel, type DfFile, type DfRecent } from "../lib/deviceFiles";
import {
  moveToVault, resetVault, restoreFromVault, setPin as createVaultPin, vaultDelete, vaultEntries,
  vaultExists, verifyPin, type VaultEntry,
} from "../lib/vault";

type Stage = "setup" | "locked" | "open";

const FAIL_LIMIT = 5;
const COOLDOWN_MS = 30_000;

export function VaultScreen({
  onClose,
  onOpen,
  intent,
}: {
  /** The closing call reports how many files a Move-to-Safe-folder intent
   *  actually landed, so the list behind can reload when it matters. */
  onClose: (movedCount: number) => void;
  /** Rows open through the same routing as every device file, minus the
   *  recents bookkeeping — a Safe folder file must not leak into a list
   *  that renders without the PIN. */
  onOpen: (e: DfFile) => void;
  /** Files that arrived from a "Move to Safe folder" menu action. */
  intent?: DfRecent[];
}) {
  const [stage, setStage] = useState<Stage>(() => (vaultExists() ? "locked" : "setup"));
  const [entries, setEntries] = useState<VaultEntry[]>(() => vaultEntries());
  const [pin, setPin] = useState("");
  const [setupFirst, setSetupFirst] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmMove, setConfirmMove] = useState<DfRecent[] | null>(null);
  const [delTarget, setDelTarget] = useState<VaultEntry | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [fails, setFails] = useState(0);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [movedCount, setMovedCount] = useState(0);

  const cooling = until > now;
  const cooldownLeft = Math.max(0, Math.ceil((until - now) / 1000));

  useEffect(() => {
    if (!cooling) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [cooling]);

  /** After the door opens, an incoming batch introduces itself. */
  const maybeMove = () => {
    if (intent && intent.length > 0) setConfirmMove(intent);
  };

  const submitPin = async (entered: string) => {
    setPin("");
    if (stage === "setup") {
      if (setupFirst === null) {
        setSetupFirst(entered);
        setNote("Enter those four digits once more to confirm.");
        return;
      }
      if (entered !== setupFirst) {
        setSetupFirst(null);
        setNote("The two entries did not match. Start again.");
        return;
      }
      setBusy(true);
      const ok = await createVaultPin(entered);
      setBusy(false);
      if (!ok) {
        setNote("This device's webview has no WebCrypto, so a Safe folder cannot be made here.");
        return;
      }
      setEntries(vaultEntries());
      setStage("open");
      setNote("Safe folder ready. Moving files in works from any list's ⋮ menu.");
      maybeMove();
      return;
    }
    const ok = await verifyPin(entered);
    if (ok) {
      setFails(0);
      setNote(null);
      setStage("open");
      maybeMove();
      return;
    }
    const n = fails + 1;
    setFails(n);
    if (n >= FAIL_LIMIT) {
      setFails(0);
      setUntil(Date.now() + COOLDOWN_MS);
      setNote("Too many tries. The pad waits thirty seconds.");
    } else {
      setNote("That is not the right PIN.");
    }
  };

  // A completed four-digit entry submits itself; the pad only collects.
  useEffect(() => {
    if (pin.length === 4 && stage !== "open" && !cooling) void submitPin(pin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const runMove = async () => {
    const list = confirmMove;
    setConfirmMove(null);
    if (!list?.length) return;
    setBusy(true);
    const { moved, failed } = await moveToVault(
      list.map((e) => ({ name: e.name, path: e.path, size: e.size, ext: e.ext })),
    );
    setBusy(false);
    setEntries(vaultEntries());
    setMovedCount((c) => c + moved.length);
    setNote(
      failed.length === 0
        ? `Moved ${moved.length} file${moved.length === 1 ? "" : "s"} into the Safe folder.`
        : `Moved ${moved.length} of ${list.length}; Android blocked ${failed.length}.`,
    );
  };

  const takeOut = async (e: VaultEntry) => {
    setBusy(true);
    const ok = await restoreFromVault(e.id);
    setBusy(false);
    if (!ok) return setNote("Android would not let this file leave the Safe folder.");
    setEntries(vaultEntries());
    setNote(`Took ${e.name} back out to where it lived.`);
  };

  const removeOne = async (e: VaultEntry) => {
    setDelTarget(null);
    setBusy(true);
    const ok = await vaultDelete(e.id);
    setBusy(false);
    if (!ok) return setNote("That file was already gone.");
    setEntries(vaultEntries());
    setNote(`Deleted ${e.name} for good.`);
  };

  const doReset = async () => {
    setConfirmReset(false);
    setBusy(true);
    const gone = await resetVault();
    setBusy(false);
    onClose(movedCount);
    void gone; // the count is stated on the sheet before this runs
  };

  const bytes = useMemo(() => entries.reduce((s, e) => s + (e.size || 0), 0), [entries]);

  /* ── the door: setup or entry ──────────────────────────────────────── */

  if (stage !== "open") {
    const inSetup = stage === "setup";
    const heading = inSetup
      ? setupFirst === null
        ? "Choose a PIN"
        : "Confirm the PIN"
      : "Enter your PIN";
    return (
      <div className="fixed inset-0 z-[65] flex flex-col bg-background">
        <div className="flex shrink-0 items-center gap-1 px-2 pt-[max(30px,env(safe-area-inset-top))]">
          <button onClick={() => onClose(movedCount)} className="sd-press sd-icon" aria-label="Back to files">
            <ChevronLeft className="size-[22px]" style={{ color: "var(--ink-2)" }} />
          </button>
          <div className="truncate text-[20px] font-semibold tracking-tight text-ink-1">
            Safe folder
          </div>
        </div>

        <div className="sd-fade-in flex flex-1 flex-col items-center justify-center px-6 pb-10">
          <span className="flex size-14 items-center justify-center rounded-full bg-surface-2">
            <FolderLock className="size-6" style={{ color: "var(--ink-2)" }} aria-hidden />
          </span>
          <div className="mt-4 text-[17px] font-medium text-ink-1">{heading}</div>
          <p className="mt-1 max-w-[280px] text-center text-[13px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
            {inSetup
              ? "Four digits. They are stored on this phone as a salted hash — not as digits — and there is no recovery if they are forgotten."
              : "Files in the Safe folder open only from behind this PIN."}
          </p>

          <div className="mt-6 flex items-center gap-3" aria-label={`${pin.length} of 4 digits entered`}>
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className="size-3.5 rounded-full border"
                style={{
                  background: i < pin.length ? "var(--brand)" : "transparent",
                  borderColor: i < pin.length ? "var(--brand)" : "var(--ink-3)",
                }}
              />
            ))}
          </div>

          {note && (
            <div className="mt-4 max-w-[300px] rounded-card border border-brand/30 bg-brand-soft px-3 py-2 text-center text-[12px]">
              {note}
            </div>
          )}
          {cooling && (
            <div className="tnum mt-4 text-[13px] text-ink-2">Try again in {cooldownLeft}s</div>
          )}

          <PinPad
            disabled={busy || cooling}
            onDigit={(d) => setPin((p) => (p.length < 4 ? p + d : p))}
            onBackspace={() => setPin((p) => p.slice(0, -1))}
          />

          {!inSetup && !cooling && (
            <button
              onClick={() => setConfirmReset(true)}
              className="sd-press mt-6 text-[13px]"
              style={{ color: "var(--ink-3)" }}
            >
              Forgot the PIN?
            </button>
          )}
        </div>

        {confirmReset && (
          <DragSheet label="Forgot the PIN" onClose={() => setConfirmReset(false)}>
            <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
              <div className="mb-1 text-[15px] font-medium text-ink-1">No PIN, no way in</div>
              <div className="text-[13px] leading-relaxed text-ink-3">
                The PIN is a one-way hash, so nothing — StudyDesk included — can recover it. The
                only door out is resetting the Safe folder, and that deletes the{" "}
                {entries.length === 1 ? "1 file" : `${entries.length} files`} inside for good.
              </div>
              <button
                onClick={() => void doReset()}
                className="sd-press mt-4 w-full rounded-card py-3.5 text-[15px] font-semibold"
                style={{
                  background: "color-mix(in srgb, var(--att-critical-text) 16%, transparent)",
                  color: "var(--att-critical-text)",
                }}
              >
                Reset and delete everything inside
              </button>
            </div>
          </DragSheet>
        )}
      </div>
    );
  }

  /* ── the folder itself ─────────────────────────────────────────────── */

  const row = (e: VaultEntry) => (
    <div key={e.id} className="flex items-center gap-3 py-2.5">
      <button
        onClick={() =>
          onOpen({ path: e.vaulted.replace(/^file:\/\//, ""), name: e.name, ext: e.ext, size: e.size, lastModified: e.at })
        }
        className="sd-tap flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <VaultThumb e={e} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] leading-tight text-ink-1">{e.name}</span>
          <span className="tnum mt-0.5 block truncate text-[13px] text-ink-2">
            {humanSize(e.size)} • in since {whenLabel(e.at)}
          </span>
        </span>
      </button>
      <button
        onClick={() => void takeOut(e)}
        aria-label={`Take ${e.name} out of the Safe folder`}
        className="sd-press sd-icon"
      >
        <RotateCcw className="size-[18px]" style={{ color: "var(--ink-2)" }} />
      </button>
      <button
        onClick={() => setDelTarget(e)}
        aria-label={`Delete ${e.name} for good`}
        className="sd-press -mr-2 p-2"
      >
        <Trash2 className="size-[18px]" style={{ color: "var(--att-critical-text)" }} />
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[65] flex flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-[max(30px,env(safe-area-inset-top))]">
        <button onClick={() => onClose(movedCount)} className="sd-press sd-icon" aria-label="Back to files">
          <ChevronLeft className="size-[22px]" style={{ color: "var(--ink-2)" }} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[20px] font-semibold tracking-tight text-ink-1">Safe folder</div>
          <div className="tnum text-[12px] text-ink-2">
            {entries.length} file{entries.length === 1 ? "" : "s"}
            {bytes > 0 ? ` • ${humanSize(bytes)}` : ""}
          </div>
        </div>
        <button
          onClick={() => {
            setStage("locked");
            setNote(null);
          }}
          className="sd-press flex items-center gap-1.5 px-2 py-2 text-[14px] font-medium"
          style={{ color: "var(--brand-ink)" }}
        >
          <Lock className="size-3.5" aria-hidden />
          Lock
        </button>
      </div>

      <div className="shrink-0 px-4 pt-1 text-[12px]" style={{ color: "var(--ink-3)" }}>
        Files wait here, inside StudyDesk&apos;s own storage, until you take them out. Put new ones in
        from any list&apos;s ⋮ menu.
      </div>

      {note && (
        <div className="mx-3 mt-2 shrink-0 rounded-card border border-brand/30 bg-brand-soft px-3 py-2 text-xs">
          {note}
        </div>
      )}

      <div className="sd-fade-in flex-1 overflow-y-auto px-4 pb-8 pt-1">
        {entries.length === 0 && !busy && (
          <p className="px-1 py-8 text-center text-[14px] text-ink-2">
            The Safe folder is empty. Any file&apos;s ⋮ menu has “Move to Safe folder”.
          </p>
        )}
        {entries.map(row)}
        {busy && (
          <div className="flex items-center justify-center gap-2 py-4 text-[13px] text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            Working
          </div>
        )}
      </div>

      {confirmMove && (
        <DragSheet label="Move into the Safe folder" onClose={() => setConfirmMove(null)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 text-[15px] font-medium text-ink-1">
              Move {confirmMove.length} file{confirmMove.length === 1 ? "" : "s"} in?
            </div>
            <div className="text-[13px] leading-relaxed text-ink-3">
              They leave their folders now. After this, only this PIN opens them — and the PIN
              cannot be recovered if it is forgotten.
            </div>
            <button
              onClick={() => void runMove()}
              className="sd-press mt-4 w-full rounded-card py-3.5 text-[15px] font-semibold"
              style={{ background: "var(--brand)", color: "var(--background)" }}
            >
              Move in
            </button>
          </div>
        </DragSheet>
      )}

      {delTarget && (
        <DragSheet label={`Delete ${delTarget.name}`} onClose={() => setDelTarget(null)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 text-[15px] font-medium text-ink-1">Delete for good?</div>
            <div className="text-[13px] text-ink-3">
              {delTarget.name} leaves this phone permanently. There is no bin behind the Safe folder.
            </div>
            <button
              onClick={() => void removeOne(delTarget)}
              className="sd-press mt-4 w-full rounded-card py-3.5 text-[15px] font-semibold"
              style={{
                background: "color-mix(in srgb, var(--att-critical-text) 16%, transparent)",
                color: "var(--att-critical-text)",
              }}
            >
              Delete
            </button>
          </div>
        </DragSheet>
      )}
    </div>
  );
}

/** Four digits, ten keys, one backspace — nothing else belongs on a PIN pad. */
function PinPad({
  onDigit,
  onBackspace,
  disabled,
}: {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  disabled?: boolean;
}) {
  const key = (label: string, onPress: () => void, aria: string, icon?: boolean) => (
    <button
      key={aria}
      onClick={onPress}
      disabled={disabled}
      aria-label={aria}
      className="sd-press flex h-[60px] w-[76px] items-center justify-center rounded-[16px] text-[22px] text-ink-1 disabled:opacity-40"
      style={{ background: "var(--surface-1)" }}
    >
      {icon ? <Delete className="size-6" style={{ color: "var(--ink-2)" }} /> : label}
    </button>
  );

  return (
    <div className="mt-5 grid grid-cols-3 gap-3">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => key(d, () => onDigit(d), d))}
      <span />
      {key("0", () => onDigit("0"), "0")}
      {key("", onBackspace, "Backspace", true)}
    </div>
  );
}

function VaultThumb({ e }: { e: VaultEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!hasRowThumb(e.ext)) return;
    void rowThumbUrl(e.vaulted.replace(/^file:\/\//, ""), e.ext, 160).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [e.vaulted, e.ext]);

  if (url) {
    return (
      <img
        src={url}
        alt=""
        decoding="async"
        className="shrink-0 rounded-[12px]"
        style={{ width: 44, height: 44, objectFit: "cover", background: "var(--surface-2)" }}
      />
    );
  }
  const Icon = ["mp3", "aac", "wav", "ogg", "m4a", "flac", "amr", "opus"].includes(e.ext)
    ? Music
    : e.ext === "apk"
      ? Download
      : FileText;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[12px] bg-surface-2"
      style={{ width: 44, height: 44 }}
    >
      <Icon className="size-5" style={{ color: "var(--ink-3)" }} />
    </span>
  );
}
