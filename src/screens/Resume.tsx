import { useEffect, useState } from "react";
import { Plus, Trash2, X, Download, ChevronLeft, ChevronRight, Check } from "lucide-react";
import {
  EMPTY_RESUME, SAMPLE_RESUME, RESUME_TEMPLATES,
  resumeToPdf, resumeToDocx, type ResumeData, type ResumeTemplate,
} from "../lib/resume";
import { addFile } from "../lib/store";

const inputCls = "w-full px-3 py-2 rounded-card bg-surface-2 border border-line text-sm outline-none focus:border-brand";
const labelCls = "text-[11px] uppercase tracking-wider text-ink-2 font-semibold";
const RKEY = "sd_resume";

function loadResume(): ResumeData {
  try {
    const v = JSON.parse(localStorage.getItem(RKEY) || "null");
    if (v && typeof v === "object") return { ...EMPTY_RESUME, ...v };
  } catch { /* fresh */ }
  return { ...EMPTY_RESUME, education: [], experience: [], projects: [] };
}

function MiniTemplate({ t, selected }: { t: ResumeTemplate; selected: boolean }) {
  const acc = `rgb(${t.accent.map((v) => Math.round(v * 255)).join(",")})`;
  return (
    <div className={`sd-press rounded-card border overflow-hidden ${selected ? "border-brand" : "border-line"}`}>
      <div className="h-20 bg-white p-2 flex gap-1.5">
        {t.header === "sidebar" ? (
          <>
            <div className="w-1/3 rounded" style={{ background: acc }} />
            <div className="flex-1 space-y-1 pt-1">
              <div className="h-2 rounded bg-neutral-300 w-4/5" />
              <div className="h-1.5 rounded bg-neutral-200" />
              <div className="h-1.5 rounded bg-neutral-200 w-3/5" />
            </div>
          </>
        ) : (
          <div className="flex-1">
            {t.header === "bar" && <div className="h-5 rounded-sm mb-1.5" style={{ background: acc }} />}
            <div
              className={`h-2.5 rounded mb-1.5 ${t.header === "center" ? "mx-auto" : ""}`}
              style={{ width: t.header === "center" ? "60%" : "75%", background: t.header === "bar" ? "#d4d4d4" : acc }}
            />
            <div className="h-1.5 rounded bg-neutral-200 mb-1" />
            <div className="h-1.5 rounded bg-neutral-200 w-4/5 mb-1" />
            {t.rule && <div className="h-px my-1" style={{ background: acc }} />}
            <div className="h-1.5 rounded bg-neutral-200 w-3/5" />
          </div>
        )}
      </div>
      <div className={`px-2.5 py-2 ${selected ? "bg-brand-soft" : "bg-surface-1"}`}>
        <div className="text-xs font-semibold flex items-center gap-1">
          {t.name}
          {selected && <Check className="size-3.5 text-brand" />}
        </div>
        <div className="text-[11px] text-ink-2">{t.blurb}</div>
      </div>
    </div>
  );
}

function Preview({ d, t }: { d: ResumeData; t: ResumeTemplate }) {
  const acc = `rgb(${t.accent.map((v) => Math.round(v * 255)).join(",")})`;
  const center = t.header === "center";
  const contact = [d.email, d.phone, d.location, d.links].filter((s) => s.trim()).join("  |  ");
  const secStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: 1,
    color: acc,
    borderBottom: t.rule ? `1.5px solid ${acc}` : "none",
    paddingBottom: t.rule ? 3 : 0,
    margin: "12px 0 6px",
  };
  const body = (
    <div className="text-[11px] leading-relaxed text-neutral-800">
      {d.summary.trim() && (
        <>
          <div style={secStyle}>Summary</div>
          <p>{d.summary}</p>
        </>
      )}
      {d.experience.length > 0 && (
        <>
          <div style={secStyle}>Experience</div>
          {d.experience.map((e, i) => (
            <div key={i} className="mb-1.5">
              <p className="font-bold">{e.role}{e.org ? ` — ${e.org}` : ""} <span className="font-normal text-neutral-500">{e.period}</span></p>
              <p className="whitespace-pre-line">{e.detail}</p>
            </div>
          ))}
        </>
      )}
      {d.education.length > 0 && (
        <>
          <div style={secStyle}>Education</div>
          {d.education.map((e, i) => (
            <div key={i} className="mb-1.5">
              <p className="font-bold">{e.degree}{e.school ? ` — ${e.school}` : ""} <span className="font-normal text-neutral-500">{e.year}</span></p>
              {e.detail.trim() && <p>{e.detail}</p>}
            </div>
          ))}
        </>
      )}
      {d.projects.length > 0 && (
        <>
          <div style={secStyle}>Projects</div>
          {d.projects.map((p, i) => (
            <div key={i} className="mb-1.5">
              <p className="font-bold">{p.name}</p>
              {p.detail.trim() && <p>{p.detail}</p>}
            </div>
          ))}
        </>
      )}
      {d.skills.trim() && (
        <>
          <div style={secStyle}>Skills</div>
          <p>{d.skills}</p>
        </>
      )}
    </div>
  );
  if (t.header === "sidebar") {
    return (
      <div className="bg-white rounded-xl overflow-hidden flex">
        <div className="w-1/3 p-3 text-white" style={{ background: "#23232b" }}>
          <p className="font-bold text-sm leading-tight">{d.name || "Your Name"}</p>
          <p className="text-[11px] mt-1 opacity-80">{d.title}</p>
          <p className="text-[11px] mt-2 whitespace-pre-line opacity-80">{[d.email, d.phone, d.location].filter((s) => s.trim()).join("\n")}</p>
        </div>
        <div className="flex-1 p-3">{body}</div>
      </div>
    );
  }
  return (
    <div className="bg-white rounded-xl p-4">
      {t.header === "bar" && (
        <div className="rounded-lg p-3 mb-2" style={{ background: acc }}>
          <p className="font-bold text-white text-base">{d.name || "Your Name"}</p>
          <p className="text-white text-[11px] opacity-90">{d.title}</p>
        </div>
      )}
      {t.header !== "bar" && (
        <div style={{ textAlign: center ? "center" : "left" }}>
          <p className="font-bold text-neutral-900" style={{ fontSize: 19 }}>{d.name || "Your Name"}</p>
          {d.title.trim() && <p className="text-[11px] text-neutral-600">{d.title}</p>}
            {contact && <p className="text-[11px] text-neutral-500 mt-0.5">{contact}</p>}
          {t.rule && <div className="h-px my-2" style={{ background: acc }} />}
        </div>
      )}
      {body}
    </div>
  );
}

