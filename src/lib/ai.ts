import { askBridge, loadBridge } from "./ask";

function loadDirect(): { base: string; model: string; key: string } | null {
  try {
    const d = JSON.parse(localStorage.getItem("sd_direct") || "{}");
    if (d.base && d.model && d.key) return d;
  } catch {
    /* none */
  }
  return null;
}

/** Ask the configured AI (Direct key first, PC bridge fallback). Returns raw text. */
export async function aiAsk(system: string, user: string): Promise<string> {
  const d = loadDirect();
  if (d) {
    try {
      const r = await fetch(`${d.base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${d.key}` },
        body: JSON.stringify({
          model: d.model,
          temperature: 0.1,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!r.ok) throw new Error(`AI service returned ${r.status}`);
      const j = await r.json();
      const text = String(j.choices?.[0]?.message?.content || "");
      if (text.trim()) return text;
      throw new Error("Empty reply");
    } catch {
      /* fall through to bridge */
    }
  }
  const b = loadBridge();
  if (!b.url || !b.token) {
    throw new Error("No AI set up. Add a Direct key or PC bridge in the Ask tab first.");
  }
  const r = await askBridge(b.url, b.token, `${system}\n\n${user}`);
  return r.output;
}

/** Ask AI for a JSON array. Extracts the first [...] block. */
export async function aiJsonArray(system: string, user: string): Promise<any[]> {
  const text = await aiAsk(system, user);
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("AI did not return a list. Try a clearer photo.");
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr)) throw new Error("AI did not return a list.");
  return arr;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type ParsedClass = {
  subject: string;
  day: string;
  start: string;
  end: string;
  room: string;
};

const to24 = (t: string): string => {
  const m = String(t || "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?$/);
  if (!m) {
    const m2 = String(t || "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m2) return `${m2[1]!.padStart(2, "0")}:${m2[2]}`;
    return "";
  }
  let h = parseInt(m[1]!, 10);
  const mm = m[2] || "00";
  const ap = m[3]!.toUpperCase();
  if (ap === "P" && h < 12) h += 12;
  if (ap === "A" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${mm}`;
};

/** Timetable OCR text → structured rows. AI first, heuristics fallback. */
export async function parseTimetableText(ocr: string): Promise<ParsedClass[]> {
  const system = [
    "You extract college timetables into JSON.",
    "Input is OCR text and may contain errors.",
    "Output ONLY a JSON array, no other text.",
    'Each item: {"subject": string, "day": one of Mon Tue Wed Thu Fri Sat, "start": "HH:MM" 24-hour, "end": "HH:MM" 24-hour, "room": string, may be ""}.',
    "Rules: expand times like 1-2 PM to 13:00-14:00. Keep break, lunch and recess rows with that subject name.",
    "A day header applies to following rows until the next day header. Drop header junk and page numbers.",
    "If a row has no clear day, use Mon.",
  ].join(" ");
  try {
    const arr = await aiJsonArray(system, `OCR text:\n${ocr.slice(0, 6000)}`);
    return arr
      .map((r: any) => ({
        subject: String(r.subject || "").slice(0, 40),
        day: DAY_NAMES.includes(String(r.day)) ? String(r.day) : "Mon",
        start: /^\d{2}:\d{2}$/.test(String(r.start || "")) ? String(r.start) : to24(String(r.start || "")),
        end: /^\d{2}:\d{2}$/.test(String(r.end || "")) ? String(r.end) : to24(String(r.end || "")),
        room: String(r.room || "").slice(0, 20),
      }))
      .filter((r) => r.subject && r.start && r.end);
  } catch {
    return heuristicTimetable(ocr);
  }
}

function heuristicTimetable(ocr: string): ParsedClass[] {
  const out: ParsedClass[] = [];
  let day = "Mon";
  for (const raw of ocr.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const dayHit = line.match(/\b(mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?)\b/i);
    if (dayHit && line.length < 24) {
      day = DAY_NAMES.find((d) => d.toLowerCase().startsWith(dayHit[1]!.slice(0, 3).toLowerCase())) || day;
      continue;
    }
    const m = line.match(/(.+?)\s+(\d{1,2}(?::\d{2})?\s*[AP]\.?M\.?)\s*[-–to]+\s*(\d{1,2}(?::\d{2})?\s*[AP]\.?M\.?)\s*(.*)/i);
    if (!m) continue;
    const start = to24(m[2]!);
    const end = to24(m[3]!);
    if (!start || !end) continue;
    out.push({ subject: m[1]!.trim().slice(0, 40), day, start, end, room: (m[4] || "").trim().slice(0, 20) });
  }
  return out.slice(0, 60);
}
