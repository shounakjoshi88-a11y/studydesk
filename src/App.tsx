import { useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useTransform, animate } from "framer-motion";
import { Menu } from "lucide-react";
import { IconAsk, IconFiles, IconNotes, IconTools, IconTodos } from "./components/NavIcons";
import { StatusBar } from "@capacitor/status-bar";
import { Capacitor } from "@capacitor/core";
import { processIncoming } from "./lib/incoming";
import { Notes } from "./screens/Notes";
import { Files } from "./screens/Files";
import { Ask } from "./screens/Ask";
import { Todos } from "./screens/Todos";
import { Campus } from "./screens/Campus";
import { Tools } from "./screens/Tools";
import { OcrTest } from "./screens/OcrTest";
import { initStore, saveNote, uid, listNotes, listPinnedTasks } from "./lib/store";
import { refreshPinned } from "./lib/pinned";

import cramRaw from "./seed/module-1-lab-cram.md?raw";
import testRaw from "./seed/module-1-test-10marks.md?raw";
import cheatRaw from "./seed/jncia-junos-cheat-sheet.md?raw";

type Tab = "notes" | "files" | "ask" | "todos" | "tools";

async function seedOnce() {
  if (localStorage.getItem("sd_seeded") === "1") return;
  await initStore();
  const existing = await listNotes();
  if (existing.length === 0) {
    const seeds: Array<[string, string]> = [
      ["Module 1 Lab Cram", cramRaw],
      ["Module 1 Mock Test (10 marks)", testRaw],
      ["JNCIA-Junos Cheat Sheet", cheatRaw],
    ];
    for (const [title, body] of seeds) {
      await saveNote({ id: uid(), title, folder: "JNCIA", updatedAt: Date.now() }, body);
    }
  }
  localStorage.setItem("sd_seeded", "1");
}

export function openDrawer() {
  window.dispatchEvent(new Event("sd-drawer"));
}

