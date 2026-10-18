/**
 * The Drive source: connect once, then browse, download and upload folders of
 * the user's own Google Drive, in the same chrome the rest of Files uses.
 *
 * There are two ways in. The default is Android's own picker plus the Drive
 * app already on the phone — choose My Drive or a folder inside it, and no
 * client ID, secret or sign-in is involved at all. The other, tucked behind
 * "Or use your own OAuth client", talks to Google's API directly with a
 * client from the user's own Cloud console. The screen above does not care
 * which route is carrying it: every row says exactly what will happen to it —
 * folders open, files save into Downloads, Google formats open in Drive
 * because their bytes live inside Google. No spinner ever pretends to be
 * progress.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft, Folder, FolderOpen, FileText, Image as ImageIcon, Video, Music, FileSpreadsheet,
  Presentation, File as FileIcon, Loader2, ChevronRight, Cloud, LogOut, UserRound,
} from "lucide-react";
import { Browser } from "@capacitor/browser";
import { DragSheet } from "./DragSheet";
import { EmptyState } from "./EmptyState";
import { humanSize, whenLabel } from "../lib/deviceFiles";
import {
  DriveAuthError, driveAbortConnect, driveConfig, driveConnect, driveDisconnect, driveDownload,
  driveKindLabel, driveList, driveOpenUrl, driveStatus, driveUpload, ROOT_ID, type DriveEntry,
} from "../lib/drive";
import {
  driveSafDownload, driveSafForget, driveSafGrant, driveSafList, driveSafOpenItem,
  driveSafState, driveSafUpload, type DriveSafStatus,
} from "../lib/driveSaf";

type Crumb = { id: string; name: string };

function iconFor(e: DriveEntry) {
  if (e.folder) return Folder;
  const m = e.mimeType;
  if (m.startsWith("image/")) return ImageIcon;
  if (m.startsWith("video/")) return Video;
  if (m.startsWith("audio/")) return Music;
  if (m === "application/vnd.google-apps.spreadsheet" || m.includes("spreadsheet") || m.includes("excel")) return FileSpreadsheet;
  if (m === "application/vnd.google-apps.presentation" || m.includes("presentation") || m.includes("powerpoint")) return Presentation;
  if (m.startsWith("application/vnd.google-apps.")) return FileText;
  return FileIcon;
}

export function DriveBrowser({
  pickFiles,
  onPicked,
}: {
  /** Set while the screen is in upload mode: browse to the folder the files
   *  should land in, then press the footer button. */
  pickFiles?: { path: string; name: string }[] | null;
  onPicked?: () => void;
}) {
  const [status, setStatus] = useState(driveStatus());
  /** null until the persisted Drive-app grant has been checked; the connect
   *  card waits for that answer rather than flashing the OAuth setup at a
   *  user who already has the Drive app route connected. */
  const [saf, setSaf] = useState<DriveSafStatus | null>(null);
  const [stack, setStack] = useState<Crumb[]>([{ id: ROOT_ID, name: "My Drive" }]);
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  /** The id of the row currently being saved, so exactly one row spins. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number; current: string } | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  // Connect card fields
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const top = stack[stack.length - 1]!;
  const topRef = useRef(top.id);

  /** Which route is actually carrying this screen. The Drive-app route wins
   *  when both somehow stored — it is the one that needs no upkeep. */
  const route: "saf" | "oauth" | null = saf?.connected
    ? "saf"
    : status.connected
      ? "oauth"
      : null;

  useEffect(() => {
    const cfg = driveConfig();
    if (cfg) {
      setClientId(cfg.clientId);
      setClientSecret(cfg.clientSecret);
      // Someone who pasted a client before keeps their route in view.
      setShowAdvanced(true);
    }
    let live = true;
    void driveSafState().then((s) => {
      if (!live) return;
      setSaf(s);
      if (s.connected) setStack([{ id: s.treeId, name: s.name }]);
    });
    return () => {
      live = false;
    };
  }, []);

  /** One folder's children, with the auth-expiry case routed to the card. */
  const load = useCallback(
    async (folderId: string) => {
      setLoading(true);
      setFatal(null);
      try {
        const r = route === "saf" ? await driveSafList(folderId) : await driveList(folderId);
        if (topRef.current !== folderId) return;
        setEntries(r.entries);
        setTruncated(r.truncated);
      } catch (e) {
        if (topRef.current !== folderId) return;
        if (e instanceof DriveAuthError) {
          setStatus(driveStatus());
          setSaf({ connected: false, name: "", treeId: "" });
          setConnectError(e.message);
        } else {
          setFatal(e instanceof Error ? e.message : String(e));
        }
        setEntries([]);
      } finally {
        if (topRef.current === folderId) setLoading(false);
      }
    },
    [route],
  );

  useEffect(() => {
    topRef.current = top.id;
    setNote(null);
    if (route) void load(top.id);
  }, [top.id, route, load]);

  const enter = (e: DriveEntry) => {
    setStack((s) => [...s, { id: e.id, name: e.name }]);
  };

  const back = () => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };

  const save = async (e: DriveEntry) => {
    if (busyId) return;
    setNote(null);
    if (e.googleDoc) {
      // On the Drive-app route the item goes straight to the Drive app, which
      // is where a Google format belongs; the browser is the fallback for the
      // rare phone that takes this content uri from nobody.
      if (route === "saf" && (await driveSafOpenItem(e))) return;
      await Browser.open({ url: driveOpenUrl(e.id) });
      return;
    }
    setBusyId(e.id);
    setNote(`Saving ${e.name}…`);
    try {
      const r = route === "saf" ? await driveSafDownload(e) : await driveDownload(e);
      setNote(`Saved to Download/${r.name} — ${humanSize(r.bytes)}.`);
    } catch (err) {
      if (err instanceof DriveAuthError) {
        setStatus(driveStatus());
        setSaf({ connected: false, name: "", treeId: "" });
        setConnectError(err.message);
      } else {
        setNote(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusyId(null);
    }
  };

  /** Upload mode's one action: the pickFiles into the folder on screen. */
  const uploadHere = async () => {
    const files = pickFiles ?? [];
    if (!files.length || uploading) return;
    setNote(null);
    let done = 0;
    const failures: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      setUploading({ done, total: files.length, current: f.name });
      try {
        await (route === "saf"
          ? driveSafUpload(f.path, f.name, top.id)
          : driveUpload(f.path, f.name, top.id));
        done++;
      } catch (err) {
        if (err instanceof DriveAuthError) {
          setUploading(null);
          setStatus(driveStatus());
          setSaf({ connected: false, name: "", treeId: "" });
          setConnectError(err.message);
          return;
        }
        failures.push(`${f.name} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    setUploading(null);
    onPicked?.();
    setNote(
      failures.length === 0
        ? `Uploaded ${done} file${done === 1 ? "" : "s"} to ${top.name}.`
        : `Uploaded ${done} of ${files.length} to ${top.name}. Failed: ${failures.join("; ")}`,
    );
    void load(top.id);
  };

  /** The default route: Android's picker hands over one Drive tree and the
   *  Drive app does the rest. Nothing is registered anywhere. */
  const connectWithDriveApp = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const r = await driveSafGrant();
      if (!r.cancelled) {
        setSaf({ connected: true, name: r.name, treeId: r.treeId });
        setStack([{ id: r.treeId, name: r.name }]);
      }
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  /** The advanced route: the user's own OAuth client, full API reach. */
  const connectWithClient = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      await driveConnect(clientId, clientSecret);
      setStatus(driveStatus());
      setTopAndReload();
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  const setTopAndReload = () => {
    setStack([{ id: ROOT_ID, name: "My Drive" }]);
  };

  const changeFolder = async () => {
    setAccountOpen(false);
    await connectWithDriveApp();
  };

  const disconnect = async () => {
    setAccountOpen(false);
    if (route === "saf") {
      await driveSafForget();
      setSaf({ connected: false, name: "", treeId: "" });
    } else {
      await driveDisconnect();
      setStatus(driveStatus());
    }
    setEntries([]);
    setNote(null);
    setStack([{ id: ROOT_ID, name: "My Drive" }]);
  };

  // ── no route yet: the connect card ──────────────────────

  if (!route) {
    if (saf === null) {
      // One quiet beat while the persisted grant is checked. It is a prefs
      // read plus Android's permission list — no network, no spinner needed.
      return <div className="sd-fade-in flex-1" aria-hidden />;
    }
    if (!status.available) {
      return (
        <div className="sd-fade-in flex-1 overflow-y-auto px-4 pb-32 pt-4">
          <p className="text-[14px] leading-relaxed text-ink-2">
            Google Drive runs on the phone build of StudyDesk — it needs Android's own picker and
            the Drive app, neither of which this preview has.
          </p>
        </div>
      );
    }
    return (
      <div className="sd-fade-in flex-1 overflow-y-auto px-4 pb-32 pt-4">
        <div className="flex items-center gap-2.5">
          <Cloud className="size-6" style={{ color: "var(--brand-ink)" }} />
          <div>
            <div className="text-[17px] font-semibold tracking-tight text-ink-1">Google Drive</div>
            <div className="text-[12px] text-ink-2">Browse without a single sign-in step</div>
          </div>
        </div>

        {(connectError || fatal) && (
          <p
            className="mt-4 rounded-card border px-3 py-2 text-[13px] text-ink-1"
            style={{
              background: "color-mix(in srgb, var(--att-critical) 10%, transparent)",
              borderColor: "color-mix(in srgb, var(--att-critical) 32%, transparent)",
            }}
          >
            {connectError || fatal}
          </p>
        )}

        <button
          onClick={() => void connectWithDriveApp()}
          disabled={connecting}
          className="sd-press mt-5 w-full rounded-card bg-brand py-3.5 text-[15px] font-semibold text-background disabled:opacity-40"
        >
          {connecting ? "Waiting for the picker…" : "Choose a Drive folder"}
        </button>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
          Android's own picker opens, showing whichever Google accounts are on this phone. Hand it
          one folder — Android never gives an app all of My Drive, so pick an existing folder, or
          tap CREATE NEW FOLDER in the picker and make one. StudyDesk can only ever see what you
          picked. No client ID, no secret, nothing to register.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
          Google Docs, Sheets and Slides open in the Drive app — their bytes live inside Google.
          Everything else saves into Download.
        </p>

        <button
          onClick={() => setShowAdvanced((s) => !s)}
          aria-expanded={showAdvanced}
          className="sd-press mt-6 flex items-center gap-1.5 text-[13px] font-medium"
          style={{ color: "var(--brand-ink)" }}
        >
          {showAdvanced ? "Hide the OAuth-client route" : "Or use your own OAuth client"}
        </button>

        {showAdvanced && (
          <div className="sd-fade-in mt-4 border-t border-line pt-4">
            <p className="text-[13px] leading-relaxed text-ink-2">
              The route above needs no setup at all. This one talks to Google's API directly, via a
              client that belongs to you rather than to this app's maker — free, and about five
              minutes in Google's Cloud console.
            </p>

            <label className="mt-4 block text-[12px] font-medium" style={{ color: "var(--ink-3)" }}>
              OAuth client ID
            </label>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="…apps.googleusercontent.com"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="mt-1.5 w-full rounded-card bg-surface-2 px-3.5 py-3.5 text-[14px] outline-none placeholder:text-ink-2 focus:ring-1 focus:ring-brand/40"
            />

            <label className="mt-4 block text-[12px] font-medium" style={{ color: "var(--ink-3)" }}>
              Client secret
            </label>
            <input
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="GOCSPX-…"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="mt-1.5 w-full rounded-card bg-surface-2 px-3.5 py-3.5 text-[14px] outline-none placeholder:text-ink-2 focus:ring-1 focus:ring-brand/40"
            />

            <button
              onClick={() => setShowSteps((s) => !s)}
              className="sd-press mt-4 flex items-center gap-1.5 text-[13px] font-medium"
              style={{ color: "var(--brand-ink)" }}
            >
              {showSteps ? "Hide" : "How do I get these?"}
            </button>

            {showSteps && (
              <ol className="sd-fade-in mt-3 space-y-2.5 rounded-card border border-line bg-surface-1 px-4 py-3.5 text-[13px] leading-relaxed text-ink-2">
                <li>1. Open console.cloud.google.com and create a project — any name will do.</li>
                <li>2. APIs &amp; Services → Library → search “Google Drive API” → Enable.</li>
                <li>
                  3. OAuth consent screen → External → app name + your email; under “Test users” add
                  your own Gmail address.
                </li>
                <li>
                  4. Credentials → Create credentials → OAuth client ID → application type{" "}
                  <span className="text-ink-1">Desktop app</span> → Create.
                </li>
                <li>5. Copy the client ID and secret from the dialog and paste them above.</li>
                <li className="pt-1" style={{ color: "var(--ink-3)" }}>
                  When Google says the app isn't verified: Advanced → go to the app → Allow. While the
                  app is in Testing mode Google expires sign-ins after 7 days — press “Publish app” on
                  the consent screen page to stop that. Verification is not needed for your own use.
                </li>
              </ol>
            )}

            <button
              onClick={() => void connectWithClient()}
              disabled={connecting || !clientId.trim() || !clientSecret.trim()}
              className="sd-press mt-5 w-full rounded-card border border-line py-3.5 text-[15px] font-semibold text-ink-1 disabled:opacity-40"
            >
              {connecting ? "Waiting for the browser…" : "Connect Google Drive"}
            </button>
            {connecting && (
              <button
                onClick={() => void driveAbortConnect()}
                className="sd-press mt-2 w-full rounded-card border border-line py-3 text-[14px] font-medium"
                style={{ color: "var(--ink-2)" }}
              >
                Cancel
              </button>
            )}
            <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
              Sign-in happens in your real browser. This app keeps the session on this phone only,
              and Disconnect revokes it with Google itself.
            </p>
          </div>
        )}
      </div>
    );
  }

  // ── signed in: one folder at a time ─────────────────────

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1 px-1 pt-2">
        <button
          onClick={back}
          disabled={stack.length <= 1}
          className="sd-press sd-icon disabled:opacity-30"
          aria-label="Up one folder"
        >
          <ChevronLeft className="size-[22px]" style={{ color: "var(--ink-2)" }} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[20px] font-semibold tracking-tight text-ink-1">{top.name}</div>
          <div className="truncate text-[12px] text-ink-2">
            {route === "saf"
              ? "Through the Drive app on this phone"
              : status.email
                ? `Drive • ${status.email}`
                : "Google Drive"}
          </div>
        </div>
        <button
          onClick={() => setAccountOpen(true)}
          className="sd-press sd-icon"
          aria-label="Drive account"
        >
          <UserRound className="size-[19px]" style={{ color: "var(--ink-2)" }} />
        </button>
      </div>

      {pickFiles && pickFiles.length > 0 && (
        <div className="mx-3 mt-2 shrink-0 rounded-card border border-brand/30 bg-brand-soft px-3 py-2 text-[12px] text-ink-1">
          Choose the folder {pickFiles.length === 1 ? `for “${pickFiles[0]!.name}”` : `for ${pickFiles.length} files`} below.
        </div>
      )}

      {note && (
        <div className="mx-3 mt-2 shrink-0 rounded-card bg-surface-2 px-3 py-2 text-[12px] text-ink-1">
          {note}
        </div>
      )}
      {fatal && (
        <div
          className="mx-3 mt-2 flex shrink-0 items-center justify-between gap-2 rounded-card border px-3 py-2 text-[12px] text-ink-1"
          style={{
            background: "color-mix(in srgb, var(--att-critical) 10%, transparent)",
            borderColor: "color-mix(in srgb, var(--att-critical) 32%, transparent)",
          }}
        >
          <span className="min-w-0">{fatal}</span>
          <button onClick={() => void load(top.id)} className="sd-press shrink-0 font-medium" style={{ color: "var(--brand-ink)" }}>
            Retry
          </button>
        </div>
      )}

      <div className="sd-fade-in flex-1 overflow-y-auto px-4 pt-1 pb-6">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            Reading Drive
          </div>
        )}

        {!loading && !fatal && entries.length === 0 && (
          <EmptyState
            variant="files"
            title="This folder is empty"
            hint={
              pickFiles && pickFiles.length > 0
                ? "Send your files here with the button below."
                : "Files you save or upload will show up here."
            }
          />
        )}

        {!loading &&
          entries.map((e) => {
            const Icon = iconFor(e);
            const busy = busyId === e.id;
            return (
              <button
                key={e.id}
                onClick={() => (e.folder ? enter(e) : void save(e))}
                className="sd-tap flex w-full items-center gap-3.5 px-1 py-3 text-left"
                aria-label={e.folder ? `Open folder ${e.name}` : `Save ${e.name} to this phone`}
              >
                <Icon className="size-[22px] shrink-0" style={{ color: e.folder ? "var(--brand-ink)" : "var(--ink-2)" }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] leading-tight text-ink-1">{e.name}</span>
                  <span className="tnum mt-0.5 block truncate text-[12px] text-ink-2">
                    {e.folder ? "Folder" : (
                      <>
                        {e.size > 0 && <>{humanSize(e.size)} • </>}
                        {e.modified > 0 ? whenLabel(e.modified) : driveKindLabel(e)}
                      </>
                    )}
                  </span>
                </span>
                {busy ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" style={{ color: "var(--ink-3)" }} aria-hidden />
                ) : e.folder ? (
                  <ChevronRight className="size-4 shrink-0" style={{ color: "var(--ink-3)" }} aria-hidden />
                ) : e.googleDoc ? (
                  <span className="shrink-0 text-[11px]" style={{ color: "var(--ink-3)" }}>opens in Drive</span>
                ) : null}
              </button>
            );
          })}

        {!loading && truncated && (
          <p className="px-1 py-4 text-center text-[12px]" style={{ color: "var(--ink-3)" }}>
            {route === "saf"
              ? "Showing the first 400 items in this folder."
              : "Showing the first 200 items in this folder."}
          </p>
        )}
      </div>

      {pickFiles && pickFiles.length > 0 && (
        <div
          className="shrink-0 border-t border-line px-4 pt-3"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <button
            onClick={() => void uploadHere()}
            disabled={!!uploading}
            className="sd-press w-full rounded-card bg-brand py-3.5 text-[15px] font-semibold text-background disabled:opacity-50"
          >
            {uploading
              ? `Uploading ${uploading.current}… (${uploading.done + 1} of ${uploading.total})`
              : pickFiles.length === 1
                ? `Upload “${pickFiles[0]!.name}” to this folder`
                : `Upload ${pickFiles.length} files to this folder`}
          </button>
        </div>
      )}

      {accountOpen && (
        <DragSheet label="Google Drive account" onClose={() => setAccountOpen(false)}>
          <div className="px-4" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}>
            <div className="mb-1 text-[15px] font-medium text-ink-1">
              {route === "saf" ? saf?.name || "Google Drive" : status.name || "Google Drive"}
            </div>
            <div className="text-[13px] text-ink-2">
              {route === "saf" ? "Through the Drive app on this phone" : status.email || "Signed in"}
            </div>

            {route === "saf" && (
              <div className="mt-4 border-t border-line pt-4">
                <button
                  onClick={() => void changeFolder()}
                  className="sd-press flex w-full items-center gap-3 py-3 text-left text-[15px] text-ink-1"
                >
                  <FolderOpen className="size-[18px]" style={{ color: "var(--ink-2)" }} />
                  Choose a different folder
                </button>
              </div>
            )}

            <div className="border-t border-line pt-4">
              <button
                onClick={() => void disconnect()}
                className="sd-press flex w-full items-center gap-3 py-3 text-left text-[15px]"
                style={{ color: "var(--att-critical-text)" }}
              >
                <LogOut className="size-[18px]" />
                Disconnect Google Drive
              </button>
              <p className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
                {route === "saf"
                  ? "Removes StudyDesk's access to that Drive area — you can grant it again any time. Files already saved to the phone stay where they are."
                  : "Signs this phone out and revokes the access with Google. Files already saved to the phone stay where they are."}
              </p>
            </div>
          </div>
        </DragSheet>
      )}
    </div>
  );
}