export function Resume({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<ResumeData>(() => loadResume());
  const [step, setStep] = useState(0);
  const [tplId, setTpl] = useState("modern");
  const [msg, setMsg] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    localStorage.setItem(RKEY, JSON.stringify(d));
  }, [d]);

  const set = (p: Partial<ResumeData>) => setD({ ...d, ...p });
  const tpl = RESUME_TEMPLATES.find((t) => t.id === tplId) || RESUME_TEMPLATES[0]!;

  const exportAs = async (kind: "pdf" | "docx") => {
    const base = (d.name.trim() || "resume").replace(/[\\/:*?"<>|]/g, "").slice(0, 50) || "resume";
    setWorking(true);
    setMsg(null);
    try {
      const data = kind === "pdf" ? await resumeToPdf(d, tpl) : await resumeToDocx(d, tpl);
      const meta = await addFile(`${base}-resume.${kind}`, data);
      setMsg(`Saved to Files: ${meta.name}`);
    } catch (e) {
      setMsg(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setWorking(false);
    }
  };

  const listEditor = <T extends object>(
    title: string,
    items: T[],
    blank: T,
    render: (item: T, i: number, update: (patch: Partial<T>) => void) => React.ReactNode
  ) => (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[11px] uppercase tracking-wider text-ink-2 font-semibold flex-1">{title}</div>
        <button
          onClick={() => setD({ ...d, ...{ [title.toLowerCase()]: [...(items as any[]), { ...blank }] } } as any)}
          className="text-[11px] font-bold text-brand"
        >
          + Add
        </button>
      </div>
      {(items as any[]).map((item: any, i: number) => (
        <div key={i} className="sd-card-in bg-surface-1 border border-line rounded-card p-3 mb-2">
          {render(item, i, (patch) => {
            const next = (items as any[]).map((x: any, j: number) => (j === i ? { ...x, ...patch } : x));
            setD({ ...d, ...{ [title.toLowerCase()]: next } } as any);
          })}
          <button
            onClick={() => setD({ ...d, ...{ [title.toLowerCase()]: (items as any[]).filter((_, j) => j !== i) } } as any)}
            className="mt-1.5 flex items-center gap-1 text-[11px] text-critical font-semibold"
          >
            <Trash2 className="size-3.5" /> Remove
          </button>
        </div>
      ))}
    </div>
  );

  const small = (value: string, onChange: (v: string) => void, placeholder: string) => (
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`${inputCls} mb-1.5`} />
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="px-4 pb-2 shrink-0 border-b border-line pt-[max(30px,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <div className="text-sm font-semibold">Resume maker</div>
            <div className="text-[11px] text-ink-2">
              {step === 0 ? "Step 1 of 3 · Details" : step === 1 ? "Step 2 of 3 · Template" : "Step 3 of 3 · Export"}
            </div>
          </div>
          <button onClick={onClose} className="sd-press p-2 rounded-xl hover:bg-surface-3" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="flex gap-1.5 mt-2">
          {["Details", "Template", "Export"].map((s, i) => (
            <button
              key={s}
              onClick={() => setStep(i)}
              className={`sd-press flex-1 py-1.5 rounded-card text-[11px] font-bold ${step === i ? "bg-brand text-background" : step > i ? "bg-brand-soft text-brand-ink" : "bg-surface-3 text-ink-3"}`}
            >
              {i + 1}. {s}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 pb-6">
        {step === 0 && (
          <>
            <div className="text-[11px] uppercase tracking-wider text-ink-2 font-semibold mb-1.5">Personal</div>
            {small(d.name, (v) => set({ name: v }), "Full name")}
            {small(d.title, (v) => set({ title: v }), "Headline, e.g. CS Undergraduate")}
            <div className="flex gap-1.5">
              <div className="flex-1">{small(d.email, (v) => set({ email: v }), "Email")}</div>
              <div className="flex-1">{small(d.phone, (v) => set({ phone: v }), "Phone")}</div>
            </div>
            {small(d.location, (v) => set({ location: v }), "City")}
            {small(d.links, (v) => set({ links: v }), "Links: github, linkedin")}
            <div className="text-[11px] uppercase tracking-wider text-ink-2 font-semibold mt-3 mb-1.5">Summary</div>
            <textarea value={d.summary} onChange={(e) => set({ summary: e.target.value })} rows={3} placeholder="Two lines about you" className={`${inputCls} resize-none mb-3`} />
            {listEditor("education", d.education, { school: "", degree: "", year: "", detail: "" }, (e, _i, u) => (
              <>
                {small(e.school, (v) => u({ school: v }), "College")}
                {small(e.degree, (v) => u({ degree: v }), "Degree")}
                <div className="flex gap-1.5">
                  <div className="flex-1">{small(e.year, (v) => u({ year: v }), "Years")}</div>
                </div>
                <textarea value={e.detail} onChange={(ev) => u({ detail: ev.target.value })} rows={2} placeholder="CGPA, coursework" className={`${inputCls} resize-none`} />
              </>
            ))}
            {listEditor("experience", d.experience, { role: "", org: "", period: "", detail: "" }, (e, _i, u) => (
              <>
                {small(e.role, (v) => u({ role: v }), "Role")}
                <div className="flex gap-1.5">
                  <div className="flex-1">{small(e.org, (v) => u({ org: v }), "Org")}</div>
                  <div className="flex-1">{small(e.period, (v) => u({ period: v }), "Period")}</div>
                </div>
                <textarea value={e.detail} onChange={(ev) => u({ detail: ev.target.value })} rows={2} placeholder="One point per line" className={`${inputCls} resize-none`} />
              </>
            ))}
            {listEditor("projects", d.projects, { name: "", detail: "" }, (e, _i, u) => (
              <>
                {small(e.name, (v) => u({ name: v }), "Project name")}
                <textarea value={e.detail} onChange={(ev) => u({ detail: ev.target.value })} rows={2} placeholder="What it does" className={`${inputCls} resize-none`} />
              </>
            ))}
            <div className="text-[11px] uppercase tracking-wider text-ink-2 font-semibold mb-1.5">Skills</div>
            <textarea value={d.skills} onChange={(e) => set({ skills: e.target.value })} rows={2} placeholder="Python, Java, React…" className={`${inputCls} resize-none`} />
            <button
              onClick={() => setD({ ...SAMPLE_RESUME })}
              className="sd-press w-full mt-3 py-2.5 rounded-card bg-surface-3 text-xs font-semibold"
            >
              Load sample data to try
            </button>
          </>
        )}

        {step === 1 && (
          <div className="grid grid-cols-2 gap-2">
            {RESUME_TEMPLATES.map((t) => (
              <button key={t.id} onClick={() => setTpl(t.id)} className="text-left">
                <MiniTemplate t={t} selected={t.id === tplId} />
              </button>
            ))}
          </div>
        )}

        {step === 2 && (
          <>
            <Preview d={d} t={tpl} />
            <div className="flex gap-2 mt-3">
              <button onClick={() => void exportAs("pdf")} disabled={working} className="sd-press flex-1 py-3 rounded-card bg-brand text-background text-sm font-semibold disabled:opacity-50">
                Export PDF
              </button>
              <button onClick={() => void exportAs("docx")} disabled={working} className="sd-press flex-1 py-3 rounded-card bg-surface-3 text-sm font-semibold disabled:opacity-50">
                Export DOCX
              </button>
            </div>
            {msg && <p className="text-xs text-ink-2 mt-2">{msg}</p>}
          </>
        )}
      </div>

      <div className="p-3 flex gap-2 shrink-0 border-t border-line" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <button
          onClick={() => setStep(Math.max(0, step - 1))}
          disabled={step === 0}
          className="sd-press flex items-center gap-1 px-4 py-3 rounded-card bg-surface-3 text-sm font-semibold disabled:opacity-40"
        >
          <ChevronLeft className="size-4" /> Back
        </button>
        <button
          onClick={() => setStep(Math.min(2, step + 1))}
          disabled={step === 2}
          className="sd-press flex-1 flex items-center justify-center gap-1 py-3 rounded-card bg-brand text-background text-sm font-semibold disabled:opacity-40"
        >
          Next <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
