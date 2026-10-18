/**
 * Tool mascots — 64×48 tiles, one per tool.
 *
 * Motion budget: ONE loop, the eye blink, implemented in CSS (.sd-blink)
 * so prefers-reduced-motion kills it without any JS branching. No body
 * float, no wing flutter, no bubble loops, no opacity pulses — decoration
 * that loops forever reads as noise, not as character.
 *
 * Colours come from the token set in index.css so a mascot can never
 * drift from the app's surfaces and ink.
 */

const INK = "var(--ink-1)";
const SOFT = "var(--surface-3)";
const FUR = "var(--surface-2)";
const VIOLET = "var(--brand)";
const LIGHT = "var(--brand-ink)";
const AMBER = "var(--att-caution)";
const GREEN = "var(--att-safe)";
const PINK = "var(--att-risk)";
const CARD = "var(--surface-1)";

/** Blink-only eyes. Left/right staggered 0.1s so the pair never syncs. */
function Eyes({ cx, cy, dx = 7, delay = 0 }: { cx: number; cy: number; dx?: number; delay?: number }) {
  return (
    <g>
      {[cx - dx, cx + dx].map((x, i) => (
        <ellipse
          key={i}
          cx={x}
          cy={cy}
          rx="2.6"
          ry="3.4"
          fill={INK}
          className="sd-blink"
          style={{ animationDelay: `${delay + i * 0.1}s` }}
        />
      ))}
    </g>
  );
}

function Turtle() {
  return (
    <g>
      <g>
        <path d="M12 40 Q12 22 36 22 Q60 22 60 40 Z" fill="#3f7d5d" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        <path d="M28 24 L36 38 M44 24 L44 38 M52 28 L48 38" stroke={INK} strokeWidth="1.4" opacity="0.6" />
        <circle cx="62" cy="36" r="8" fill="#4c9a6f" stroke={INK} strokeWidth="2" />
        <ellipse cx="64" cy="34" rx="1.8" ry="1.8" fill={INK} className="sd-blink" />
        <path d="M8 42 Q4 44 6 48" stroke="#4c9a6f" strokeWidth="4" fill="none" strokeLinecap="round" />
      </g>
      <ellipse cx="36" cy="50" rx="26" ry="3.5" fill={SOFT} opacity="0.7" />
    </g>
  );
}

function Owl() {
  return (
    <g>
      <ellipse cx="36" cy="30" rx="15" ry="17" fill={FUR} stroke={INK} strokeWidth="2" />
      <path d="M24 18 L21 8 L31 14 Z M48 18 L51 8 L41 14 Z" fill={FUR} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <circle cx="30" cy="28" r="6" fill="#fff" />
      <circle cx="42" cy="28" r="6" fill="#fff" />
      <g>
        <circle cx="30" cy="28" r="2.6" fill="#101014" />
        <circle cx="42" cy="28" r="2.6" fill="#101014" />
      </g>
      <path d="M33 36 L39 36 L36 39 Z" fill={AMBER} />
      <path d="M20 34 Q12 38 14 46 M52 34 Q60 38 58 46" stroke={FUR} strokeWidth="5" fill="none" strokeLinecap="round" />
    </g>
  );
}

function Rabbit() {
  return (
    <g>
      <ellipse cx="48" cy="14" rx="5" ry="13" fill={FUR} stroke={INK} strokeWidth="2" />
      <ellipse cx="34" cy="16" rx="5" ry="12" fill={FUR} stroke={INK} strokeWidth="2" />
      <ellipse cx="34" cy="16" rx="2" ry="7" fill={LIGHT} opacity="0.8" />
      <circle cx="36" cy="38" r="13" fill={FUR} stroke={INK} strokeWidth="2" />
      <Eyes cx={36} cy={37} dx={5.5} />
      <path d="M34 43 L38 43 L36 45 Z" fill={LIGHT} />
      <ellipse cx="36" cy="52" rx="14" ry="4" fill={FUR} />
      <circle cx="62" cy="48" r="3.5" fill="#fff" opacity="0.9" />
    </g>
  );
}

function Fox() {
  return (
    <g>
      <path d="M8 44 Q22 46 30 36 Q24 48 12 50 Z" fill="#c96a2e" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <circle cx="44" cy="32" r="15" fill="#c96a2e" stroke={INK} strokeWidth="2" />
      <path d="M32 22 L29 10 L41 18 Z M56 22 L59 10 L47 18 Z" fill="#c96a2e" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <ellipse cx="44" cy="40" rx="8" ry="6" fill="#fff" opacity="0.95" />
      <Eyes cx={44} cy={29} dx={6} />
      <circle cx="44" cy="37" r="2.4" fill="#101014" />
    </g>
  );
}

