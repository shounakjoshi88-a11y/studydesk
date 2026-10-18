import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Trash2, X, Bell, BellOff, Shuffle, RotateCcw, ChevronLeft, ChevronDown, LogOut, RefreshCw, ScanText, Loader2, Check, KeyRound } from "lucide-react";
import { LocalNotifications } from "@capacitor/local-notifications";
import { EmptyState } from "../components/EmptyState";
import {
  junoLogin, junoTerms, junoSubjects, junoLogout as junoLogoutBridge, junoDetail as junoDetailBridge, loadJuno, clearJuno,
  junoNativeLogin, junoNativeLogout, junoNativeTerms, junoNativeSubjects, junoNativeDetail, nativeSignedIn,
  junoNativeProfile, type JunoProfile,
  loadCreds, saveCreds, forgetCreds, prefersSave, setPrefersSave,
  type JunoTerm, type JunoSubjectRow, type JunoSubjectsResult, type JunoSession,
} from "../lib/juno";
import { loadBridge } from "../lib/ask";
import { parseTimetableText, type ParsedClass } from "../lib/ai";
import { AttendanceRing, BAND_SHORT } from "../components/AttendanceRing";
import { JunoSignInSheet } from "../components/JunoSignInSheet";
import { DragSheet } from "../components/DragSheet";
import { FlipClock } from "../components/FlipClock";
import type { PortalState } from "../components/PortalGlyph";
import { BAND_GLYPH, BAND_TEXT, REQUIRED, bandOf, byUrgency, pct, rollUp, safeBunks, needToAttend } from "../lib/attendance";
import { byDue, byDueTime, cardDue, deckStats, dueAt, gradeCard, relative, whenLabel, type TimeOfDay } from "../lib/review";

/** Never let a hung network call leave the button spinning forever. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** One sentence of plain bunk advice — the payoff of the attendance screen. */
function bunkLine(s: { name: string; attended: number; total: number }): string {
  const p = pct(s);
  if (p === null) return "No classes recorded yet";
  const b = safeBunks(s);
  if (p >= 100) return "Perfect record — attend anything";
  if (p < REQUIRED) return `Attend the next ${needToAttend(s)} to reach ${REQUIRED}%`;
  return `${b} safe ${b === 1 ? "bunk" : "bunks"} left`;
}
import { postPinned, unpostPinned } from "../lib/pinned";
import {
  listClasses, saveClasses, listSubjects, saveSubjects, listDecks, saveDecks,
  listMarks, appendMark, clearMarksFor, listFiles, getFileData, fileToBase64,
  listPinnedTasks, savePinnedTasks,
  bunkInfo, uid, type ClassItem, type AttSubject, type Deck, type AttMark, type FileMeta, type PinnedTask,
} from "../lib/store";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const todayIdx = () => (new Date().getDay() + 6) % 7;

/** Which portal account the local attendance list belongs to. */
const ATT_OWNER = "sd_att_owner";
const loadJson = <T,>(k: string): T | null => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
const saveJson = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch { /* storage blocked; the list still lives in memory for this session */ }
};

const numId = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h % 2000000000);
};

/**
 * Class reminder.
 *
 * Two things were silently killing these on Android 13+:
 *   1. the manifest had no POST_NOTIFICATIONS, so the system dropped every
 *      one of them without a word;
 *   2. the schedule is registered per class, so a timetable edit or a
 *      reinstall left stale ids behind. `remapClassReminder` cancels any
 *      previous id for the same slot before re-arming.
 */
const NOTIF_CHANNEL = "class-reminders";

async function ensureNotifPermission(): Promise<boolean> {
  try {
    const res: any = await LocalNotifications.requestPermissions();
    const state = String(res?.display ?? res ?? "");
    // Anything the user hasn't hard-blocked counts as usable.
    return state !== "denied";
  } catch {
    return false;
  }
}

async function scheduleClassReminder(c: ClassItem) {
  try {
    const ok = await ensureNotifPermission();
    if (!ok) return;
    const [hh, mm] = c.start.split(":").map(Number);
    const mins = Math.max(0, (hh || 0) * 60 + (mm || 0) - 10);
    // Capacitor weekday: 1 = Sunday … 7 = Saturday. Ours: 0 = Mon … 6 = Sun.
    const weekday = c.day === 6 ? 1 : c.day + 2;
    await LocalNotifications.cancel({ notifications: [{ id: numId(c.id) }] }).catch(() => undefined);
    await LocalNotifications.schedule({
      notifications: [
        {
          id: numId(c.id),
          title: c.subject,
          body: c.room ? `Room ${c.room}, starts ${c.start}` : `Starts ${c.start}`,
          schedule: { on: { weekday, hour: Math.floor(mins / 60), minute: mins % 60 }, repeats: true },
          extra: { kind: "class", classId: c.id },
        },
      ],
    });
  } catch (e) {
    console.warn("reminder not scheduled", e);
  }
}

async function cancelClassReminder(c: ClassItem) {
  try {
    await LocalNotifications.cancel({ notifications: [{ id: numId(c.id) }] });
  } catch { /* noop */ }
}

/** Re-arm every reminder for a class list — used after a timetable import. */
async function armAllReminders(list: ClassItem[]) {
  for (const c of list) {
    if ((c as any).remind !== false) await scheduleClassReminder(c);
  }
}

const inputCls = "w-full px-3 py-2.5 rounded-[10px] bg-input border border-border text-sm outline-none focus:border-brand";
// Sentence case, no tracking. Shouted eyebrows are the loudest template tell.
const labelCls = "text-[12px] font-medium text-ink-2";
const sheetCls = "fixed inset-0 z-50 flex flex-col justify-end bg-black/60";
const sheetInner = "bg-card border-t border-border rounded-t-3xl p-4 pb-8 max-h-[80%] flex flex-col";

type Sub = "schedule" | "attendance" | "cards" | "juno" | "pinned";

const SUBS: Sub[] = ["schedule", "attendance", "cards", "juno", "pinned"];
  const SUB_KEY = "sd_campus_tab";

/**
 * Campus unmounts every time the drawer closes, so without this the tab you
 * were on is gone by the time you come back and you land on Schedule every
 * time. Remembered rather than restored to a default, because the tab you
 * came back to is almost always the one you just left.
 */
function readSub(): Sub {
  try {
    const v = localStorage.getItem(SUB_KEY);
    return SUBS.includes(v as Sub) ? (v as Sub) : "schedule";
  } catch {
    return "schedule";
  }
}

/**
 * When the attendance section last signed itself in. The portal starts
 * refusing calls after a couple of dozen requests, so re-opening the
 * drawer twice in a minute must not mean a second login POST.
 */
let lastAutoSync = 0;
const AUTO_SYNC_COOLDOWN = 45_000;

