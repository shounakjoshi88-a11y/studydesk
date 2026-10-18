/**
 * Empty-state illustrations — every variant is its own <svg> now.
 *
 * `notes` is the full-colour writer piece; the rest are pixel art rendered
 * from ASCII grids by `Pixels` (one char = one cell, crispEdges), each with
 * its own prefixed classes and its own reduced-motion guard scoped to its
 * root — so nothing leaks into the rest of StudyDesk.
 *
 * Motion is stepped on purpose — 2-frame bobs, hard blinks, dots that jump a
 * whole cell — so the scenes read as game sprites, not vector art with
 * jagged edges.
 */

/**
 * Notes' empty state: a man scratching his head with a pencil, wondering what
 * to write on a blank notepad.
 *
 * Same treatment as PinArt — standalone artwork, its own aspect ratio, its own
 * looping motion — with the same three non-negotiable adaptations:
 *   - Every class and keyframe is prefixed `sdn-`. As authored it shipped bare
 *     `.blink`, `.scratch`, `.cursor` and friends, which would have styled
 *     every matching node in the app.
 *   - The reduced-motion rule is scoped to `.sdn-root *`. As authored it read
 *     `* { animation: none !important }`, which would have frozen every
 *     animation in StudyDesk rather than just this figure.
 *   - The C2PA provenance block is dropped; it renders nothing. Keep the
 *     signed original if the chain matters to you.
 *   - The stray `</g>` before the closing tag is removed. In JSX an unbalanced
 *     close tag is a parse error, not a warning.
 */