function Squirrel() {
  return (
    <g>
      <path d="M52 48 Q66 40 62 24 Q60 14 50 16 Q58 24 52 34" fill="none" stroke="#b07a3f" strokeWidth="8" strokeLinecap="round" />
      <ellipse cx="34" cy="38" rx="13" ry="14" fill="#b07a3f" stroke={INK} strokeWidth="2" />
      <Eyes cx={32} cy={35} dx={5} />
      <path d="M24 26 L22 18 L30 23 Z M40 26 L42 18 L34 23 Z" fill="#b07a3f" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
      <g>
        <ellipse cx="30" cy="46" rx="5" ry="6.5" fill="#8a5a28" stroke={INK} strokeWidth="1.6" />
        <rect x="27" y="36" width="6" height="5" rx="2" fill="#6d4520" />
      </g>
    </g>
  );
}

function Penguin() {
  return (
    <g>
      <rect x="8" y="30" width="8" height="14" rx="4" fill={VIOLET} opacity="0.8" />
      <rect x="20" y="22" width="8" height="22" rx="4" fill={VIOLET} />
      <rect x="32" y="34" width="8" height="10" rx="4" fill={VIOLET} opacity="0.6" />
      <ellipse cx="54" cy="32" rx="11" ry="14" fill={SOFT} stroke={INK} strokeWidth="2" />
      <ellipse cx="54" cy="35" rx="6.5" ry="9" fill="#fff" />
      <Eyes cx={54} cy={29} dx={4} />
      <path d="M51 36 L57 36 L54 39 Z" fill={AMBER} />
      <path d="M48 48 L60 48" stroke={AMBER} strokeWidth="3" strokeLinecap="round" />
    </g>
  );
}

function Panda() {
  return (
    <g>
      <circle cx="24" cy="16" r="7" fill={FUR} stroke={INK} strokeWidth="2" />
      <circle cx="48" cy="16" r="7" fill={FUR} stroke={INK} strokeWidth="2" />
      <circle cx="36" cy="30" r="15" fill="#f2f0ea" stroke={INK} strokeWidth="2" />
      <ellipse cx="30" cy="28" rx="4.5" ry="5.5" fill={FUR} transform="rotate(-15 30 28)" />
      <ellipse cx="42" cy="28" rx="4.5" ry="5.5" fill={FUR} transform="rotate(15 42 28)" />
      <Eyes cx={36} cy={28} dx={6} />
      <ellipse cx="36" cy="38" rx="3" ry="2.2" fill={FUR} />
      <rect x="54" y="22" width="14" height="11" rx="2.5" fill={SOFT} stroke={INK} strokeWidth="1.6" />
      <circle cx="61" cy="27.5" r="3" fill={LIGHT} />
    </g>
  );
}

function Frog() {
  return (
    <g>
      <ellipse cx="36" cy="36" rx="20" ry="14" fill="#4c9a6f" stroke={INK} strokeWidth="2" />
      <circle cx="27" cy="22" r="7" fill="#4c9a6f" stroke={INK} strokeWidth="2" />
      <circle cx="45" cy="22" r="7" fill="#4c9a6f" stroke={INK} strokeWidth="2" />
      <g>
        <circle cx="27" cy="22" r="2.6" fill="#101014" />
        <circle cx="45" cy="22" r="2.6" fill="#101014" />
      </g>
      <path d="M26 38 Q36 46 46 38" stroke={INK} strokeWidth="2" fill="none" strokeLinecap="round" />
      <circle cx="22" cy="36" r="2.4" fill={PINK} opacity="0.8" />
      <circle cx="50" cy="36" r="2.4" fill={PINK} opacity="0.8" />
      <circle cx="62" cy="20" r="4" fill={LIGHT} opacity="0.9" />
    </g>
  );
}

