// src/components/MessageRenderer.tsx
//
// KaTeX-primary math renderer with raw LaTeX fallback.
//
// - KaTeX renders ~98% of common LaTeX (matrices, aligned, cases, fractions,
//   accents, mhchem, integrals, \begin{align*}, \begin{aligned}, etc.).
// - ~70 custom macros defined for operators models commonly use without
//   declaration (\R, \tr, \argmax, \Span, \rank, \diag, etc.).
// - repairLatex() surgically fixes common model hallucination patterns:
//   \big{ → \bigl\{ , \int{x} → \int_{x}, \text{lim} → \lim, etc.
// - If KaTeX still fails, the raw LaTeX is shown inline in a styled monospace
//   block — no CDN dependency, no network fallback.
//
// Unicode math (∮∯∰⨌⨝ℵ₀ℝℂℱ… and the entire Mathematical Alphanumeric Symbols
// block U+1D400–U+1D7FF) is mapped to native LaTeX commands before rendering.

import React, { useState, useMemo, useEffect, useRef } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check, ChevronDown, Download } from "lucide-react";
import katex from "katex";
import "katex/dist/katex.min.css";

import type { Source } from "../types";
import { getDomain, fixMalformedTags } from "../lib/chat-utils";
import { ChartRenderer, type ChartData } from "./ChartBlock";
import { LiveWidget } from "./LiveWidget";
import SmilesDrawer from "smiles-drawer";
import DOMPurify from "dompurify";

// ─── Common KaTeX macros ─────────────────────────────────
export const MACROS: Record<string, string> = {
  "\\ce": "\\mhchem",
  "\\pu": "\\mhchem",
  // Blackboard bold
  "\\R": "\\mathbb{R}",
  "\\C": "\\mathbb{C}",
  "\\N": "\\mathbb{N}",
  "\\Z": "\\mathbb{Z}",
  "\\Q": "\\mathbb{Q}",
  "\\F": "\\mathbb{F}",
  "\\E": "\\mathbb{E}",
  // Greek variants
  "\\eps": "\\varepsilon",
  "\\vphi": "\\varphi",
  "\\vpi": "\\varpi",
  "\\varrho": "\\varrho",
  "\\varkappa": "\\varkappa",
  // Common operators
  "\\tr": "\\operatorname{tr}",
  "\\Span": "\\operatorname{Span}",
  "\\rank": "\\operatorname{rank}",
  "\\diag": "\\operatorname{diag}",
  "\\range": "\\operatorname{range}",
  "\\nullspace": "\\operatorname{null}",
  "\\spans": "\\operatorname{span}",
  "\\im": "\\operatorname{Im}",
  "\\re": "\\operatorname{Re}",
  "\\argmin": "\\operatorname{argmin}",
  "\\argmax": "\\operatorname{argmax}",
  "\\sgn": "\\operatorname{sgn}",
  "\\supp": "\\operatorname{supp}",
  "\\vol": "\\operatorname{vol}",
  "\\dist": "\\operatorname{dist}",
  "\\diam": "\\operatorname{diam}",
  "\\conv": "\\operatorname{conv}",
  "\\Proj": "\\operatorname{Proj}",
  "\\Res": "\\operatorname{Res}",
  "\\Pr": "\\operatorname{Pr}",
  "\\Exp": "\\operatorname{E}",
  "\\Var": "\\operatorname{Var}",
  "\\Cov": "\\operatorname{Cov}",
  "\\Corr": "\\operatorname{Corr}",
  "\\lcm": "\\operatorname{lcm}",
  "\\grad": "\\nabla",
  "\\slashed": "\\not{#1}",
  "\\curl": "\\nabla\\times",
  "\\divg": "\\nabla\\cdot",
  // Paired delimiters
  "\\abs": "\\lvert#1\\rvert",
  "\\norm": "\\lVert#1\\rVert",
  "\\ceil": "\\lceil#1\\rceil",
  "\\floor": "\\lfloor#1\\rfloor",
  "\\set": "\\{\\,#1\\,\\}",
  "\\bkt": "\\left[#1\\right]",
  "\\paren": "\\left(#1\\right)",
};

// ─── KaTeX global setup + mhchem ─────────────────────────
if (typeof window !== "undefined") {
  const kt = (katex as any).default || katex;
  if (kt) { (window as any).katex = kt; }
}

let mhchemLoaded = false;
let mhchemPromise: Promise<boolean> | null = null;

const ensureMhchem = (): Promise<boolean> => {
  if (mhchemLoaded) return Promise.resolve(true);
  if (mhchemPromise) return mhchemPromise;
  // Wrap in try/catch because dynamic import() may throw synchronously in
  // some bundler targets (e.g. Bun browser builds that inline the module).
  try {
    mhchemPromise = import("katex/dist/contrib/mhchem.min.js")
      .then(() => { mhchemLoaded = true; return true; })
      .catch((e) => { console.error("mhchem load error:", e); return false; });
  } catch (e) {
    console.error("mhchem sync import error:", e);
    mhchemPromise = Promise.resolve(false);
  }
  return mhchemPromise;
};

// ─── Raw LaTeX fallback (when KaTeX fails) ───────────────
function RawLatexFallback({ formula, display }: { formula: string; display: boolean }) {
  const cleanFormula = useMemo(() => {
    return (formula || "")
      .trim()
      .replace(/^\$\$/, "")
      .replace(/\$\$$/, "")
      .replace(/^\\\[/, "")
      .replace(/\\\]$/, "")
      .replace(/^\\\(/, "")
      .replace(/\\\)$/, "")
      .trim();
  }, [formula]);

  if (display) {
    return (
      <div className="my-4 rounded-card border border-[var(--att-caution)]/30 bg-[var(--att-caution)]/5 p-3 text-left overflow-x-auto">
        <div className="text-[11px] font-medium text-caution-text mb-1">LaTeX</div>
        <pre className="text-[11px] text-ink-1 whitespace-pre-wrap break-words font-mono">{cleanFormula}</pre>
      </div>
    );
  }
  return (
    <code className="inline-block align-middle rounded border border-[var(--att-caution)]/30 bg-[var(--att-caution)]/10 px-1.5 py-0.5 text-xs text-caution-text">
      {cleanFormula}
    </code>
  );
}

// ─── MathJax fallback for features KaTeX can't handle ────
// KaTeX doesn't support: \multicolumn, \intertext, \genfrac, \xymatrix, \halign.
// We lazily load MathJax v3 from CDN only when needed.

let mjPromise: Promise<any> | null = null;
let mjReady = false;

export function needsMathJax(formula: string): boolean {
  if (/\\xymatrix\b/.test(formula)) return true;
  return false;
}

function MathJaxRenderer({ formula, display }: { formula: string; display: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "rendered" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");

  const cleanFormula = useMemo(() => {
    return (formula || "")
      .trim()
      .replace(/^\$\$/, "").replace(/\$\$$/, "")
      .replace(/^\\\[/, "").replace(/\\\]$/, "")
      .replace(/^\\\(/, "").replace(/\\\)$/, "")
      .trim();
  }, [formula]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cleanFormula) { if (!cancelled) setState("rendered"); return; }
      try {
        if (!mjReady) {
          if (!mjPromise) {
            (window as any).MathJax = {
              tex: { inlineMath: [["\\(", "\\)"]], displayMath: [["$$", "$$"], ["\\[", "\\]"]], processEscapes: true, processEnvironments: true, packages: { "[+]": ["xy"] } },
              loader: { load: ["[tex]/xy"] },
              options: { ignoreHtmlClass: "tex2jax_ignore", processHtmlClass: "tex2jax_process" },
              startup: { typeset: false, ready: () => { (window as any).MathJax.startup.defaultReady(); (window as any).MathJax.startup.promise.then(() => { mjReady = true; }).catch(() => {}); } },
              chtml: { scale: 1.0, fontURL: "https://cdn.jsdelivr.net/npm/mathjax@3/es5/output/chtml/fonts/woff-v2" },
            };
            const s = document.createElement("script");
            s.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js";
            s.async = true; s.crossOrigin = "anonymous";
            mjPromise = new Promise((resolve, reject) => { s.onload = resolve; s.onerror = reject; });
            document.head.appendChild(s);
          }
          await mjPromise;
        }
        if (cancelled) return;
        const node = containerRef.current;
        if (!node) return;
        node.innerHTML = "";
        const wrapper = document.createElement(display ? "div" : "span");
        wrapper.className = "mathjax-node";
        wrapper.textContent = `${display ? "\\[" : "\\("}${cleanFormula}${display ? "\\]" : "\\)"}`;
        node.appendChild(wrapper);
        await (window as any).MathJax.typesetPromise([wrapper]);
        if (!cancelled) setState("rendered");
      } catch (e: any) {
        if (!cancelled) { setErrMsg(e?.message || String(e)); setState("error"); }
      }
    })();
    return () => { cancelled = true; };
  }, [cleanFormula, display]);

  if (state === "error") {
    return <RawLatexFallback formula={formula} display={display} />;
  }

  const wrapperClass = display
    ? "my-4 text-center overflow-x-auto max-w-full py-2 block"
    : "inline-math-container inline-block align-middle max-w-full overflow-x-auto overflow-y-hidden";

  return (
    <span className={wrapperClass} style={{ position: "relative" }}>
      <div ref={containerRef} />
      {state === "loading" && (
        <span className="absolute inset-0 flex items-center justify-center text-xs text-ink-3 animate-pulse">
          {display ? "Rendering complex formula…" : "⋯"}
        </span>
      )}
    </span>
  );
}