function WriterArt() {
  return (
    <svg
      className="sdn-root"
      width="112"
      height="220"
      viewBox="0 0 360 710"
      fill="none"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <style>{`
        .sdn-breathe { animation: sdn-breathe 3.6s ease-in-out infinite; }
        .sdn-headtilt { transform-origin: 245px 122px; animation: sdn-tilt 4.8s ease-in-out infinite; }
        .sdn-scratch { transform-origin: 112px 125px; animation: sdn-scratch .65s ease-in-out infinite alternate; }
        .sdn-padhold { transform-origin: 358px 240px; animation: sdn-pad 3.2s ease-in-out infinite; }
        .sdn-blink { transform-box: fill-box; transform-origin: center; animation: sdn-blink 4s infinite; }
        .sdn-brow { animation: sdn-brow 2.4s ease-in-out infinite; }
        .sdn-cursor { animation: sdn-cursor 1s steps(1) infinite; }
        .sdn-q {
          font: 800 34px 'IBM Plex Sans', system-ui, sans-serif;
          transform-box: fill-box;
          transform-origin: center;
          opacity: 0;
          animation: sdn-qfloat 3.6s ease-in-out infinite;
        }
        .sdn-q2 { animation-delay: .9s; }
        .sdn-q3 { animation-delay: 1.8s; }
        .sdn-q4 { animation-delay: 2.7s; }

        @keyframes sdn-breathe { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(1.5px); } }
        @keyframes sdn-tilt { 0%, 100% { transform: rotate(-1.5deg); } 50% { transform: rotate(2.5deg); } }
        @keyframes sdn-scratch { from { transform: rotate(-5deg); } to { transform: rotate(4deg); } }
        @keyframes sdn-pad { 0%, 100% { transform: rotate(-1.5deg); } 50% { transform: rotate(1.5deg); } }
        @keyframes sdn-blink { 0%, 92%, 100% { transform: scaleY(1); } 96% { transform: scaleY(.1); } }
        @keyframes sdn-brow { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
        @keyframes sdn-cursor { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
        @keyframes sdn-qfloat {
          0% { opacity: 0; transform: translateY(12px) scale(.5) rotate(-10deg); }
          25% { opacity: 1; transform: translateY(0) scale(1) rotate(6deg); }
          70% { opacity: 1; transform: translateY(-8px) scale(1) rotate(-6deg); }
          100% { opacity: 0; transform: translateY(-20px) scale(.8) rotate(8deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .sdn-root * { animation: none !important; }
          .sdn-q { opacity: 1; }
        }
      `}</style>

      <g transform="translate(-90,0)">
        <ellipse cx="240" cy="690" rx="95" ry="9" fill="#000" opacity=".08" />

        {/* hips + legs */}
        <path d="M184 326 L306 322 C308 380 306 410 300 425 L244 444 L190 425 C184 400 184 360 184 326Z" fill="#32252b" />
        <path d="M184 378 C178 440 174 520 176 600 L178 662 L228 662 C228 620 232 560 236 500 C238 470 240 450 244 430Z" fill="#2f2228" />
        <path d="M244 400 L304 386 C304 440 298 520 296 590 L292 660 L240 660 C240 600 238 540 238 500 C238 450 240 430 244 400Z" fill="#36282e" />
        <path d="M198 520 C204 550 210 580 212 625 M262 470 C268 520 270 580 266 630 M276 420 C284 450 288 480 290 510" fill="none" stroke="#1f1518" strokeWidth="1.4" strokeLinecap="round" />

        {/* shoes */}
        <path d="M168 656 L224 656 C230 668 228 680 218 684 L170 686 C162 684 162 668 168 656Z M238 654 L296 654 C308 662 312 676 302 683 L244 685 C236 682 234 666 238 654Z" fill="#141013" />
        <path d="M168 684 H220 M242 683 H300" stroke="#e9e5e0" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M180 666 C190 664 204 664 214 668 M252 664 C264 662 282 664 292 670" fill="none" stroke="#3a3338" strokeWidth="1.4" strokeLinecap="round" />

        <g className="sdn-breathe">
          {/* cream top */}
          <path d="M204 148 C210 140 220 134 226 130 L258 134 C263 138 264 146 264 152 C266 200 272 280 270 332 L268 390 C258 398 244 398 234 392 C236 340 232 270 204 148Z" fill="#f8f0e6" />
          <path d="M240 330 C248 346 258 350 268 346" fill="none" stroke="#e6d8c6" strokeWidth="2" strokeLinecap="round" />

          {/* cardigan left panel */}
          <path d="M204 138 C186 142 170 152 164 168 C170 230 174 300 182 392 C200 397 222 395 236 390 C236 370 235 350 234 334 C226 270 214 200 204 138Z" fill="#6fa57d" />
          <path d="M188 190 C192 250 198 320 206 388 M222 240 C226 280 230 310 232 336" fill="none" stroke="#2e5a3c" strokeWidth="1.4" strokeLinecap="round" />
          {/* cardigan right panel */}
          <path d="M262 142 C278 148 292 154 300 166 C306 200 308 250 308 300 L310 384 C294 389 278 389 264 386 C266 350 270 320 270 316 C268 260 266 200 262 142Z" fill="#6fa57d" />
          <path d="M284 200 C290 260 296 320 300 384" fill="none" stroke="#2e5a3c" strokeWidth="1.4" strokeLinecap="round" />

          {/* right (front) upper arm */}
          <path d="M296 156 C308 158 316 168 318 190 C320 215 319 240 317 256 Q311 276 291 260 C288 230 284 195 281 172 C284 162 289 157 296 156Z" fill="#6fa57d" stroke="#2e5a3c" strokeWidth="1.4" />

          {/* neck + head */}
          <g className="sdn-headtilt">
            <path d="M232 110 L254 114 L257 142 C248 150 236 148 228 140Z" fill="#d8826a" />
            <path d="M234 108 L262 127 L257 140 L230 136Z" fill="#c0705a" opacity=".6" />
            <path d="M224 127 C232 122 252 124 262 130 L266 146 C252 152 230 150 221 144Z" fill="#f8f0e6" stroke="#e6d8c6" strokeWidth="1.5" />
            <path d="M220 78 C218 62 232 52 250 52 C262 53 268 62 269 74 L271 84 Q277 93 273 97 Q270 99 270 101 Q273 104 270 107 Q272 111 269 113 L268 120 Q268 126 262 127 L243 119 Q236 116 234 108 C226 102 222 92 220 78Z" fill="#e8957b" />
            <path d="M262 127 L243 119 Q237 116 235 109" fill="none" stroke="#d4806a" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M212 74 C210 92 218 106 232 114 L238 108 C234 98 234 88 236 78Z" fill="#2b2226" />
            <ellipse cx="239" cy="95" rx="6" ry="9" fill="#d8826a" />
            <path d="M237 90 Q242 95 238 100" fill="none" stroke="#b96650" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M207 72 C203 58 214 46 230 48 C238 40 254 40 262 46 C272 46 278 56 272 64 C268 60 262 58 255 59 C246 60 240 64 237 72 C235 78 235 82 235 88 L229 90 C220 88 212 82 207 72Z" fill="#1a1316" />
            <g fill="#1a1316">
              <circle cx="214" cy="62" r="7" /><circle cx="226" cy="52" r="8" /><circle cx="242" cy="45" r="9" />
              <circle cx="258" cy="47" r="9" /><circle cx="268" cy="57" r="6" />
            </g>
            <g className="sdn-brow"><path d="M252 76 Q259 71 267 75" fill="none" stroke="#1a1316" strokeWidth="2.4" strokeLinecap="round" /></g>
            <ellipse className="sdn-blink" cx="260" cy="87" rx="2.2" ry="3" fill="#1a1316" />
            <path d="M263 111 Q267 109 270 110" fill="none" stroke="#b5604d" strokeWidth="1.8" strokeLinecap="round" />
          </g>

          {/* back arm: scratching head with pencil */}
          <path d="M179 157 C160 140 138 122 120 115 C108 111 100 122 104 135 C118 150 142 168 157 183 C168 190 175 175 179 157Z" fill="#6fa57d" stroke="#2e5a3c" strokeWidth="1.4" />
          <g className="sdn-scratch">
            <path d="M105.8 113.6 L130.3 97.8 L144.7 124.2 L118.2 136.4 Q100 128 105.8 113.6Z" fill="#6fa57d" stroke="#2e5a3c" strokeWidth="1.4" />
            <path d="M131 96 L146 123" stroke="#4d8560" strokeWidth="7" strokeLinecap="round" />
            <path d="M132.7 102.2 L181.6 78.8 L188.4 91.2 L142.3 119.8Z" fill="#e8957b" />
            {/* pencil */}
            <path d="M172 100 L214 70" stroke="#f2c14e" strokeWidth="5.5" strokeLinecap="round" />
            <path d="M207 75 L214 70" stroke="#e0b98f" strokeWidth="5.5" strokeLinecap="round" />
            <path d="M214 70 L217 68" stroke="#222" strokeWidth="3" strokeLinecap="round" />
            <path d="M172 100 L175 98" stroke="#ef7d8a" strokeWidth="6.5" strokeLinecap="round" />
            {/* fist gripping pencil */}
            <g transform="translate(194 83) rotate(-32)" stroke="#c97560" strokeWidth="1" strokeLinejoin="round">
              <path d="M-11 -6 Q-11 -10 -6 -10 H9 Q14 -10 14 -5 V6 Q14 10 9 10 H-6 Q-11 10 -11 6Z" fill="#e8957b" />
              <rect x="-9" y="-9" width="6" height="18" rx="3" fill="#e8957b" />
              <rect x="-2.5" y="-9" width="6" height="18.5" rx="3" fill="#e8957b" />
              <rect x="4" y="-9" width="6" height="18" rx="3" fill="#e8957b" />
              <rect x="9.5" y="-7" width="5" height="14" rx="2.5" fill="#e8957b" />
              <path d="M-8 -10 Q2 -15 13 -9 Q14 -6 10 -5 Q0 -8 -7 -5Z" fill="#eea189" />
              <ellipse cx="11" cy="-8.5" rx="2.4" ry="1.6" fill="#f6c2ae" stroke="none" />
            </g>
          </g>

          {/* front arm forearm + notepad */}
          <g className="sdn-padhold">
            <g transform="rotate(5 358 250)">
              <rect x="356" y="150" width="80" height="104" rx="6" fill="#fffdf7" stroke="#d7cdb8" strokeWidth="2" />
              <rect x="356" y="150" width="80" height="18" rx="6" fill="#f2c14e" />
              <g fill="#8a6d1f">
                <circle cx="372" cy="150" r="3" /><circle cx="388" cy="150" r="3" />
                <circle cx="404" cy="150" r="3" /><circle cx="420" cy="150" r="3" />
              </g>
              <path d="M366 186H436M366 202H426M366 218H426M366 234H426" stroke="#dfe6ee" strokeWidth="2" strokeLinecap="round" />
              <path d="M392 186H410" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />
              <rect className="sdn-cursor" x="414" y="178" width="2.5" height="16" fill="#3b82f6" />
              <text x="398" y="248" fontFamily="'IBM Plex Sans', system-ui, sans-serif" fontSize="22" fontWeight="800" fill="#f59e0b" opacity=".85">?</text>
            </g>
            <path d="M301.4 250.8 L332.7 233.5 L344.9 254.1 L314.6 273.2 Q296 268 301.4 250.8Z" fill="#6fa57d" stroke="#2e5a3c" strokeWidth="1.4" />
            <path d="M334.2 236.1 L348.7 230.4 L355.3 241.6 L343.4 251.5Z" fill="#e8957b" />
            {/* hand: back of palm + four fingers wrapping the pad edge */}
            <g stroke="#c97560" strokeWidth="1" strokeLinejoin="round">
              <path d="M347 229 C350 224 355 223 358 224 L359 253 C356 259 351 258 349 252 C349 247 352 243 355 241Z" fill="#e8957b" />
              <path d="M357 224 H375 Q380 224 380 227.7 Q380 231.5 375 231.5 H357Z" fill="#e8957b" />
              <path d="M357 231.5 H377 Q382 231.5 382 235.3 Q382 239 377 239 H357Z" fill="#e8957b" />
              <path d="M357 239 H375 Q380 239 380 242.7 Q380 246.5 375 246.5 H357Z" fill="#e8957b" />
              <path d="M357 246.5 H371 Q376 246.5 376 249.8 Q376 253 371 253 H357Z" fill="#e8957b" />
              <path d="M366 224.5V231M367 232V238.5M366 239.5V246M365 247V252.5" fill="none" strokeWidth=".8" />
              <g fill="#f6c2ae" stroke="none">
                <ellipse cx="376.5" cy="227.7" rx="2.3" ry="2.4" /><ellipse cx="378.5" cy="235.3" rx="2.3" ry="2.4" />
                <ellipse cx="376.5" cy="242.7" rx="2.3" ry="2.4" /><ellipse cx="372.5" cy="249.8" rx="2.2" ry="2.2" />
              </g>
            </g>
          </g>
        </g>
      </g>

      {/* question marks */}
      <text className="sdn-q" x="282" y="34" fill="#f59e0b">?</text>
      <text className="sdn-q sdn-q2" x="178" y="26" fill="#3b82f6" style={{ fontSize: 28 }}>?</text>
      <text className="sdn-q sdn-q3" x="322" y="92" fill="#ef4444" style={{ fontSize: 26 }}>?</text>
      <text className="sdn-q sdn-q4" x="136" y="62" fill="#8b5cf6" style={{ fontSize: 30 }}>?</text>
    </svg>
  );
}