function Whale() {
  return (
    <g>
      <g>
        <path d="M8 36 Q20 22 40 24 Q58 26 60 38 Q58 48 38 48 Q18 48 8 36 Z" fill="#5b8dd9" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        <path d="M58 30 Q68 26 66 16 Q60 22 56 22 Z" fill="#5b8dd9" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        <ellipse cx="24" cy="35" rx="2.2" ry="2.2" fill="#101014" className="sd-blink" />
        <path d="M14 42 q4 3 8 1" stroke={INK} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </g>
      <g fill={LIGHT}>
        <circle cx="34" cy="18" r="2.4" />
        <circle cx="39" cy="18" r="2" />
        <circle cx="44" cy="18" r="1.6" />
      </g>
    </g>
  );
}

function Bee() {
  return (
    <g>
      <g>
        <ellipse cx="34" cy="32" rx="14" ry="11" fill={AMBER} stroke={INK} strokeWidth="2" />
        <rect x="30" y="21" width="4.5" height="22" rx="2" fill={FUR} />
        <rect x="39" y="21" width="4.5" height="22" rx="2" fill={FUR} />
        <ellipse cx="28" cy="18" rx="7" ry="4.5" fill="#fff" opacity="0.75" />
        <ellipse cx="44" cy="30" rx="2" ry="2" fill="#101014" className="sd-blink" />
        <path d="M44 36 q3 2 6 0" stroke="#101014" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        <path d="M20 32 L14 36" stroke={INK} strokeWidth="2" strokeLinecap="round" />
      </g>
      <rect x="54" y="18" width="14" height="10" rx="2" fill={CARD} stroke={LIGHT} strokeWidth="1.6" />
      <circle cx="54" cy="23" r="2" fill={LIGHT} />
    </g>
  );
}

function Crab() {
  return (
    <g>
      <line x1="18" y1="42" x2="10" y2="48" stroke="#c65a4a" strokeWidth="3" strokeLinecap="round" />
      <line x1="54" y1="42" x2="62" y2="48" stroke="#c65a4a" strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="36" cy="36" rx="17" ry="12" fill="#c65a4a" stroke={INK} strokeWidth="2" />
      <line x1="30" y1="24" x2="30" y2="18" stroke={INK} strokeWidth="2" />
      <line x1="42" y1="24" x2="42" y2="18" stroke={INK} strokeWidth="2" />
      <circle cx="30" cy="16" r="3.4" fill="#fff" stroke={INK} strokeWidth="1.6" />
      <circle cx="42" cy="16" r="3.4" fill="#fff" stroke={INK} strokeWidth="1.6" />
      <g>
        <ellipse cx="30" cy="16" rx="1.5" ry="1.5" fill="#101014" className="sd-blink" />
        <ellipse cx="42" cy="16" rx="1.5" ry="1.5" fill="#101014" className="sd-blink" style={{ animationDelay: "0.1s" }} />
      </g>
      <g>
        <circle cx="12" cy="28" r="7" fill="#c65a4a" stroke={INK} strokeWidth="2" />
        <line x1="12" y1="28" x2="12" y2="21" stroke={INK} strokeWidth="2" />
      </g>
      <g>
        <circle cx="60" cy="28" r="7" fill="#c65a4a" stroke={INK} strokeWidth="2" />
        <line x1="60" y1="28" x2="60" y2="21" stroke={INK} strokeWidth="2" />
      </g>
    </g>
  );
}

