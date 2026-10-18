import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";

const DIR = Directory.Data;
const NOTES_DIR = "notes";
const FILES_DIR = "files";

export type NoteMeta = { id: string; title: string; folder: string; updatedAt: number; originFileId?: string; originExt?: string };
export type FileMeta = { id: string; name: string; ext: string; size: number; addedAt: number; pinned: boolean };

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function ensureDir(path: string) {
  try {
    await Filesystem.mkdir({ path, directory: DIR, recursive: true });
  } catch {
    /* already exists */
  }
}

export async function initStore() {
  await ensureDir(NOTES_DIR);
  await ensureDir(FILES_DIR);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const r = await Filesystem.readFile({ path, directory: DIR, encoding: Encoding.UTF8 });
    const t = typeof r.data === "string" ? r.data : "";
    return JSON.parse(t) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, v: unknown) {
  await Filesystem.writeFile({
    path,
    directory: DIR,
    data: JSON.stringify(v),
    encoding: Encoding.UTF8,
  });
}

// ── Notes ──────────────────────────────────────────────
export async function listNotes(): Promise<NoteMeta[]> {
  const all = await readJson<NoteMeta[]>(`${NOTES_DIR}/index.json`, []);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getNoteBody(id: string): Promise<string> {
  try {
    const r = await Filesystem.readFile({
      path: `${NOTES_DIR}/${id}.md`,
      directory: DIR,
      encoding: Encoding.UTF8,
    });
    return typeof r.data === "string" ? r.data : "";
  } catch {
    return "";
  }
}

export async function saveNote(meta: NoteMeta, body: string): Promise<NoteMeta> {
  const all = await readJson<NoteMeta[]>(`${NOTES_DIR}/index.json`, []);
  const rec = { ...meta, updatedAt: Date.now() };
  const i = all.findIndex((n) => n.id === meta.id);
  if (i >= 0) all[i] = rec;
  else all.unshift(rec);
  await writeJson(`${NOTES_DIR}/index.json`, all);
  await Filesystem.writeFile({
    path: `${NOTES_DIR}/${meta.id}.md`,
    directory: DIR,
    data: body,
    encoding: Encoding.UTF8,
  });
  return rec;
}

export async function deleteNote(id: string) {
  const all = (await readJson<NoteMeta[]>(`${NOTES_DIR}/index.json`, [])).filter(
    (n) => n.id !== id
  );
  await writeJson(`${NOTES_DIR}/index.json`, all);
  try {
    await Filesystem.deleteFile({ path: `${NOTES_DIR}/${id}.md`, directory: DIR });
  } catch {
    /* noop */
  }
}

// ── Files ──────────────────────────────────────────────
export async function listFiles(): Promise<FileMeta[]> {
  const all = await readJson<FileMeta[]>(`${FILES_DIR}/index.json`, []);
  return all
    .map((f) => ({ ...f, pinned: Boolean(f.pinned) }))
    .sort((a, b) => b.addedAt - a.addedAt);
}

export async function getFileData(id: string): Promise<string> {
  const r = await Filesystem.readFile({
    path: `${FILES_DIR}/${id}.b64`,
    directory: DIR,
    encoding: Encoding.UTF8,
  });
  return typeof r.data === "string" ? r.data : "";
}

export async function addFile(name: string, base64: string): Promise<FileMeta> {
  const all = await readJson<FileMeta[]>(`${FILES_DIR}/index.json`, []);
  const dot = name.lastIndexOf(".");
  const meta: FileMeta = {
    id: uid(),
    name,
    ext: dot >= 0 ? name.slice(dot + 1).toLowerCase() : "",
    size: Math.round((base64.length * 3) / 4),
    addedAt: Date.now(),
    pinned: false,
  };
  await Filesystem.writeFile({
    path: `${FILES_DIR}/${meta.id}.b64`,
    directory: DIR,
    data: base64,
    encoding: Encoding.UTF8,
  });
  all.unshift(meta);
  await writeJson(`${FILES_DIR}/index.json`, all);
  return meta;
}

export async function setPinned(id: string, pinned: boolean): Promise<FileMeta[]> {
  const all = await readJson<FileMeta[]>(`${FILES_DIR}/index.json`, []);
  const next = all.map((f) => (f.id === id ? { ...f, pinned } : f));
  await writeJson(`${FILES_DIR}/index.json`, next);
  return listFiles();
}

export async function updateNoteMeta(id: string, patch: Partial<NoteMeta>) {
  const all = await readJson<NoteMeta[]>(`${NOTES_DIR}/index.json`, []);
  await writeJson(
    `${NOTES_DIR}/index.json`,
    all.map((n) => (n.id === id ? { ...n, ...patch } : n))
  );
}

export async function moveFolderNotes(oldF: string, newF: string) {
  const all = await readJson<NoteMeta[]>(`${NOTES_DIR}/index.json`, []);
  await writeJson(
    `${NOTES_DIR}/index.json`,
    all.map((n) => (n.folder === oldF ? { ...n, folder: newF } : n))
  );
}

// ── Todos ──────────────────────────────────────────────
export type Todo = { id: string; text: string; done: boolean; at: number; due?: string; time?: string; details?: string };

export async function listTodos(): Promise<Todo[]> {
  return readJson<Todo[]>(`todos/index.json`, []);
}

export async function saveTodos(t: Todo[]) {
  await ensureDir("todos");
  await writeJson(`todos/index.json`, t);
}

// ── Campus: timetable, attendance, flashcards ────────────
export type ClassItem = { id: string; subject: string; day: number; start: string; end: string; room: string; remind: boolean };
export type AttSubject = { id: string; name: string; attended: number; total: number };
/**
 * A flashcard. `box` and `last` are the review state and are optional so
 * decks written before scheduling existed still load — they simply come
 * back as never-seen, which is exactly right.
 */
export type FlashCard = {
  id: string;
  front: string;
  back: string;
  /** Spaced-repetition box, 0 (relearning) to 3 (long interval). */
  box?: number;
  /** Epoch ms of the last review. */
  last?: number;
};

export type Deck = { id: string; name: string; cards: FlashCard[] };

export async function listClasses(): Promise<ClassItem[]> {
  return readJson<ClassItem[]>(`campus/timetable.json`, []);
}

export async function saveClasses(c: ClassItem[]) {
  await ensureDir("campus");
  await writeJson(`campus/timetable.json`, c);
}

export async function listSubjects(): Promise<AttSubject[]> {
  return readJson<AttSubject[]>(`campus/attendance.json`, []);
}

export async function saveSubjects(s: AttSubject[]) {
  await ensureDir("campus");
  await writeJson(`campus/attendance.json`, s);
}

// ── Attendance log (per-mark history) ──────────────────
export type AttMark = { sid: string; date: string; present: boolean; at: number };

export async function listMarks(): Promise<AttMark[]> {
  return readJson<AttMark[]>(`campus/attendance-log.json`, []);
}

export async function appendMark(m: AttMark) {
  await ensureDir("campus");
  const all = await listMarks();
  all.push(m);
  await writeJson(`campus/attendance-log.json`, all.slice(-2000));
}

export async function clearMarksFor(sid: string) {
  await writeJson(
    `campus/attendance-log.json`,
    (await listMarks()).filter((m) => m.sid !== sid)
  );
}

export async function listDecks(): Promise<Deck[]> {
  return readJson<Deck[]>(`campus/decks.json`, []);
}

export async function saveDecks(d: Deck[]) {
  await ensureDir("campus");
  await writeJson(`campus/decks.json`, d);
}

/** Safe bunks left before dropping below target (default 75%). */
export function bunkInfo(attended: number, total: number, target = 0.75): { pct: number; safe: number; need: number } {
  const pct = total === 0 ? 100 : (attended / total) * 100;
  let safe = 0;
  while (total + safe + 1 > 0 && (attended / (total + safe + 1)) * 100 >= target * 100) safe++;
  let need = 0;
  if (pct < target * 100) {
    while (((attended + need) / (total + need)) * 100 < target * 100) {
      need++;
      if (need > 500) break;
    }
  }
  return { pct, safe, need };
}

export async function updateFileData(id: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
  }
  await Filesystem.writeFile({
    path: `${FILES_DIR}/${id}.b64`,
    directory: DIR,
    data: btoa(s),
    encoding: Encoding.UTF8,
  });
}

