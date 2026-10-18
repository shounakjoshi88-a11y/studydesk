/**
 * Document summarisation, entirely on device.
 *
 * This is an original implementation of extractive summarisation: score every
 * sentence by the inverse sentence frequency of the content words it carries,
 * damp anything the selection has already covered, then read the winners back
 * in document order. Extractive rather than abstractive on purpose — the
 * sentences are the document's own, so a summary can never invent a claim, and
 * for study material that is the property you actually want.
 *
 * Every sentence keeps a reference to the page it came from, so a point in the
 * summary can be traced back to the source rather than trusted blindly.
 */

import { getFileData, type FileMeta } from "./store";
import { extractPdfText, docxToMd, textOfFile, TEXT_EXTS, sheetToMdTable } from "./office";

export type SummaryDepth = "brief" | "detailed";

export type SummaryPoint = {
  text: string;
  page: number | null;
};

export type SummaryStats = {
  sentences: number;
  points: number;
  words: number;
  readMinutes: number;
};

export type SummaryDoc = {
  title: string;
  pages: Map<number, string>;
  pageCount: number;
  text: string;
};

/**
 * Function words carry no topical signal, so they are removed before counting.
 * English only by design: the documents this app is pointed at are English, and
 * a half-hearted second language list does more harm than it prevents.
 */