// ─── Commutative diagram (\begin{CD}) → KaTeX matrix ─────
// KaTeX doesn't support the CD environment. We convert it to
// a \begin{matrix} with \xrightarrow / \xleftarrow / \downarrow / \uparrow.
//
// In amscd the first row defines a grid where columns alternate:
//   [entry(0), arrow(1), entry(2), arrow(3), entry(4), …]
// Horizontal arrows (@>>> @<<< @=) go in ODD columns (arrow positions).
// Vertical arrows (@VVV @AAA) and @. go in EVEN columns (entry positions).
export function convertCDtoMatrix(s: string): string {
  return s.replace(/\\begin\s*\{CD\}\s*([\s\S]*?)\s*\\end\s*\{CD\}/gi, (_match, body: string) => {
    const rawRows = body.split(/\\\\/).map((r: string) => r.trim()).filter((r: string) => r.length > 0);
    if (rawRows.length === 0) return s;

    // Number of entries = number of @-separated parts in the first row
    const numEntries = rawRows[0]!.split('@').length;
    const targetCols = 2 * numEntries - 1;

    function isArrowRow(parts: string[]): boolean {
      for (let i = 1; i < Math.min(parts.length, numEntries); i++) {
        if (/^[><=]/.test(parts[i] ?? '')) return true;
      }
      return false;
    }

    function extractArrowAndEntry(part: string): [string, string] {
      let arrowEnd = 0;
      while (arrowEnd < part.length && /[><VA.={]/.test(part[arrowEnd]!)) {
        if (part[arrowEnd] === '{') {
          const close = part.indexOf('}', arrowEnd);
          if (close < 0) break;
          arrowEnd = close + 1;
        } else {
          arrowEnd++;
        }
      }
      return [part.slice(0, arrowEnd), part.slice(arrowEnd).trim()];
    }

    const matrixRows: string[][] = [];

    for (const rawRow of rawRows) {
      const parts = rawRow.split('@').map((p: string) => p.trim());

      if (isArrowRow(parts)) {
        // ── Arrow row: each @-part is arrow + entry ──
        const cells: string[] = [];
        cells.push(parts[0] ?? '');
        const maxArrows = Math.min(parts.length - 1, numEntries - 1);
        for (let pi = 1; pi <= maxArrows; pi++) {
          const [arrowStr, entryStr] = extractArrowAndEntry(parts[pi] ?? '');
          cells.push(parseCDArrow(arrowStr));
          cells.push(entryStr);
        }
        while (cells.length < targetCols) cells.push('');
        if (cells.length > targetCols) cells.length = targetCols;
        matrixRows.push(cells);

      } else {
        // ── Entry row: @-parts fill entry cells; arrow cells are empty ──
        // `.` adds 1 cell (empty arrow column)
        // `VVV/AAA` adds 2 cells (entry column with vertical arrow + empty arrow column)
        const cells: string[] = [];
        cells.push(parts[0] ?? ''); // first entry

        const maxParts = Math.min(parts.length - 1, numEntries - 1);
        for (let pi = 1; pi <= maxParts; pi++) {
          const [arrowStr, _entryStr] = extractArrowAndEntry(parts[pi] ?? '');
          const firstChar = arrowStr[0] ?? '';
          if (firstChar === 'V' || firstChar === 'A') {
            cells.push(parseCDArrow(arrowStr)); // entry column: vertical arrow
            cells.push('');                     // arrow column: empty
          } else {
            // `.` or anything else → null arrow, 1 cell
            cells.push('');
          }
        }

        while (cells.length < targetCols) cells.push('');
        if (cells.length > targetCols) cells.length = targetCols;
        matrixRows.push(cells);
      }
    }

    return '\\begin{matrix}' + matrixRows.map((r: string[]) => r.join(' & ')).join('\\\\') + '\\end{matrix}';
  });
}

function parseCDArrow(arrow: string): string {
  if (!arrow || arrow === '.') return '';

  // Extract all {...} labels and determine arrow type
  const labels: string[] = [];
  let arrowType = '';
  for (let i = 0; i < arrow.length; i++) {
    const ch = arrow[i]!;
    if (ch === '{') {
      const close = arrow.indexOf('}', i);
      if (close < 0) { labels.push(arrow.slice(i + 1)); break; }
      labels.push(arrow.slice(i + 1, close));
      i = close;
    } else if (/[><VA=]/.test(ch)) {
      if (!arrowType) arrowType = ch;
    }
  }

  if (!arrowType) return '';

  switch (arrowType) {
    case '>':
      if (labels.length === 0) return '\\to';
      if (labels.length === 1) return `\\xrightarrow{${labels[0]}}`;
      return `\\xrightarrow[${labels[1]}]{${labels[0]}}`;
    case '<':
      if (labels.length === 0) return '\\leftarrow';
      if (labels.length === 1) return `\\xleftarrow{${labels[0]}}`;
      return `\\xleftarrow[${labels[1]}]{${labels[0]}}`;
    case 'V':
      return labels.length > 0 ? `\\downarrow_{${labels[labels.length - 1]}}` : '\\downarrow';
    case 'A':
      return labels.length > 0 ? `\\uparrow^{${labels[labels.length - 1]}}` : '\\uparrow';
    case '=':
      return '\\doteq';
    default:
      return '';
  }
}

// ─── Conservative LaTeX repair ───────────────────────────
//
// Surgical fixes for common model hallucination patterns.
// Each fix is narrow in scope to avoid breaking valid LaTeX.
export function repairLatex(formula: string): string {
  if (!formula) return "";
  let s = formula;

  // ── 0. Convert \begin{CD}...\end{CD} to KaTeX-compatible matrix ──
  s = convertCDtoMatrix(s);

  // ── 1. Convert \big{ \Big{ \bigg{ \Bigg{ (and }) to explicit \bigl \bigr ──
  s = s
    .replace(/\\(big|Big|bigg|Bigg)\{/g, "\\$1l\\{")
    .replace(/\\(big|Big|bigg|Bigg)\}/g, "\\$1r\\}");

  // ── 2. \int{x} → \int_{x}, \sum{x} → \sum_{x} (model hallucination) ──
  s = s.replace(/\\(int|oint|iint|iiint|iiiint|sum|prod|coprod|bigotimes|bigoplus|bigodot|bigcup|bigcap|bigsqcup|bigvee|bigwedge)\s*\{/g, "\\$1_{");

  // ── 3. \text{lim} → \lim, \text{min} → \min etc. (common model mistake) ──
  s = s
    .replace(/\\text\s*\{\s*(lim|min|max|sup|inf|arg|min|arg|max|sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|log|ln|exp|det|deg|gcd|Pr|dim|hom|ker)\s*\}/g, "\\$1");

  // ── 3b. Protect \text{...} content from unicode mapping below
  // (unicode math chars like ° inside \text break KaTeX)
  const textBlocks: string[] = [];
  s = s.replace(/(\\text\{[^}]*\})/g, (m) => {
    const idx = textBlocks.length;
    textBlocks.push(m);
    return `\x00TEXT${idx}\x00`;
  });

  // ── 4. Map Unicode math symbols to LaTeX ──
  s = mapUnicodeMath(s);

  // ── 4b. Restore protected \text{...} blocks
  s = s.replace(/\x00TEXT(\d+)\x00/g, (_, idx) => textBlocks[+idx] ?? '');

  // ── 5. Escape # (macro parameter character breaks KaTeX) ──
  s = s.replace(/(?<!\\)#/g, '\\#');

  // ── 6. Balance \left / \right pairs ──
  const leftCnt = (s.match(/\\left\b/g) || []).length;
  const rightCnt = (s.match(/\\right\b/g) || []).length;
  if (leftCnt > rightCnt) s += ' \\right.'.repeat(leftCnt - rightCnt);
  else if (rightCnt > leftCnt) s = '\\left. '.repeat(rightCnt - leftCnt) + s;

  // ── 7. Strip \tag{...} and \label{...} inside align environments ──
  s = s.replace(/\\tag\s*\{[^}]*\}/g, '');
  s = s.replace(/\\label\s*\{[^}]*\}/g, '');

  // ── 8. Convert \\[<dimen>] to \\ (KaTeX doesn't support optional arg) ──
  s = s.replace(/\\\\\[\d+(?:\.\d+)?\s*(?:pt|ex|em|mm|cm|in|pc|mu)\]/g, '\\\\');

  // ── 9. Commands KaTeX doesn't support — convert to KaTeX-compatible forms ──
  // \intertext{...} → \text{...}\\  (inline text then newline)
  s = s.replace(/\\intertext\s*\{([^}]*)\}/g, "\\text{$1}\\\\");
  // \multicolumn{n}{align}{text} → {text}  (keep content, drop spanning)
  s = s.replace(/\\multicolumn\s*\{[^}]*\}\s*\{[^}]*\}\s*\{([^}]*)\}/g, "{$1}");
  // \genfrac{ldelim}{rdelim}{thick}{style}{num}{den} → \frac{num}{den}
  s = s.replace(/\\genfrac(\s*\{[^}]*\}){4}\s*\{([^}]*)\}\s*\{([^}]*)\}/g, "\\frac{$2}{$3}");
  // \xymatrix{...} / \halign{...} — let KaTeX fail naturally to RawLatexFallback

  // ── 10. Strip \hfill etc. in math mode ──
  s = s.replace(/\\hfill\b/g, ' ');

  // ── 11. Balance unbalanced braces (last resort safety net) ──
  s = balanceBraces(s);

  return s.trim();
}