export type EmptyVariant =
  | "notes"
  | "files"
  | "ask"
  | "todos"
  | "pins"
  | "schedule"
  | "subjects"
  | "search";

const STANDALONE: Partial<Record<EmptyVariant, () => React.ReactElement>> = {
  notes: WriterArt,
  pins: PinsArtPx,
  ask: AskArtPx,
  todos: TodosArtPx,
  files: FilesArtPx,
  schedule: ScheduleArtPx,
  subjects: SubjectsArtPx,
  search: SearchArtPx,
};

/* ---------------------------------------------------------------------------
 * Pixel-art empty states (ask / todos)
 *
 * One character = one cell; horizontal runs merge into <rect>s and the root
 * sets shape-rendering: crispEdges, so the sprite stays square at any zoom.
 * ------------------------------------------------------------------------ */

const PX_CELL = 3;

const PX: Record<string, string> = {
  K: "#39465c", // panda's dark fur
  W: "#f4f6fa", // panda's white fur
  E: "#ffffff", // eye glint
  N: "#161b24", // nose, mouth, clock hand
  P: "#e0a3a3", // blush
  R: "#e0a3a3", // pencil eraser
  S: "#bcc7d8", // clipboard task lines
  Y: "#e2b04a", // pencil body
  U: "#e8cfa8", // pencil wood
  L: "#161b24", // pencil lead
  F: "#232c3c", // pencil ferrule
  T: "#2dd4bf", // the tick
  q: "#a9bbd6", // question marks
  p: "#e0a3a3", // blush question mark
  s: "#8fa3c4", // sparkles
  g: "#2f6f63", // bamboo stem
  n: "#21524a", // bamboo node
  l: "#46a68c", // bamboo leaf
  D: "#8fa3c4", // calendar day highlight
  d: "#6f83a5", // book spine (steel)
  h: "#b8873a", // folder shade
  r: "#c7808f", // book spine (blush)
};