const STOP = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below
   between both but by can cannot could couldn't did didn't do does doesn't doing don't down during each few
   for from further had hadn't has hasn't have haven't having he her here hers herself him himself his how
   however i if in into is isn't it its itself just let's me more most mustn't my myself no nor not of off
   on once only or other ought our ours ourselves out over own same shan't she should shouldn't so some such
   than that the their theirs them themselves then there these they this those through to too under until up
   very was wasn't we were weren't what when where which while who whom why will with won't would wouldn't
   you your yours yourself yourselves shall will may might must also upon within without across among
   therefore thus hence however moreover furthermore whereas although though since because while whereas`
    .split(/\s+/)
    .filter(Boolean)
);

/** Formats whose text we can lift without a converter round trip. */
export function summarizable(ext: string): boolean {
  return (
    ext === "pdf" ||
    ext === "docx" ||
    ext === "xls" ||
    ext === "xlsx" ||
    ext === "csv" ||
    ext === "tsv" ||
    TEXT_EXTS.has(ext)
  );
}

function baseName(name: string, ext: string): string {
  if (ext && name.toLowerCase().endsWith("." + ext)) return name.slice(0, name.length - ext.length - 1);
  return name;
}

/**
 * Pull plain text out of a stored file. PDFs keep their page boundaries because
 * that is what makes a citation possible later on.
 */
export async function loadSummaryDoc(
  meta: FileMeta,
  onStage?: (stage: string) => void
): Promise<SummaryDoc> {
  const title = baseName(meta.name, meta.ext);
  onStage?.("Reading the file");

  const data = await getFileData(meta.id);
  let text = "";
  const pages = new Map<number, string>();

  if (meta.ext === "pdf") {
    onStage?.("Pulling text out of the pages");
    text = await extractPdfText(data, title);
    // extractPdfText lays the output out as "## Page N" sections, which is
    // exactly the boundary information we want to keep.
    const marks = [...text.matchAll(/^##\s+Page\s+(\d+)\s*$/gm)];
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i]!.index + marks[i]![0].length;
      const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
      pages.set(Number(marks[i]![1]), text.slice(start, end));
    }
  } else if (meta.ext === "docx") {
    onStage?.("Reading the document");
    text = await docxToMd(data, title);
  } else if (meta.ext === "xls" || meta.ext === "xlsx") {
    onStage?.("Reading the sheets");
    text = sheetToMdTable(data);
  } else {
    text = textOfFile(meta.ext, data);
  }

  if (!text.trim()) throw new Error("No readable text in this file.");
  return { title, pages, pageCount: pages.size, text };
}

/**
 * Split prose into sentences. Headings, table rows and list bullets are folded
 * into the following sentence, because a fragment on its own is not a thought.
 */
function splitSentences(raw: string): string[] {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\|/g, " ")
    .replace(/^[#>*\-+]+\s*/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n");

  const parts = text.split(/(?<=[.!?])\s+|(?<=[.!?])(?=[\p{Lu}])|\n/u);

  const merged: string[] = [];
  for (const part of parts) {
    const s = part.trim();
    if (!s) continue;
    const prev = merged[merged.length - 1];
    const unfinished = prev !== undefined && !/[.!?:)]["')\]]?$/.test(prev);
    if (prev !== undefined && prev.length < 44 && merged.length > 0) merged[merged.length - 1] = `${prev} ${s}`;
    else if (unfinished && prev.length < 400) merged[merged.length - 1] = `${prev} ${s}`;
    else merged.push(s);
  }

  return merged
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 32 && /\p{L}/u.test(s) && contentTerms(s).length >= 4);
}

function words(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
}

/** Words that actually indicate what a sentence is about. */
function contentTerms(s: string): string[] {
  const out: string[] = [];
  for (const w of words(s)) {
    if (w.length < 3) continue;
    if (STOP.has(w)) continue;
    if (/^\d+$/.test(w)) continue;
    out.push(w);
  }
  return out;
}

const DEPTH: Record<SummaryDepth, { ratio: number; min: number; max: number }> = {
  brief: { ratio: 0.16, min: 3, max: 9 },
  detailed: { ratio: 0.32, min: 6, max: 22 },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Pick the sentences worth reading, in the order they appeared.
 *
 * Scoring is inverse sentence frequency rather than raw term frequency: a word
 * that turns up in most sentences of the document is filler, and weighting it
 * heavily is exactly how a frequency counter produces a summary that reads like
 * a word cloud. Dividing by the square root of sentence length then stops long
 * sentences from winning on volume alone, and a marginal-gain pass drops any
 * candidate whose content is already covered by a sentence chosen before it.
 */
export function summarizeDoc(doc: SummaryDoc, depth: SummaryDepth = "brief"): {
  points: SummaryPoint[];
  stats: SummaryStats;
} {
  const sentences = splitSentences(doc.text);
  const n = sentences.length;

  if (n === 0) {
    return {
      points: [],
      stats: { sentences: 0, points: 0, words: countWords(doc.text), readMinutes: readMinutes(countWords(doc.text)) },
    };
  }

  const perSentence = sentences.map(contentTerms);
  const seen = new Map<string, number>();
  for (const terms of perSentence) {
    for (const t of new Set(terms)) seen.set(t, (seen.get(t) ?? 0) + 1);
  }

  const weight = new Map<string, number>();
  for (const [term, freq] of seen) weight.set(term, Math.log(1 + n / freq));

  const scored = perSentence.map((terms, i) => {
    const unique = new Set(terms);
    let sum = 0;
    for (const t of unique) sum += weight.get(t) ?? 0;
    const lengthNorm = Math.sqrt(Math.max(4, unique.size));
    // A lead position is a real signal in prose, but a nudge rather than a
    // thumb on the scale — the first paragraph of a syllabus is not the point.
    const lead = i === 0 ? 1.3 : i === 1 ? 1.1 : i === n - 1 ? 1.05 : 1;
    return { i, text: sentences[i]!, terms: unique, score: (sum / lengthNorm) * lead };
  });

  const target = clamp(
    Math.round(DEPTH[depth].ratio * n),
    Math.min(DEPTH[depth].min, n),
    DEPTH[depth].max
  );

  const picked: typeof scored = [];
  const taken = new Map<string, number>();
  const pool = scored.slice();

  while (picked.length < target && pool.length) {
    let bestAt = 0;
    let bestVal = -Infinity;
    for (let k = 0; k < pool.length; k++) {
      const cand = pool[k]!;
      let overlap = 0;
      for (const t of cand.terms) overlap += (taken.get(t) ?? 0) * (weight.get(t) ?? 0);
      const val = cand.score - 0.9 * overlap;
      if (val > bestVal) {
        bestVal = val;
        bestAt = k;
      }
    }
    const chosen = pool.splice(bestAt, 1)[0]!;
    picked.push(chosen);
    for (const t of chosen.terms) taken.set(t, (taken.get(t) ?? 0) + 1);
  }

  picked.sort((a, b) => a.i - b.i);

  const pageBags = new Map<number, Set<string>>();
  for (const [page, body] of doc.pages) pageBags.set(page, new Set(contentTerms(body)));

  const points: SummaryPoint[] = picked.map((p) => ({
    text: p.text,
    page: locatePage(p.terms, pageBags),
  }));

  const totalWords = countWords(doc.text);
  return {
    points,
    stats: { sentences: n, points: points.length, words: totalWords, readMinutes: readMinutes(totalWords) },
  };
}

/**
 * Which page a summary sentence came from, found by counting how many of its
 * distinctive words appear on each page. A single shared word is not evidence,
 * so anything below two matches is reported as unknown instead of guessed.
 */
function locatePage(terms: Set<string>, pageBags: Map<number, Set<string>>): number | null {
  if (!pageBags.size) return null;
  let best: number | null = null;
  let bestHits = 0;
  for (const [page, bag] of pageBags) {
    let hits = 0;
    for (const t of terms) if (bag.has(t)) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      best = page;
    }
  }
  return bestHits >= 2 ? best : null;
}

function countWords(s: string): number {
  return (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

/** 230 words a minute is a fair pace for reading unfamiliar material. */
function readMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 230));
}

/**
 * Which page a sentence belongs to, judged the same way as for locally chosen
 * sentences. Used to give an AI-written point a page reference without ever
 * asking the model where it thought the point came from — the evidence is the
 * document, not the model's word.
 */
export function attributePage(sentence: string, pages: Map<number, string>): number | null {
  if (!pages.size) return null;
  const bags = new Map<number, Set<string>>();
  for (const [page, body] of pages) bags.set(page, new Set(contentTerms(body)));
  return locatePage(new Set(contentTerms(sentence)), bags);
}

/** The summary as Markdown, ready to drop into a note. */
export function summaryToMarkdown(doc: SummaryDoc, points: SummaryPoint[]): string {
  const lines = [`# ${doc.title} — summary`, ""];
  points.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.text}`);
    if (p.page !== null) lines.push(`   Page ${p.page}`);
    lines.push("");
  });
  lines.push(`---`, `${points.length} points from ${countWords(doc.text)} words.`);
  if (doc.pageCount) lines.push(`${doc.pageCount} pages.`);
  return lines.join("\n");
}

/** The summary as plain text, for pasting elsewhere. */
export function summaryToPlainText(doc: SummaryDoc, points: SummaryPoint[]): string {
  return points
    .map((p, i) => `${i + 1}. ${p.text}${p.page !== null ? ` (page ${p.page})` : ""}`)
    .join("\n\n");
}
