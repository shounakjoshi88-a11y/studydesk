import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, ChevronDown, Plus, AlignLeft } from "lucide-react";
import { LocalNotifications } from "@capacitor/local-notifications";
import { EmptyState } from "../components/EmptyState";
import { listTodos, saveTodos, uid, type Todo } from "../lib/store";

export function Todos() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [time, setTime] = useState("");
  const [details, setDetails] = useState("");
  const [more, setMore] = useState(false);
  const [scope, setScope] = useState<"all" | "today">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const refresh = async () => setTodos(await listTodos());
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const persist = async (t: Todo[]) => {
    setTodos(t);
    await saveTodos(t);
  };

  const notifId = (id: string) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return Math.abs(h % 2000000000);
  };

  const scheduleNotif = async (t: Todo) => {
    try {
      if (!t.due || t.done) return;
      const when = new Date(`${t.due}T${t.time || "09:00"}:00`).getTime();
      if (when < Date.now() + 60000) return;
      await LocalNotifications.requestPermissions();
      await LocalNotifications.schedule({
        notifications: [{
          id: notifId(t.id),
          title: t.text.slice(0, 60),
          body: t.details || "Task due",
          schedule: { at: new Date(when) },
        }],
      });
    } catch { /* notifications unavailable */ }
  };

  const cancelNotif = async (id: string) => {
    try {
      await LocalNotifications.cancel({ notifications: [{ id: notifId(id) }] });
    } catch { /* noop */ }
  };

  const add = () => {
    const v = text.trim().slice(0, 200);
    if (!v) return;
    const item: Todo = {
      id: uid(), text: v, done: false, at: Date.now(),
      due: due || undefined, time: time || undefined,
      details: details.trim().slice(0, 500) || undefined,
    };
    void persist([item, ...todos]).then(() => void scheduleNotif(item));
    setText("");
    setDue("");
    setTime("");
    setDetails("");
    setMore(false);
  };

  const toggle = (id: string) => {
    const next = todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
    const changed = next.find((t) => t.id === id)!;
    void persist(next);
    if (changed.done) void cancelNotif(id);
    else void scheduleNotif(changed);
  };

  const remove = (id: string) => {
    void persist(todos.filter((t) => t.id !== id));
    void cancelNotif(id);
  };

  const doneCount = todos.filter((t) => t.done).length;
  const todayStr = new Date().toISOString().slice(0, 10);
  const sorted = [...todos]
    .filter((t) => (scope === "today" ? t.due === todayStr : true))
    .sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const at = a.due ? a.due + (a.time || "") : "";
      const bt = b.due ? b.due + (b.time || "") : "";
      if (!at && !bt) return b.at - a.at;
      if (!at) return 1;
      if (!bt) return -1;
      return at.localeCompare(bt);
    });
  const dueLabel = (d?: string) => {
    if (!d) return "";
    const [y, m, dd] = d.split("-");
    return `${dd}/${m}`;
  };
  const leftLabel = (t: Todo): string | null => {
    if (!t.due || t.done) return null;
    const when = new Date(`${t.due}T${t.time || "23:59"}:00`).getTime();
    const diff = when - Date.now();
    if (diff <= 0) return "Overdue";
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `in ${hrs}h ${mins % 60}m`;
    return `in ${Math.floor(hrs / 24)}d`;
  };

  return (
    <div className="relative flex flex-col h-full">
      <div className="px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-1 shrink-0">
        <h2 className="text-xl font-semibold tracking-tight">To-dos</h2>
        <p className="tnum mt-1 text-[12px] text-ink-2">
          {todos.length === 0 ? "Anything to get done?" : `${doneCount} of ${todos.length} done`}
        </p>
        {/* The bar and the line above say the same thing on purpose — one
            reads as progress at a glance, the other stays screen-readable. */}
        {todos.length > 0 && (
          <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.round((doneCount / todos.length) * 100)}%`,
                background: "var(--brand)",
                transition: "width var(--dur-3) var(--ease-out)",
              }}
            />
          </div>
        )}

        {/* One plate for the whole "add a task" act, the way Ask frames its
            question box. The primary commit is the paper button, and it only
            lights up when there is something to add. */}
        <div className="mt-3 rounded-card border border-line bg-surface-1 p-1.5 pl-3">
          <div className="flex items-center gap-1.5">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="New task, e.g. Revise subnetting"
              className="h-11 min-w-0 flex-1 bg-transparent text-[15px] text-ink-1 outline-none placeholder:text-ink-3"
            />
            <button
              onClick={add}
              disabled={!text.trim()}
              className={`sd-tap grid size-10 shrink-0 place-items-center rounded-[10px] ${text.trim() ? "bg-paper text-paper-ink" : "bg-surface-3 text-ink-3"}`}
              aria-label="Add task"
            >
              <Plus className="size-[18px]" strokeWidth={2} />
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              aria-label="Due date"
              className="h-10 min-w-0 flex-1 rounded-[10px] border border-line bg-surface-2 px-2.5 text-[12px] text-ink-2 outline-none focus:border-brand"
            />
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-label="Due time"
              className="h-10 min-w-0 flex-1 rounded-[10px] border border-line bg-surface-2 px-2.5 text-[12px] text-ink-2 outline-none focus:border-brand"
            />
            <button
              onClick={() => setMore(!more)}
              aria-pressed={more}
              className={`sd-tap flex h-10 shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 text-[12px] font-medium ${more ? "bg-brand-soft text-brand-ink" : "bg-surface-2 text-ink-2"}`}
            >
              <AlignLeft className="size-3.5" strokeWidth={1.75} /> Details
            </button>
          </div>
          {more && (
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Details: room no, pages to read, links…"
              rows={2}
              className="mt-1.5 w-full resize-none rounded-[10px] border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink-1 outline-none focus:border-brand"
            />
          )}
        </div>

        <div className="mt-3 flex rounded-[12px] bg-surface-2 p-1" role="tablist" aria-label="Which tasks to show">
          {(["all", "today"] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={scope === s}
              onClick={() => setScope(s)}
              className={`sd-tap h-9 flex-1 rounded-[9px] text-[13px] font-medium ${scope === s ? "bg-surface-3 text-ink-1" : "text-ink-3"}`}
            >
              {s === "all" ? "All tasks" : "Today only"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-24 pt-1">
        {todos.length === 0 ? (
          <EmptyState variant="todos" title="All clear" hint="Add your first task above — a date and time get you a reminder." />
        ) : sorted.length === 0 ? (
          <div className="mt-16 text-center">
            <p className="text-[13px] text-ink-2">Nothing due today.</p>
            <button onClick={() => setScope("all")} className="sd-tap mt-2 text-[13px] font-medium" style={{ color: "var(--brand-ink)" }}>
              Show all tasks
            </button>
          </div>
        ) : (
          sorted.map((t, i) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.24) }}
              className="mb-2 flex items-center gap-3 rounded-card border border-line bg-surface-1 px-3.5 py-3"
            >
              {/* 22px of ink inside a 36px target — the circle stays light,
                  the finger does not have to be. */}
              <button
                onClick={() => toggle(t.id)}
                aria-label={t.done ? "Mark open" : "Mark done"}
                className="sd-tap -m-1 flex size-9 shrink-0 items-center justify-center rounded-full"
              >
                <span className={`flex size-[22px] items-center justify-center rounded-full border-2 transition-colors ${t.done ? "border-brand bg-brand" : "border-line-strong"}`}>
                  {t.done && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2.5 6.5 L5 9 L9.5 3.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
              </button>
              <div
                className="sd-tap min-w-0 flex-1"
                onClick={() => setExpanded(expanded === t.id ? null : t.id)}
              >
                <p className={`text-[15px] leading-snug ${t.done ? "line-through text-ink-3" : ""}`}>
                  {t.text}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {t.due && (
                    <motion.span
                      key={leftLabel(t) || "nodue"}
                      initial={{ opacity: 0.4 }}
                      animate={{ opacity: 1 }}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${!t.done && t.due < todayStr ? "bg-[var(--att-critical)]/15 text-critical" : "bg-surface-3 text-ink-2"}`}
                    >
                      {leftLabel(t) || `Due ${dueLabel(t.due)}`}
                    </motion.span>
                  )}
                  {t.time && <span className="text-[11px] text-ink-3">at {t.time}</span>}
                  {t.details && (
                    <span className="flex items-center gap-0.5 text-[11px] text-ink-3">
                      <ChevronDown className={`size-3 transition-transform ${expanded === t.id ? "rotate-180" : ""}`} /> note
                    </span>
                  )}
                </div>
                {expanded === t.id && t.details && (
                  <motion.p
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    className="mt-1.5 overflow-hidden text-[12px] leading-relaxed text-ink-2 whitespace-pre-wrap"
                  >
                    {t.details}
                  </motion.p>
                )}
              </div>
              <button onClick={() => remove(t.id)} className="sd-tap grid size-9 shrink-0 place-items-center rounded-lg text-ink-3" aria-label="Delete task">
                <X className="size-4" />
              </button>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}