/** Renders an ASCII grid as crisp rects — one char per cell, runs merged. */
function Pixels({ grid, x = 0, y = 0 }: { grid: string[]; x?: number; y?: number }) {
  const rects: React.ReactElement[] = [];
  grid.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      const ch = row[c];
      if (!PX[ch]) { c++; continue; }
      let w = 1;
      while (c + w < row.length && row[c + w] === ch) w++;
      rects.push(
        <rect key={`${r}-${c}`} x={c * PX_CELL} y={r * PX_CELL} width={w * PX_CELL} height={PX_CELL} fill={PX[ch]} />,
      );
      c += w;
    }
  });
  return <g transform={`translate(${x} ${y})`}>{rects}</g>;
}

/** The panda both scenes share — 30×28 cells. */
const PANDA_GRID = [
  ".....KKKKK..........KKKKK.....",
  "....KKKKKKK........KKKKKKK....",
  "....KKKKKKK........KKKKKKK....",
  "....KKKWWWWWWWWWWWWWWWWKKK....",
  "...KKWWWWWWWWWWWWWWWWWWWWKK...",
  "...KWWWWWWWWWWWWWWWWWWWWWWK...",
  "...WWWWWWWWWWWWWWWWWWWWWWWW...",
  "...WWWWKKKKKWWWWWWKKKKKWWWW...",
  "...WWWKKKKKKKWWWWKKKKKKKWWW...",
  "...WWWKKEEKKKWWWWKKKEEKKWWW...",
  "...WWWKKEEKKKWWWWKKKEEKKWWW...",
  "...WWWWKKKKKWWWWWWKKKKKWWWW...",
  "...WWWWWKKKWWWWWWWWKKKWWWWW...",
  "...WWWWWPWWWWWNNWWWWWPWWWWW...",
  "...WWWWWWWWWWWNNWWWWWWWWWWW...",
  "...WWWWWWWWWWNWWNWWWWWWWWWW...",
  "...WWWWWWWWWWWNNWWWWWWWWWWW...",
  "...WWWWWWWWWWWWWWWWWWWWWWWW...",
  "....WWWWWWWWWWWWWWWWWWWWWW....",
  "....KKWWWWWWWWWWWWWWWWWWKK....",
  "....KKWWWWWWWWWWWWWWWWWWKK....",
  "...KKKWWWWWWWWWWWWWWWWWWKKK...",
  "...KKKWWWWWWWWWWWWWWWWWWKKK...",
  "...KKWWWWWWWWWWWWWWWWWWWWKK...",
  "...KKWWWWWWWWWWWWWWWWWWWWKK...",
  "...KKKKWWWWWWWWWWWWWWWWKKKK...",
  "..KKKKKWWWWWWWWWWWWWWWWKKKKK..",
  "..KKKKKKKKK........KKKKKKKKK..",
];

