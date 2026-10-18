/**
 * Google Drive, signed in with the user's own OAuth client.
 *
 * This is the full-API route. The default route lives in lib/driveSaf.ts: the
 * Drive app already on the phone answers everything through Android's own
 * picker and no client exists anywhere. Both dress their rows as the same
 * DriveEntry, so the screen above can swap between them.
 *
 * The flow is the loopback one every desktop CLI uses, and there is no
 * backend anywhere in it:
 *
 *   1. This module builds the consent URL with PKCE (S256) and a random
 *      state, and the native side opens a one-shot listener on 127.0.0.1.
 *   2. The consent page opens in the system browser — Google refuses OAuth
 *      inside a WebView, and rightly so; a real browser shows the real URL.
 *   3. Google redirects to http://127.0.0.1:8976/oauth2redirect?code=…,
 *      which lands on the listener. The promise that was waiting resolves
 *      with the URL; the code is exchanged for tokens over a native POST,
 *      so no CORS rule and no client secret in a page can break it.
 *
 * The client itself is the user's own: they create a free OAuth client in
 * their Google Cloud console (the app walks them through it on first open),
 * and paste its ID and secret. The secret for an installed app is not a
 * secret in Google's own words — it cannot be kept from the APK anyway — and
 * PKCE is what actually guards the exchange.
 *
 * Tokens live in localStorage on this phone and nowhere else. Disconnect
 * revokes them with Google itself, not merely with us.
 */

import { Browser } from "@capacitor/browser";
import {
  driveAvailable, driveDownloadNative, driveFormPost, driveHttpGet, driveOauthCancel,
  driveOauthListen, driveUploadNative,
} from "./deviceFiles";

const CFG_KEY = "studydesk.drive.client.v1";
const TOK_KEY = "studydesk.drive.token.v1";

