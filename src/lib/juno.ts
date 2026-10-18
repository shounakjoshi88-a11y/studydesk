import { NativeHttp } from "./native-http";

export type JunoSubject = { name: string; attended: number; total: number; pct: number };

const JKEY = "sd_juno";

export function loadJuno(): { portal: string; session: string } {
  try {
    const v = JSON.parse(localStorage.getItem(JKEY) || "{}");
    return { portal: v.portal || "https://rcoem.in", session: v.session || "" };
  } catch {
    return { portal: "https://rcoem.in", session: "" };
  }
}

export function saveJuno(v: { portal: string; session: string }) {
  localStorage.setItem(JKEY, JSON.stringify(v));
}

export function clearJuno() {
  localStorage.removeItem(JKEY);
}

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e: any = new Error(String(j.error || `Request failed (${r.status})`));
    if (j.debug) e.debug = j.debug;
    throw e;
  }
  return j;
}

/**
 * Sign in through the PC bridge. The bridge holds the session server-side
 * because the portal only serves its data endpoints after a home.htm warm-up,
 * and the cookie chain is easier to keep intact off the phone.
 */
export async function junoLogin(
  _bridge: string, token: string, _portal: string, username: string, password: string
): Promise<{ ok: boolean }> {
  const j = await postJson(`${_bridge.replace(/\/$/, "")}/juno/login`, { token, username, password });
  return { ok: Boolean(j.ok) };
}

export type JunoTerm = {
  id: number;
  name: string;
  current: boolean;
  start?: string;
  end?: string;
  /** Raw ids the subject endpoint needs. Kept internal. */
  _ids: {
    termId: string;
    subjectwisestudentids: string;
    subejctwiseBatchIds: string;
    batchsemestercapacity: string;
  };
};

export type JunoSubjectRow = {
  id: string;
  name: string;
  code: string;
  teacher: string;
  attended: number;
  absent: number;
  total: number;
  /** null when the portal reports 0/0 — that is "no data", not 0%. */
  pct: number | null;
};

export type JunoSubjectsResult = {
  term: { id: number; name: string };
  overall: number | null;
  subjects: JunoSubjectRow[];
};

function withToken(bridge: string, token: string, path: string, extra = "") {
  return `${bridge.replace(/\/$/, "")}${path}?token=${encodeURIComponent(token)}${extra}`;
}

export async function junoStatus(bridge: string, token: string): Promise<boolean> {
  const r = await fetch(withToken(bridge, token, "/juno/status")).catch(() => null);
  if (!r) return false;
  return Boolean((await r.json().catch(() => ({}))).connected);
}

export async function junoTerms(bridge: string, token: string): Promise<JunoTerm[]> {
  const r = await fetch(withToken(bridge, token, "/juno/terms"));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw withMeta(j, "Could not load terms.");
  return Array.isArray(j.terms) ? j.terms : [];
}

export async function junoSubjects(bridge: string, token: string, termId?: number | string): Promise<JunoSubjectsResult> {
  const extra = termId === undefined || termId === null ? "" : `&termId=${encodeURIComponent(String(termId))}`;
  const r = await fetch(withToken(bridge, token, "/juno/subjects", extra));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw withMeta(j, "Could not load attendance.");
  return {
    term: j.term || { id: 0, name: "" },
    overall: typeof j.overall === "number" ? j.overall : null,
    subjects: Array.isArray(j.subjects) ? j.subjects : [],
  };
}

export type JunoSession = { date: string; from: string; to: string; session: string; present: boolean };

export async function junoDetail(bridge: string, token: string, id: string): Promise<JunoSession[]> {
  const r = await fetch(withToken(bridge, token, "/juno/detail", `&id=${encodeURIComponent(id)}`));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw withMeta(j, "Could not load sessions.");
  return Array.isArray(j.sessions) ? j.sessions : [];
}