/** Speech bubble with a tail leaning toward the panda's head. */
const BUBBLE_GRID = [
  "..KKKKKKKKKKKKKKKKKKKK..",
  ".KKWWWWWWWWWWWWWWWWWWKK.",
  "KKWWWWWWWWWWWWWWWWWWWWKK",
  ...Array(11).fill("KWWWWWWWWWWWWWWWWWWWWWWK"),
  "KKWWWWWWWWWWWWWWWWWWWWKK",
  ".KKWWWWWWWWWWWWWWWWWWKK.",
  "..KKKKKKKKKKKKKKKKKKKK..",
  ".....KKKK...............",
  "....KK..................",
];

const QMARK_GRID = [
  "..qqq..",
  ".qq.qq.",
  "qq...qq",
  ".....qq",
  "....qq.",
  "...qq..",
  "...qq..",
  ".......",
  "...qq..",
  "...qq..",
];
const QMARK_BLUSH = QMARK_GRID.map((r) => r.replace(/q/g, "p"));

const SPARK_GRID = [".s.", "sss", ".s."];

const BAMBOO_GRID = [
  "...gg...", "...gg...", "...gg...", "...gg...", "...gg...", "...gg...",
  "..nnnn..", "...gg...",
  "...gg.l.", "...gg..l", "...gg.ll",
  "...gg...", "...gg...",
  "..nnnn..", "...gg...",
  "l...gg..", "ll..gg..", ".l..gg..",
  "...gg...", "...gg...",
  "..nnnn..", "...gg...",
  "...gg.l.", "...gg..l", "...gg.ll",
  "...gg...", "...gg...",
  "..nnnn..", "...gg...", "...gg...",
];

/** Clipboard: clip on top, four task rows with a line each. */
const BOARD_GRID: string[] = (() => {
  const blank = `K${"W".repeat(24)}K`;
  const rows = [
    ".........KKKKKKKK.........",
    ".........KKWWWWKK.........",
    ".........KKWWWWKK.........",
    "K".repeat(26),
    blank,
  ];
  for (let i = 0; i < 4; i++) {
    rows.push(
      "...KKKKKKKK...............",
      "...KWWWWWWK...............",
      "...KWWWWWWK...............",
      "...KWWWWWWK..SSSSSSSSSSS..",
      "...KWWWWWWK..SSSSSSSSSSS..",
      "...KWWWWWWK...............",
      "...KWWWWWWK...............",
      "...KKKKKKKK...............",
    );
    if (i < 3) rows.push(blank);
  }
  rows.push(blank, "K".repeat(26));
  return rows;
})();

const CHECK_GRID = [
  "......",
  ".....T",
  "T....T",
  ".T..T.",
  "..TT..",
];

const CLOCK_GRID = [
  "..K.....K..",
  ".KKK...KKK.",
  "..KK...KK..",
  "..KKKKKKK..",
  ".KKWWWWWKK.",
  "KKWWWWWWWKK",
  "KWWWWWWWWWK",
  "KWWWWWWWWWK",
  "KKWWWWWWWKK",
  ".KKWWWWWKK.",
  "..KKKKKKK..",
];

/** Diagonal pencil, eraser bottom-left, lead tip top-right. */
const PENCIL_GRID = [
  "..........LL",
  ".........UL.",
  "........UU..",
  "......YYU...",
  ".....YYY....",
  "....YYY.....",
  "...YYY......",
  "..FYY.......",
  ".RFY........",
  "RRF.........",
  "RR..........",
  "R...........",
];