function balanceBraces(s: string): string {
  let depth = 0;
  let lastOpenAt = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; } // skip next char (escaped)
    if (c === "{") { if (depth === 0) lastOpenAt = i; depth++; }
    else if (c === "}") {
      if (depth === 0) {
        // Stray close brace — drop it
        s = s.slice(0, i) + s.slice(i + 1);
        i--;
      } else { depth--; }
    }
  }
  // Unclosed opens — append matching closes
  if (depth > 0) s += "}".repeat(depth);
  return s;
}

// ─── Unicode → LaTeX mapping ─────────────────────────────
const UNICODE_TABLE: Array<[string, string]> = [
  // Integrals
  ["∮", "\\oint"], ["∬", "\\iint"], ["∭", "\\iiint"],
  ["∯", "\\oiint"], ["∰", "\\oiiint"],
  ["∱", "\\ointctrclockwise"], ["∲", "\\ointclockwise"], ["∳", "\\oint"],
  ["⨌", "\\iiiint"], ["⨍", "\\int"], ["⨎", "\\iint"],
  ["⨏", "\\int"], ["⨐", "\\int"], ["⨑", "\\int"],
  ["⨒", "\\iint"], ["⨓", "\\iiint"], ["⨔", "\\int"],
  ["⨕", "\\int"], ["⨖", "\\oiint"], ["⨗", "\\int"],
  ["⨘", "\\int"], ["⨙", "\\int"], ["⨚", "\\iint"],
  ["⨛", "\\iiint"], ["⨜", "\\int"],
  ["⨝", "\\Join"], ["⨞", "\\Join"], ["⨟", "\\diameter"],
  // Big operators
  ["∏", "\\prod"], ["∐", "\\coprod"], ["∑", "\\sum"],
  ["⊕", "\\oplus"], ["⊖", "\\ominus"], ["⊗", "\\otimes"],
  ["⊘", "\\oslash"], ["⊙", "\\odot"], ["⊚", "\\ocircle"], ["⊛", "\\ast"],
  ["⊎", "\\uplus"], ["⊓", "\\sqcap"], ["⊔", "\\sqcup"],
  ["∧", "\\land"], ["∨", "\\lor"], ["∩", "\\cap"], ["∪", "\\cup"],
  ["△", "\\triangle"], ["▽", "\\triangledown"],
  ["⨃", "\\cupdot"], ["⨄", "\\cupplus"], ["⨅", "\\sqcap"],
  // Roots & misc operators
  ["√", "\\sqrt"], ["∛", "\\sqrt[3]"], ["∜", "\\sqrt[4]"],
  ["∞", "\\infty"], ["∇", "\\nabla"], ["∂", "\\partial"],
  ["∆", "\\Delta"], ["∇", "\\nabla"],
  // Blackboard bold sets
  ["ℂ", "\\mathbb{C}"], ["ℕ", "\\mathbb{N}"], ["ℝ", "\\mathbb{R}"],
  ["ℚ", "\\mathbb{Q}"], ["ℤ", "\\mathbb{Z}"], ["ℍ", "\\mathbb{H}"],
  ["ℙ", "\\mathbb{P}"], ["𝔽", "\\mathbb{F}"], ["𝕂", "\\mathbb{K}"],
  ["𝔸", "\\mathbb{A}"], ["𝔹", "\\mathbb{B}"], ["𝔻", "\\mathbb{D}"],
  ["𝔼", "\\mathbb{E}"], ["𝔾", "\\mathbb{G}"], ["𝕀", "\\mathbb{I}"],
  ["𝕁", "\\mathbb{J}"], ["𝕃", "\\mathbb{L}"], ["𝕄", "\\mathbb{M}"],
  ["𝕆", "\\mathbb{O}"], ["𝕊", "\\mathbb{S}"], ["𝕋", "\\mathbb{T}"],
  ["𝕌", "\\mathbb{U}"], ["𝕍", "\\mathbb{V}"], ["𝕎", "\\mathbb{W}"],
  ["𝕏", "\\mathbb{X}"], ["𝕐", "\\mathbb{Y}"],
  // Caligraphic (script)
  ["ℬ", "\\mathcal{B}"], ["ℰ", "\\mathcal{E}"], ["ℱ", "\\mathcal{F}"],
  ["ℋ", "\\mathcal{H}"], ["ℐ", "\\mathcal{I}"], ["ℒ", "\\mathcal{L}"],
  ["ℳ", "\\mathcal{M}"], ["ℛ", "\\mathcal{R}"],
  ["𝒜", "\\mathcal{A}"], ["𝒞", "\\mathcal{C}"], ["𝒟", "\\mathcal{D}"],
  ["𝒢", "\\mathcal{G}"], ["𝒥", "\\mathcal{J}"], ["𝒦", "\\mathcal{K}"],
  ["𝒩", "\\mathcal{N}"], ["𝒪", "\\mathcal{O}"], ["𝒫", "\\mathcal{P}"],
  ["𝒬", "\\mathcal{Q}"], ["𝒮", "\\mathcal{S}"], ["𝒯", "\\mathcal{T}"],
  ["𝒰", "\\mathcal{U}"], ["𝒱", "\\mathcal{V}"], ["𝒲", "\\mathcal{W}"],
  ["𝒳", "\\mathcal{X}"], ["𝒴", "\\mathcal{Y}"], ["𝒵", "\\mathcal{Z}"],
  // Fraktur
  ["ℑ", "\\mathfrak{I}"], ["ℜ", "\\mathfrak{R}"], ["ℌ", "\\mathfrak{H}"],
  ["ℨ", "\\mathfrak{Z}"],
  ["𝔄", "\\mathfrak{A}"], ["𝔅", "\\mathfrak{B}"], ["𝔇", "\\mathfrak{D}"],
  ["𝔈", "\\mathfrak{E}"], ["𝔉", "\\mathfrak{F}"], ["𝔊", "\\mathfrak{G}"],
  ["𝔍", "\\mathfrak{J}"], ["𝔎", "\\mathfrak{K}"], ["𝔏", "\\mathfrak{L}"],
  ["𝔐", "\\mathfrak{M}"], ["𝔑", "\\mathfrak{N}"], ["𝔒", "\\mathfrak{O}"],
  ["𝔓", "\\mathfrak{P}"], ["𝔔", "\\mathfrak{Q}"], ["𝔖", "\\mathfrak{S}"],
  ["𝔗", "\\mathfrak{T}"], ["𝔘", "\\mathfrak{U}"], ["𝔙", "\\mathfrak{V}"],
  ["𝔚", "\\mathfrak{W}"], ["𝔛", "\\mathfrak{X}"], ["𝔜", "\\mathfrak{Y}"],
  // Hebrew
  ["ℵ", "\\aleph"], ["ℶ", "\\beth"], ["ℷ", "\\gimel"], ["ℸ", "\\daleth"],
  // Subscripts
  ["₀", "_{0}"], ["₁", "_{1}"], ["₂", "_{2}"], ["₃", "_{3}"], ["₄", "_{4}"],
  ["₅", "_{5}"], ["₆", "_{6}"], ["₇", "_{7}"], ["₈", "_{8}"], ["₉", "_{9}"],
  ["₊", "_{+}"], ["₋", "_{-}"], ["₌", "_{=}",], ["₍", "_{"], ["₎", "}"],
  ["ₐ", "_{a}"], ["ₑ", "_{e}"], ["ₒ", "_{o}"], ["ₓ", "_{x}"],
  ["ₕ", "_{h}"], ["ₖ", "_{k}"], ["ₗ", "_{l}"], ["ₘ", "_{m}"], ["ₙ", "_{n}"],
  ["ₚ", "_{p}"], ["ₛ", "_{s}"], ["ₜ", "_{t}"],
  // Superscripts
  ["⁰", "^{0}"], ["¹", "^{1}"], ["²", "^{2}"], ["³", "^{3}"], ["⁴", "^{4}"],
  ["⁵", "^{5}"], ["⁶", "^{6}"], ["⁷", "^{7}"], ["⁸", "^{8}"], ["⁹", "^{9}"],
  ["⁺", "^{+}"], ["⁻", "^{-}"], ["⁼", "^{=}"], ["⁽", "^{"], ["⁾", "}"],
  ["ⁿ", "^{n}"], ["ⁱ", "^{i}"],
  // Arrows
  ["→", "\\to"], ["←", "\\leftarrow"], ["↔", "\\leftrightarrow"],
  ["⇒", "\\Rightarrow"], ["⇐", "\\Leftarrow"], ["⇔", "\\Leftrightarrow"],
  ["↦", "\\mapsto"], ["↪", "\\hookrightarrow"], ["↩", "\\hookleftarrow"],
  ["⇀", "\\rightharpoonup"], ["↽", "\\leftharpoonup"],
  ["⇁", "\\rightharpoondown"], ["⇌", "\\rightleftharpoons"],
  ["⟶", "\\longrightarrow"], ["⟵", "\\longleftarrow"],
  ["⟷", "\\longleftrightarrow"], ["⟹", "\\Longrightarrow"],
  ["⟸", "\\Longleftarrow"], ["⟺", "\\Longleftrightarrow"],
  ["⟴", "\\rightarrowtail"], ["⟶", "\\longrightarrow"],
  ["↗", "\\nearrow"], ["↘", "\\searrow"], ["↙", "\\swarrow"], ["↖", "\\nwarrow"],
  ["⇉", "\\rightrightarrows"], ["⇈", "\\upuparrows"],
  ["⇊", "\\downdownarrows"], ["⇋", "\\leftarrowtail"],
  // Operators
  ["⋅", "\\cdot"], ["·", "\\cdot"], ["×", "\\times"], ["÷", "\\div"],
  ["±", "\\pm"], ["∓", "\\mp"],
  ["∧", "\\wedge"], ["∨", "\\vee"], ["¬", "\\neg"],
  ["∀", "\\forall"], ["∃", "\\exists"], ["∄", "\\nexists"],
  // Relations
  ["∈", "\\in"], ["∋", "\\ni"], ["∉", "\\notin"], ["∌", "\\not\\ni"],
  ["⊂", "\\subset"], ["⊃", "\\supset"], ["⊆", "\\subseteq"], ["⊇", "\\supseteq"],
  ["⊊", "\\subsetneq"], ["⊋", "\\supsetneq"], ["⊏", "\\sqsubset"], ["⊐", "\\sqsupset"],
  ["⊑", "\\sqsubseteq"], ["⊒", "\\sqsupseteq"],
  ["∪", "\\cup"], ["∩", "\\cap"], ["∖", "\\setminus"], ["△", "\\triangle"],
  ["△", "\\bigtriangleup"], ["▽", "\\bigtriangledown"],
  ["≤", "\\le"], ["≤", "\\leq"], ["≥", "\\ge"], ["≥", "\\geq"],
  ["≦", "\\leqq"], ["≧", "\\geqq"], ["≲", "\\lesssim"], ["≳", "\\gtrsim"],
  ["≪", "\\ll"], ["≫", "\\gg"],
  ["≠", "\\ne"], ["≠", "\\neq"], ["≡", "\\equiv"], ["≈", "\\approx"],
  ["≅", "\\cong"], ["∼", "\\sim"], ["∽", "\\backsim"], ["∾", "\\lazysim"],
  ["≃", "\\simeq"], ["⋍", "\\backsimeq"],
  ["≍", "\\asymp"], ["∥", "\\parallel"], ["∦", "\\nparallel"],
  ["∝", "\\propto"], ["⊥", "\\perp"], ["∠", "\\angle"], ["∡", "\\measuredangle"], ["∢", "\\sphericalangle"],
  ["⋄", "\\diamond"], ["⋆", "\\star"], ["∗", "\\ast"], ["∘", "\\circ"],
  ["∙", "\\bullet"], ["⌃", "\\wedge"],
  // Brackets
  ["⟨", "\\langle "], ["⟩", "\\rangle "],
  ["⟦", "\\llbracket"], ["⟧", "\\rrbracket"],
  ["⌈", "\\lceil"], ["⌉", "\\rceil"], ["⌊", "\\lfloor"], ["⌋", "\\rfloor"],
  ["⟪", "\\langle\\!\\langle "], ["⟫", "\\rangle\\!\\rangle "],
  // Misc
  ["ℏ", "\\hbar"], ["ℓ", "\\ell"], ["ℊ", "g"], ["℘", "\\wp"],
  ["ℜ", "\\Re"], ["ℑ", "\\Im"], ["Ⅼ", "\\mathcal{L}"],
  ["…", "\\ldots"], ["⋯", "\\cdots"], ["⋮", "\\vdots"], ["⋱", "\\ddots"],
  ["°", "^{\\circ}"], ["′", "^{\\prime}"], ["″", "^{\\prime\\prime}"], ["‴", "^{\\prime\\prime\\prime}"],
  ["‵", "\\backprime"], ["‶", "\\backprime\\backprime"],
  ["№", "\\text{No.}"], ["§", "\\S"], ["¶", "\\P"],
  ["©", "\\copyright"], ["®", "\\textcircled{\\textsf{R}}"], ["™", "\\texttrademark"],
  ["¥", "\\textyen"], ["£", "\\textsterling"], ["€", "\\euro"],
  // Greek (in case model uses Unicode Greek)
  ["α", "\\alpha"], ["β", "\\beta"], ["γ", "\\gamma"], ["δ", "\\delta"],
  ["ε", "\\epsilon"], ["ϵ", "\\varepsilon"], ["ζ", "\\zeta"], ["η", "\\eta"],
  ["θ", "\\theta"], ["ϑ", "\\vartheta"], ["ι", "\\iota"], ["κ", "\\kappa"],
  ["ϰ", "\\varkappa"], ["λ", "\\lambda"], ["μ", "\\mu"], ["ν", "\\nu"],
  ["ξ", "\\xi"], ["π", "\\pi"], ["ϖ", "\\varpi"], ["ρ", "\\rho"],
  ["ϱ", "\\varrho"], ["σ", "\\sigma"], ["ς", "\\varsigma"], ["τ", "\\tau"],
  ["υ", "\\upsilon"], ["φ", "\\phi"], ["ϕ", "\\varphi"], ["χ", "\\chi"],
  ["ψ", "\\psi"], ["ω", "\\omega"],
  ["Γ", "\\Gamma"], ["Δ", "\\Delta"], ["Θ", "\\Theta"], ["Λ", "\\Lambda"],
  ["Ξ", "\\Xi"], ["Π", "\\Pi"], ["Σ", "\\Sigma"], ["Υ", "\\Upsilon"],
  ["Φ", "\\Phi"], ["Ψ", "\\Psi"], ["Ω", "\\Omega"],
  // Punctuation
  ["—", "\\text{---}"], ["–", "\\text{--}"], ["•", "\\bullet"],
  // Tilde etc.
  ["˜", "\\~{}"], ["¯", "\\bar{}"], ["´", "\\'{}"], ["`", "\\`{}"],
  ["ˆ", "\\^{}"], ["˚", "\\mathring{}"],
  // Misc symbols
  ["♠", "\\spadesuit"], ["♥", "\\heartsuit"], ["♦", "\\diamondsuit"], ["♣", "\\clubsuit"],
  ["∅", "\\emptyset"], ["Ø", "\\emptyset"],
  ["✓", "\\checkmark"], ["✗", "\\text{✗}"],
  ["☐", "\\Box"], ["☑", "\\text{☑}"], ["☒", "\\text{☒}"],
];