export async function junoLogout(bridge: string, token: string): Promise<void> {
  await fetch(`${bridge.replace(/\/$/, "")}/juno/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => undefined);
}

function withMeta(j: any, fallback: string) {
  const e: any = new Error(String(j?.error || fallback));
  e.signedOut = Boolean(j?.signedOut);
  e.rateLimited = Boolean(j?.rateLimited);
  e.stale = Boolean(j?.stale);
  return e;
}

/* ── The password manager ─────────────────────────────────────────
   One saved login, for the one portal this app signs in to. It is
   written the moment a sign-in succeeds (unless the save row on the
   sheet is switched off), read back into the form and into the
   automatic attendance sign-in, and removed by a single "Forget" tap.

   What is true, stated once: the pair lives in this app's own
   storage. It is never logged, never part of any sync payload, and
   sent to exactly one place — the student's college portal (or their
   own PC bridge). At rest it sits under Android's own file-based
   encryption like the rest of the app's data; StudyDesk does not
   stack a second cipher on top and does not claim to. The sheet says
   the same thing in fewer words, because a stored password is a real
   tradeoff and the user should be choosing it knowingly. */
const CRED_KEY = "sd_juno_creds";

export type SavedCreds = { username: string; password: string };

export function loadCreds(): SavedCreds | null {
  try {
    const v = JSON.parse(localStorage.getItem(CRED_KEY) || "null");
    if (v && typeof v.username === "string" && typeof v.password === "string" && v.username) {
      return { username: v.username, password: v.password };
    }
  } catch { /* corrupt or absent */ }
  return null;
}

export function saveCreds(c: SavedCreds) {
  try {
    localStorage.setItem(CRED_KEY, JSON.stringify(c));
  } catch { /* storage full or blocked — remembering is a convenience, not a requirement */ }
}

export function forgetCreds() {
  try {
    localStorage.removeItem(CRED_KEY);
  } catch { /* noop */ }
}

/** Whether the sheet's save row is switched on. Defaults to on, and the
    choice is persisted, so unchecking it once does not quietly come
    back the next time the sheet opens. */
const SAVE_KEY = "sd_juno_save";

export function prefersSave(): boolean {
  try {
    return localStorage.getItem(SAVE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setPrefersSave(v: boolean) {
  try {
    localStorage.setItem(SAVE_KEY, v ? "1" : "0");
  } catch { /* the preference just won't stick */ }
}

export function cleanJunoHtml(h: string): string {
  return h
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

export function parseJunoSubjects(html: string): JunoSubject[] {
  const out: JunoSubject[] = [];
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const chunks = tables.length ? tables : [html];
  for (const ch of chunks) {
    const rows = ch.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((m) => cleanJunoHtml(m[1]).trim())
        .filter(Boolean);
      if (cells.length < 2) continue;
      const pctCell = cells.find((c) => /(\d{1,3}(?:\.\d+)?)\s*%/.test(c));
      if (!pctCell) continue;
      const pct = parseFloat(pctCell.match(/(\d{1,3}(?:\.\d+)?)\s*%/)![1]!);
      if (!(pct >= 0 && pct <= 100)) continue;
      const nums = cells.flatMap((c) =>
        [...c.matchAll(/(\d+)\s*\/\s*(\d+)/g)].map((m) => [parseInt(m[1]!), parseInt(m[2]!)] as const)
      );
      const name =
        cells
          .filter((c) => /[A-Za-z]{3,}/.test(c) && !/%/.test(c))
          .sort((a, b) => b.length - a.length)[0] || "";
      if (!name) continue;
      const [attended, total] = nums[0] || [pct > 0 ? Math.round((pct / 100) * 40) : 0, 40];
      out.push({ name: name.slice(0, 60), attended, total, pct: Math.round(pct * 10) / 10 });
    }
  }
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true))).slice(0, 30);
}

function nativeCookies(headers: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "set-cookie") out.push(...String(v).split("\n"));
  }
  return out;
}

function jarPairs(setCookies: string[]): string {
  return setCookies
    .map((c) => c.split(";")[0]!.trim())
    .filter((p) => /^[^=]+=[^;]*$/.test(p))
    .join("; ");
}

function extractCsrf(html: string): string | null {
  const m =
    html.match(/name="_csrf" value="([^"]+)"/) ||
    html.match(/"_csrf"\s*:\s*"([^"]+)"/) ||
    html.match(/name="csrf[A-Za-z_]*" value="([^"]+)"/);
  return m ? m[1]! : null;
}


/* ══════════════════════════════════════════════════════════════════
   NATIVE PATH — straight from the phone, no PC bridge.

   Same endpoint chain as the bridge, driven through the Android
   NativeHttp plugin (which bypasses CORS). The plugin hands cookies
   back as plain headers, so the jar is maintained here in TypeScript.

   Two things the portal does that will break this if you forget them:
     1. GET /home.htm?type=owner must be called once after login, or
        every data endpoint returns the body "Problem".
     2. Rate limit: empty body means "slow down", not "no data".
   ══════════════════════════════════════════════════════════════════ */

const NATIVE_UA =
  "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";

type Jar = Map<string, string>;

function cookieHeader(jar: Jar): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorb(jar: Jar, headers: Record<string, string>) {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "set-cookie") continue;
    for (const raw of String(v).split("\n")) {
      const pair = raw.split(";")[0]?.trim();
      const i = pair?.indexOf("=") ?? -1;
      if (pair && i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
}

function nativeSession(portal: string) {
  const jar: Jar = new Map();
  const ref = `${portal.replace(/\/$/, "")}/studentCourseFileNew.htm`;
  const get = async (path: string) => {
    const r = await NativeHttp.request({
      url: portal.replace(/\/$/, "") + path,
      method: "GET",
      headers: {
        ...(cookieHeader(jar) ? { Cookie: cookieHeader(jar) } : {}),
        "User-Agent": NATIVE_UA,
        "X-Requested-With": "XMLHttpRequest",
        Referer: ref,
      },
    });
    absorb(jar, r.headers || {});
    return r;
  };
  return { jar, get };
}

async function nativeJson(get: (p: string) => Promise<any>, path: string, tries = 1) {
  for (let i = 0; i <= tries; i++) {
    const res = await get(path);
    const status = Number(res?.status ?? 0);
    const body = String(res?.body || "").trim();
    if (body) {
      if (body === "Problem") {
        const e: any = new Error("Session went stale. Sign in again.");
        e.stale = true;
        throw e;
      }
      try {
        return JSON.parse(body);
      } catch {
        throw new Error("Unexpected response from the portal.");
      }
    }
    // A 3xx is the portal bouncing us — the session was rejected. That is
    // NOT a rate limit, so fail fast and let the caller fall back rather
    // than sitting on a retry loop.
    if (status >= 300 && status < 400) {
      const e: any = new Error("The portal rejected the session.");
      e.stale = true;
      throw e;
    }
    // Empty 200 = rate limited. One short retry, then hand back to the caller.
    if (i < tries) await new Promise((r) => setTimeout(r, 8000));
  }
  const e: any = new Error("The portal is rate-limiting. Wait a minute and try again.");
  e.rateLimited = true;
  throw e;
}

let nativeLive: { portal: string; get: (p: string) => Promise<any> } | null = null;

export function nativeSignedIn() {
  return Boolean(nativeLive);
}

/** Sign in to the portal from the phone. Keeps the session in memory only. */
export async function junoNativeLogin(portal: string, username: string, password: string) {
  const base = portal.replace(/\/$/, "");
  const s = nativeSession(base);
  const lp = await s.get("/login.htm");
  const csrf = extractCsrf(String(lp.body || ""));
  const form =
    `j_username=${encodeURIComponent(username)}&j_password=${encodeURIComponent(password)}` +
    (csrf ? `&_csrf=${encodeURIComponent(csrf)}` : "");
  const r = await NativeHttp.request({
    url: base + "/j_spring_security_check",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": NATIVE_UA,
      ...(cookieHeader(s.jar) ? { Cookie: cookieHeader(s.jar) } : {}),
    },
    body: form,
  });
  // The login POST issues the *authenticated* session cookie. Not absorbing
  // it here is why every later call comes back empty.
  absorb(s.jar, r.headers || {});
  const body = String(r.body || "");
  const loc = String(r.location || "");
  if (!s.jar.get("JSESSIONID")) throw badCredentials("The portal did not accept the request.");

  // Spring Security bounces a rejected login back to the form. Detect that
  // specifically so we can say "wrong password" instead of hanging.
  if (/error|login\.htm/i.test(loc) && !/home\.htm/i.test(loc)) {
    throw badCredentials("That username or password was rejected by the portal.");
  }
  if (body.includes("j_password") && body.includes("Invalid")) {
    throw badCredentials("That username or password was rejected by the portal.");
  }
  // A 200 carrying the login form back means the same thing.
  if (r.status === 200 && body.includes('name="j_username"')) {
    throw badCredentials("That username or password was rejected by the portal.");
  }

  // Mandatory warm-up, and verify it actually took: a stale session answers
  // with a redirect, which is the real "you're not logged in" signal.
  const home = await s.get("/home.htm?type=owner");
  if (/login/i.test(String(home.location || ""))) {
    throw badCredentials("That username or password was rejected by the portal.");
  }
  nativeLive = { portal: base, get: s.get };
  return { ok: true };
}

function badCredentials(message: string) {
  const e: any = new Error(message);
  e.badCredentials = true;
  e.signedOut = true;
  return e;
}

export function junoNativeLogout() {
  nativeLive = null;
}

export async function junoNativeTerms(): Promise<JunoTerm[]> {
  if (!nativeLive) throw notSignedIn();
  const rows = await nativeJson(nativeLive.get, "/stu_getTermsOfStudentForCourceFile.json");
  return (Array.isArray(rows) ? rows : []).map((t: any) => ({
    id: Number(t.semesterId),
    name: String(t.terms2Name || "").trim(),
    current: Boolean(t.terms2Status),
    start: t.teachingStartDate || "",
    end: t.teachingEndDate || "",
    _ids: {
      termId: String(t.semesterId),
      subjectwisestudentids: t.subjectwiseStudentIds || "",
      // Server-side typo, kept verbatim.
      subejctwiseBatchIds: t.subejctwiseBatchIds || "",
      batchsemestercapacity: String(t.batchsemesterCapacity || ""),
    },
  }));
}

export async function junoNativeSubjects(termId?: number | string, known?: JunoTerm[]): Promise<JunoSubjectsResult> {
  if (!nativeLive) throw notSignedIn();
  // Reuse the terms the caller already fetched. Fetching them again here was
  // the single biggest source of the "stuck on Syncing…" feeling.
  const terms = known ?? (await junoNativeTerms());
  const t = termId ? terms.find((x) => String(x.id) === String(termId)) : terms.find((x) => x.current) || terms[0];
  if (!t) throw new Error("No term found for this account.");
  const q = new URLSearchParams({
    termId: t._ids.termId,
    refreshData: "0",
    subjectwisestudentids: t._ids.subjectwisestudentids,
    subejctwiseBatchIds: t._ids.subejctwiseBatchIds,
    batchsemestercapacity: t._ids.batchsemestercapacity,
  });
  const rows = await nativeJson(nativeLive.get, "/stu_getSubjectOnChangeWithSemId1.json?" + q.toString());
  let overall: number | null = null;
  try {
    const raw = String((await nativeLive.get("/stu_getStudentAttendancePercentageSP.json")).body || "").trim();
    const m = raw.match(/(\d{1,3}(?:\.\d+)?)/);
    if (m) overall = Math.round(parseFloat(m[1]) * 100) / 100;
  } catch { /* overall is a nice-to-have */ }
  return {
    term: { id: t.id, name: t.name },
    overall,
    subjects: mapRows(rows),
  };
}

export async function junoNativeDetail(id: string): Promise<JunoSession[]> {
  if (!nativeLive) throw notSignedIn();
  const rows = await nativeJson(
    nativeLive.get,
    "/stu_getSubjectWiseStudentAttendanceCoursceFile.json?subjectWiseStudentID=" + encodeURIComponent(id)
  );
  return (Array.isArray(rows) ? rows : []).map((r: any) => ({
    date: String(r.Date || ""),
    from: String(r.stime || ""),
    to: String(r.etime || ""),
    session: String(r.sessionNo ?? r.session ?? ""),
    present: String(r.presenty || r.present || "").toUpperCase().startsWith("P"),
  }));
}

/**
 * The student's own record, as the portal exposes it.
 *
 * Only fields that actually came back are ever filled in. The portal does not
 * publish a roll number or a division on this endpoint, so rather than guess
 * at them and present a fabricated identity card, they are simply absent from
 * the type and from the screen.
 */
export type JunoProfile = {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  fullName?: string;
  /** The portal's own "Student Unique Id", e.g. 25RBU/UG/CS/01/000342. */
  uniqueId?: string;
  courseName?: string;
  departmentName?: string;
  instituteName?: string;
  /** Key the portal uses to address the student's uploaded photo. */
  profileImagePath?: string;
  dateOfBirth?: string;
  bloodGroup?: string;
  mobileNo?: string;
  email?: string;
  /** Current term name comes from the terms endpoint, e.g. "SEM III". */
  termName?: string;
};

const clean = (s: unknown) => {
  const v = String(s ?? "").trim();
  return v.length ? v : undefined;
};

/**
 * Fetch the profile from the live portal session.
 *
 * The current term is passed in rather than fetched here. The Juno tab has
 * already asked the portal for the terms to render its own selector, and this
 * is an extra request against a portal that starts refusing calls after a
 * couple of dozen. One wasted request is the difference between the profile
 * loading and not.
 */
export async function junoNativeProfile(termName?: string): Promise<JunoProfile> {
  if (!nativeLive) throw notSignedIn();
  const raw = await nativeJson(nativeLive.get, "/stu_getStudentDetails.json");
  const rec: any = Array.isArray(raw) ? raw[0] : raw;
  if (!rec || typeof rec !== "object") throw new Error("The portal returned no student record.");

  const name = [clean(rec.firstName), clean(rec.middleName), clean(rec.lastName)]
    .filter(Boolean)
    .join(" ");

  let term = clean(termName);
  if (!term) {
    try {
      const terms = await junoNativeTerms();
      term = clean(terms.find((t) => t.current)?.name) ?? clean(terms[terms.length - 1]?.name);
    } catch {
      // A profile without a term is still a profile; the term is a bonus and
      // must not be able to fail the whole thing.
    }
  }

  return {
    firstName: clean(rec.firstName),
    middleName: clean(rec.middleName),
    lastName: clean(rec.lastName),
    fullName: clean(name),
    uniqueId: clean(rec.studentUniqueId),
    courseName: clean(rec.courseName),
    departmentName: clean(rec.departmentName),
    instituteName: clean(rec.instituteName),
    profileImagePath: clean(rec.profileImagePath),
    dateOfBirth: clean(rec.dob),
    bloodGroup: clean(rec.bloodGroup),
    mobileNo: clean(rec.mobileNo),
    email: clean(rec.personalEmailId) ?? clean(rec.alternateEmailId),
    termName: term,
  };
}

function mapRows(rows: any): JunoSubjectRow[] {
  return (Array.isArray(rows) ? rows : []).map((r: any) => {
    const attended = Number(r.presentCount) || 0;
    const total = attended + (Number(r.absentCount) || 0);
    return {
      // The per-date detail endpoint keys off the ENCODED id, not the
      // numeric one — passing SubjectwiseStudentId returns an empty body.
      id: String(r.encoSubjectwiseStudentId ?? r.SubjectwiseStudentId ?? r.subjectCode ?? r.subject),
      name: String(r.subject || "").trim(),
      code: String(r.subjectCode || "").trim(),
      // Server-side typo, kept verbatim.
      teacher: String(r.facultName || "").trim(),
      attended,
      absent: Number(r.absentCount) || 0,
      total,
      // The college's own app renders 0/0 as "NaN%" — surface it as
      // "no data" rather than pretending it is 0%.
      pct: total ? Math.round((attended / total) * 1000) / 10 : null,
    };
  });
}

function notSignedIn() {
  const e: any = new Error("Not signed in to Juno.");
  e.signedOut = true;
  return e;
}