/** Ask's empty state: a pixel panda watching a speech bubble type. */
function AskArtPx() {
  return (
    <svg className="sda-root" width="180" height="160" viewBox="0 0 180 160" fill="none" shapeRendering="crispEdges" aria-hidden="true">
      <style>{`
        .sda-bob { animation: sda-bob 2.2s steps(1, end) infinite; }
        .sda-bubble { animation: sda-wob 3.4s steps(1, end) infinite; }
        .sda-blink { opacity: 0; animation: sda-blink 5s steps(1, end) infinite; }
        .sda-dot { animation: sda-dot 1.3s steps(1, end) infinite; }
        .sda-dot.d2 { animation-delay: .18s; }
        .sda-dot.d3 { animation-delay: .36s; }
        .sda-q { opacity: 0; animation: sda-float 6.2s steps(1, end) infinite; }
        .sda-q.q2 { animation-delay: 2.2s; }
        .sda-spark { animation: sda-spark 2.6s steps(1, end) infinite; }
        .sda-spark.s2 { animation-delay: 1.2s; }

        @keyframes sda-bob { 0%, 49% { transform: translateY(0); } 50%, 100% { transform: translateY(-3px); } }
        @keyframes sda-wob {
          0%, 24% { transform: translate(0, 0); }
          25%, 49% { transform: translate(-3px, -3px); }
          50%, 74% { transform: translate(0, -3px); }
          75%, 100% { transform: translate(3px, 0); }
        }
        @keyframes sda-blink { 0%, 88% { opacity: 0; } 89%, 95% { opacity: 1; } 96%, 100% { opacity: 0; } }
        @keyframes sda-dot { 0%, 32% { transform: translateY(0); } 33%, 65% { transform: translateY(-3px); } 66%, 100% { transform: translateY(0); } }
        @keyframes sda-float {
          0%, 14% { opacity: 0; transform: translate(0, 6px); }
          15%, 40% { opacity: 1; transform: translate(0, 0); }
          41%, 66% { opacity: 1; transform: translate(0, -9px); }
          67%, 88% { opacity: 1; transform: translate(0, -15px); }
          89%, 100% { opacity: 0; transform: translate(0, -15px); }
        }
        @keyframes sda-spark { 0%, 44% { opacity: 1; } 45%, 100% { opacity: .25; } }
        @media (prefers-reduced-motion: reduce) {
          .sda-root * { animation: none !important; }
          .sda-q { opacity: 1; }
        }
      `}</style>

      <rect x="26" y="150" width="128" height="3" fill="#161d27" />
      <rect x="38" y="153" width="104" height="3" fill="#0e131b" />
      <Pixels grid={BAMBOO_GRID} x={6} y={58} />

      <g className="sda-bob">
        <Pixels grid={PANDA_GRID} x={30} y={66} />
        <rect className="sda-blink" x="54" y="93" width="6" height="6" fill={PX.K} />
        <rect className="sda-blink" x="87" y="93" width="6" height="6" fill={PX.K} />
      </g>

      <g className="sda-bubble">
        <Pixels grid={BUBBLE_GRID} x={66} y={10} />
        <rect className="sda-dot" x="81" y="34" width="6" height="6" fill="#8fa3c4" />
        <rect className="sda-dot d2" x="99" y="34" width="6" height="6" fill="#8fa3c4" />
        <rect className="sda-dot d3" x="117" y="34" width="6" height="6" fill="#8fa3c4" />
      </g>

      <g className="sda-q"><Pixels grid={QMARK_GRID} x={34} y={24} /></g>
      <g className="sda-q q2"><Pixels grid={QMARK_BLUSH} x={146} y={34} /></g>
      <g className="sda-spark"><Pixels grid={SPARK_GRID} x={156} y={14} /></g>
      <g className="sda-spark s2"><Pixels grid={SPARK_GRID} x={18} y={40} /></g>
    </svg>
  );
}