function mapUnicodeMath(s: string): string {
  // Mathematical Alphanumeric Symbols block (U+1D400–U+1D7FF) — full mapping
  // Bold A–Z (1D400–1D419), a–z (1D41A–1D433)
  s = s.replace(/[\u{1D400}-\u{1D419}]/gu, (ch) => `\\mathbf{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D400 + 0x41)}}`);
  s = s.replace(/[\u{1D41A}-\u{1D433}]/gu, (ch) => `\\mathbf{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D41A + 0x61)}}`);
  // Italic A–Z (1D434–1D44D), a–z (1D44E–1D467)
  s = s.replace(/[\u{1D434}-\u{1D44D}]/gu, (ch) => `\\mathit{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D434 + 0x41)}}`);
  s = s.replace(/[\u{1D44E}-\u{1D467}]/gu, (ch) => `\\mathit{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D44E + 0x61)}}`);
  // Bold Italic A–Z (1D468–1D481), a–z (1D482–1D49B)
  s = s.replace(/[\u{1D468}-\u{1D481}]/gu, (ch) => `\\boldsymbol{\\mathit{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D468 + 0x41)}}}`);
  s = s.replace(/[\u{1D482}-\u{1D49B}]/gu, (ch) => `\\boldsymbol{\\mathit{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D482 + 0x61)}}}`);
  // Script (caligraphic) A–Z (1D49C–1D4B5), a–z (1D4B6–1D4CF)
  s = s.replace(/[\u{1D49C}-\u{1D4B5}]/gu, (ch) => `\\mathcal{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D49C + 0x41)}}`);
  s = s.replace(/[\u{1D4B6}-\u{1D4CF}]/gu, (ch) => `\\mathcal{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D4B6 + 0x61)}}`);
  // Fraktur A–Z (1D504–1D51D), a–z (1D51E–1D537)
  s = s.replace(/[\u{1D504}-\u{1D51D}]/gu, (ch) => `\\mathfrak{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D504 + 0x41)}}`);
  s = s.replace(/[\u{1D51E}-\u{1D537}]/gu, (ch) => `\\mathfrak{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D51E + 0x61)}}`);
  // Double-struck A–Z (1D538–1D551), a–z (1D552–1D56B), 0–9 (1D7D8–1D7E1)
  s = s.replace(/[\u{1D538}-\u{1D551}]/gu, (ch) => `\\mathbb{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D538 + 0x41)}}`);
  s = s.replace(/[\u{1D552}-\u{1D56B}]/gu, (ch) => `\\mathbb{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D552 + 0x61)}}`);
  s = s.replace(/[\u{1D7D8}-\u{1D7E1}]/gu, (ch) => `\\mathbb{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D7D8 + 0x30)}}`);
  // Bold Fraktur A–Z (1D56C–1D585), a–z (1D586–1D59F)
  s = s.replace(/[\u{1D56C}-\u{1D585}]/gu, (ch) => `\\mathfrak{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D56C + 0x41)}}`);
  s = s.replace(/[\u{1D586}-\u{1D59F}]/gu, (ch) => `\\mathfrak{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D586 + 0x61)}}`);
  // Sans-serif A–Z (1D5A0–1D5B9), a–z (1D5BA–1D5D3), 0–9 (1D7E2–1D7EB)
  s = s.replace(/[\u{1D5A0}-\u{1D5B9}]/gu, (ch) => `\\mathsf{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D5A0 + 0x41)}}`);
  s = s.replace(/[\u{1D5BA}-\u{1D5D3}]/gu, (ch) => `\\mathsf{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D5BA + 0x61)}}`);
  s = s.replace(/[\u{1D7E2}-\u{1D7EB}]/gu, (ch) => `\\mathsf{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D7E2 + 0x30)}}`);
  // Sans-serif Bold A–Z (1D5D4–1D5ED), a–z (1D5EE–1D607), 0–9 (1D7EC–1D7F5)
  s = s.replace(/[\u{1D5D4}-\u{1D5ED}]/gu, (ch) => `\\mathbf{\\mathsf{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D5D4 + 0x41)}}}`);
  s = s.replace(/[\u{1D5EE}-\u{1D607}]/gu, (ch) => `\\mathbf{\\mathsf{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D5EE + 0x61)}}}`);
  s = s.replace(/[\u{1D7EC}-\u{1D7F5}]/gu, (ch) => `\\mathbf{\\mathsf{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D7EC + 0x30)}}`);
  // Sans-serif Italic A–Z (1D608–1D621), a–z (1D622–1D63B)
  s = s.replace(/[\u{1D608}-\u{1D621}]/gu, (ch) => `\\mathit{\\mathsf{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D608 + 0x41)}}}`);
  s = s.replace(/[\u{1D622}-\u{1D63B}]/gu, (ch) => `\\mathit{\\mathsf{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D622 + 0x61)}}}`);
  // Monospace A–Z (1D670–1D689), a–z (1D68A–1D6A3), 0–9 (1D7F6–1D7FF)
  s = s.replace(/[\u{1D670}-\u{1D689}]/gu, (ch) => `\\mathtt{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D670 + 0x41)}}`);
  s = s.replace(/[\u{1D68A}-\u{1D6A3}]/gu, (ch) => `\\mathtt{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D68A + 0x61)}}`);
  s = s.replace(/[\u{1D7F6}-\u{1D7FF}]/gu, (ch) => `\\mathtt{${String.fromCodePoint(ch.codePointAt(0)! - 0x1D7F6 + 0x30)}}`);

  // Apply the per-character table
  for (const [uni, tex] of UNICODE_TABLE) {
    if (s.indexOf(uni) !== -1) s = s.split(uni).join(tex);
  }
  return s;
}

