export type AskEntry = { q: string; a: string; at: number; sid: string | null };
export type PcSession = { id: string; title: string; updated: number };

const ASK_KEY = "sd_asks";
const BRIDGE_KEY = "sd_bridge";
const SID_KEY = "sd_bridge_sid";

export function loadAsks(): AskEntry[] {
  try {
    return JSON.parse(localStorage.getItem(ASK_KEY) || "[]");
  } catch {
    return [];
  }
}

export function pushAsk(e: AskEntry) {
  const all = [e, ...loadAsks()].slice(0, 100);
  localStorage.setItem(ASK_KEY, JSON.stringify(all));
}

export function loadBridge(): { url: string; token: string } {
  try {
    return JSON.parse(localStorage.getItem(BRIDGE_KEY) || "{}");
  } catch {
    return { url: "", token: "" };
  }
}

export function saveBridge(v: { url: string; token: string }) {
  localStorage.setItem(BRIDGE_KEY, JSON.stringify(v));
}

export function loadSid(): string | null {
  return localStorage.getItem(SID_KEY) || null;
}

export function saveSid(id: string | null) {
  if (id) localStorage.setItem(SID_KEY, id);
  else localStorage.removeItem(SID_KEY);
}

export async function listSessions(url: string, token: string): Promise<PcSession[]> {
  const r = await fetch(`${url.replace(/\/$/, "")}/sessions?token=${encodeURIComponent(token)}`);
  if (!r.ok) throw new Error(`PC returned ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.sessions) ? j.sessions : [];
}

export async function askBridge(
  url: string, token: string, prompt: string, sessionId?: string | null
): Promise<{ output: string; sessionId: string | null }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, prompt, sessionId: sessionId || undefined }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Bridge returned ${r.status}`);
    const j = await r.json();
    return { output: String(j.output || "(empty reply from PC)"), sessionId: j.sessionId || null };
  } finally {
    clearTimeout(t);
  }
}