/** To-dos' empty state: the panda pencils ticks onto a clipboard, one by one. */
function TodosArtPx() {
  return (
    <svg className="sdk-root" width="180" height="160" viewBox="0 0 180 160" fill="none" shapeRendering="crispEdges" aria-hidden="true">
      <style>{`
        .sdk-bob { animation: sdk-bob 2.4s steps(1, end) infinite; }
        .sdk-blink { opacity: 0; animation: sdk-blink 5.4s steps(1, end) infinite; }
        .sdk-tick { opacity: 0; animation: sdk-tick 8s steps(1, end) infinite; }
        .sdk-tick.c2 { animation-delay: .5s; }
        .sdk-tick.c3 { animation-delay: 1s; }
        .sdk-tick.c4 { animation-delay: 1.5s; }
        .sdk-hand1 { animation: sdk-h1 1s steps(1, end) infinite; }
        .sdk-hand2 { opacity: 0; animation: sdk-h2 1s steps(1, end) infinite; }
        .sdk-spark { animation: sdk-spark 3s steps(1, end) infinite; }
        .sdk-spark.s2 { animation-delay: 1.4s; }

        @keyframes sdk-bob { 0%, 49% { transform: translateY(0); } 50%, 100% { transform: translateY(-3px); } }
        @keyframes sdk-blink { 0%, 89% { opacity: 0; } 90%, 95% { opacity: 1; } 96%, 100% { opacity: 0; } }
        @keyframes sdk-tick { 0%, 6% { opacity: 0; } 7%, 84% { opacity: 1; } 88%, 100% { opacity: 0; } }
        @keyframes sdk-h1 { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
        @keyframes sdk-h2 { 0%, 49% { opacity: 0; } 50%, 100% { opacity: 1; } }
        @keyframes sdk-spark { 0%, 44% { opacity: 1; } 45%, 100% { opacity: .25; } }
        @media (prefers-reduced-motion: reduce) {
          .sdk-root * { animation: none !important; }
          .sdk-tick { opacity: 1; }
        }
      `}</style>

      <rect x="20" y="142" width="140" height="3" fill="#161d27" />
      <rect x="32" y="145" width="116" height="3" fill="#0e131b" />
      <Pixels grid={BOARD_GRID} x={88} y={16} />

      {[5, 14, 23, 32].map((s, i) => (
        <g key={s} className={`sdk-tick c${i + 1}`}>
          <Pixels grid={CHECK_GRID} x={88 + 4 * PX_CELL} y={16 + (s + 2) * PX_CELL} />
        </g>
      ))}

      <Pixels grid={CLOCK_GRID} x={30} y={14} />
      <rect className="sdk-hand1" x="45" y="23" width="3" height="9" fill={PX.N} />
      <rect className="sdk-hand2" x="48" y="29" width="3" height="3" fill={PX.N} />
      <rect className="sdk-hand2" x="51" y="26" width="3" height="3" fill={PX.N} />

      <g className="sdk-bob">
        <Pixels grid={PANDA_GRID} x={6} y={56} />
        <Pixels grid={PENCIL_GRID} x={84} y={84} />
        <rect className="sdk-blink" x="30" y="83" width="6" height="6" fill={PX.K} />
        <rect className="sdk-blink" x="63" y="83" width="6" height="6" fill={PX.K} />
      </g>

      <g className="sdk-spark"><Pixels grid={SPARK_GRID} x={72} y={30} /></g>
      <g className="sdk-spark s2"><Pixels grid={SPARK_GRID} x={168} y={100} /></g>
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * The five small scenes: same panda, one prop each — folder, magnifier,
 * calendar, books, pushpin. `PandaScene` keeps them a family; the reduced-
 * motion guard lives on `.spx-root` only.
 * ------------------------------------------------------------------------ */

const MAGNIFIER_GRID = [
  "...KKKKK.....",
  "..KKWWWKK....",
  ".KKWWWWWKK...",
  ".KWWWWWWWK...",
  "KWWWWWWWWWK..",
  "KWWWWWWWWWK..",
  "KWWWWWWWWWK..",
  ".KWWWWWWWK...",
  ".KKWWWWWKK...",
  "..KKWWWKK....",
  "...KKKKK.KK..",
  "........KKK..",
  ".......KKK...",
  "......KKK....",
  ".....KKK.....",
  "....KKK......",
];

const FOLDER_GRID = [
  "YYYYYYY.............",
  "YYYYYYY....WWWW.....",
  "YYYYYYY...WWWWWW....",
  "YYYYYYYYYYYYYYYYYYYY",
  "Y.........WWWWWW...Y",
  "Y.........WWWWWW...Y",
  "YYYYYYYYYYYYYYYYYYYY",
  "YYYYYYYYYYYYYYYYYYYY",
  "YYYYYYYYYYYYYYYYYYYY",
  "YYYYYYYYWWWWYYYYYYYY",
  "YYYYYYYYWWWWYYYYYYYY",
  "YYYYYYYYYYYYYYYYYYYY",
  "YYYYYYYYYYYYYYYYYYYY",
  "hhhhhhhhhhhhhhhhhhhh",
];

const CALENDAR_GRID = [
  "..KK............KK..",
  "..KK............KK..",
  "YYYYYYYYYYYYYYYYYYYY",
  "YYYYYYYYYYYYYYYYYYYY",
  ".WWWWWWWWWWWWWWWWWW.",
  ".W.KK.KK.KK.KK.KK.W.",
  ".W................W.",
  ".W.KK.KK.KK.KK.KK.W.",
  ".W................W.",
  ".W.KK.KK.KK.KK.KK.W.",
  ".WWWWWWWWWWWWWWWWWW.",
];

const BOOKS_GRID = [
  "......hhhhhhhhhh....",
  "......hhYYYYYYWW....",
  "......hhYYYYYYWW....",
  "....dddddddddddd....",
  "....ddDDDDDDDDWW....",
  "....ddDDDDDDDDWW....",
  "..rrrrrrrrrrrrrrrr..",
  "..rrPPPPPPPPPPPPWW..",
  "..rrPPPPPPPPPPPPWW..",
];

const PUSHPIN_GRID = [
  ".........PPP..",
  "........PWWPP.",
  ".......PPWPPPP",
  ".......PPPPPPP",
  ".......PPPPPPP",
  "........PPPPP.",
  ".........PPP..",
  ".........KKK..",
  "..........KK..",
  "..........KK..",
  "..........KK..",
  "..........KK..",
  "..........KK..",
  "..........KK..",
];

/** A pixel panda + one prop; all five of the little scenes share this frame. */
function PandaScene({
  grid,
  x,
  y,
  children,
}: {
  grid: string[];
  x: number;
  y: number;
  children?: React.ReactNode;
}) {
  return (
    <svg className="spx-root" width="180" height="160" viewBox="0 0 180 160" fill="none" shapeRendering="crispEdges" aria-hidden="true">
      <style>{`
        .spx-bob { animation: spx-bob 2.3s steps(1, end) infinite; }
        .spx-blink { opacity: 0; animation: spx-blink 5.2s steps(1, end) infinite; }
        .spx-spark { animation: spx-spark 2.8s steps(1, end) infinite; }
        .spx-day { opacity: 0; animation: spx-day 7s steps(1, end) infinite; }
        .spx-day.d2 { animation-delay: .5s; }
        .spx-day.d3 { animation-delay: 1s; }
        .spx-day.d4 { animation-delay: 1.5s; }

        @keyframes spx-bob { 0%, 49% { transform: translateY(0); } 50%, 100% { transform: translateY(-3px); } }
        @keyframes spx-blink { 0%, 89% { opacity: 0; } 90%, 95% { opacity: 1; } 96%, 100% { opacity: 0; } }
        @keyframes spx-spark { 0%, 44% { opacity: 1; } 45%, 100% { opacity: .25; } }
        @keyframes spx-day { 0%, 7% { opacity: 0; } 8%, 84% { opacity: 1; } 88%, 100% { opacity: 0; } }
        @media (prefers-reduced-motion: reduce) {
          .spx-root * { animation: none !important; }
          .spx-day { opacity: 1; }
        }
      `}</style>

      <rect x="20" y="142" width="140" height="3" fill="#161d27" />
      <rect x="32" y="145" width="116" height="3" fill="#0e131b" />
      <Pixels grid={grid} x={x} y={y} />

      <g className="spx-bob">
        <Pixels grid={PANDA_GRID} x={24} y={58} />
        <rect className="spx-blink" x="48" y="85" width="6" height="6" fill={PX.K} />
        <rect className="spx-blink" x="81" y="85" width="6" height="6" fill={PX.K} />
      </g>

      {children}

      <g className="spx-spark"><Pixels grid={SPARK_GRID} x={12} y={18} /></g>
    </svg>
  );
}

/** Files' empty state: panda beside an amber folder, paper peeking out. */
function FilesArtPx() {
  return <PandaScene grid={FOLDER_GRID} x={118} y={100} />;
}

/** Search's empty state: panda beside a magnifier. */
function SearchArtPx() {
  return <PandaScene grid={MAGNIFIER_GRID} x={130} y={78} />;
}

/** Schedule's empty state: panda under a wall calendar whose days light up. */
function ScheduleArtPx() {
  return (
    <PandaScene grid={CALENDAR_GRID} x={118} y={30}>
      <g className="spx-day d1"><rect x="127" y="45" width="6" height="6" fill={PX.D} /></g>
      <g className="spx-day d2"><rect x="145" y="45" width="6" height="6" fill={PX.D} /></g>
      <g className="spx-day d3"><rect x="136" y="51" width="6" height="6" fill={PX.D} /></g>
      <g className="spx-day d4"><rect x="154" y="57" width="6" height="6" fill={PX.D} /></g>
    </PandaScene>
  );
}

/** Subjects' empty state: panda beside a stack of three books. */
function SubjectsArtPx() {
  return <PandaScene grid={BOOKS_GRID} x={118} y={115} />;
}

/** Pinned's empty state: panda beside a pushpin stuck in the ground. */
function PinsArtPx() {
  return <PandaScene grid={PUSHPIN_GRID} x={128} y={100} />;
}

export function EmptyState({
  variant,
  title,
  hint,
}: {
  variant: EmptyVariant;
  title: string;
  hint: string;
}) {
  const Art = STANDALONE[variant];
  return (
    // The one entrance an empty state gets: art, then title, then line, a
    // step apart — once per mount, and skipped entirely under reduced
    // motion because .sd-card-in is already in that guard. The end frame is
    // the design; the motion only says "this space is ready".
    <div className="flex flex-col items-center mt-8 px-8" role="status">
      <div className="sd-card-in">
        {Art ? <Art /> : null}
      </div>
      <p className="sd-card-in text-sm font-semibold mt-3 text-ink-1" style={{ animationDelay: "70ms" }}>
        {title}
      </p>
      <p
        className="sd-card-in text-xs text-ink-2 mt-1 text-center max-w-[46ch]"
        style={{ animationDelay: "140ms" }}
      >
        {hint}
      </p>
    </div>
  );
}
