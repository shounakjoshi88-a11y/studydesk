import { useState } from "react";
import { Send, Loader2, BookmarkPlus, Settings2, ScanLine, MessagesSquare, Plus, X } from "lucide-react";
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerCameraDirection, CapacitorBarcodeScannerTypeHint } from "@capacitor/barcode-scanner";
import { MessageRenderer } from "../components/MessageRenderer";
import { EmptyState } from "../components/EmptyState";
import {
  askBridge, listSessions, loadAsks, pushAsk, loadBridge, saveBridge,
  loadSid, saveSid, type AskEntry, type PcSession,
} from "../lib/ask";
import { saveNote, uid } from "../lib/store";

const noop = () => {};
const inputCls = "h-11 w-full rounded-[10px] border border-line bg-surface-2 px-3.5 text-[14px] text-ink-1 outline-none focus:border-brand";
const labelCls = "text-[12px] font-medium text-ink-2";
/** The two ways to reach an answer. The caption under the switch explains
 *  the active one, so both blurbs do not have to sit on screen at once. */
const MODES = [
  { id: "bridge", top: "PC bridge", sub: "Full agent on your PC" },
  { id: "direct", top: "Direct key", sub: "Works with your PC off" },
] as const;

/** "14:05" for today, "5 Oct 14:05" after — the same shape Notes uses. */
function whenStamp(t: number): string {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function Ask() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [asks, setAsks] = useState<AskEntry[]>(() => loadAsks());
  const [showCfg, setShowCfg] = useState(false);
  const [showChats, setShowChats] = useState(false);
  const [sessions, setSessions] = useState<PcSession[]>([]);
  const [sid, setSid] = useState<string | null>(() => loadSid());
  const [cfg, setCfg] = useState(() => {
    const b = loadBridge();
    return { url: b.url || "", token: b.token || "" };
  });

  const saveCfg = () => {
    saveBridge(cfg);
    localStorage.setItem("sd_direct", JSON.stringify(dcfg));
    setShowCfg(false);
  };

  const [mode, setMode] = useState<"bridge" | "direct">(() =>
    localStorage.getItem("sd_ask_mode") === "direct" ? "direct" : "bridge"
  );
  const [dcfg, setDcfg] = useState(() => {
    try {
      const d = JSON.parse(localStorage.getItem("sd_direct") || "{}");
      return {
        base: d.base || "https://opencode.ai/zen/v1",
        model: d.model || "big-pickle",
        key: d.key || "",
      };
    } catch {
      return { base: "https://opencode.ai/zen/v1", model: "big-pickle", key: "" };
    }
  });

  const threadKey = mode === "direct" ? "direct" : sid;
  const thread = asks.filter((a) => (a.sid || null) === threadKey);
  const configured = Boolean(loadBridge().url && loadBridge().token);
  const activeTitle =
    mode === "direct"
      ? "Direct key chat"
      : sessions.find((s) => s.id === sid)?.title || (sid ? sid.slice(0, 18) + "…" : "New chat");

  const sendDirect = async (prompt: string) => {
    if (!dcfg.base || !dcfg.model || !dcfg.key) {
      setErr("Add your Base URL, Model and API key first.");
      setShowCfg(true);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const history = [...asks]
        .filter((a) => a.sid === "direct")
        .slice(0, 6)
        .reverse()
        .flatMap((e) => [
          { role: "user", content: e.q },
          { role: "assistant", content: e.a },
        ]);
      const r = await fetch(`${dcfg.base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${dcfg.key}` },
        body: JSON.stringify({
          model: dcfg.model,
          messages: [
            { role: "system", content: "You are a concise study tutor for networking and JNCIA exams. Answer in markdown. Short explanations, small examples, tables where useful." },
            ...history,
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!r.ok) throw new Error(`AI service returned ${r.status}`);
      const j = await r.json();
      const a = String(j.choices?.[0]?.message?.content || "Empty reply. Try again.");
      const entry = { q: prompt, a, at: Date.now(), sid: "direct" as const };
      pushAsk(entry);
      setAsks(loadAsks());
      setQ("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const prompt = q.trim();
    if (!prompt || busy) return;
    if (mode === "direct") {
      await sendDirect(prompt);
      return;
    }
    const b = loadBridge();
    if (!b.url || !b.token) {
      setErr("Connect your PC first. Open the bridge page on your PC and scan the QR.");
      setShowCfg(true);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await askBridge(b.url, b.token, prompt, sid);
      if (r.sessionId && r.sessionId !== sid) {
        setSid(r.sessionId);
        saveSid(r.sessionId);
      }
      const entry = { q: prompt, a: r.output, at: Date.now(), sid: r.sessionId || null };
      pushAsk(entry);
      setAsks(loadAsks());
      setQ("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openChats = async () => {
    setShowChats(true);
    setErr(null);
    try {
      const b = loadBridge();
      if (!b.url || !b.token) throw new Error("Connect your PC first, then open chats.");
      setSessions(await listSessions(b.url, b.token));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const pickSession = (id: string | null) => {
    setSid(id);
    saveSid(id);
    setShowChats(false);
  };

  const scanQr = async () => {
    setErr(null);
    try {
      const r = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
        scanButton: false,
        scanText: "Point at the StudyDesk QR on your PC",
      });
      const j = JSON.parse(String(r.ScanResult || ""));
      if (!j.url || !j.token) throw new Error("That QR is not a StudyDesk code.");
      const v = { url: String(j.url), token: String(j.token) };
      setCfg(v);
      saveBridge(v);
      setShowCfg(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const saveAsNote = async (e: AskEntry) => {
    await saveNote(
      { id: uid(), title: e.q.slice(0, 60), folder: "Ask", updatedAt: Date.now() },
      `# Q: ${e.q}\n\n${e.a}`
    );
  };

  const linkReady = mode === "direct" || configured;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 shrink-0">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold tracking-tight">Ask</h2>
            {/* Dot colour is never the only signal — the words spell the state out. */}
            <p className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-2">
              <span
                className={`size-1.5 rounded-full shrink-0 ${linkReady ? "bg-[var(--att-safe)]" : "bg-[var(--att-caution)]"}`}
                aria-hidden
              />
              <span className="truncate">{linkReady ? "Linked" : "Not linked"} · {activeTitle}</span>
            </p>
          </div>
          <button onClick={() => void openChats()} className="sd-tap grid size-10 shrink-0 place-items-center rounded-[10px] text-ink-3" aria-label="Chats">
            <MessagesSquare className="size-[18px]" strokeWidth={1.75} />
          </button>
          <button
            onClick={() => setShowCfg(!showCfg)}
            aria-expanded={showCfg}
            className="sd-tap grid size-10 shrink-0 place-items-center rounded-[10px]"
            style={showCfg ? { background: "var(--brand-soft)", color: "var(--brand-ink)" } : { color: "var(--ink-3)" }}
            aria-label="Ask settings"
          >
            <Settings2 className="size-[18px]" strokeWidth={1.75} />
          </button>
        </div>

        <div className="mt-3 flex rounded-[12px] bg-surface-2 p-1" role="tablist" aria-label="Answer source">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              onClick={() => { setMode(m.id); localStorage.setItem("sd_ask_mode", m.id); }}
              className={`sd-tap h-9 flex-1 rounded-[9px] text-[13px] font-medium ${mode === m.id ? "bg-surface-3 text-ink-1" : "text-ink-3"}`}
            >
              {m.top}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-ink-3">{MODES.find((m) => m.id === mode)?.sub}</p>

        {showCfg && (
          <div className="mt-3 space-y-3 rounded-card border border-line bg-surface-1 p-3.5">
            {mode === "bridge" ? (
              <>
                <div>
                  <label className={labelCls} htmlFor="ask-url">PC address</label>
                  <input
                    id="ask-url"
                    value={cfg.url}
                    onChange={(e) => setCfg({ ...cfg, url: e.target.value })}
                    placeholder="http://192.168.1.6:8787"
                    className={`${inputCls} mt-1.5`}
                  />
                </div>
                <div>
                  <label className={labelCls} htmlFor="ask-token">Token</label>
                  <input
                    id="ask-token"
                    value={cfg.token}
                    onChange={(e) => setCfg({ ...cfg, token: e.target.value })}
                    placeholder="Shown on the PC dashboard"
                    type="password"
                    className={`${inputCls} mt-1.5`}
                  />
                </div>
                <div className="flex gap-2 pt-0.5">
                  <button onClick={saveCfg} className="sd-tap h-11 flex-1 rounded-[10px] bg-paper text-[14px] font-medium text-paper-ink">
                    Save
                  </button>
                  <button onClick={() => void scanQr()} className="sd-tap flex h-11 flex-1 items-center justify-center gap-2 rounded-[10px] bg-surface-2 text-[14px] font-medium text-ink-1">
                    <ScanLine className="size-4" strokeWidth={1.75} /> Scan QR
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className={labelCls} htmlFor="ask-base">Base URL</label>
                  <input id="ask-base" value={dcfg.base} onChange={(e) => setDcfg({ ...dcfg, base: e.target.value })} className={`${inputCls} mt-1.5`} />
                </div>
                <div>
                  <label className={labelCls} htmlFor="ask-model">Model</label>
                  <input id="ask-model" value={dcfg.model} onChange={(e) => setDcfg({ ...dcfg, model: e.target.value })} placeholder="big-pickle" className={`${inputCls} mt-1.5`} />
                </div>
                <div>
                  <label className={labelCls} htmlFor="ask-key">API key</label>
                  <input id="ask-key" value={dcfg.key} onChange={(e) => setDcfg({ ...dcfg, key: e.target.value })} type="password" placeholder="Stored only on this phone" className={`${inputCls} mt-1.5`} />
                </div>
                <button onClick={saveCfg} className="sd-tap h-11 w-full rounded-[10px] bg-paper text-[14px] font-medium text-paper-ink">
                  Save
                </button>
                <p className="text-[11px] leading-relaxed text-ink-3">
                  Billed to your own key. Free options on Zen: big-pickle, space-bunny-free.
                </p>
              </>
            )}
          </div>
        )}

        <div className="mt-3 flex items-end gap-1.5 rounded-card border border-line bg-surface-1 p-1.5 pl-3">
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ask anything about your syllabus"
            rows={2}
            className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-snug text-ink-1 outline-none placeholder:text-ink-3"
          />
          <button
            onClick={() => void send()}
            disabled={busy || !q.trim()}
            className={`sd-tap grid size-10 shrink-0 place-items-center rounded-[10px] ${busy || !q.trim() ? "bg-surface-3 text-ink-3" : "bg-paper text-paper-ink"}`}
            aria-label="Send question"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
        {err && <p className="mt-2 text-[12px] leading-relaxed text-critical">{err}</p>}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-24 pt-1">
        {thread.length === 0 && (
          <EmptyState variant="ask" title="Quiet in here" hint="Ask anything about your syllabus. Bookmark an answer to keep it as a note." />
        )}
        {thread.map((e, i) => (
          <article key={e.at + "-" + i} className="sd-card-in mb-2.5 rounded-card border border-line bg-surface-1 p-4" style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}>
            <div className="flex items-start gap-3">
              <p className="flex-1 text-[15px] font-medium leading-snug">{e.q}</p>
              <button onClick={() => void saveAsNote(e)} className="sd-tap -m-1.5 grid size-8 shrink-0 place-items-center rounded-lg text-ink-3" aria-label="Save as note">
                <BookmarkPlus className="size-[17px]" strokeWidth={1.75} />
              </button>
            </div>
            <p className="tnum mt-1 text-[11px] text-ink-3">{whenStamp(e.at)}</p>
            <div className="mt-3 border-t border-line pt-3">
              <MessageRenderer content={e.a} onCitationClick={noop} sources={[]} />
            </div>
          </article>
        ))}
      </div>

      {showChats && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={() => setShowChats(false)}>
          <div className="flex max-h-[80%] flex-col rounded-t-3xl border-t border-border bg-card p-4 pb-8" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <div className="flex-1 text-[15px] font-semibold">Chats on your PC</div>
              <button onClick={() => setShowChats(false)} className="sd-tap grid size-9 place-items-center rounded-[10px] text-ink-3" aria-label="Close">
                <X className="size-[18px]" strokeWidth={1.75} />
              </button>
            </div>
            <button
              onClick={() => pickSession(null)}
              className="sd-tap flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-paper text-[14px] font-medium text-paper-ink"
            >
              <Plus className="size-4" strokeWidth={2} /> New chat
            </button>
            <div className="mt-2 overflow-y-auto">
              {sessions.length === 0 && (
                <p className="py-4 text-center text-[12px] text-ink-2">No chats on your PC yet.</p>
              )}
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => pickSession(s.id)}
                  className={`sd-tap mb-1.5 w-full rounded-card border px-3.5 py-3 text-left ${s.id === sid ? "border-brand/60 bg-brand-soft" : "border-line bg-surface-1"}`}
                >
                  <div className="truncate text-[14px] font-medium">{s.title || "Untitled chat"}</div>
                  <div className="tnum mt-0.5 text-[11px] text-ink-3">
                    {s.updated ? whenStamp(s.updated) : s.id.slice(0, 18)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