export function Campus({ onClose }: { onClose?: () => void } = {}) {
  const [sub, setSubState] = useState<Sub>(readSub);
  const setSub = useCallback((s: Sub) => {
    setSubState(s);
    try {
      localStorage.setItem(SUB_KEY, s);
    } catch {
      /* private mode: the tab just won't be remembered */
    }
  }, []);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [clearArm, setClearArm] = useState(false);
  const [subjects, setSubjects] = useState<AttSubject[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);

  const [showClassForm, setShowClassForm] = useState(false);
  const [cf, setCf] = useState({ subject: "", day: todayIdx() > 5 ? 0 : todayIdx(), start: "09:00", end: "10:00", room: "", remind: true });
  const [showSubForm, setShowSubForm] = useState(false);
  const [sf, setSf] = useState("");
  const [showDeckForm, setShowDeckForm] = useState(false);
  const [df, setDf] = useState("");
  const [openDeck, setOpenDeck] = useState<string | null>(null);
  const [cardF, setCardF] = useState("");
  const [cardB, setCardB] = useState("");
  const [study, setStudy] = useState<{ queue: string[]; i: number; flipped: boolean; knew: number } | null>(null);

  const [scanOpen, setScanOpen] = useState(false);
  const [libImgs, setLibImgs] = useState<FileMeta[]>([]);
  const [ocrStage, setOcrStage] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [scanDone, setScanDone] = useState(false);
  const [parsed, setParsed] = useState<Array<ParsedClass & { id: string }>>([]);

  const [pins, setPins] = useState<PinnedTask[]>([]);
  const [pinText, setPinText] = useState("");
  const [pinDue, setPinDue] = useState("");
  const [pinTime, setPinTime] = useState<TimeOfDay>({ h: 9, m: 0, ap: "AM" });

  const loadPins = async () => setPins(await listPinnedTasks());

  const [portal] = useState(() => loadJuno().portal);
  const [juser, setJuser] = useState(() => loadCreds()?.username ?? "");
  const [jpass, setJpass] = useState(() => loadCreds()?.password ?? "");
  const [jremember, setJremember] = useState(() => prefersSave());
  const [jshowPass, setJshowPass] = useState(false);
  const [jsigned, setJsigned] = useState(false);
  const [jopen, setJopen] = useState(false);
  const [jsubjects, setJsubjects] = useState<JunoSubjectRow[]>([]);
  const [jterms, setJterms] = useState<JunoTerm[]>([]);
  const [jterm, setJterm] = useState<number | null>(null);
  const [jmsg, setJmsg] = useState<string | null>(null);
  const [jmsgTone, setJmsgTone] = useState<"info" | "error">("info");
  const [jworking, setJworking] = useState(false);
  /** A sign-in the app started by itself (entering Attendance), not the sheet. */
  const [jauto, setJauto] = useState(false);
  const [joverall, setJoverall] = useState<number | null>(null);
  const [jvia, setJvia] = useState<string | null>(null);
  const [jdetailId, setJdetailId] = useState<string | null>(null);
  const [jdetailName, setJdetailName] = useState("");
  const [jdetail, setJdetail] = useState<JunoSession[] | null>(null);
  const [jdetailErr, setJdetailErr] = useState<string | null>(null);

  // The hero number is rolled up from the rows on screen, not read from the
  // portal's overall endpoint. That endpoint is term-agnostic — it answers
  // "your whole course", not "this term" — so it stayed frozen at the same
  // number while the list underneath changed terms, which made the headline
  // disagree with the list it was supposed to summarise. Deriving it means
  // the two can never drift.
  const jroll = rollUp(jsubjects);
  // Counted rather than eyeballed, so the sentence under the percentage can
  // never drift from the list either. A subject the portal reports as 0/0 is
  // excluded: it has no percentage to be in danger with, and counting it
  // would quietly inflate "all clear".
  const jneeds = jsubjects.filter((s) => s.pct !== null && bandOf(s.pct) !== "safe").length;

  // Rolled up once per render. The old attendance header called rollUp five
  // times inside its own markup, which is four recomputations nobody asked
  // for and one more place for the header and the list to disagree.
  const aroll = subjects.length > 0 ? rollUp(subjects) : null;

  /* One attendance surface, two sources.
     Signed in to Juno, the portal is the better record: it knows which term
     each subject belongs to, who taught it, and the individual class dates.
     Signed out, the list you keep in the app is all there is. Both carry the
     same attended/total shape, so the same ring, the same bands and the same
     rows serve either - which is the whole point. The Juno tab used to render
     a second, near-identical attendance UI over the top of this one. */
  const liveAtt = jsigned && jsubjects.length > 0;
  const attRoll = liveAtt ? jroll : aroll;
  const aclasses = subjects.reduce((n, s) => n + s.total, 0);

  // Read once per render and passed around. Anything that decides whether a
  // deadline has passed or a card is due has to agree with itself; three
  // separate Date.now() calls can disagree across a midnight.
  const now = Date.now();

  // Pinned: the open list, and how late it already is.
  const livePins = byDueTime(pins.filter((p) => !p.done));
  const overdue = livePins.filter((p) => p.due !== undefined && p.due < now).length;
  // What the list actually renders: open pins worst-first, finished ones
  // sunk to the bottom. Sorting the live set alone was not enough, because a
  // completed pin with an old deadline would otherwise keep outranking
  // everything still open.
  const orderedPins = useMemo(
    () => [...byDueTime(pins.filter((p) => !p.done)), ...byDueTime(pins.filter((p) => p.done))],
    [pins],
  );

  // Cards: one number for the whole tab, and the decks that need you first.
  const totalDue = decks.reduce((n, d) => n + deckStats(d, now).due, 0);
  const sortedDecks = byDue(decks, now);

  // The password manager's write half: a successful sign-in saves the pair
  // unless the save row on the sheet is switched off. Its read half is
  // openSignIn below, and the attendance auto sign-in further down.
  const persistCreds = (u: string, p: string) => {
    if (jremember) saveCreds({ username: u, password: p });
    else forgetCreds();
  };

  // Opening the sheet refills it from the password manager. The plain field
  // defaults only cover the first render of a mount, which is not enough: a
  // successful sign-in deliberately clears the password from state (the
  // session lives in memory), so without this the very next open would show
  // an empty password field over a password sitting right there in storage.
  const openSignIn = () => {
    const c = loadCreds();
    if (c) {
      if (!juser.trim()) setJuser(c.username);
      if (!jpass) setJpass(c.password);
    }
    setJopen(true);
  };

  const openJunoDetail = async (id: string, name: string) => {
    setJdetailId(id);
    setJdetailName(name);
    setJdetail(null);
    setJdetailErr(null);
    try {
      if (nativeSignedIn()) {
        setJdetail(await junoNativeDetail(id));
      } else {
        const b = bridgeCreds();
        setJdetail(await junoDetailBridge(b.url, b.token, id));
      }
    } catch (e) {
      setJdetailErr(e instanceof Error ? e.message : String(e));
    }
  };

  const bridgeCreds = () => {
    const b = loadBridge();
    if (!b.url || !b.token) throw new Error("No PC bridge set — open the Ask tab, tap the gear, and scan the QR on your PC.");
    return b;
  };

  const junoSync = async (termId?: number) => {
    setJworking(true);
    setJmsg(null);
    setJmsgTone("info");
    const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
    // Native first — no PC needed. Bridge is the fallback for when the
    // device's network can't reach the portal directly.
    // Each step reports progress so the button never just says "Syncing…".
    const step = (s: string) => setJmsg(s);
    // The password manager fills the gap: the state holds what was just
    // typed, and the saved pair covers the auto sign-in case, where
    // nothing was typed at all.
    const saved = loadCreds();
    const u = juser.trim() || saved?.username || "";
    const p = jpass || saved?.password || "";
    const needCreds = () => {
      if (!u || !p) throw new Error("Enter your Juno username and password.");
    };
    const tryNative = async () => {
      if (!jsigned) {
        // A live session in memory is reused, never replayed: hopping
        // between tabs should not mean a second login POST.
        if (!nativeSignedIn()) {
          needCreds();
          step("Signing in…");
          await junoNativeLogin(portal, u, p);
        }
        if (u && p) {
          persistCreds(u, p);
          setJuser(u);
        }
        setJsigned(true);
        setJpass("");
      }
      step(jterms.length ? "Reading subjects…" : "Reading your terms…");
      const terms = jterms.length ? jterms : await junoNativeTerms();
      if (!jterms.length) setJterms(terms);
      step("Reading subjects…");
      const data = await junoNativeSubjects(termId ?? jterm ?? undefined, terms);
      return { data, via: "This phone" };
    };
    const tryBridge = async () => {
      const b = bridgeCreds();
      if (!jsigned) {
        needCreds();
        step("Signing in via your PC…");
        await junoLogin(b.url, b.token, portal, u, p);
        persistCreds(u, p);
        setJuser(u);
        setJsigned(true);
        setJpass("");
      }
      step("Reading your terms…");
      const terms = jterms.length ? jterms : await junoTerms(b.url, b.token);
      if (!jterms.length) setJterms(terms);
      step("Reading subjects…");
      const data = await junoSubjects(b.url, b.token, termId ?? jterm ?? undefined);
      return { data, via: "PC bridge" };
    };
    try {
      let r: { data: JunoSubjectsResult; via: string };
      try {
        r = await withTimeout(tryNative(), 20000, "This phone took too long — trying the PC bridge.");
      } catch (nativeErr: any) {
        // Wrong password will not get better over the bridge, and neither
        // will a rate limit — don't make the user wait through both.
        if (nativeErr?.badCredentials) throw nativeErr;
        if (nativeErr?.signedOut || nativeErr?.stale) junoNativeLogout();
        step("Phone couldn't reach it — trying your PC…");
        r = await withTimeout(tryBridge(), 40000, "The portal did not answer in time.");
      }
      setJvia(r.via);
      setJsubjects(r.data.subjects);
      setJoverall(r.data.overall);
      setJterm(r.data.term.id);
      // Fresh login ⇒ fresh attendance, never a blend of two accounts.
      await resetAttendance(u || "account");
      // Push straight into Attendance so the numbers are live everywhere
      // without a second tap.
      let imported = "";
      try {
        const res = await junoImport(r.data.subjects);
        imported = res;
      } catch { /* import is a convenience; a failure shouldn't break the sync */ }
      setJmsg(
        `Synced ${r.data.term.name || "current term"} — ${r.data.subjects.length} subjects` +
          (r.data.overall !== null ? `, ${r.data.overall.toFixed(2)}% overall` : "")
      );
      // Let the glyph finish its check before the sheet leaves. The results
      // are already rendered behind it, so this reads as the sheet handing
      // off, not as a stall.
      if (jopen) setTimeout(() => setJopen(false), 760);
    } catch (e: any) {
      if (e?.badCredentials) {
        // Don't wipe the form — the user just needs to fix one field.
        setJmsgTone("error");
        setJshowPass(true);
        setJmsg(e.message);
      } else if (e?.signedOut || e?.stale) {
        setJsigned(false);
        junoNativeLogout();
        clearJuno();
        setJmsgTone("error");
        setJmsg(msgOf(e));
      } else {
        setJmsgTone("error");
        setJmsg(msgOf(e));
      }
    } finally {
      setJworking(false);
    }
  };

  /*
    Attendance — and the Juno tab — signed in without being asked.

    The session lives in memory only, by design, but the password manager
    gives the app enough to sign back in on its own, and that is the whole
    point of saving it: opening the drawer onto Attendance should land on
    fresh portal numbers, not on a sign-in form.

    What keeps this from being rude to a portal that rate-limits:
      - it runs once per mount, keyed on arriving in those sections;
      - a saved pair (or a still-live session) is required first;
      - a cooldown absorbs drawer open/close, which remounts this screen;
      - a failure lands on the Attendance error line with a manual sign-in
        next to it, and is never retried in a loop.
  */
  const autoRan = useRef(false);
  useEffect(() => {
    if ((sub !== "attendance" && sub !== "juno") || autoRan.current) return;
    autoRan.current = true;
    if (jworking) return;
    if (jsigned && jsubjects.length > 0) return;
    if (!loadCreds() && !nativeSignedIn()) return;
    if (Date.now() - lastAutoSync < AUTO_SYNC_COOLDOWN) return;
    lastAutoSync = Date.now();
    setJauto(true);
    void junoSync().finally(() => setJauto(false));
    // Keyed on the section alone on purpose: this fires on arrival, and
    // the guards above carry everything else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub]);

  const junoLogout = async () => {
    // Reset local state FIRST and unconditionally. Awaiting the bridge call
    // before this is what made the button look dead when the PC was off.
    junoNativeLogout();
    setJsigned(false);
    setJsubjects([]);
    setJterms([]);
    setJterm(null);
    setJoverall(null);
    setJdetailId(null);
    setJvia(null);
    // Sign out means the attendance on screen is no longer yours to keep.
    void (async () => {
      await saveSubjects([]);
      saveJson(ATT_OWNER, null);
      setSubjects([]);
    })();
    clearJuno();
    forgetCreds();
    setJremember(false);
    setJuser("");
    setJpass("");
    setJmsgTone("info");
    setJmsg("Signed out. Your saved password and attendance data were cleared from this phone.");
    // Best-effort cleanup on the PC, in the background, never blocking the UI.
    void (async () => {
      try {
        const b = loadBridge();
        if (b.url && b.token) await withTimeout(junoLogoutBridge(b.url, b.token), 4000, "noop");
      } catch { /* the PC may simply be off; local sign-out already happened */ }
    })();
  };

  /**
   * Attendance belongs to one portal account. Signing in — as you or as a
   * friend on the same phone — replaces it wholesale rather than merging,
   * because the portal is the source of truth and a merged list from two
   * different people is just wrong. Called only AFTER a login succeeds, so a
   * failed attempt never costs you the data you already had.
   */
  const resetAttendance = async (account: string) => {
    const previous = loadJson<string>(ATT_OWNER);
    if (previous === account) return;
    await saveSubjects([]);
    setSubjects([]);
    saveJson(ATT_OWNER, account);
  };

  const clearAllSubjects = async () => {
    await saveSubjects([]);
    saveJson(ATT_OWNER, null);
    setSubjects([]);
    setJmsg("Cleared every subject. Sign in to Juno to pull them back.");
    setJmsgTone("info");
  };

  /**
   * Merge portal rows into the local attendance list. Returns a short
   * summary instead of setting the message, so the caller decides what the
   * user sees (the sync path appends this to its own line).
   */
  const junoImport = async (rows?: JunoSubjectRow[]): Promise<string> => {
    const list = rows ?? jsubjects;
    if (!list.length) return "";
    const current = await listSubjects();
    const next = [...current];
    let added = 0;
    let updated = 0;
    for (const s of list) {
      const i = next.findIndex((x) => x.name.toLowerCase() === s.name.toLowerCase());
      if (i >= 0) {
        next[i] = { ...next[i]!, attended: s.attended, total: s.total };
        updated++;
      } else {
        next.push({ id: uid(), name: s.name, attended: s.attended, total: s.total });
        added++;
      }
    }
    setSubjects(next);
    await saveSubjects(next);
    const summary = `${added} new, ${updated} updated`;
    if (!rows) setJmsg(`Imported into Attendance: ${summary}.`);
    return summary;
  };

  const openScan = async () => {
    setScanOpen(true);
    setParsed([]);
    setScanMsg(null);
    setScanDone(false);
    setOcrStage(null);
    setLibImgs((await listFiles()).filter((f) => ["png", "jpg", "jpeg", "webp"].includes(f.ext)));
  };

  const runScan = async (data: string) => {
    setOcrStage("Looking for the table grid…");
    setScanMsg(null);
    try {
      const { scanTimetableImage } = await import("../lib/tableocr");
      const rows = await scanTimetableImage(data, (s) => setOcrStage(s));
      if (!rows.length) throw new Error("No rows found.");
      setParsed(rows.map((r) => ({ ...r, id: uid() })));
      setOcrStage(null);
      return;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (why !== "NO_GRID") {
        setOcrStage(null);
        setScanMsg(why);
        return;
      }
    }
    try {
      setOcrStage("No clear grid. Reading whole photo…");
      const { ocrImage } = await import("../lib/office");
      const text = await ocrImage(data, "jpg", (p, stage) => setOcrStage(`${stage} ${Math.round(p * 100)}%`));
      setOcrStage("Understanding timetable…");
      const rows2 = await parseTimetableText(text);
      if (!rows2.length) throw new Error("No rows found. Try a straighter, brighter photo.");
      setParsed(rows2.map((r) => ({ ...r, id: uid() })));
      setOcrStage(null);
    } catch (e2) {
      setOcrStage(null);
      setScanMsg(e2 instanceof Error ? e2.message : String(e2));
    }
  };

  const runScanPhone = async (list: FileList | null) => {
    if (!list?.length) return;
    const f = list[0]!;
    try {
      setOcrStage("Reading photo…");
      await runScan(await fileToBase64(f));
    } catch (e) {
      setOcrStage(null);
      setScanMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmImport = async () => {
    const items: ClassItem[] = parsed
      .filter((r) => r.subject.trim() && r.start && r.end)
      .map((r) => ({
        id: uid(),
        subject: r.subject.trim().slice(0, 40),
        day: DAYS.indexOf(r.day) >= 0 ? DAYS.indexOf(r.day) : 0,
        start: r.start,
        end: r.end,
        room: r.room,
        remind: !/break|lunch|recess/i.test(r.subject),
      }));
    if (!items.length) {
      setScanMsg("Nothing valid to import. Fix the rows first.");
      return;
    }
    // The scan *is* the timetable: importing replaces whatever sat on those
    // days before. Appending instead stacked an old bad import under a fresh
    // good one — two sets of times for the same lecture.
    const scanDays = new Set(items.map((i) => i.day));
    const dropped = classes.filter((c) => scanDays.has(c.day));
    for (const c of dropped) void cancelClassReminder(c);
    const next = [...classes.filter((c) => !scanDays.has(c.day)), ...items];
    await persistClasses(next);
    // Ask for notification permission at the moment it means something —
    // right after the student imports a real timetable.
    await armAllReminders(items);
    setParsed([]);
    setScanMsg(
      `Imported ${items.length} classes${dropped.length ? `, replacing ${dropped.length} on those days` : ""}. Each one reminds you 10 minutes before.`
    );
    setScanDone(true);
  };

  const addPin = async () => {
    const v = pinText.trim().slice(0, 160);
    if (!v) return;
    const item: PinnedTask = {
      id: uid(),
      text: v,
      pinned: true,
      at: Date.now(),
      due: dueAt(pinDue, pinTime),
    };
    const next = [item, ...pins];
    setPins(next);
    await savePinnedTasks(next);
    setPinText("");
    setPinDue("");
    try {
      await postPinned(item);
    } catch {
      /* stays listed; toggle off/on retries */
    }
  };

  const deletePin = async (id: string) => {
    const next = pins.filter((p) => p.id !== id);
    setPins(next);
    await savePinnedTasks(next);
    try {
      await unpostPinned(id);
    } catch {
      /* noop */
    }
  };

  /**
   * Ticking a pin off takes it off the lockscreen immediately — a done task
   * still shouting at you is the failure mode this whole tab has to avoid.
   * The record is kept rather than deleted so an accidental tap is
   * recoverable; unticking puts it straight back.
   */
  const completePin = async (id: string) => {
    const wasDone = pins.find((p) => p.id === id)?.done;
    const next = pins.map((p) =>
      p.id === id ? { ...p, done: !wasDone, doneAt: wasDone ? undefined : Date.now() } : p
    );
    setPins(next);
    await savePinnedTasks(next);
    const t = next.find((p) => p.id === id);
    if (!t) return;
    try {
      if (t.done || !t.pinned) await unpostPinned(t.id);
      else await postPinned(t);
    } catch {
      /* notification failed, the tick itself is already saved */
    }
  };

  const refresh = async () => {
    setClasses(await listClasses());
    setSubjects(await listSubjects());
    void loadPins();
    let dk = await listDecks();
    if (!dk.length) {
      dk = [{
        id: uid(),
        name: "Module 1 Quick Fire",
        cards: [
          { id: uid(), front: "How many usable hosts in a /26?", back: "62. Block size 64, minus network and broadcast." },
          { id: uid(), front: "Which route wins: 10.0.0.0/8 vs 10.1.1.0/24 for 10.1.1.50?", back: "10.1.1.0/24. Longest match always wins." },
          { id: uid(), front: "Device that breaks broadcast domains?", back: "Router. Switches break collision domains per port." },
          { id: uid(), front: "TCP vs UDP in one line each?", back: "TCP: reliable handshake. UDP: fast, best-effort." },
          { id: uid(), front: "Route preference: Static, OSPF internal, BGP?", back: "Static 5, OSPF 10, BGP 170. Lower wins." },
        ],
      }];
      await saveDecks(dk);
    }
    setDecks(dk);
  };
  useEffect(() => { void refresh(); }, []);

  // A reboot wipes the OS alarm table, so re-arm the whole timetable once the
  // screen mounts. Without this, reminders die silently after a restart.
  useEffect(() => {
    if (classes.length) void armAllReminders(classes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistClasses = async (c: ClassItem[]) => {
    setClasses(c);
    await saveClasses(c);
  };

  const addClass = async () => {
    const subject = cf.subject.trim().slice(0, 40);
    if (!subject) return;
    const item: ClassItem = { id: uid(), subject, day: cf.day, start: cf.start, end: cf.end, room: cf.room.trim().slice(0, 20), remind: cf.remind };
    await persistClasses([...classes, item]);
    if (item.remind) void scheduleClassReminder(item);
    setCf({ subject: "", day: cf.day, start: "09:00", end: "10:00", room: "", remind: true });
    setShowClassForm(false);
  };

  const removeClass = async (c: ClassItem) => {
    await cancelClassReminder(c);
    await persistClasses(classes.filter((x) => x.id !== c.id));
  };

  // Two taps: the first arms, the second wipes. A slipped thumb losing a
  // scanned timetable would mean photographing the notice board again.
  const clearTimetable = async () => {
    if (!clearArm) {
      setClearArm(true);
      window.setTimeout(() => setClearArm(false), 3200);
      return;
    }
    setClearArm(false);
    for (const c of classes) void cancelClassReminder(c);
    await persistClasses([]);
  };

  const toggleRemind = async (c: ClassItem) => {
    const next = { ...c, remind: !c.remind };
    await persistClasses(classes.map((x) => (x.id === c.id ? next : x)));
    if (next.remind) void scheduleClassReminder(next);
    else void cancelClassReminder(next);
  };

  const addSubject = async () => {
    const name = sf.trim().slice(0, 40);
    if (!name) return;
    const next = [...subjects, { id: uid(), name, attended: 0, total: 0 }];
    setSubjects(next);
    await saveSubjects(next);
    setSf("");
    setShowSubForm(false);
  };

  const bump = async (s: AttSubject, present: boolean) => {
    const next = subjects.map((x) =>
      x.id === s.id
        ? {
            ...x,
            attended: x.attended + (present ? 1 : 0),
            total: x.total + 1,
          }
        : x
    );
    setSubjects(next);
    await saveSubjects(next);
    await appendMark({
      sid: s.id,
      date: new Date().toISOString().slice(0, 10),
      present,
      at: Date.now(),
    });
    setMarks(await listMarks());
  };

  const removeSubject = async (id: string) => {
    const next = subjects.filter((s) => s.id !== id);
    setSubjects(next);
    await saveSubjects(next);
    await clearMarksFor(id);
    if (detailId === id) setDetailId(null);
  };

  const [detailId, setDetailId] = useState<string | null>(null);
  const [marks, setMarks] = useState<AttMark[]>([]);

  const openDetail = async (id: string) => {
    setMarks(await listMarks());
    setDetailId(id);
  };

  const addDeck = async () => {
    const name = df.trim().slice(0, 40);
    if (!name) return;
    const next = [...decks, { id: uid(), name, cards: [] }];
    setDecks(next);
    await saveDecks(next);
    setDf("");
    setShowDeckForm(false);
  };

  const removeDeck = async (id: string) => {
    const next = decks.filter((d) => d.id !== id);
    setDecks(next);
    await saveDecks(next);
    if (openDeck === id) {
      setOpenDeck(null);
      setStudy(null);
    }
  };

  const addCard = async () => {
    if (!openDeck || !cardF.trim() || !cardB.trim()) return;
    const next = decks.map((d) =>
      d.id === openDeck
        ? { ...d, cards: [...d.cards, { id: uid(), front: cardF.trim().slice(0, 300), back: cardB.trim().slice(0, 600) }] }
        : d
    );
    setDecks(next);
    await saveDecks(next);
    setCardF("");
    setCardB("");
  };

  const removeCard = async (deckId: string, cardId: string) => {
    const next = decks.map((d) =>
      d.id === deckId ? { ...d, cards: d.cards.filter((c) => c.id !== cardId) } : d
    );
    setDecks(next);
    await saveDecks(next);
  };

  const startStudy = (deckId: string) => {
    const d = decks.find((x) => x.id === deckId);
    if (!d || !d.cards.length) return;
    const t = Date.now();
    // Due cards first. Shuffling the whole deck meant every session
    // re-asked the twelve cards you already know while burying the three you
    // keep forgetting — which is the opposite of what a revision queue is for.
    // Falling back to everything means a brand-new deck is still studiable.
    const due = d.cards.filter((c) => cardDue(c, t));
    const pool = due.length ? due : d.cards;
    const queue = pool.map((c) => c.id);
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j]!, queue[i]!];
    }
    setStudy({ queue, i: 0, flipped: false, knew: 0 });
  };

  /**
   * Record a grade so the schedule actually moves. Without this the box and
   * `last` fields would be decoration and every card would stay due forever.
   */
  const gradeInDeck = async (cardId: string, knew: boolean) => {
    if (!openDeck) return;
    const t = Date.now();
    const next = decks.map((d) =>
      d.id === openDeck
        ? { ...d, cards: d.cards.map((c) => (c.id === cardId ? gradeCard(c, knew, t) : c)) }
        : d
    );
    setDecks(next);
    await saveDecks(next);
  };

  const sorted = useMemo(
    () => [...classes].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start)),
    [classes]
  );
  const today = sorted.filter((c) => c.day === todayIdx());
  const deck = decks.find((d) => d.id === openDeck) || null;
  const dstats = deck ? deckStats(deck, now) : null;

  return (
    <div className="flex flex-col h-full">
      <div
        className="shrink-0 px-4"
        style={{ paddingTop: "max(0.75rem,env(safe-area-inset-top))" }}
      >
        {/* One title, not two. The drawer used to print "Campus" and then
            Campus printed it again, straight underneath.
            In the drawer the close button shares this row, so the title and
            the X sit on one line and one right edge — a lone X floating
            above the title was just dead space. */}
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-2xl font-semibold">Campus</h2>
          {onClose && (
            <button
              onClick={onClose}
              className="sd-press -mr-2 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-full"
              style={{ color: "var(--ink-2)" }}
              aria-label="Close menu"
            >
              <X className="size-5" />
            </button>
          )}
        </div>
        {/* Text tabs with an underline beat a row of filled pills.
            Scrolls rather than squeezing — five labels don't fit at 320px. */}
        <div data-hscroll className="-mx-4 mt-3 flex gap-5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist">
          {([
            ["schedule", "Schedule"],
            ["attendance", "Attendance"],
            ["cards", "Cards"],
            ["juno", "Juno"],
            ["pinned", "Pinned"],
          ] as Array<[Sub, string]>).map(([id, label]) => {
            const on = sub === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={on}
                onClick={() => setSub(id)}
                className="relative shrink-0 whitespace-nowrap pb-2 text-[14px] transition-colors"
                style={{ color: on ? "var(--ink-1)" : "var(--ink-3)" }}
              >
                {label}
                {on && (
                  <span
                    className="absolute inset-x-0 -bottom-px h-[2px] rounded-full"
                    style={{ background: "var(--ink-1)" }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-24">
        {sub === "schedule" && (
          <>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[13px] text-ink-2">Today, {DAYS[todayIdx()]}</div>
              <div className="flex gap-2">
                <button
                  onClick={() => void openScan()}
                  className="sd-press rounded-[10px] border px-3 py-2 text-[13px] font-medium"
                  style={{ borderColor: "var(--line)", color: "var(--ink-1)" }}
                >
                  Scan photo
                </button>
                <button
                  onClick={() => setShowClassForm(true)}
                  className="sd-press rounded-[10px] px-3 py-2 text-[13px] font-semibold"
                  style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
                >
                  Add class
                </button>
              </div>
            </div>
            {today.length === 0 && (
              <p className="mb-4 text-[13px]" style={{ color: "var(--ink-3)" }}>
                Nothing on today. Enjoy it, or get ahead on something.
              </p>
            )}
            {today.map((c) => (
              <ClassRow key={c.id} c={c} onToggle={() => void toggleRemind(c)} onDelete={() => void removeClass(c)} />
            ))}
            <div className="px-1 mt-4 mb-1.5 flex items-center justify-between">
              <div className={labelCls}>Week</div>
              {sorted.length > 0 && (
                <button
                  onClick={() => void clearTimetable()}
                  className="sd-press px-1 py-0.5 text-[12px] font-medium"
                  style={{ color: clearArm ? "var(--att-critical-text)" : "var(--ink-3)" }}
                >
                  {clearArm ? "Tap again to delete all classes" : "Clear timetable"}
                </button>
              )}
            </div>
            {sorted.length === 0 && (
              <EmptyState variant="schedule" title="No timetable yet" hint="Add your classes to see today at a glance." />
            )}
            {DAYS.slice(0, 6).map((d, di) => {
              const items = sorted.filter((c) => c.day === di);
              if (!items.length) return null;
              return (
                <div key={d} className="mb-2.5">
                  <div className="text-[11px] font-semibold text-muted-foreground px-1 mb-1">{d}</div>
                  {items.map((c) => (
                    <ClassRow key={c.id} c={c} onToggle={() => void toggleRemind(c)} onDelete={() => void removeClass(c)} />
                  ))}
                </div>
              );
            })}
          </>
        )}

        {sub === "attendance" && (
          <>
            {/* No header band naming the term. The term strip below already
                says which term you are reading, with the selected one
                underlined, so a line above it repeating the same two words
                read as a stutter and pushed the actual content down.

                Refresh used to live in that band. It now sits on the subject
                list header, beside the numbers it recomputes, where it has
                something to be about. */}

            {/* Term picker. Text with an underline, not a row of filled
                capsules: it is a single-select filter, and the Campus tabs
                above already established this as the idiom here. */}
            {liveAtt && jterms.length > 1 && (
              <div
                data-hscroll
                role="tablist"
                aria-label="Term"
                className="-mx-4 mt-5 flex gap-5 overflow-x-auto border-y border-line px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {jterms.map((t) => {
                  const on = String(t.id) === String(jterm);
                  return (
                    <button
                      key={t.id}
                      role="tab"
                      aria-selected={on}
                      onClick={() => { setJterm(t.id); void junoSync(t.id); }}
                      className="relative shrink-0 whitespace-nowrap py-3 text-[13px]"
                      style={{ color: on ? "var(--ink-1)" : "var(--ink-3)" }}
                    >
                      {t.name}
                      {on && (
                        <span
                          className="absolute inset-x-0 bottom-0 h-[2px] rounded-full"
                          style={{ background: "var(--ink-1)" }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* The quiet half of the auto sign-in: the saved login went in
                on its own, and this one line is the only acknowledgement.
                It collapses to nothing the moment the live list arrives. */}
            {jauto && !liveAtt && (
              <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--ink-2)" }} aria-live="polite">
                <Loader2 className="size-4 animate-spin" />
                {jmsg ?? "Signing in to Juno…"}
              </div>
            )}
            {!jauto && !liveAtt && jmsg && jmsgTone === "error" && (
              <div className="flex items-center justify-between gap-4">
                <p className="min-w-0 flex-1 text-[13px]" style={{ color: "var(--att-critical-text)" }}>{jmsg}</p>
                <button
                  onClick={openSignIn}
                  className="sd-press shrink-0 rounded-[10px] px-3 py-2 text-[13px] font-semibold"
                  style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
                >
                  Sign in
                </button>
              </div>
            )}

            {/* One focal point, then quiet. The ring is the memorable element
                and the column beside it carries the payoff — the one number
                that changes what you do today. Four equal stat cards would be
                the dashboard-kit tell. */}
            {attRoll && (
              <div className="flex items-center gap-5">
                <AttendanceRing value={attRoll.pct} size={124} />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] leading-snug" style={{ color: "var(--ink-1)" }}>
                    {attRoll.totalBunks > 0 ? (
                      <>
                        You can skip <strong className="font-semibold">{attRoll.totalBunks}</strong> more and
                        still finish above {REQUIRED}%.
                      </>
                    ) : (
                      <>No free skips left. Every class counts from here.</>
                    )}
                  </p>
                  {/* Band and counts as one quiet line, beside the ring where
                      there is room for it — not stacked under a circle,
                      where a caption reads as a label floating in space. */}
                  <p className="mt-2 text-[13px]" style={{ color: "var(--ink-3)" }}>
                    <span style={{ color: BAND_TEXT[attRoll.band] }}>{BAND_SHORT[attRoll.band]}</span>
                    {attRoll.atRisk > 0 ? `, ${attRoll.atRisk} below target` : ""}
                    {`, ${attRoll.subjects} ${attRoll.subjects === 1 ? "subject" : "subjects"}`}
                    {!liveAtt && `, ${aclasses} ${aclasses === 1 ? "class" : "classes"}`}
                  </p>
                </div>
              </div>
            )}

            {/* Editing is only offered on the list the app owns. The portal's
                copy is not ours to edit, so Add and Clear appear only when
                that is the copy on screen - otherwise the buttons would
                silently do nothing. */}
            {!liveAtt && (
              <>
                {/* One primary action, and the destructive one drops to plain
                    text. A bordered "Clear all" sitting shoulder to shoulder with a
                    filled button gave a bulk delete the same visual weight as the
                    thing you actually came to do. */}
                <div className="mt-6 flex items-center justify-end gap-4">
                  {subjects.length > 0 && (
                    <button
                      onClick={() => void clearAllSubjects()}
                      className="sd-press px-1 py-2 text-[13px] font-medium"
                      style={{ color: "var(--ink-3)" }}
                    >
                      Clear all
                    </button>
                  )}
                  <button
                    onClick={() => setShowSubForm(true)}
                    className="sd-press rounded-[12px] px-4 py-2.5 text-[14px] font-semibold"
                    style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
                  >
                    Add subject
                  </button>
                </div>

                {subjects.length === 0 && (
                  <EmptyState variant="subjects" title="No subjects yet" hint="Sign in to Juno and they'll land here on their own." />
                )}
              </>
            )}

            {/* The list gets the header it never had, and the one action that
                recomputes these numbers goes on it. Refresh is not chrome and
                it is not an account action, so it belongs to the data: on the
                right of the label naming the data, sharing the "Week" label
                grammar the Schedule tab already uses. While a sync is in
                flight the same slot holds the spinner, so the row never
                changes size and the button never jumps. */}
            {liveAtt && (
              <div className={`mt-6 flex items-center justify-between gap-3 border-t border-line pt-1 ${labelCls}`}>
                <span className="pl-1">Subjects</span>
                <button
                  onClick={() => void junoSync()}
                  disabled={jworking}
                  className="flex size-11 shrink-0 items-center justify-center rounded-[10px] disabled:opacity-40"
                  style={{ color: "var(--ink-2)" }}
                  aria-label="Sync attendance"
                  title="Sync attendance"
                >
                  {jworking ? <Loader2 className="size-[18px] animate-spin" /> : <RefreshCw className="size-[17px]" />}
                </button>
              </div>
            )}

            {/* The list, as a list. The previous version boxed every subject
                in its own bordered card and then spent three more signals on
                the same fact — a colour rail down the left, a dot before the
                number, and a ring on the right that looked identical on every
                row. One signal does the work: the percentage, coloured by band,
                right-aligned in tabular figures, with the band's own shape added
                only where the band is not the safe one. */}
            {liveAtt &&
              jsubjects.map((s, i) => {
                const p = s.pct;
                const band = p === null ? "safe" : bandOf(p);
                const flagged = p !== null && band !== "safe";
                return (
                  <button
                    key={s.id || i}
                    onClick={() => void openJunoDetail(s.id, s.name)}
                    className="flex w-full items-center gap-4 py-3 text-left"
                    style={{ borderTop: i > 0 ? "1px solid var(--line)" : "none" }}
                  >
                    {/* Two lines, not one truncated line. The part that
                        tells two of these rows apart is the (L) / (P) at
                        the very end, so clipping the tail made two
                        different subjects read as the same name. */}
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[15px] font-medium leading-snug" style={{ color: "var(--ink-1)" }}>
                        {s.name}
                      </span>
                      <span className="mt-0.5 block truncate text-[13px]" style={{ color: "var(--ink-3)" }}>
                        {s.teacher || s.code || "Faculty not listed"}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span
                        className="tnum block text-[16px] font-semibold"
                        style={{ color: p === null ? "var(--ink-3)" : BAND_TEXT[band] }}
                      >
                        {p === null ? "No data" : `${flagged ? BAND_GLYPH[band] + " " : ""}${p.toFixed(2)}%`}
                      </span>
                      <span className="tnum mt-0.5 block text-[13px]" style={{ color: "var(--ink-3)" }}>
                        {s.attended}/{s.total}
                      </span>
                    </span>
                  </button>
                );
              })}

            {!liveAtt &&
              byUrgency(subjects).map((s, i) => {
                const p = pct(s);
                const band = bandOf(p);
                const flagged = p !== null && band !== "safe";
                return (
                  <div key={s.id} style={{ borderTop: i > 0 ? "1px solid var(--line)" : "none" }}>
                    <button
                      onClick={() => void openDetail(s.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        void removeSubject(s.id);
                      }}
                      className="sd-tap flex w-full items-center gap-4 py-3 text-left"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-[15px] font-medium leading-snug" style={{ color: "var(--ink-1)" }}>
                          {s.name}
                        </span>
                        <span
                          className="mt-0.5 block text-[13px]"
                          style={{ color: safeBunks(s) === 0 ? "var(--att-caution-text)" : "var(--ink-2)" }}
                        >
                          {bunkLine(s)}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span
                          className="tnum block text-[16px] font-semibold"
                          style={{ color: p === null ? "var(--ink-3)" : BAND_TEXT[band] }}
                        >
                          {p === null ? "No data" : `${flagged ? BAND_GLYPH[band] + " " : ""}${p.toFixed(1)}%`}
                        </span>
                        <span className="tnum mt-0.5 block text-[13px]" style={{ color: "var(--ink-3)" }}>
                          {s.attended}/{s.total}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
          </>
        )}

        {sub === "cards" && !deck && (
          <>
            {/* One number, because "how much is waiting for me" is the only
                reason to open a flashcard app. Everything else on this screen
                is in service of that number. */}
            {decks.length > 0 ? (
              <div className="mt-1 flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <div className="tnum text-[40px] font-semibold leading-none" style={{ color: totalDue > 0 ? "var(--ink-1)" : "var(--att-safe-text)" }}>
                    {totalDue}
                  </div>
                  <p className="mt-2.5 text-[13px]" style={{ color: "var(--ink-2)" }}>
                    {totalDue === 0
                      ? `all caught up across ${decks.length} ${decks.length === 1 ? "deck" : "decks"}`
                      : `${totalDue === 1 ? "card" : "cards"} due across ${decks.length} ${decks.length === 1 ? "deck" : "decks"}`}
                  </p>
                </div>
                <button
                  onClick={() => setShowDeckForm(true)}
                  className="sd-press shrink-0 rounded-[12px] px-4 py-2.5 text-[14px] font-semibold"
                  style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
                >
                  New deck
                </button>
              </div>
            ) : (
              <div className="mt-1 flex justify-end">
                <button
                  onClick={() => setShowDeckForm(true)}
                  className="sd-press rounded-[12px] px-4 py-2.5 text-[14px] font-semibold"
                  style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
                >
                  New deck
                </button>
              </div>
            )}

            {decks.length === 0 && (
              <EmptyState variant="subjects" title="No decks yet" hint="Group cards by unit or topic, then review only what is due." />
            )}

            {/* Rows sorted by most due first, so the deck that needs work is
                at the top instead of wherever it happened to be created. */}
            <ul className={decks.length === 0 ? "" : "mt-2"}>
              {sortedDecks.map((d, i) => {
                const st = deckStats(d, now);
                return (
                  <li key={d.id} style={{ borderTop: i > 0 ? "1px solid var(--line)" : "none" }}>
                    <button
                      onClick={() => { setOpenDeck(d.id); setStudy(null); }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        void removeDeck(d.id);
                      }}
                      className="sd-tap flex w-full items-center gap-3 py-3 text-left"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-[15px] font-medium leading-snug" style={{ color: "var(--ink-1)" }}>
                          {d.name}
                        </span>
                        <span className="mt-0.5 block text-[13px]" style={{ color: "var(--ink-3)" }}>
                          {st.seen} of {st.total} seen
                          {st.total === 0 ? "" : st.seen === 0 ? ", none started" : ""}
                        </span>
                      </span>
                      {st.due > 0 ? (
                        <span
                          className="tnum shrink-0 rounded-full px-2.5 py-1 text-[13px] font-semibold"
                          style={{ background: "rgba(45,212,191,0.13)", color: "var(--att-safe-text)" }}
                        >
                          {st.due} due
                        </span>
                      ) : (
                        <span className="shrink-0 text-[13px]" style={{ color: "var(--att-safe-text)" }}>clear</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {sub === "cards" && deck && dstats && !study && (
          <>
            <button onClick={() => setOpenDeck(null)} className="flex items-center gap-1 text-[13px] text-ink-2 mt-1 mb-3">
              <ChevronLeft className="size-4" /> All decks
            </button>
            <h3 className="text-[20px] font-semibold leading-snug" style={{ color: "var(--ink-1)" }}>{deck.name}</h3>
            <p className="mt-1.5 text-[13px]" style={{ color: "var(--ink-2)" }}>
              {dstats.seen} of {dstats.total} seen
              {dstats.due > 0 ? `, ${dstats.due} due` : ", nothing due"}
            </p>
            <button
              onClick={() => startStudy(deck.id)}
              disabled={!deck.cards.length}
              className="sd-press mt-4 flex h-[52px] w-full items-center justify-center gap-2 rounded-[12px] text-[15px] font-semibold disabled:opacity-40"
              style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
            >
              {dstats.due > 0 ? `Study ${dstats.due} due` : "Study all"}
            </button>

            <div className="mt-6">
              <label className={labelCls} htmlFor="card-front">Add a card</label>
              <input
                id="card-front"
                value={cardF}
                onChange={(e) => setCardF(e.target.value)}
                placeholder="Front: the question"
                className="mt-1.5 w-full rounded-[12px] border border-line bg-input px-4 text-[16px] text-ink-1 outline-none focus:border-brand"
              />
              <input
                value={cardB}
                onChange={(e) => setCardB(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addCard()}
                placeholder="Back: the answer"
                className="mt-2 w-full rounded-[12px] border border-line bg-input px-4 text-[16px] text-ink-1 outline-none focus:border-brand"
              />
              <button
                onClick={() => void addCard()}
                disabled={!cardF.trim() || !cardB.trim()}
                className="sd-press mt-3 w-full rounded-[12px] py-2.5 text-[14px] font-semibold disabled:opacity-40"
                style={{ background: "var(--surface-3)", color: "var(--ink-1)" }}
              >
                Add card
              </button>
            </div>

            {/* Rows, not boxes, with the review state as the only signal —
                a due card is the one thing worth scanning for. */}
            <ul className="mt-6">
              {deck.cards.map((c, i) => (
                <li key={c.id} style={{ borderTop: i > 0 ? "1px solid var(--line)" : "none" }}>
                  <div
                    onContextMenu={(e) => {
                      e.preventDefault();
                      void removeCard(deck.id, c.id);
                    }}
                    className="flex items-start gap-3 py-3"
                  >
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full" style={{ background: cardDue(c, now) ? "var(--att-safe)" : "var(--line-strong)" }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium leading-snug" style={{ color: "var(--ink-1)" }}>{c.front}</span>
                      <span className="mt-0.5 block text-[13px] leading-snug" style={{ color: "var(--ink-3)" }}>{c.back}</span>
                    </span>
                    {c.last ? (
                      <span className="tnum shrink-0 text-[12px]" style={{ color: "var(--ink-3)" }}>{whenLabel(c.last, now)}</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {sub === "cards" && deck && study && (
          <StudyView
            deck={deck}
            study={study}
            onFlip={() => setStudy({ ...study, flipped: !study.flipped })}
            onGrade={(knew: boolean) => {
              const graded = study.queue[study.i];
              if (graded) void gradeInDeck(graded, knew);
              const ni = study.i + 1;
              if (ni >= study.queue.length) {
                setStudy({ ...study, i: ni, knew: study.knew + (knew ? 1 : 0) });
              } else {
                setStudy({ queue: study.queue, i: ni, flipped: false, knew: study.knew + (knew ? 1 : 0) });
              }
            }}
            onRestart={() => startStudy(deck.id)}
            onExit={() => setStudy(null)}
          />
        )}

        {sub === "pinned" && (
          <>
            {/* Composer. Bare on the canvas, like every other Campus tab: the
                form and its list are one thing, so they get no container. The
                depth this section wanted comes from the clock, not from a
                panel wrapped around both. */}
            <div className="mt-1">
              <label className={labelCls} htmlFor="pin-text">What needs doing</label>
              <input
                id="pin-text"
                value={pinText}
                onChange={(e) => setPinText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addPin()}
                placeholder="Submit the CN record"
                className="mt-1.5 w-full rounded-[6px] border border-line bg-input px-4 text-[16px] text-ink-1 outline-none focus:border-brand"
              />
              {/* The deadline folds down to one field. Six flap cards standing
                  permanently open put more chrome in front of you than the
                  thing being written, and the Pin button beside them had no
                  relationship to either row. Pin is now the one primary
                  action on its own line, full width like Juno's Sign in. */}
              <div className="mt-4">
                <div className={labelCls}>Due (optional)</div>
                <FlipClock day={pinDue} onDay={setPinDue} value={pinTime} onChange={setPinTime} />
              </div>

              <button
                onClick={() => void addPin()}
                className="sd-press mt-4 h-[48px] w-full rounded-[10px] text-[15px] font-semibold"
                style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
              >
                Pin
              </button>
            </div>

            {pins.length === 0 ? (
              <EmptyState variant="pins" title="Nothing pinned" hint="Pin what the teacher assigns. It waits on your lockscreen." />
            ) : (
              <>
                {/* The one number worth seeing: how late you already are. */}
                <p
                  className="mt-6 text-[13px]"
                  style={{ color: overdue ? "var(--att-critical-text)" : "var(--ink-2)" }}
                >
                  {livePins.length} open{overdue > 0 ? `, ${overdue} overdue` : ""}
                </p>
                <ul className="mt-1.5">
                  {orderedPins.map((p, i) => {
                    const rel = p.due ? relative(p.due, now) : null;
                    return (
                      <li key={p.id} style={{ borderTop: i > 0 ? "1px solid var(--line)" : "none" }}>
                        <div
                          className="flex items-start gap-3 py-3"
                          onContextMenu={(e) => {
                            e.preventDefault();
                            void deletePin(p.id);
                          }}
                        >
                          {/* Done is a checkbox, because finishing the thing is
                              the entire point of pinning it. */}
                          <span className="pg-check-hit mt-0.5">
                            <input
                              type="checkbox"
                              checked={Boolean(p.done)}
                              onChange={() => void completePin(p.id)}
                              className="pg-check-input"
                            />
                            <span className="pg-check" aria-hidden="true">
                              {p.done && <Check className="size-3.5" strokeWidth={3} />}
                            </span>
                          </span>
                          <div className="min-w-0 flex-1">
                            <div
                              className="line-clamp-2 text-[15px] font-medium leading-snug"
                              style={{
                                color: p.done ? "var(--ink-3)" : "var(--ink-1)",
                                textDecoration: p.done ? "line-through" : "none",
                              }}
                            >
                              {p.text}
                            </div>
                            <div
                              className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px]"
                              style={{ color: rel?.overdue ? "var(--att-critical-text)" : "var(--ink-3)" }}
                            >
                              {rel && <span>{rel.text}</span>}
                              {rel && <span>·</span>}
                              <span>{p.pinned ? "On lockscreen" : "Not pinned"}</span>
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        )}
        {sub === "juno" && (
          <>
            {/* Signed in, this is who the rest of this tab is about: the same
                identity block the college's own app opens with, read from the
                portal rather than typed in.
                It lives here rather than above the tabs because it is reference
                data, not a control, and five non-actionable rows on every
                section pushed down the content you opened that tab to read. */}
            <JunoProfileBlock
              signedIn={jsigned}
              termName={jterms.find((t) => t.current)?.name ?? jterms[jterms.length - 1]?.name}
            />

            {/* Signed out: one verb, one button. The tab name already says
                Juno, so there is nothing to explain here - the sheet is
                where the form and the explanation live. */}
            {jsigned ? (
              /* Juno is your account, and an account screen holds one thing:
                 who you are and the way out of it. The attendance it also used
                 to show lives in the Attendance tab now, because that is where
                 attendance is edited, filtered by term, and read. Two sections
                 rendering the same percentages was one too many, and the
                 duplicate could never agree with the original.

                 Sign out is a quiet text action sitting directly under the
                 profile, not an icon floating in the empty half of the screen.
                 A lone icon with nothing around it reads as a misplaced
                 control rather than as the one thing you can do here. */
              <button
                onClick={() => void junoLogout()}
                className="sd-press mt-6 flex items-center gap-2 py-2 text-[13px] font-medium"
                style={{ color: "var(--ink-3)" }}
              >
                <LogOut className="size-4" />
                Sign out of Juno
              </button>
            ) : (
              <>
                <button
                  onClick={openSignIn}
                  className="sd-press flex h-[52px] w-full items-center justify-center gap-2 rounded-[12px] text-[15px] font-semibold"
                  style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
                >
                  Sign in
                </button>
                {/* The password manager, visible. The button above is the
                    verb; this row is the state, with the one action that
                    changes it. */}
                {juser && jremember && (
                  <div className="mt-3 flex items-center gap-3 rounded-[12px] bg-surface-2 px-4 py-3">
                    <KeyRound className="size-4 shrink-0" style={{ color: "var(--ink-3)" }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium" style={{ color: "var(--ink-1)" }}>{juser}</span>
                      <span className="mt-0.5 block text-[12px]" style={{ color: "var(--ink-3)" }}>
                        Saved login — attendance signs in with it on its own.
                      </span>
                    </span>
                    <button
                      onClick={() => {
                        forgetCreds();
                        setPrefersSave(false);
                        setJremember(false);
                        setJpass("");
                        setJmsg(null);
                      }}
                      className="sd-press shrink-0 px-1 py-2 text-[13px] font-medium"
                      style={{ color: "var(--ink-3)" }}
                    >
                      Forget
                    </button>
                  </div>
                )}
              </>
            )}
            {jsigned && jmsg && jmsgTone === "error" && (
              <p className="mt-2 text-[13px]" style={{ color: "var(--att-critical-text)" }}>{jmsg}</p>
            )}

          </>
        )}

        {/* Per-date session detail — the portal's own tap-through. Same
            DragSheet as the sign-in, so it slides down to dismiss and has no
            X: two overlays in one flow should not have two sets of rules. */}
        {jdetailId && (
          <DragSheet
            onClose={() => setJdetailId(null)}
            label={`Sessions for ${jdetailName}`}
            panelClassName="max-h-[70vh] overflow-y-auto"
          >
            <h3 className="mb-3 text-[17px] font-semibold leading-snug" style={{ color: "var(--ink-1)" }}>
              {jdetailName}
            </h3>
            {!jdetail && !jdetailErr && (
              <div className="flex items-center gap-2 py-6 text-sm" style={{ color: "var(--ink-2)" }}>
                <Loader2 className="size-4 animate-spin" /> Loading sessions…
              </div>
            )}
            {jdetailErr && <p className="py-4 text-[13px]" style={{ color: "var(--att-critical-text)" }}>{jdetailErr}</p>}
            {jdetail && jdetail.length === 0 && (
              <p className="py-4 text-[13px]" style={{ color: "var(--ink-2)" }}>No session records returned for this subject.</p>
            )}
              {/* Sessions as a list. This was one bordered card per date
                  with a coloured P/A tile in front of every row — the two
                  most recognisable tells in one place. The word on the right
                  already carries the status, so it does not need a second
                  badge saying the same thing, and the rows do not need
                  boxes to be a list. */}
              {jdetail?.map((s, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 py-2.5"
                  style={{ borderTop: i === 0 ? "none" : "1px solid var(--line)" }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="tnum block text-[14px] font-medium" style={{ color: "var(--ink-1)" }}>{s.date}</span>
                    <span className="tnum mt-0.5 block text-[12px]" style={{ color: "var(--ink-3)" }}>
                      {s.from}–{s.to}{s.session ? `, session ${s.session}` : ""}
                    </span>
                  </span>
                  <span
                    className="shrink-0 text-[13px] font-medium"
                    style={{ color: s.present ? "var(--att-safe-text)" : "var(--att-critical-text)" }}
                  >
                    {s.present ? "Present" : "Absent"}
                  </span>
                </div>
              ))}
          </DragSheet>
        )}
      </div>

      {jopen && (
        <JunoSignInSheet
          user={juser}
          pass={jpass}
          remember={jremember}
          showPass={jshowPass}
          working={jworking}
          // The glyph is the only place the four request states are legible.
          // Derived, not stored, so it can never disagree with jworking.
          glyph={
            (jworking
              ? "working"
              : jmsg && jmsgTone === "error"
                ? "error"
                : jsigned
                  ? "ok"
                  : "idle") as PortalState
          }
          message={jworking ? (jmsg ?? "Working…") : jmsgTone === "error" ? (jmsg ?? "") : ""}
          tone={jmsgTone === "error" ? "error" : "ok"}
          onUser={setJuser}
          onPass={setJpass}
          onRemember={(v) => { setJremember(v); setPrefersSave(v); }}
          onTogglePass={() => setJshowPass((v: boolean) => !v)}
          onSubmit={() => void junoSync()}
          onClose={() => setJopen(false)}
        />
      )}

      {detailId &&
        (() => {
          const s = subjects.find((x) => x.id === detailId);
          if (!s) return null;
          return (
            <SubjectDetail
              s={s}
              marks={marks}
              onClose={() => setDetailId(null)}
              onMark={(p) => void bump(s, p)}
              onDelete={() => void removeSubject(s.id)}
            />
          );
        })()}
      {scanOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <header className="px-4 pb-3 shrink-0 border-b border-border pt-[max(30px,env(safe-area-inset-top))]">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">Scan timetable</div>
                <div className="text-[11px] text-muted-foreground">Photo of the class-group timetable</div>
              </div>
              <button onClick={() => { setScanOpen(false); setParsed([]); setOcrStage(null); }} className="p-2 rounded-xl hover:bg-accent" aria-label="Close">
                <X className="size-5" />
              </button>
            </div>
          </header>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {parsed.length === 0 ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Straight, bright photo with the full week visible works best.
                </p>
                <label className="flex items-center justify-center gap-2 w-full py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold">
                  <ScanText className="size-4" /> Choose photo
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => void runScanPhone(e.target.files)} />
                </label>
                <div className={labelCls}>Or pick from Files</div>
                <div className="space-y-1.5">
                  {libImgs.length === 0 && (
                    <p className="text-xs text-muted-foreground">No images in Files.</p>
                  )}
                  {libImgs.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => getFileData(f.id).then((d) => void runScan(d)).catch(() => setScanMsg("Could not read that file."))}
                      className="w-full text-left px-3.5 py-2.5 rounded-2xl bg-card border border-border text-sm truncate"
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
                {ocrStage && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> {ocrStage}
                  </div>
                )}
                {scanMsg && <p className="text-xs text-destructive">{scanMsg}</p>}
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {parsed.length} rows read. Fix anything wrong, then import. Breaks skip reminders automatically.
                </p>
                {parsed.map((r) => (
                  <div key={r.id} className="bg-card border border-border rounded-2xl p-3 space-y-1.5">
                    <div className="flex gap-1.5">
                      <input
                        value={r.subject}
                        onChange={(e) => setParsed(parsed.map((x) => (x.id === r.id ? { ...x, subject: e.target.value } : x)))}
                        placeholder="Subject"
                        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-input border border-border text-sm outline-none focus:border-primary"
                      />
                      <button
                        onClick={() => setParsed(parsed.filter((x) => x.id !== r.id))}
                        className="p-2 rounded-lg text-muted-foreground hover:text-destructive"
                        aria-label="Drop row"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                    <div className="flex gap-1.5">
                      <select
                        value={r.day}
                        onChange={(e) => setParsed(parsed.map((x) => (x.id === r.id ? { ...x, day: e.target.value } : x)))}
                        className="flex-1 px-2 py-1.5 rounded-lg bg-input border border-border text-xs outline-none"
                      >
                        {DAYS.map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                      <input
                        type="time"
                        value={r.start}
                        onChange={(e) => setParsed(parsed.map((x) => (x.id === r.id ? { ...x, start: e.target.value } : x)))}
                        className="flex-1 px-2 py-1.5 rounded-lg bg-input border border-border text-xs outline-none"
                      />
                      <input
                        type="time"
                        value={r.end}
                        onChange={(e) => setParsed(parsed.map((x) => (x.id === r.id ? { ...x, end: e.target.value } : x)))}
                        className="flex-1 px-2 py-1.5 rounded-lg bg-input border border-border text-xs outline-none"
                      />
                    </div>
                    <input
                      value={r.room}
                      onChange={(e) => setParsed(parsed.map((x) => (x.id === r.id ? { ...x, room: e.target.value } : x)))}
                      placeholder="Room (optional)"
                      className="w-full px-2.5 py-1.5 rounded-lg bg-input border border-border text-xs outline-none focus:border-primary"
                    />
                  </div>
                ))}
                <button
                  onClick={() => void confirmImport()}
                  className="w-full py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold"
                >
                  Import {parsed.length} entries
                </button>
                <p className="text-[11px] text-muted-foreground">
                  Importing replaces the classes already on the days this scan covers.
                </p>
                {scanDone && scanMsg && <p className="text-xs text-emerald-400">{scanMsg}</p>}
              </>
            )}
          </div>
        </div>
      )}
      {showClassForm && (
        <Sheet onClose={() => setShowClassForm(false)} title="New class">
          <Field label="Subject">
            <input value={cf.subject} onChange={(e) => setCf({ ...cf, subject: e.target.value })} placeholder="e.g. Computer Networks" className={inputCls} />
          </Field>
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="Day">
                <select value={cf.day} onChange={(e) => setCf({ ...cf, day: Number(e.target.value) })} className={inputCls}>
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>{d}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Room">
                <input value={cf.room} onChange={(e) => setCf({ ...cf, room: e.target.value })} placeholder="A3" className={inputCls} />
              </Field>
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="Start">
                <input type="time" value={cf.start} onChange={(e) => setCf({ ...cf, start: e.target.value })} className={inputCls} />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="End">
                <input type="time" value={cf.end} onChange={(e) => setCf({ ...cf, end: e.target.value })} className={inputCls} />
              </Field>
            </div>
          </div>
          <button onClick={() => setCf({ ...cf, remind: !cf.remind })} className="flex items-center gap-2 w-full px-3.5 py-3 rounded-2xl bg-background border border-border text-sm">
            {cf.remind ? <Bell className="size-4 text-primary" /> : <BellOff className="size-4 text-muted-foreground" />}
            Remind 10 min before
          </button>
          <button onClick={() => void addClass()} className="w-full py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold">
            Add class
          </button>
        </Sheet>
      )}

      {showSubForm && (
        <Sheet onClose={() => setShowSubForm(false)} title="New subject">
          <Field label="Subject name">
            <input value={sf} onChange={(e) => setSf(e.target.value)} placeholder="e.g. CN" className={inputCls} />
          </Field>
          <button onClick={() => void addSubject()} className="w-full py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold">
            Add subject
          </button>
        </Sheet>
      )}

      {showDeckForm && (
        <Sheet onClose={() => setShowDeckForm(false)} title="New deck">
          <Field label="Deck name">
            <input value={df} onChange={(e) => setDf(e.target.value)} placeholder="e.g. OS Unit 2" className={inputCls} />
          </Field>
          <button onClick={() => void addDeck()} className="w-full py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold">
            Add deck
          </button>
        </Sheet>
      )}
    </div>
  );
}

/**
 * The student's portal identity, fetched once per signed-in session and cached
 * for the life of it.
 *
 * Deliberately a list of labelled facts on the canvas, not a card. It is
 * reference data you read, not a thing you tap, so it gets the same treatment
 * as every other list in the app: rows, hairlines, quiet labels. The name is
 * the one thing at full weight, because it is the thing you are looking for.
 *
 * Every field here came back from the portal. A field the portal does not
 * publish is not rendered at all - an identity card with a gap in it is
 * honest, one with a guess in it is not.
 */
function JunoProfileBlock({ signedIn, termName }: { signedIn: boolean; termName?: string }) {
  const [profile, setProfile] = useState<JunoProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [more, setMore] = useState(false);

  // Keyed on the sign-in flag Campus already owns, not on the module-level
  // session check: a global read during render would only be re-evaluated when
  // something else happened to re-render this screen, so signing in could
  // leave the block missing until you happened to switch tabs.
  useEffect(() => {
    if (!signedIn) {
      setProfile(null);
      setErr(null);
      return;
    }
    let alive = true;
    setBusy(true);
    setErr(null);
    void junoNativeProfile(termName)
      .then((p) => {
        if (!alive) return;
        setProfile(p);
        setBusy(false);
      })
      .catch((e) => {
        // Logged as well as shown. Swallowing this is what made a real failure
        // look like "nothing was built".
        console.error("[juno] profile fetch failed", e);
        if (!alive) return;
        setProfile(null);
        setBusy(false);
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [signedIn, termName, nonce]);

  if (!signedIn || (!profile && !err)) return null;

  if (!profile && err) {
    /* Recoverable, with a retry - and quiet about it. An error card where a
       profile belongs would be worse than the missing profile, so this is one
       hairline row: what went wrong, and a way to try again. */
    return (
      <div className="mt-4 flex items-center gap-3 py-2">
        <p className="min-w-0 flex-1 text-[13px]" style={{ color: "var(--ink-3)" }}>
          {/limit|busy|reject/i.test(err) ? "The portal is busy. Try again shortly." : "Could not read your profile."}
        </p>
        <button
          onClick={() => setNonce((n) => n + 1)}
          disabled={busy}
          className="sd-press shrink-0 rounded-[8px] px-3 py-1.5 text-[13px]"
          style={{ background: "var(--surface-2)", color: "var(--ink-1)" }}
        >
          {busy ? "Trying" : "Try again"}
        </button>
      </div>
    );
  }

  if (!profile) return null;

  /* The portal shouts in capitals. Sentence case is not a style preference
     here, it is legibility: a 40-character department name in full caps is a
     grey block, and it is the one line on this screen that cannot be scanned.
     Only strings that arrive entirely upper-case are touched, so a course name
     that already reads "B.Tech. Computer Science" is left exactly as written. */
  const calm = (s?: string) => {
    if (!s) return s;
    const shouty = s === s.toUpperCase() && /[A-Z]{3,}/.test(s);
    if (!shouty) return s;
    // Small words stay lowercase unless they open the string, so the result
    // reads as a sentence rather than as Title Case shouted more quietly.
    const small = new Set([
      "of", "and", "the", "for", "in", "on", "at", "to", "a", "an", "with", "by", "from",
    ]);
    const words = s.toLowerCase().split(" ");
    return words
      .map((w, i) =>
        small.has(w) && i > 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)
      )
      .join(" ");
  };

  /* Semester is deliberately absent. The term strip directly below already
     shows it, selected and underlined - printing it a third time in the
     profile was pure duplication. Course and the two institutional lines are
     real information but not the thing you opened this tab for, so they sit
     behind one tap rather than taking a screenful up front. */
  const extras: { label: string; value: string }[] = [];
  const push = (label: string, v?: string) => {
    if (v) extras.push({ label, value: calm(v)! });
  };
  push("Course", profile.courseName);
  push("Department", profile.departmentName);
  push("Institute", profile.instituteName);

  if (!profile.fullName && !profile.uniqueId && extras.length === 0) return null;

  return (
    <div className="mt-4">
      {/* Identity, not a data table: a name and the one identifier people
          actually copy, and nothing that is not a fact about you. */}
      <p className="truncate text-[15px] font-medium" style={{ color: "var(--ink-1)" }}>
        {profile.fullName}
      </p>
      {profile.uniqueId && (
        <p className="tnum mt-0.5 truncate text-[13px]" style={{ color: "var(--ink-2)" }}>
          {profile.uniqueId}
        </p>
      )}
      {extras.length > 0 && (
        <>
          <button
            onClick={() => setMore((o) => !o)}
            aria-expanded={more}
            className="sd-press mt-1.5 flex items-center gap-1 py-1 text-[13px]"
            style={{ color: "var(--ink-3)" }}
          >
            {more ? "Less" : "Course and institute"}
            <ChevronDown
              className="size-3.5 transition-transform"
              style={{ transform: more ? "rotate(180deg)" : "none" }}
            />
          </button>
          {more && (
            <dl className="mt-1.5">
              {extras.map((f, i) => (
                <div
                  key={f.label}
                  className="flex gap-3 py-1.5"
                  style={{ borderTop: "1px solid var(--line)" }}
                >
                  <dt className="w-[76px] shrink-0 text-[13px]" style={{ color: "var(--ink-3)" }}>
                    {f.label}
                  </dt>
                  <dd className="min-w-0 flex-1 text-[13px]" style={{ color: "var(--ink-2)" }}>
                    {f.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {  return (
    <div className="mb-2.5">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">{label}</div>
      {children}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div className="bg-card border-t border-border rounded-t-3xl p-4 pb-8 max-h-[85%] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <div className="flex-1 text-sm font-semibold">{title}</div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-accent" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Is this class running right now? Drives the only "live" treatment. */
function isLive(c: ClassItem): boolean {
  if (c.day !== todayIdx()) return false;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const toM = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  return mins >= toM(c.start) && mins < toM(c.end);
}

function ClassRow({ c, onToggle, onDelete }: { c: ClassItem; onToggle: () => void; onDelete: () => void }) {
  const live = isLive(c);
  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        onDelete();
      }}
      className="flex items-center gap-3 border-b border-line py-3"
    >
      {/* While a class runs, its time rail breathes. It is the only looping
          element here, and it only moves when it means something. */}
      <div className="relative flex h-10 w-1 shrink-0 items-center justify-center">
        {live && <span className="sd-live-halo" />}
        <span
          className="relative h-full w-1 rounded-full"
          style={{ background: live ? "var(--att-safe)" : "var(--line-strong)" }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium" style={{ color: "var(--ink-1)" }}>
          {c.subject}
        </div>
        <div className="tnum text-[12px]" style={{ color: live ? "var(--att-safe-text)" : "var(--ink-3)" }}>
          {c.start}–{c.end}
          {c.room ? `, room ${c.room}` : ""}
          {live ? " — happening now" : ""}
        </div>
      </div>
      <button
        onClick={onToggle}
        className="sd-press rounded-lg p-2.5"
        style={{ color: c.remind ? "var(--ink-2)" : "var(--ink-3)" }}
        aria-label={c.remind ? "Turn off reminder" : "Turn on reminder"}
        aria-pressed={Boolean(c.remind)}
      >
        {c.remind ? <Bell className="size-4" /> : <BellOff className="size-4" />}
      </button>
    </div>
  );
}

function SubjectDetail({
  s,
  marks,
  onClose,
  onMark,
  onDelete,
}: {
  s: AttSubject;
  marks: AttMark[];
  onClose: () => void;
  onMark: (present: boolean) => void;
  onDelete: () => void;
}) {
  const info = bunkInfo(s.attended, s.total);
  const pct = Math.max(0, Math.min(100, info.pct));
  const R = 34;
  const C = 2 * Math.PI * R;
  const color = info.pct >= 90 ? "#34d399" : info.pct >= 75 ? "#fbbf24" : "#f06666";
  const mine = marks.filter((m) => m.sid === s.id).slice(-14).reverse();
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div className="bg-card border-t border-border rounded-t-3xl p-4 pb-8 max-h-[80%] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <div className="relative size-[84px] shrink-0">
            <svg width="84" height="84" viewBox="0 0 84 84">
              <circle cx="42" cy="42" r={R} fill="none" stroke="#2a2a33" strokeWidth="8" />
              <motion.circle
                cx="42" cy="42" r={R} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
                strokeDasharray={C} initial={{ strokeDashoffset: C }}
                animate={{ strokeDashoffset: C * (1 - pct / 100) }}
                transition={{ duration: 0.8, ease: "easeOut" }} transform="rotate(-90 42 42)"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-sm font-bold">{info.pct.toFixed(0)}%</span>
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-bold truncate">{s.name}</div>
            <div className="text-xs text-muted-foreground">{s.attended} present of {s.total} classes</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {info.pct >= 75 ? `Safe bunks left: ${info.safe}` : `Attend next ${info.need} to recover`}
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-accent self-start" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mt-4 mb-2">Recent marks</div>
        {mine.length === 0 ? (
          <p className="text-xs text-muted-foreground">No manual marks yet. Juno totals carry no day history.</p>
        ) : (
          <div className="flex gap-1.5 flex-wrap">
            {mine.map((m, i) => (
              <div
                key={m.at + "-" + i}
                title={`${m.date}, ${m.present ? "present" : "absent"}`}
                className={`size-7 rounded-full flex items-center justify-center text-[10px] font-bold ${m.present ? "bg-emerald-500/20 text-emerald-400" : "bg-destructive/15 text-destructive"}`}
              >
                {m.present ? "P" : "A"}
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 mt-4">
          <button onClick={() => onMark(true)} className="flex-1 py-3 rounded-2xl bg-emerald-500/15 text-emerald-400 text-sm font-bold">
            Present
          </button>
          <button onClick={() => onMark(false)} className="flex-1 py-3 rounded-2xl bg-destructive/10 text-destructive text-sm font-bold">
            Absent
          </button>
        </div>
        <button onClick={onDelete} className="w-full mt-2 py-2.5 rounded-2xl text-xs font-semibold text-muted-foreground hover:text-destructive">
          Delete subject
        </button>
      </div>
    </div>
  );
}

function StudyView({
  deck, study, onFlip, onGrade, onRestart, onExit,
}: {
  deck: Deck;
  study: { queue: string[]; i: number; flipped: boolean; knew: number };
  onFlip: () => void;
  onGrade: (knew: boolean) => void;
  onRestart: () => void;
  onExit: () => void;
}) {
  if (study.i >= study.queue.length) {
    return (
      <div className="flex flex-col items-center mt-10 px-6">
        <div className="text-4xl font-bold">{study.knew}/{study.queue.length}</div>
        <p className="text-sm text-muted-foreground mt-1">knew it</p>
        <div className="flex gap-2 mt-5 w-full">
          <button onClick={onRestart} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl bg-accent text-sm font-semibold">
            <RotateCcw className="size-4" /> Shuffle again
          </button>
          <button onClick={onExit} className="flex-1 py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold">
            Back to deck
          </button>
        </div>
      </div>
    );
  }
  const card = deck.cards.find((c) => c.id === study.queue[study.i]);
  if (!card) return null;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 mt-1 mb-2">
        <button onClick={onExit} className="flex items-center gap-1 text-xs text-muted-foreground">
          <ChevronLeft className="size-4" /> Deck
        </button>
        <div className="flex-1" />
        <div className="text-[11px] text-muted-foreground">
          {study.i + 1} of {study.queue.length}, {study.knew} knew
        </div>
        <button onClick={onRestart} className="p-2 rounded-lg text-muted-foreground" aria-label="Restart shuffle">
          <Shuffle className="size-4" />
        </button>
      </div>
      <motion.button
        key={card.id + String(study.flipped)}
        initial={{ opacity: 0.4 }}
        animate={{ opacity: 1 }}
        onClick={onFlip}
        className="w-full text-left bg-card border border-border rounded-3xl p-6 min-h-[220px] flex flex-col justify-center"
      >
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          {study.flipped ? "Answer" : "Tap to reveal"}
        </div>
        <p className="text-base leading-relaxed">{study.flipped ? card.back : card.front}</p>
      </motion.button>
      {study.flipped ? (
        <div className="flex gap-2 mt-3">
          <button onClick={() => onGrade(false)} className="flex-1 py-3 rounded-2xl bg-destructive/10 border border-destructive/30 text-destructive text-sm font-bold">
            Still learning
          </button>
          <button onClick={() => onGrade(true)} className="flex-1 py-3 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-sm font-bold">
            Knew it
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground text-center mt-3">Recall it first, then flip.</p>
      )}
    </div>
  );
}