function Sloth() {
  return (
    <g>
      <line x1="10" y1="6" x2="62" y2="6" stroke={SOFT} strokeWidth="4" strokeLinecap="round" />
      <line x1="26" y1="6" x2="26" y2="20" stroke={SOFT} strokeWidth="3" />
      <line x1="46" y1="6" x2="46" y2="20" stroke={SOFT} strokeWidth="3" />
      <g>
        <ellipse cx="36" cy="34" rx="15" ry="13" fill="#8a7a63" stroke={INK} strokeWidth="2" />
        <ellipse cx="30" cy="32" rx="5" ry="6" fill="#e8e2d4" />
        <ellipse cx="42" cy="32" rx="5" ry="6" fill="#e8e2d4" />
        <ellipse cx="30" cy="33" rx="2" ry="2" fill="#101014" className="sd-blink" />
        <ellipse cx="42" cy="33" rx="2" ry="2" fill="#101014" className="sd-blink" style={{ animationDelay: "0.1s" }} />
        <ellipse cx="36" cy="40" rx="2.6" ry="2" fill="#4a3f30" />
        <path d="M32 44 q4 3 8 0" stroke={INK} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </g>
      <g>
        <path d="M60 34 a8 8 0 0 1 7 8" fill="none" stroke={GREEN} strokeWidth="3" strokeLinecap="round" />
        <path d="M67 38 l0 5 l-5 -1" fill="none" stroke={GREEN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M60 48 a8 8 0 0 1 -7 -8" fill="none" stroke={LIGHT} strokeWidth="3" strokeLinecap="round" />
        <path d="M53 44 l0 -5 l5 1" fill="none" stroke={LIGHT} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </g>
  );
}

function Otter() {
  return (
    <g>
      <ellipse cx="36" cy="32" rx="14" ry="16" fill="#7d95a8" stroke={INK} strokeWidth="2" />
      <ellipse cx="36" cy="37" rx="7.5" ry="9" fill="#c9d6e0" />
      <circle cx="27.5" cy="13" r="4" fill="#8ca6ba" stroke={INK} strokeWidth="1.6" />
      <circle cx="44.5" cy="13" r="4" fill="#8ca6ba" stroke={INK} strokeWidth="1.6" />
      <ellipse cx="36" cy="16" rx="11" ry="10.5" fill="#8ca6ba" stroke={INK} strokeWidth="2" />
      <Eyes cx={36} cy={15} dx={5} />
      <ellipse cx="36" cy="21" rx="2.6" ry="2" fill="#d98fa0" />
      <path d="M30 25 Q27 27 28.5 30 M42 25 Q45 27 43.5 30" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <path d="M20 40 Q14 44 16 50 M52 40 Q58 44 56 50" stroke="#7d95a8" strokeWidth="4.5" fill="none" strokeLinecap="round" />
      <ellipse cx="36" cy="50" rx="21" ry="3" fill={SOFT} opacity="0.7" />
    </g>
  );
}

/** The scanner's mascot: a seal with a paper-white snout, which is also the
 *  joke — a seal is what you put on a finished scan. */
function Seal() {
  return (
    <g>
      <path d="M12 44 Q10 30 28 28 Q46 26 54 32 Q60 35.5 60 41 Q60 45 54 45 L14 45 Q12 45 12 44 Z" fill="#8b97a8" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M12 43 Q3 40 5 33 Q9 38 14 39 Z" fill="#a2adbd" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <circle cx="53" cy="29" r="11" fill="#a2adbd" stroke={INK} strokeWidth="2" />
      <Eyes cx={52} cy={26} dx={4.5} />
      <ellipse cx="62" cy="32" rx="5" ry="4" fill={CARD} stroke={INK} strokeWidth="1.6" />
      <circle cx="60.6" cy="31.2" r="1.3" fill={INK} />
      <path d="M61 35.5 L69 37.5 M61 37 L68 40.5" stroke={INK} strokeWidth="1.1" opacity="0.7" strokeLinecap="round" />
      <path d="M38 43 Q42 49 48 47" stroke="#8b97a8" strokeWidth="4" fill="none" strokeLinecap="round" />
      <ellipse cx="34" cy="50" rx="26" ry="3.2" fill={SOFT} opacity="0.7" />
    </g>
  );
}

/** The signature tool's mascot: an octopus, for obvious reasons. */
function Octopus() {
  return (
    <g>
      <path d="M20 28 Q20 13 36 13 Q52 13 52 28 L52 33 Q52 38 47 38 L25 38 Q20 38 20 33 Z" fill="#8d7bb5" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M24 38 Q22 46 16 48 Q23 50 27 44" fill="#7a68a3" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M33 38 Q33 47 30 51 Q37 50 37 43" fill="#7a68a3" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M43 38 Q45 46 51 48 Q44 50 40 44" fill="#7a68a3" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <Eyes cx={36} cy={26} dx={8} />
      <ellipse cx="36" cy="51" rx="24" ry="3" fill={SOFT} opacity="0.7" />
    </g>
  );
}

const MASCOTS: Record<string, () => React.ReactElement> = {
  compress: Turtle,
  merge: Otter,
  imgtopdf: Owl,
  resize: Rabbit,
  rotate: Fox,
  split: Squirrel,
  sort: Penguin,
  toimages: Panda,
  numbers: Frog,
  watermark: Whale,
  meta: Bee,
  compare: Crab,
  convert: Sloth,
  scan: Seal,
  sign: Octopus,
};

export function ToolMascot({ id }: { id: string }) {
  const M = MASCOTS[id] || Owl;
  return (
    <svg width="64" height="48" viewBox="0 0 72 54" fill="none" aria-hidden>
      <M />
    </svg>
  );
}