const PORT = 8976;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2redirect`;
const SCOPE = "https://www.googleapis.com/auth/drive";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/drive/v3";

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const ROOT_ID = "root";

/** Thrown when the stored sign-in is gone (revoked, or aged out while the
 *  OAuth app sits in testing mode). The UI's move is to show Connect again. */
export class DriveAuthError extends Error {}

type DriveConfig = { clientId: string; clientSecret: string };
type DriveTokens = {
  access: string;
  refresh: string;
  expiresAt: number;
  email: string;
  name: string;
};

export type DriveEntry = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  modified: number;
  folder: boolean;
  /** A Docs/Sheets/Slides-style item: lives inside Drive, no bytes to fetch. */
  googleDoc: boolean;
};

// ── storage ───────────────────────────────────────────────

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function driveConfig(): DriveConfig | null {
  return readJson<DriveConfig>(CFG_KEY);
}

function readTokens(): DriveTokens | null {
  return readJson<DriveTokens>(TOK_KEY);
}

export function driveStatus(): { available: boolean; configured: boolean; connected: boolean; email: string; name: string } {
  const cfg = driveConfig();
  const tok = readTokens();
  return {
    available: driveAvailable(),
    configured: !!cfg?.clientId && !!cfg?.clientSecret,
    connected: !!tok?.refresh,
    email: tok?.email ?? "",
    name: tok?.name ?? "",
  };
}

// ── PKCE ──────────────────────────────────────────────────

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  const buf = new Uint8Array(48);
  crypto.getRandomValues(buf);
  return base64Url(buf);
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

// ── sign-in ───────────────────────────────────────────────

function tokenError(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string; error_description?: string };
    const code = j.error ?? "";
    if (code === "invalid_grant") return "That sign-in is no longer valid. Connect again.";
    if (code === "invalid_client") return "Google did not recognise that client ID/secret pair. Check both from the Cloud console.";
    if (code === "redirect_uri_mismatch") return "The OAuth client must be of type \"Desktop app\" — that type is what allows the loopback redirect this app uses.";
    return j.error_description || code || "Google refused the sign-in.";
  } catch {
    return "Google refused the sign-in.";
  }
}

/**
 * The whole first-run ceremony: browser consent → loopback redirect → token
 * exchange → profile lookup. Every leg is validated (state, error param,
 * refresh token) because a half-finished sign-in that "succeeds" would only
 * fail later in a place with worse manners.
 */
export async function driveConnect(clientId: string, clientSecret: string): Promise<{ email: string; name: string }> {
  if (!driveAvailable()) throw new Error("Google Drive needs the Android build.");
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!id || !secret) throw new Error("Paste the client ID and the client secret first.");

  const verifier = randomVerifier();
  const challenge = await challengeOf(verifier);
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));

  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // Without the explicit prompt Google re-issues a refresh token only the
    // first time, and a re-connect later would silently get an hour-long
    // session instead of a durable one.
    prompt: "consent",
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  });

  // The listener has to be up before the browser goes anywhere: the redirect
  // can arrive while the consent screen is still rendering its last frame.
  const listening = driveOauthListen(PORT);
  await Browser.open({ url: `${AUTH_URL}?${params.toString()}` });

  let redirect: string;
  try {
    redirect = await listening;
  } catch (e) {
    void Browser.close();
    throw e;
  }
  void Browser.close();

  const url = new URL(redirect);
  const err = url.searchParams.get("error");
  if (err) {
    throw new Error(err === "access_denied" ? "Sign-in was cancelled." : `Google said: ${err}`);
  }
  if (url.searchParams.get("state") !== state) {
    throw new Error("The sign-in answer did not match this session. Try again.");
  }
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Google did not send an authorization code.");

  const res = await driveFormPost(
    TOKEN_URL,
    new URLSearchParams({
      client_id: id,
      client_secret: secret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
    }).toString(),
  );
  if (res.status >= 400) throw new Error(tokenError(res.body));

  const tok = JSON.parse(res.body) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tok.access_token) throw new Error("Google did not return an access token.");
  if (!tok.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Remove StudyDesk from myaccount.google.com/permissions and connect again.",
    );
  }

  // The profile is a convenience, not a requirement: a failure here must not
  // sink a sign-in that already has working tokens.
  let email = "";
  let name = "";
  try {
    const about = await driveHttpGet(`${API}/about?fields=user(displayName,emailAddress)`, tok.access_token);
    if (about.status < 400) {
      const j = JSON.parse(about.body) as { user?: { displayName?: string; emailAddress?: string } };
      email = j.user?.emailAddress ?? "";
      name = j.user?.displayName ?? "";
    }
  } catch {
    /* leave the profile blank */
  }

  const tokens: DriveTokens = {
    access: tok.access_token,
    refresh: tok.refresh_token,
    // A minute of slack keeps a token from expiring mid-request.
    expiresAt: Date.now() + Math.max(60, (tok.expires_in ?? 3600) - 60) * 1000,
    email,
    name,
  };
  localStorage.setItem(CFG_KEY, JSON.stringify({ clientId: id, clientSecret: secret }));
  localStorage.setItem(TOK_KEY, JSON.stringify(tokens));
  return { email, name };
}

/** Ends a sign-in that is mid-flight: the listener stops waiting, the pending
 *  connect() rejects with "cancelled", and the browser tab is closed. */
export async function driveAbortConnect(): Promise<void> {
  try {
    await driveOauthCancel();
  } catch {
    /* already gone */
  }
  void Browser.close();
}

/** Forgets locally and revokes with Google. Either half alone would be a lie:
 *  dropped-only tokens keep working for whoever still has a copy, and a revoke
 *  that fails offline should still sign this phone out. */
export async function driveDisconnect(): Promise<void> {
  const tok = readTokens();
  localStorage.removeItem(TOK_KEY);
  if (!tok?.refresh) return;
  try {
    await driveFormPost(REVOKE_URL, new URLSearchParams({ token: tok.refresh }).toString());
  } catch {
    /* offline: gone from this phone is the part that had to happen */
  }
}

// ── tokens ────────────────────────────────────────────────

/** The current access token, refreshed if it is at or near expiry. */
async function freshToken(): Promise<string> {
  const tok = readTokens();
  if (!tok?.refresh) throw new DriveAuthError("Connect Google Drive first.");
  if (Date.now() < tok.expiresAt - 5_000 && tok.access) return tok.access;

  const cfg = driveConfig();
  if (!cfg) throw new DriveAuthError("The Drive setup is missing from this phone. Connect again.");

  const res = await driveFormPost(
    TOKEN_URL,
    new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: tok.refresh,
    }).toString(),
  );
  if (res.status >= 400) {
    // An invalid_grant here means revoked, or aged out by a testing-mode
    // OAuth app. Either way this phone cannot recover by itself.
    localStorage.removeItem(TOK_KEY);
    throw new DriveAuthError("Drive sign-in expired. Connect again.");
  }
  const j = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new DriveAuthError("Drive sign-in expired. Connect again.");
  const next: DriveTokens = {
    ...tok,
    access: j.access_token,
    expiresAt: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000,
  };
  localStorage.setItem(TOK_KEY, JSON.stringify(next));
  return next.access;
}

// ── listing ───────────────────────────────────────────────

function toEntry(f: {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
}): DriveEntry {
  const mime = f.mimeType ?? "";
  return {
    id: f.id ?? "",
    name: f.name ?? "(untitled)",
    mimeType: mime,
    size: f.size ? Number(f.size) : 0,
    modified: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
    folder: mime === FOLDER_MIME,
    googleDoc: mime.startsWith("application/vnd.google-apps.") && mime !== FOLDER_MIME,
  };
}

/**
 * One folder's children, folders first, then names the way a human reads
 * them. Drive answers at most 200 rows per call; the caller is told when
 * there are more rather than silently losing them.
 */
export async function driveList(folderId: string): Promise<{ entries: DriveEntry[]; truncated: boolean }> {
  const token = await freshToken();
  const params = new URLSearchParams({
    q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
    pageSize: "200",
    fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await driveHttpGet(`${API}/files?${params.toString()}`, token);
  if (res.status >= 400) {
    if (res.status === 401) {
      localStorage.removeItem(TOK_KEY);
      throw new DriveAuthError("Drive sign-in expired. Connect again.");
    }
    throw new Error(`Drive answered ${res.status}. ${res.body}`);
  }
  const j = JSON.parse(res.body) as {
    nextPageToken?: string;
    files?: Parameters<typeof toEntry>[0][];
  };
  const entries = (j.files ?? []).map(toEntry);
  entries.sort((a, b) => {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return { entries, truncated: !!j.nextPageToken };
}

// ── transfers ─────────────────────────────────────────────

/** One Drive file onto the phone. Google's own formats (Docs, Sheets…) have
 *  no bytes to fetch — those open in the browser instead. */
export async function driveDownload(e: DriveEntry): Promise<{ path: string; name: string; bytes: number }> {
  if (e.googleDoc) throw new Error("This one lives inside Drive. Opening it in Drive is the honest move.");
  const token = await freshToken();
  const url = `${API}/files/${encodeURIComponent(e.id)}?alt=media&supportsAllDrives=true`;
  return driveDownloadNative(url, token, e.name);
}

/** Where a Drive item opens when it is a Google format. */
export const driveOpenUrl = (id: string) => `https://drive.google.com/open?id=${encodeURIComponent(id)}`;

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  epub: "application/epub+zip",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odp: "application/vnd.oasis.opendocument.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  webm: "video/webm",
  "3gp": "video/3gpp",
  m4v: "video/x-m4v",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  amr: "audio/amr",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
  apk: "application/vnd.android.package-archive",
};

export function mimeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/** One phone file up into a Drive folder, streamed off its path. */
export async function driveUpload(
  path: string,
  name: string,
  folderId: string,
): Promise<{ id: string; name: string }> {
  const token = await freshToken();
  return driveUploadNative(path, folderId, token, name, mimeOf(name));
}

/* ── display helpers ─────────────────────────────────────── */

const GOOGLE_LABEL: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.form": "Google Form",
  "application/vnd.google-apps.drawing": "Google Drawing",
  "application/vnd.google-apps.script": "Apps Script",
  "application/vnd.google-apps.site": "Google Site",
  "application/vnd.google-apps.shortcut": "Shortcut",
  "application/vnd.google-apps.map": "My Map",
  "application/vnd.google-apps.jam": "Jamboard",
};

export function driveKindLabel(e: DriveEntry): string {
  if (e.folder) return "Folder";
  const named = GOOGLE_LABEL[e.mimeType];
  if (named) return `${named} — opens in Drive`;
  const ext = e.name.slice(e.name.lastIndexOf(".") + 1).toLowerCase();
  return ext ? ext.toUpperCase() : "File";
}