export async function deleteFileEntry(id: string) {
  const all = (await readJson<FileMeta[]>(`${FILES_DIR}/index.json`, [])).filter(
    (f) => f.id !== id
  );
  await writeJson(`${FILES_DIR}/index.json`, all);
  try {
    await Filesystem.deleteFile({ path: `${FILES_DIR}/${id}.b64`, directory: DIR });
  } catch {
    /* noop */
  }
}

// ── Pinned board (lockscreen tasks) ───────────────────────────────
/**
 * A pin is a deadline the student was handed, not a note. `due` is what
 * makes it worth looking at; `done` is what makes it finishable. Both are
 * optional because pins saved before this existed have neither, and they
 * still have to load.
 */
export type PinnedTask = {
  id: string;
  text: string;
  pinned: boolean;
  at: number;
  /** Epoch ms of the deadline, if the student set one. */
  due?: number;
  /** Set when they say they have dealt with it. */
  done?: boolean;
  doneAt?: number;
};

export async function listPinnedTasks(): Promise<PinnedTask[]> {
  return readJson<PinnedTask[]>(`campus/pinned.json`, []);
}

export async function savePinnedTasks(t: PinnedTask[]) {
  await ensureDir("campus");
  await writeJson(`campus/pinned.json`, t);
}

// ── base64 helpers ─────────────────────────────────────
export function fileToBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      res(s.includes(",") ? s.split(",")[1]! : s);
    };
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64ToText(b64: string): string {
  try {
    return new TextDecoder().decode(b64ToBytes(b64));
  } catch {
    return "";
  }
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