// ─── Math Components ─────────────────────────────────────
export function InlineMath({ formula }: { formula: string }) {
  // Route directly to MathJax for features KaTeX doesn't support
  if (needsMathJax(formula)) {
    return <MathJaxRenderer formula={formula} display={false} />;
  }

  const html = useMemo(() => {
    if (!formula) return "";
    const kt = (katex as any).default || katex;
    if (!kt || typeof kt.renderToString !== "function") return "";
    try {
      const repaired = repairLatex(formula);
      const result = kt.renderToString(repaired, {
        throwOnError: false,
        displayMode: false,
        strict: "ignore",
        trust: true,
        output: "html",
        macros: MACROS,
      });
      if (/class=["'][^"']*\bkatex-error\b/.test(result) || result.includes("ParseError")) {
        return "";
      }
      return result;
    } catch (e) {
      return "";
    }
  }, [formula]);

  useEffect(() => {
    if (/\\(ce|pu)\b/.test(formula)) {
      ensureMhchem();
    }
  }, [formula]);

  if (!html) {
    return <RawLatexFallback formula={formula} display={false} />;
  }
  return (
    <span
      dangerouslySetInnerHTML={{ __html: html }}
      className="inline-math-container inline-flex align-middle max-w-full overflow-x-auto overflow-y-hidden"
      style={{ overflowX: 'auto', overflowY: 'hidden', maxWidth: '100%', display: 'inline-flex', verticalAlign: 'middle' }}
    />
  );
}

function DisplayMath({ formula }: { formula: string }) {
  // Route directly to MathJax for features KaTeX doesn't support
  if (needsMathJax(formula)) {
    return <MathJaxRenderer formula={formula} display={true} />;
  }

  const html = useMemo(() => {
    if (!formula) return "";
    const kt = (katex as any).default || katex;
    if (!kt || typeof kt.renderToString !== "function") return "";
    let clean = formula.trim()
      .replace(/^(\\\[|\$\$)/, "")
      .replace(/(\\\]|\$\$)$/, "")
      .trim();
    try {
      const repaired = repairLatex(clean);
      const result = kt.renderToString(repaired, {
        throwOnError: false,
        displayMode: true,
        strict: "ignore",
        trust: true,
        output: "html",
        macros: MACROS,
      });
      if (/class=["'][^"']*\bkatex-error\b/.test(result) || result.includes("ParseError")) {
        return "";
      }
      return result;
    } catch (e) {
      return "";
    }
  }, [formula]);

  useEffect(() => {
    if (/\\(ce|pu)\b/.test(formula)) {
      ensureMhchem();
    }
  }, [formula]);

  if (!html) {
    return <RawLatexFallback formula={formula} display={true} />;
  }
  return (
    <span
      className="my-4 text-center overflow-x-auto max-w-full py-2 block"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ─── Lazy load mermaid ────────────────────────────────────
let mermaid: any = null;
const loadMermaid = async () => {
  if (!mermaid) {
    try {
      const mod = await import("mermaid");
      mermaid = mod.default || mod;
      if (mermaid && typeof mermaid.initialize === "function") {
        mermaid.initialize({ startOnLoad: false, theme: "dark" });
        mermaid.parseError = () => {};
      }
      if ((mermaid as any).logger) {
        (mermaid as any).logger.warn = () => {};
        (mermaid as any).logger.error = () => {};
      }
    } catch (e) { console.error("Mermaid load error:", e); }
  }
  return mermaid;
};

// ─── SMILES / Molecular Structure Renderer ──────────────
function SmilesRenderer({ smiles }: { smiles: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "rendered" | "error">("loading");
  const [isLight, setIsLight] = useState(
    () => document.documentElement.classList.contains('light')
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsLight(document.documentElement.classList.contains('light'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!ref.current || !smiles) return;
    setState("loading");

    try {
      const clean = SmilesDrawer.clean(smiles);
      if (!clean) { setState("error"); return; }

      const drawer = new SmilesDrawer.Drawer({
        width: 400,
        height: 300,
        padding: 20,
      });

      SmilesDrawer.parse(clean, (tree: any) => {
        if (!ref.current) return;
        const theme = isLight ? "light" : "dark";
        drawer.draw(tree, ref.current as unknown as HTMLCanvasElement, theme, false);
        setState("rendered");
      }, (err: any) => {
        console.error("SMILES parse error:", err);
        setState("error");
      });
    } catch (e) {
      console.error("SMILES render error:", e);
      setState("error");
    }
  }, [smiles, isLight]);

  if (state === "error") {
    return (
      <div className="my-4 rounded-card border border-[var(--att-caution)]/30 bg-[var(--att-caution)]/5 p-4">
        <p className="text-xs font-medium text-caution-text mb-1">⚠ Could not render molecular structure</p>
        <p className="text-[11px] text-ink-2 mb-1">Invalid or unsupported SMILES string.</p>
        <pre className="text-[11px] font-mono text-ink-3 whitespace-pre-wrap">{smiles}</pre>
      </div>
    );
  }

  return (
    <div className="my-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-medium text-ink-2 bg-surface-3 px-1.5 py-0.5 rounded">SMILES</span>
      </div>
      {state === "loading" && (
        <div className="flex items-center justify-center gap-2 py-8 text-ink-3">
          <svg className="animate-spin size-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/></svg>
          <span className="text-xs">Rendering SMILES structure...</span>
        </div>
      )}
      <div ref={ref} className="flex justify-center" style={{ minHeight: 80 }} />
    </div>
  );
}

// ─── TikZ Renderer ───────────────────────────────────────
let tikzPromise: Promise<boolean> | null = null;

function loadTikzjax(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if ((window as any).__tikzjaxLoaded) return Promise.resolve(true);
  if (tikzPromise) return tikzPromise;

  tikzPromise = new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/tikzjax@latest/dist/fonts.css";
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);

    const script = document.createElement("script");
    const isDark = document.documentElement.classList.contains("dark");
    const theme = isDark ? "dark" : "light";
    const styles = [
      "body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }",
      `svg text { fill: ${isDark ? "#d4d1cb" : "#1a1a1a"}; }`,
      `svg .TikZGraphic path:not([fill]), svg .TikZGraphic line { stroke: ${isDark ? "#d4d1cb" : "#1a1a1a"}; }`,
    ].join("");
    script.textContent = `document.addEventListener("DOMContentLoaded",()=>{const s=document.createElement("style");s.textContent=${JSON.stringify(styles)};document.head.appendChild(s)});`;
    document.head.appendChild(script);

    const mainScript = document.createElement("script");
    mainScript.src = "https://cdn.jsdelivr.net/npm/tikzjax@latest/dist/tikzjax.js";
    mainScript.crossOrigin = "anonymous";
    mainScript.onload = () => {
      (window as any).__tikzjaxLoaded = true;
      resolve(true);
    };
    mainScript.onerror = () => {
      console.error("Failed to load TikZJax from CDN");
      resolve(false);
    };
    document.head.appendChild(mainScript);
  });

  return tikzPromise;
}

function TikzRenderer({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "rendered" | "error">("loading");
  const renderedRef = useRef(false);

  useEffect(() => {
    if (!ref.current || !code || renderedRef.current) return;
    renderedRef.current = true;
    setState("loading");

    (async () => {
      const loaded = await loadTikzjax();
      if (!ref.current) return;
      if (!loaded) { setState("error"); return; }

      const script = document.createElement("script");
      script.type = "text/tikz";
      script.textContent = code;
      ref.current.appendChild(script);

      // tikzjax auto-renders all <script type="text/tikz"> on load,
      // but if it loaded before us we need to trigger render
      const tz = (window as any).tikzjax;
      if (tz && typeof tz.render === "function") {
        try {
          tz.render();
          // tikzjax renders async — wait a frame then check
          requestAnimationFrame(() => {
            if (ref.current) setState("rendered");
          });
        } catch (e) {
          console.error("TikZJax render error:", e);
          setState("error");
        }
      } else {
        // Wait for tikzjax to auto-discover our script
        const check = setInterval(() => {
          if (ref.current && ref.current.querySelector("svg")) {
            clearInterval(check);
            setState("rendered");
          }
        }, 100);
        setTimeout(() => { clearInterval(check); if (ref.current && !ref.current.querySelector("svg")) setState("error"); }, 8000);
      }
    })();
  }, [code]);

  if (state === "error") {
    return (
      <div className="my-4 rounded-card border border-[var(--att-caution)]/30 bg-[var(--att-caution)]/5 p-4 text-center">
        <p className="text-xs font-medium text-caution-text mb-1">⚠ TikZ render failed</p>
        <p className="text-[11px] text-ink-2 mb-2">Could not render TikZ diagram. Make sure <code className="inline-code">tikzjax</code> loaded correctly.</p>
        <details className="text-left">
          <summary className="text-[11px] text-ink-2 cursor-pointer hover:text-ink-1">Show TeX source</summary>
          <pre className="text-[11px] font-mono text-ink-1 whitespace-pre-wrap mt-2 p-2 rounded-card bg-surface-2">{code}</pre>
        </details>
      </div>
    );
  }

  return (
    <div className="tikz-renderer my-4">
      {state === "loading" && (
        <div className="flex items-center justify-center gap-2 py-8 text-ink-3">
          <svg className="animate-spin size-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/></svg>
          <span className="text-xs">Rendering TikZ diagram...</span>
        </div>
      )}
      <div ref={ref} className="flex justify-center overflow-x-auto" style={{ opacity: state === "rendered" ? 1 : 0 }} />
    </div>
  );
}

// ─── Music Notation Renderer (uses abcjs for ABC notation, NOT LilyPond) ──
// NOTE: This renders ABC notation (https://abcnotation.com), not LilyPond.
// LilyPond → web requires server-side compilation; abcjs is used as a portable
// client-side alternative that handles the common use case.
let abcjs: any = null;
const loadAbcjs = async () => {
  if (!abcjs) {
    try {
      const mod = await import("abcjs/dist/abcjs-basic");
      abcjs = mod.default || mod;
    } catch (e) { console.error("abcjs load error:", e); }
  }
  return abcjs;
};

function MusicRenderer({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    (async () => {
      if (ref.current && code) {
        try {
          const lib = await loadAbcjs();
          if (lib && typeof lib.renderAbc === "function") {
            ref.current.innerHTML = "";
            lib.renderAbc(ref.current, code, {
              responsive: "resize",
              theme: "dark",
              paddingtop: 0, paddingbottom: 0, paddingright: 0, paddingleft: 0,
            });
          }
        } catch (e) {
          console.error("abcjs render error:", e);
          setError("Failed to render ABC notation");
        }
      }
    })();
  }, [code]);
  if (error) {
    return (
      <div className="my-4 rounded-card border border-[var(--att-caution)]/30 bg-[var(--att-caution)]/5 p-4">
        <p className="text-xs font-medium text-caution-text mb-1">⚠ Music render error</p>
        <p className="text-[11px] text-ink-2">{error}</p>
        <pre className="text-[11px] font-mono text-ink-3 mt-2 whitespace-pre-wrap">{code}</pre>
      </div>
    );
  }
  return (
    <div className="my-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-medium text-ink-2 bg-surface-3 px-1.5 py-0.5 rounded">ABC notation</span>
      </div>
      <div ref={ref} className="bg-surface-2 rounded-card p-4 overflow-x-auto" />
    </div>
  );
}

// ─── Mermaid Renderer ────────────────────────────────────
function MermaidRenderer({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const attemptedRef = useRef(false);
  useEffect(() => {
    attemptedRef.current = false;
    let cancelled = false;
    (async () => {
      const m = await loadMermaid();
      if (!ref.current || !m || cancelled) return;
      attemptedRef.current = true;
      try {
        if (typeof (m as any).parse === "function") {
          try { (m as any).parse(code); } catch { return; }
        }
        const id = "mermaid-" + Math.random().toString(36).substr(2, 9);
        const { svg } = await m.render(id, code);
        if (!cancelled) { ref.current.innerHTML = svg; setError(null); }
      } catch {
        if (!cancelled) setError("Failed to render Mermaid");
      }
    })();
    return () => { cancelled = true; };
  }, [code]);
  if (error) return <p className="text-critical-text text-sm my-2">! {error}</p>;
  return <div ref={ref} className="mermaid-renderer my-4 overflow-x-auto" />;
}

// ─── Code Block ──────────────────────────────────────────
function CodeBlock({ language, code, onHtmlPreview }: { language: string; code: string; onHtmlPreview?: (html: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [isLight, setIsLight] = useState(
    () => document.documentElement.classList.contains('light')
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsLight(document.documentElement.classList.contains('light'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isHtml = language === "html";
  const syntaxTheme = isLight ? oneLight : vscDarkPlus;
  return (
    <div className="code-block-wrapper group my-4">
      <div className="code-block-header">
        <div className="flex items-center gap-2">
          <span className="rounded bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-ink-2">{language || "text"}</span>
          {code.split("\n").length > 20 && (
            <button onClick={() => setCollapsed(!collapsed)} className="sd-press flex items-center gap-1 text-[11px] text-ink-2 hover:text-ink-1">
              <ChevronDown className={`size-3 transition-transform ${collapsed ? "" : "rotate-180"}`} />
              {collapsed ? "Expand" : "Collapse"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {isHtml && onHtmlPreview && (
            <button
              onClick={() => onHtmlPreview(code)}
              className="sd-press flex items-center gap-1 text-[11px] font-medium text-safe-text hover:text-safe transition-colors"
              title="Run HTML preview"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              Preview
            </button>
          )}
          <button onClick={handleCopy} className="sd-press flex items-center gap-1.5 text-[11px] text-ink-2 hover:text-ink-1">
            {copied ? <Check className="size-3.5 text-safe-text" /> : <Copy className="size-3.5" />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
      <div className={`overflow-auto transition-all duration-300 ${collapsed ? "max-h-0" : "max-h-[800px]"}`}>
        <SyntaxHighlighter
          language={language || "text"}
          style={syntaxTheme}
          customStyle={{ margin: 0, borderRadius: "0", background: "transparent", padding: "0.75rem", overflowX: "auto" }}
          codeTagProps={{ style: { fontFamily: "JetBrains Mono, monospace", fontSize: "0.75rem" } }}
        >{code}</SyntaxHighlighter>
      </div>
    </div>
  );
}

// ─── Inline Formatting ───────────────────────────────────
function linkifyUrls(text: string, keyPrefix: string): React.ReactNode[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.split(urlRegex).map((part, idx) => {
    if (part.match(/^https?:\/\/[^\s]+$/)) {
      return <a key={`${keyPrefix}url-${idx}`} href={part} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline break-all">{part}</a>;
    }
    return <span key={`${keyPrefix}text-${idx}`}>{part}</span>;
  });
}

function splitWithDelimiters(text: string, regex: RegExp): { type: "delimiter" | "text"; value: string }[] {
  const parts: { type: "delimiter" | "text"; value: string }[] = [];
  if (typeof text !== "string") return parts;
  let lastIdx = 0;
  let match;
  const safeRegex = new RegExp(regex.source, regex.flags);
  while ((match = safeRegex.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push({ type: "text", value: text.slice(lastIdx, match.index) });
    parts.push({ type: "delimiter", value: match[0] });
    lastIdx = match.index + match[0].length;
    if (!safeRegex.global) break;
  }
  if (lastIdx < text.length) parts.push({ type: "text", value: text.slice(lastIdx) });
  return parts;
}

// ── Note: [a-zA-Z*]+ (was [a-z*]+) so that \begin{CD}, \begin{Bmatrix}, etc. match ──
const INLINE_DELIM_REGEX = /(\$\$[\s\S]+?\$\$|(?<!\\)\\\[(?!-?\d+pt)[\s\S]+?\\\]|(\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\})|`[^`]+`|\*\*[\s\S]+?\*\*|__[\s\S]+?__|\*(?!\*)[\s\S]+?\*|_(?!_)[\s\S]+?_|\\\(.+?\\\)|\\\[.+?\\\]|\$(?!-?\d[\d.,%]*\$).+?\$|\[\d+\])/g;

function CitationHoverCard({ url, content, children }: { url: string; content?: string; children: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const domain = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return url; } })();
  return (
    <span className="relative inline" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {children}
      {hovered && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2.5 rounded-lg border border-line bg-surface-3 shadow-xl z-50 w-80 pointer-events-none">
          <span className="flex items-center gap-2 mb-2">
            <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`} alt="" className="size-4 rounded shrink-0" />
            <span className="text-ink-1 font-medium text-xs truncate">{domain}</span>
          </span>
          {content && <span className="text-ink-2 text-[11px] leading-relaxed block">{content}</span>}
          {!content && <span className="text-ink-2 text-[11px] truncate block">{url}</span>}
        </span>
      )}
    </span>
  );
}

function formatInlineText(text: string, onCitationClick: any, sources: Source[], parentKey: string): React.ReactNode[] {
  if (typeof text !== "string") return [];
  return splitWithDelimiters(text, INLINE_DELIM_REGEX).flatMap((part, partIdx) => {
    const key = `${parentKey}-p${partIdx}`;
    if (part.type === "text") return linkifyUrls(part.value, key);
    const val = part.value;
    if (val.startsWith("\\begin{") || val.startsWith("$$") || (val.startsWith("\\[") && val.length > 10)) return <DisplayMath key={key} formula={val} />;
    if (val.startsWith("`")) return <code key={key} className="inline-code">{val.slice(1, -1)}</code>;
    if (val.startsWith("**") || val.startsWith("__")) return <strong key={key} className="font-bold text-ink-1">{formatInlineText(val.slice(2, -2), onCitationClick, sources, key)}</strong>;
    if (val.startsWith("*") || val.startsWith("_")) return <em key={key} className="italic">{formatInlineText(val.slice(1, -1), onCitationClick, sources, key)}</em>;
    if (val.startsWith("$") || val.startsWith("\\(")) {
      const inner = val.replace(/^(\$|\\\()/, "").replace(/(\$|\\\))$/, "");
      return <InlineMath key={key} formula={inner} />;
    }
    const cMatch = val.match(/^\[(\d+)\]$/);
    if (cMatch) {
      const num = Number(cMatch[1]);
      const idx = num - 1;
      const name = sources[idx]?.url ? getDomain(sources[idx].url) : `[${num}]`;
      const url = sources[idx]?.url;
      return <CitationHoverCard key={key} url={url || ''} content={sources[idx]?.content}><button onClick={() => { onCitationClick(idx); if (url) window.open(url, "_blank"); }} className="citation-btn text-[0.7em] align-super ml-0.5">{name}</button></CitationHoverCard>;
    }
    return <span key={key}>{val}</span>;
  });
}

function stripJsonComments(raw: string): string {
  return raw.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
}

function parseTable(lines: string[], startIndex: number) {
  const rows: string[][] = [];
  let i = startIndex;
  while (i < lines.length && lines[i]?.trim().startsWith("|") && lines[i]?.trim().endsWith("|")) {
    const row = lines[i]!.trim().slice(1, -1).split("|").map(c => c.trim());
    if (!row.every(c => c.match(/^[:\s-]+$/))) rows.push(row);
    i++;
  }
  return { rows, nextIndex: i };
}

function downloadTableAsCsv(rows: string[][], tableIndex: number) {
  const header = rows[0] ?? [];
  const data = rows.slice(1);
  const csvContent = [
    header.map(c => `"${c.replace(/"/g, '""')}"`).join(","),
    ...data.map(row => header.map((_, ci) => `"${(row[ci] ?? "").replace(/"/g, '""')}"`).join(",")),
  ].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `table-${tableIndex + 1}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function parseList(lines: string[], startIndex: number) {
  const items: { level: number; text: string; type: "ol" | "ul" }[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    const match = line.match(/^(\s*)([-*•]|\d+\.)\s+(.+)$/);
    if (!match) break;
    items.push({ level: match[1]!.length, text: match[3]!, type: match[2]!.match(/\d/) ? "ol" : "ul" });
    i++;
  }
  return { items, nextIndex: i };
}

function renderList(items: any[], onCitationClick: any, sources: Source[], parentKey: string) {
  const result: React.ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    const baseLevel = item.level;
    const listType = item.type;
    const ListTag = listType === "ol" ? "ol" : "ul";

    // Collect all items at this level or nested under it (stop at next same-level item of different type)
    const group: any[] = [];
    let j = i;
    while (j < items.length) {
      const cur = items[j];
      if (cur.level === baseLevel && cur.type !== listType) break;
      if (cur.level < baseLevel) break;
      group.push(cur);
      j++;
    }

    // Separate top-level items from nested
    const topLevelItems = group.filter((x: any) => x.level === baseLevel && x.type === listType);
    if (topLevelItems.length === 0) { i = j; continue; }

    result.push(
      <ListTag key={`${parentKey}-${i}`} className={`${listType === "ol" ? "list-decimal" : "list-disc"} pl-6 my-2 space-y-1`}>
        {topLevelItems.map((li: any) => {
          // Find nested items that belong to this top-level item
          const liIdx = group.indexOf(li);
          const nested: any[] = [];
          for (let k = liIdx + 1; k < group.length; k++) {
            const sub = group[k];
            if (sub.level <= baseLevel) break;
            nested.push(sub);
          }
          return (
            <li key={`${parentKey}-li-${i}-${li.text.slice(0, 20)}`} className="pl-1">
              {formatInlineText(li.text, onCitationClick, sources, `${parentKey}-li-${i}-${li.text.slice(0, 10)}`)}
              {nested.length > 0 && renderList(nested, onCitationClick, sources, `${parentKey}-nested-${i}-${li.text.slice(0, 10)}`)}
            </li>
          );
        })}
      </ListTag>
    );
    i = j;
  }
  return result;
}

function renderPlainBlocks(text: string, onCitationClick: any, sources: Source[], parentIdx: number) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const Tag = `h${hMatch[1]!.length}` as any;
      elements.push(<Tag key={`h-${parentIdx}-${i}`} className="font-bold text-ink-1 mt-6 mb-2 tracking-tight">{formatInlineText(hMatch[2]!, onCitationClick, sources, `h-${parentIdx}-${i}`)}</Tag>);
      i++; continue;
    }
    const lineEnvMatch = trimmed.match(/^\\begin\{([a-zA-Z*]+)\}/);
    if (lineEnvMatch) {
      const env = lineEnvMatch[1];
      let block = line;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l) break;
        block += '\n' + l;
        if (l.includes(`\\end{${env}}`)) break;
        j++;
      }
      if (env === "tikzpicture" || env === "tikzcd") {
        const inner = block.replace(/^\\begin\{[a-zA-Z*]+\}[\s\S]*?\n?/, "").replace(/\n?\\end\{[a-zA-Z*]+\}$/, "").trim();
        elements.push(<TikzRenderer key={`tikz-${parentIdx}-${i}`} code={inner} />);
      } else {
        elements.push(<DisplayMath key={`env-${parentIdx}-${i}`} formula={block} />);
      }
      i = j + 1;
      continue;
    }
    if (trimmed.startsWith("|")) {
      const { rows, nextIndex } = parseTable(lines, i);
      if (rows.length > 1) {
        const tblIdx = elements.length;
        elements.push(
          <div key={`tab-${parentIdx}-${i}`} className="group my-4 overflow-x-auto relative">
            <table className="min-w-full text-sm">
              <thead className="text-left border-b border-line-strong"><tr>{rows[0]!.map((cell, ci) => (<th key={ci} className="px-4 py-3 font-semibold text-ink-1 text-sm">{formatInlineText(cell, onCitationClick, sources, `th-${parentIdx}-${i}-${ci}`)}</th>))}</tr></thead>
              <tbody className="divide-y divide-line">{rows.slice(1).map((row, ri) => (<tr key={ri} className="hover:bg-surface-1 transition-colors">{row.map((cell, ci) => (<td key={ci} className="px-4 py-2.5 text-ink-2 text-sm">{formatInlineText(cell, onCitationClick, sources, `td-${parentIdx}-${i}-${ri}-${ci}`)}</td>))}</tr>))}</tbody>
            </table>
            <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-1 right-1">
              <button
                title="Export as CSV"
                onClick={() => downloadTableAsCsv(rows, tblIdx)}
                className="sd-press p-1 rounded hover:bg-surface-3 text-ink-2 hover:text-ink-1 transition-colors cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
        i = nextIndex; continue;
      }
    }
    if (trimmed.match(/^([-*•]|\d+\.)\s+/)) {
      const { items, nextIndex } = parseList(lines, i);
      elements.push(<div key={`lst-${parentIdx}-${i}`}>{renderList(items, onCitationClick, sources, `lst-${parentIdx}-${i}`)}</div>);
      i = nextIndex; continue;
    }
    if (trimmed.startsWith(">")) {
      const bqLines: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const t = l?.trim() ?? "";
        if (!t.startsWith(">")) break;
        bqLines.push(t.replace(/^>\s?/, ""));
        i++;
      }
      elements.push(
        <div key={`bq-${parentIdx}-${i}`} className="my-3 pl-3 py-2 border-l-2 border-ink-3/30 bg-ink-3/[0.04] rounded-r-lg">
          {bqLines.map((bq, bi) => (
            <p key={`bq-${parentIdx}-${i}-${bi}`} className="leading-relaxed text-[15px] text-ink-1 last:mb-0 mb-1">{formatInlineText(bq, onCitationClick, sources, `bq-${parentIdx}-${i}-${bi}`)}</p>
          ))}
        </div>
      );
      continue;
    }
    if (trimmed === "---") {
      elements.push(<hr key={`hr-${parentIdx}-${i}`} className="my-8 border-line" />);
      i++; continue;
    }
    elements.push(<p key={`p-${parentIdx}-${i}`} className="leading-relaxed mb-4 last:mb-0 text-[15px] text-ink-1">{formatInlineText(line, onCitationClick, sources, `p-${parentIdx}-${i}`)}</p>);
    i++;
  }
  return elements;
}

// ── XyMatrix standalone detection ─────────────────────────
// \xymatrix{...} doesn't use \begin/\end, so it won't be caught by BLOCK_DELIM_REGEX.
// We wrap it in \[...\] so it routes to DisplayMath / MathJax.
function extractXymatrixBlocks(text: string): string {
  return text.replace(/\\(?:xymatrix\*?(?:@[^{]*)?)\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g,
    (_match) => {
      return `\\[${_match}\\]`;
    }
  );
}

// ── Inline code protection ────────────────────────────────
// Mask backtick-delimited inline code before the block regex runs, so that
// prose mentions of \begin{CD} inside `code` aren't captured as env starts.
const CODE_MASK = '\x00CD';
const CODE_MASK_END = '\x00';

function maskCode(text: string, store: string[]): string {
  // Only match single-backtick spans, not triple-backtick fences
  return text.replace(/(?<!``)`[^`]+`(?!`)/g, (m) => {
    const idx = store.length;
    store.push(m);
    return `${CODE_MASK}${idx}${CODE_MASK_END}`;
  });
}
function restoreCode(text: string, store: string[]): string {
  return text.replace(new RegExp(`${CODE_MASK}(\\d+)${CODE_MASK_END}`, 'g'), (_, idx) => store[+idx] ?? '');
}

// ── Block regex: \3 backreference ensures \begin{CD} only matches \end{CD} ──
const BLOCK_DELIM_REGEX = /(<(?:CHART|MERMAID|LIVE|svg|TIKZ|LILYPOND|MUSIC|ABC|CHEMICAL|SMILES|MOL)(?:\s+[^>]*)?>[\s\S]*?<\/(?:CHART|MERMAID|LIVE|svg|TIKZ|LILYPOND|MUSIC|ABC|CHEMICAL|SMILES|MOL)>|```[a-z]*[\s\S]*?```|(?<=\n|^)\s*\$\$[\s\S]*?\s*\$\$(?=\s*$|\n)|(?<!\\)\\\[(?!-?\d+pt)[\s\S]+?\\\])/gim;

function renderBlocks(text: string, onCitationClick: any, sources: Source[], onHtmlPreview?: (html: string) => void) {
  if (typeof text !== "string") return [];
  text = fixMalformedTags(text);
  const codeStore: string[] = [];
  const masked = maskCode(text, codeStore);
  const withXy = extractXymatrixBlocks(masked);
  return splitWithDelimiters(withXy, BLOCK_DELIM_REGEX).flatMap((part, pi) => {
    // Restore inline code spans — text parts need it, and code-block delimiter
    // parts may have placeholders if the code contained inline backtick spans.
    part.value = restoreCode(part.value, codeStore);
    if (part.type === "delimiter") {
      const val = part.value;
      const tagMatch = val.match(/<(CHART|MERMAID|LIVE|svg|TIKZ|LILYPOND|MUSIC|ABC|CHEMICAL|SMILES|MOL)/i);
      if (tagMatch) {
        const tag = tagMatch[1]!.toUpperCase();
        const contentBase = val.replace(/<[^>]+>/gi, "").trim();
        if (tag === "LIVE") {
          return <LiveWidget key={pi} html={contentBase} />;
        }
        if (tag === "CHART") {
          try {
            const data = JSON.parse(stripJsonComments(contentBase));
            if (data && typeof data === "object") return <ChartRenderer key={pi} data={data} />;
            return <div key={pi} className="text-critical-text text-xs my-2">Invalid Chart Data</div>;
          } catch { return <div key={pi} className="text-critical-text text-xs my-2">Invalid Chart JSON</div>; }
        }
        if (tag === "MERMAID") {
          const mermaidCode = contentBase.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
          return <MermaidRenderer key={pi} code={mermaidCode} />;
        }
        if (tag === "TIKZ") return <TikzRenderer key={pi} code={contentBase} />;
        if (tag === "LILYPOND" || tag === "MUSIC" || tag === "ABC") return <MusicRenderer key={pi} code={contentBase} />;
        if (tag === "CHEMICAL") {
          // \ce{} only handles chemical equations (e.g. \ce{H2O}, \ce{NaOH + HCl -> NaCl + H2O}).
          // For structural formulas use <SMILES>...</SMILES> with a SMILES string.
          return (
            <div key={pi}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] font-medium text-ink-2 bg-surface-3 px-1.5 py-0.5 rounded">Chemical equation</span>
              </div>
              <DisplayMath formula={`\\ce{${contentBase}}`} />
            </div>
          );
        }
        if (tag === "SMILES" || tag === "MOL") return <SmilesRenderer key={pi} smiles={contentBase} />;
        return <div key={pi} className="my-4 overflow-x-auto" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(val) }} />;
      }
      if (val.startsWith("```")) {
        const match = val.match(/^```([a-z]*)\n?([\s\S]*?)\n?```$/i);
        return <CodeBlock key={pi} language={match?.[1] || "text"} code={match?.[2] || ""} onHtmlPreview={onHtmlPreview} />;
      }
      if (val.startsWith("\\begin{")) {
        const envMatch = val.match(/\\begin\{([a-zA-Z*]+)\}/i);
        const env = envMatch?.[1];
        if (env === "tikzpicture") {
          const content = val.replace(/^\\begin\{tikzpicture\}[\s\S]*?\n?/, "").replace(/\n?\\end\{tikzpicture\}$/, "").trim();
          return <TikzRenderer key={pi} code={content} />;
        }
        if (env === "tikzcd") {
          const content = val.replace(/^\\begin\{tikzcd\}[\s\S]*?\n?/, "").replace(/\n?\\end\{tikzcd\}$/, "").trim();
          return <TikzRenderer key={pi} code={`\\begin{tikzcd}\n${content}\n\\end{tikzcd}`} />;
        }
        return <DisplayMath key={pi} formula={val} />;
      }
      if (val.trim().startsWith("$$") || (val.trim().startsWith("\\[") && val.length > 10)) {
        const inner = val.trim().replace(/^\$\$/, "").replace(/\$\$$/, "").replace(/^\\\[/, "").replace(/\\\]$/, "").trim();
        if (inner.startsWith("\\begin{tikzpicture}")) {
          const content = inner.replace(/^\\begin\{tikzpicture\}[\s\S]*?\n?/, "").replace(/\n?\\end\{tikzpicture\}$/, "").trim();
          return <TikzRenderer key={pi} code={content} />;
        }
        if (/^\\begin\{tikzcd\}/i.test(inner)) {
          const content = inner.replace(/^\\begin\{tikzcd\}[\s\S]*?\n?/, "").replace(/\n?\\end\{tikzcd\}$/, "").trim();
          return <TikzRenderer key={pi} code={`\\begin{tikzcd}\n${content}\n\\end{tikzcd}`} />;
        }
        return <DisplayMath key={pi} formula={val.trim()} />;
      }
      return <span key={pi}>{val}</span>;
    }
    return renderPlainBlocks(part.value, onCitationClick, sources, pi);
  });
}

export const MessageRenderer = React.memo(function MessageRenderer({
  content,
  onCitationClick,
  sources,
  onHtmlPreview,
}: {
  content: string;
  onCitationClick: (index: number) => void;
  sources: Source[];
  onHtmlPreview?: (html: string) => void;
}) {
  const safeContent = content ?? "";
  const blocks = useMemo(() => renderBlocks(safeContent, onCitationClick, sources, onHtmlPreview), [safeContent, onCitationClick, sources, onHtmlPreview]);
  return <div className="markdown-body space-y-1 break-words">{blocks}</div>;
});