export default function App() {
  const [tab, setTab] = useState<Tab>("notes");
  const [drawer, setDrawer] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // TEMP-OCRTEST: remove before release
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("ocrtest")) {
    return (
      <div className="dark flex flex-col h-full bg-background text-foreground">
        <OcrTest />
      </div>
    );
  }
  // The panel is w-full, so its real width is the viewport's. A hardcoded
  // 400 made every drag threshold a guess: on a narrow phone it was
  // roughly right by accident, and on anything wider the drawer would stop
  // short of the edge instead of leaving cleanly.
  const [panelW, setPanelW] = useState(400);
  useEffect(() => {
    const measure = () => setPanelW(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  const mx = useMotionValue(-panelW);
  const backdrop = useTransform(mx, [-panelW, 0], [0, 0.6]);
  // One spring for both directions. A tween in, a different tween out, and
  // a third spring for the snap-back is how a drawer ends up feeling like
  // three different panels; this way a flick, a slow drag and a tap all
  // land on the same curve.
  const SNAP = { type: "spring", stiffness: 520, damping: 44, mass: 0.9 } as const;
  /** Released past this much open, the drawer commits to fully open. */
  const OPEN_AT = 0.8;
  /** Released below this much open, it commits shut. */
  const CLOSE_AT = 0.3;
  const drag = useRef<{
    x0: number;
    y0: number;
    base: number;
    mode: "edge" | "panel" | null;
    t: number;
    x: number;
  }>({ x0: 0, y0: 0, base: -panelW, mode: null, t: 0, x: 0 });

  const openDrawer = () => {
    setDrawer(true);
    animate(mx, 0, SNAP);
  };
  const closeDrawer = () => {
    animate(mx, -panelW, { ...SNAP, onComplete: () => setDrawer(false) });
  };
  /**
   * Where a released drag lands. The drawer only has two resting states, and
   * this is the only thing that decides between them.
   *
   * Two dead zones do the work the user actually asked for: let go past 80%
   * open and it commits to fully open, let go under 30% and it commits shut,
   * and anything between snaps to whichever end is nearer. There is no width
   * of the gesture that leaves the drawer parked halfway, which is what made
   * it feel like it could get stuck.
   *
   * Velocity still overrides the distance, in both directions, because a
   * short fast flick is how people really open and close a drawer and it
   * never travels far enough to cross a threshold on its own.
   */
  const settle = (velocity: number) => {
    const shown = Math.min(1, Math.max(0, (mx.get() + panelW) / panelW));
    const quick = Math.abs(velocity) > 0.45; // px per ms
    const open = quick
      ? velocity > 0
      : shown >= OPEN_AT
        ? true
        : shown <= CLOSE_AT
          ? false
          : shown > 0.5;
    if (open) animate(mx, 0, SNAP);
    else closeDrawer();
  };

  useEffect(() => {
    document.documentElement.classList.add("dark");
    try {
      void StatusBar.setOverlaysWebView({ overlay: false });
    } catch {
      /* web fallback: CSS safe-area handles it */
    }
    const h = (e: Event) => {
      const tab = (e as CustomEvent).detail?.tab;
      if (typeof tab === "string") setTab(tab as Tab);
    };
    const d = () => openDrawer();
    // Notes reports whether a note is open so the dock can step out of the way.
    // Same window-event channel as the tab and drawer signals above, rather
    // than lifting the editor's state up here.
    const ed = (e: Event) => setEditorOpen(Boolean((e as CustomEvent).detail?.open));
    window.addEventListener("sd-tab", h);
    window.addEventListener("sd-drawer", d);
    window.addEventListener("sd-editor", ed);
    // Seeding first, then the share intake: saveNote is a read-modify-write
    // of the notes index, and on a first-ever launch both would race it.
    void seedOnce().then(() => processIncoming());
    void listPinnedTasks().then((t) => refreshPinned(t.filter((x) => x.pinned)));
    // Files shared into the app while it is already running arrive as a new
    // intent; the app coming back to the foreground is when they land.
    let removeAppState: (() => void) | undefined;
    if (Capacitor.isNativePlatform()) {
      void import("@capacitor/app").then(async ({ App }) => {
        const hnd = await App.addListener("appStateChange", (s) => {
          if (s.isActive) void processIncoming();
        });
        removeAppState = () => void hnd.remove();
      });
    }
    return () => {
      window.removeEventListener("sd-tab", h);
      window.removeEventListener("sd-drawer", d);
      window.removeEventListener("sd-editor", ed);
      removeAppState?.();
    };
  }, []);

  const onMainTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]!;
    if (!drawer && t.clientX < 44) {
      drag.current = { x0: t.clientX, y0: t.clientY, base: -panelW, mode: "edge", t: performance.now(), x: t.clientX };
    }
  };
  const onMainTouchMove = (e: React.TouchEvent) => {
    const d = drag.current;
    if (d.mode !== "edge") return;
    const t = e.touches[0]!;
    const dx = t.clientX - d.x0;
    const dy = t.clientY - d.y0;
    if (Math.abs(dy) > Math.abs(dx) * 1.1) {
      d.mode = null;
      return;
    }
    d.x = t.clientX;
    d.t = performance.now();
    if (dx > 10 && !drawer) setDrawer(true);
    if (drawer) mx.set(Math.min(0, -panelW + Math.max(0, dx)));
  };
  const onMainTouchEnd = () => {
    const d = drag.current;
    if (d.mode !== "edge") return;
    d.mode = null;
    // Same snap as the panel drag, so an opening swipe that stops short
    // resolves the same way a closing one does instead of having its own idea
    // about what counts as open enough. Rightward is positive here too, so a
    // flick toward opening reads as "open" in both gestures.
    const dt = performance.now() - d.t;
    const vx = dt > 0 ? (d.x - d.x0) / dt : 0;
    settle(vx);
  };
  // A cancelled gesture (an incoming call, the system stealing the touch)
  // never reaches onTouchEnd, so without this the panel stays wherever the
  // finger happened to be — the one case that really can strand it open.
  const onMainTouchCancel = () => {
    if (drag.current.mode === "edge") settle(0);
    drag.current.mode = null;
  };

  // A drag that starts inside a horizontally scrollable strip (the Campus
  // tab bar) belongs to that strip, not to the drawer. Without this, swiping
  // to reach "Pinned" yanked the whole sidebar sideways.
  const inHScroll = (t: EventTarget | null) =>
    t instanceof Element && Boolean(t.closest("[data-hscroll]"));

  const onPanelTouchStart = (e: React.TouchEvent) => {
    if (inHScroll(e.target)) {
      drag.current = { x0: 0, y0: 0, base: 0, mode: null, t: 0, x: 0 };
      return;
    }
    const t = e.touches[0]!;
    drag.current = { x0: t.clientX, y0: t.clientY, base: mx.get(), mode: "panel", t: performance.now(), x: t.clientX };
  };
  const onPanelTouchMove = (e: React.TouchEvent) => {
    const d = drag.current;
    if (d.mode !== "panel") return;
    const t = e.touches[0]!;
    const dx = t.clientX - d.x0;
    const dy = t.clientY - d.y0;
    if (Math.abs(dy) > Math.abs(dx) * 1.1) {
      d.mode = null;
      return;
    }
    d.x = t.clientX;
    d.t = performance.now();
    // Never past the edge: a rightward drag on an open drawer should feel
    // like it is at its limit, not like it can be pushed further open.
    mx.set(Math.min(0, d.base + dx));
  };
  const onPanelTouchEnd = () => {
    const d = drag.current;
    if (d.mode !== "panel") return;
    d.mode = null;
    const dt = performance.now() - d.t;
    const vx = dt > 0 ? (d.x - d.x0) / dt : 0;
    settle(vx);
  };
  const onPanelTouchCancel = () => {
    if (drag.current.mode === "panel") settle(0);
    drag.current.mode = null;
  };

  const tabs: Array<{ id: Tab; label: string; icon: () => React.ReactElement }> = [
    { id: "notes", label: "Notes", icon: IconNotes },
    { id: "files", label: "Files", icon: IconFiles },
    { id: "tools", label: "Tools", icon: IconTools },
    { id: "ask", label: "Ask", icon: IconAsk },
    { id: "todos", label: "To-dos", icon: IconTodos },
  ];

  return (
    <div className="dark flex flex-col h-full bg-background text-foreground">
      {tab === "notes" && (
        <header className="flex items-center gap-1 px-2 pb-2 shrink-0 pt-[max(1rem,env(safe-area-inset-top))]">
          {/* The edge swipe is a lovely gesture and a terrible only option —
              it fails the moment a system back-gesture or a screen edge
              gets in the way, and then Campus is simply unreachable. The
              title row is where the app's other entry points live, so the
              button belongs here rather than floating over the content. */}
          <button
            onClick={openDrawer}
            className="flex size-11 shrink-0 items-center justify-center rounded-xl"
            style={{ color: "var(--ink-2)" }}
            aria-label="Open Campus"
            title="Campus"
          >
            <Menu className="size-5" />
          </button>
          <h1 className="text-lg font-semibold tracking-tight">StudyDesk</h1>
        </header>
      )}

      <main
        className="flex-1 min-h-0"
        onTouchStart={onMainTouchStart}
        onTouchMove={onMainTouchMove}
        onTouchEnd={onMainTouchEnd}
        onTouchCancel={onMainTouchCancel}
      >
        {tab === "notes" && <Notes key="notes" />}
        {tab === "files" && <Files key="files" />}
        {tab === "tools" && <Tools key="tools" />}
        {tab === "ask" && <Ask key="ask" />}
        {tab === "todos" && <Todos key="todos" />}
      </main>

      {/* Hidden while a note is open. The editor is a focused mode, and a tab
          bar offering to leave it — over unsaved work — is the wrong thing to
          spend the last 60px of a screen on. */}
      {!editorOpen && (
        <nav className="sd-glass sd-dock mx-3 mb-3 flex shrink-0" style={{ marginBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                onContextMenu={(e) => {
                  // Long-pressing Files is the shortcut to the source switcher,
                  // which keeps a whole row of tabs off the Files screen. A
                  // long press alone is an invisible gesture, so the Files
                  // header also shows the current source as a tap target;
                  // this is the fast path, not the only path.
                  if (t.id !== "files") return;
                  e.preventDefault();
                  window.dispatchEvent(new CustomEvent("sd-files-switch"));
                }}
                aria-current={active ? "page" : undefined}
                aria-label={t.id === "files" ? "Files. Long press to change where files come from" : undefined}
                className="sd-press flex-1 flex flex-col items-center gap-1 py-2.5"
                style={{ color: active ? "var(--brand)" : "var(--ink-3)" }}
              >
                {/* The active item gets a plate of its own, so it is marked by
                    shape as well as by colour and weight — and the circle is
                    what makes five icons read as one object. */}
                <span
                  className="size-9 rounded-full flex items-center justify-center"
                  style={{ background: active ? "var(--brand-soft)" : "transparent" }}
                >
                  <Icon />
                </span>
                <span className={`text-[11px] leading-none ${active ? "font-semibold" : "font-medium"}`}>
                  {t.label}
                </span>
              </button>
            );
          })}
        </nav>
      )}

      {drawer && (
        <div className="fixed inset-0 z-50">
          {/* No scrim. The panel itself is the affordance, and a dimmed
              half-visible screen behind it just reads as a glitch. */}
          <motion.div
            className="absolute inset-0"
            style={{ opacity: backdrop }}
            onClick={closeDrawer}
          />
          <motion.aside
            style={{ x: mx }}
            className="absolute left-0 top-0 bottom-0 w-full bg-background flex flex-col"
            onTouchStart={onPanelTouchStart}
            onTouchMove={onPanelTouchMove}
            onTouchEnd={onPanelTouchEnd}
            onTouchCancel={onPanelTouchCancel}
          >
            {/* Campus owns the whole panel now, title and close button
                together on one line. The drawer used to print its own
                chrome row above it, which stranded the X. */}
            <div className="min-h-0 flex-1">
              <Campus key="campus-drawer" onClose={closeDrawer} />
            </div>
          </motion.aside>
        </div>
      )}
    </div>
  );
}
