// src/lib/chat-utils.ts
export type Source = { url: string; content?: string };

/**
 * Fixes malformed opening/closing tags where the model drops the first 1-3
 * characters (e.g. "ART>" instead of "<CHART>", "HOUGHT>" instead of
 * "<THOUGHT>").  This runs as a pre-processing step so downstream renderers
 * always see well-formed tags.
 */
export function fixMalformedTags(text: string): string {
  if (!text) return text;
  let s = text;

  // ── Opening tags (model often drops leading "<C", "<T", "<F" etc.) ──
  s = s.replace(/(?<![A-Za-z<])CHART>/gi, '<CHART>');
  s = s.replace(/(?<![A-Za-z<])MERMAID>/gi, '<MERMAID>');
  s = s.replace(/(?<![A-Za-z<])THOUGHT>/gi, '<THOUGHT>');
  s = s.replace(/(?<![A-Za-z<])THINK>/gi, '<THINK>');
  s = s.replace(/(?<![A-Za-z<])FOLLOW_UPS>/gi, '<FOLLOW_UPS>');
  s = s.replace(/(?<![A-Za-z<])ANSWER>/gi, '<ANSWER>');
  s = s.replace(/(?<![A-Za-z<])LIVE>/gi, '<LIVE>');

  // ── Partial prefixes where 1-2 leading chars are missing ──
  s = s.replace(/(?<![A-Za-z<])ART>/gi, '<CHART>');
  s = s.replace(/(?<![A-Za-z<])HART>/gi, '<CHART>');
  s = s.replace(/(?<![A-Za-z<])ERMAID>/gi, '<MERMAID>');
  s = s.replace(/(?<![A-Za-z<])HOUGHT>/gi, '<THOUGHT>');
  s = s.replace(/(?<![A-Za-z<])OUGHT>/gi, '<THOUGHT>');
  s = s.replace(/(?<![A-Za-z<])HINK>/gi, '<THINK>');
  s = s.replace(/(?<![A-Za-z<])INK>/gi, '<THINK>');
  s = s.replace(/(?<![A-Za-z<])OLLOW_UPS>/gi, '<FOLLOW_UPS>');

  // ── Closing tags missing the opening "<" ──
  s = s.replace(/\/(CHART|MERMAID|LIVE|THOUGHT|THINK|FOLLOW_UPS|ANSWER)>/gi, '</$1>');

  // ── Closing tags with extra "<" like "</<CHART>" ──
  s = s.replace(/<\s*\/\s*<\s*(CHART|MERMAID|LIVE|THOUGHT|THINK|FOLLOW_UPS|ANSWER|SOURCES)>/gi, '</$1>');

  return s;
}

export function parseAssistantContent(raw: string) {
  const sourcesRegex = /<SOURCES>([\s\S]*?)<\/SOURCES>/;
  const sourcesMatch = raw.match(sourcesRegex);
  const content = raw.replace(sourcesRegex, "").trim();
  const sources = (() => {
    if (!sourcesMatch?.[1]) return [] as Source[];
    try {
      const parsed = JSON.parse(sourcesMatch[1]) as Source[];
      return parsed.filter((item) => item?.url);
    } catch {
      return [] as Source[];
    }
  })();
  return { content, sources };
}

export function parseAssistantSections(content: string) {
  const answerMatch = content.match(/<ANSWER>([\s\S]*?)<\/ANSWER>/i);
  const followUpsMatch = content.match(/<FOLLOW_UPS>([\s\S]*?)<\/FOLLOW_UPS>/i);

  const rawAnswer = answerMatch?.[1] ?? content;
  const answer = rawAnswer
    .replace(/<\/?ANSWER>/gi, "")
    .replace(/<\/?FOLLOW_UPS>/gi, "")
    .replace(/<\/?question>/gi, "")
    .trim();

  const followUpScope = followUpsMatch?.[1] ?? content;
  const matches = followUpScope.match(/<question>(.*?)<\/question>/gi) ?? [];
  const followUps = Array.from(
    new Set(matches.map((q) => q.replace(/<\/?question>/gi, "").trim()).filter(Boolean))
  ).slice(0, 3);

  return { answer, followUps };
}

/**
 * Robust extraction that works even if only closing tags are present.
 * Used for both live streaming and historical message loading.
 */
export function extractLiveContent(raw: string): {
  answer: string;
  followUps: string[];
} {
  let answer = "";
  let followUps: string[] = [];
  raw = fixMalformedTags(raw);

  // 1. Remove thought and follow-up blocks entirely from cleanRaw before processing fallback
  const cleanRaw = raw
    .replace(/<(?:thought|think|THOUGHT|THINK)>[\s\S]*?(?:<\/(?:thought|think|THOUGHT|THINK)>|$)/gi, "")
    .replace(/<FOLLOW_UPS>[\s\S]*?(?:<\/FOLLOW_UPS>|$)/gi, "")
    .replace(/<FOLLOW_UPS[\s\S]*/gi, "")
    .replace(/^\s*(?:\{[\s\S]*?\}|\[[\s\S]*?\])\s*/g, '')
    .trim();

  // 2. Look for <ANSWER> block
  const rawUpper = raw.toUpperCase();
  const answerStart = rawUpper.indexOf("<ANSWER>");
  const answerEnd = rawUpper.indexOf("</ANSWER>");

  if (answerStart !== -1) {
    const startIdx = answerStart + 8;
    let endIdx = answerEnd !== -1 ? answerEnd : raw.length;
    
    // Slice up to FOLLOW_UPS if it starts before ANSWER ends (unclosed ANSWER tag case)
    const followStartIdx = rawUpper.indexOf("<FOLLOW_UPS>");
    if (followStartIdx !== -1 && followStartIdx < endIdx) {
      endIdx = followStartIdx;
    }

    answer = raw.slice(startIdx, endIdx)
      .replace(/^(?:assistant|[}\],:\s])+/gi, "")
      .trimStart();
  } else if (answerEnd !== -1) {
    // No opening tag but closing exists – take everything before closing but after thoughts
    const thoughtEnd = rawUpper.lastIndexOf("</THOUGHT>");
    const startIdx = thoughtEnd !== -1 ? thoughtEnd + 10 : 0;
    answer = raw.slice(startIdx, answerEnd)
      .replace(/^(?:assistant|[}\],:\s])+/gi, "")
      .trimStart();
  } else if (rawUpper.includes("<THOUGHT>") || rawUpper.includes("<THINK>")) {
    // We are still in thinking phase or haven't seen <ANSWER> yet.
    // Return cleanRaw (which has thoughts stripped) to avoid raw markup leak if thoughts are unclosed.
    answer = cleanRaw.replace(/^(?:assistant|[}\],:\s])+/gi, "");
  } else {
    // Fallback for legacy messages or non-tagged streams
    answer = cleanRaw.replace(/^(?:assistant|[}\],:\s])+/gi, "");
  }

  // Ensure no residual tag markup or follow-ups leak into answer
  answer = answer
    .replace(/<FOLLOW_UPS>[\s\S]*?(?:<\/FOLLOW_UPS>|$)/gi, "")
    .replace(/<FOLLOW_UPS[\s\S]*/gi, "")
    .replace(/<\/?(?:ANSWER|question)>/gi, "");

  // Extract follow‑up questions
  const followStart = rawUpper.indexOf("<FOLLOW_UPS>");
  const followEnd = rawUpper.indexOf("</FOLLOW_UPS>");

  if (followStart !== -1) {
    const startIdx = followStart + 12;
    const endIdx = followEnd !== -1 ? followEnd : raw.length;
    const section = raw.slice(startIdx, endIdx);
    const questionMatches = section.matchAll(/<question>(.+?)<\/question>/gs);
    followUps = Array.from(questionMatches, (m) => (m[1] as string).trim());
  }

  return { answer, followUps };
}

export function deepCleanAnswer(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return "";
  let clean = fixMalformedTags(raw)
    .replace(/<FOLLOW_UPS>[\s\S]*?(?:<\/FOLLOW_UPS>|$)/gi, "")
    .replace(/<FOLLOW_UPS[\s\S]*/gi, "")
    .replace(/\{"type"[\s\S]*?\}/g, "")
    .replace(/<(?:thought|think)>[\s\S]*?(?:<\/(?:thought|think)>|$)/gi, '')
    .replace(/<\/?(?:thought|think|ANSWER|question)>/gi, '')
    .replace(/\n\d+ https?:\/\/[^\n]+(\n|$)/g, '')
    .replace(/<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^>]*)?$/g, '')
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?(?:<\|tool_calls_section_end\|>|$)/gi, '')
    .replace(/<\|tool_call_begin\|>[\s\S]*?(?:<\|tool_call_end\|>|$)/gi, '')
    .replace(/<\|tool_calls_section_(?:begin|end)\|>/gi, '')
    .replace(/<\|tool_call_(?:begin|end)\|>/gi, '')
    .replace(/```(?:stdout|stderr|output|result|bash_output|python_output)\s*\n[\s\S]*?\n```/gi, '')
    .replace(/^(?:Output|Result|Stdout|Stderr)\s*:\s*$/gim, '');
  return clean.replace(/\n+$/, "").trim();
}

export function rewriteSandboxUrls(text: string, conversationId?: string | null): string {
  if (!conversationId || !text) return text;
  // Strip markdown link wrappers around sandbox URLs: [text](sandbox:/path/file) → text
  let result = text.replace(
    /\[([^\]]*)\]\(sandbox:\/home\/user\/(?:uploads\/|edits\/)?([^\s)\]]+)\)/gi,
    (_match, linkText) => linkText
  );
  // Replace bare sandbox: URLs with download URLs
  result = result.replace(
    /sandbox:\/home\/user\/(?:uploads\/|edits\/)?([^\s)\]]+)/gi,
    (_match, filename) => `/api/sandbox/download/${conversationId}/${filename}`
  );
  return result;
}

export function extractSandboxDownloadUrls(text: string): Array<{ url: string; filename: string }> {
  const results: Array<{ url: string; filename: string }> = [];
  const regex = /\/api\/sandbox\/download\/([^/]+)\/([^\s)\]]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    results.push({ url: match[0], filename: match[2] || 'file' });
  }
  return results;
}

export function replaceSandboxDownloadUrls(text: string, replaceWith: (url: string) => string): string {
  return text.replace(/\/api\/sandbox\/download\/[^\s)\]]+/g, (match) => replaceWith(match));
}

export function getDomain(url: string) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "unknown-source";
  }
}