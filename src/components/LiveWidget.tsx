import { useRef, useState, useMemo } from "react";
import { Maximize2, Minimize2, RefreshCw, AlertTriangle } from "lucide-react";

type LiveWidgetProps = {
  html: string;
};

function extractJs(html: string): { body: string; scripts: string[] } {
  const scripts: string[] = [];
  const body = html.replace(/<script[\s\S]*?>([\s\S]*?)<\/script>/gi, (_, code) => {
    scripts.push(code.trim());
    return "";
  });
  return { body: body.trim(), scripts };
}

export function LiveWidget({ html }: LiveWidgetProps) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);

  const { body, scripts } = useMemo(() => extractJs(html), [html]);

  const srcDoc = useMemo(() => {
    const inlineScripts = scripts.map((s, i) =>
      `try { (function() { ${s} })() } catch(e) { console.error('LiveWidget script ${i}:', e); }`
    ).join('\n');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: transparent;
      color: #faf9f5;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    svg, canvas { max-width: 100%; max-height: 100%; }
  </style>
</head>
<body>
${body}
<script>
${inlineScripts}
window.addEventListener('error', function(e) {
  document.documentElement.setAttribute('data-error', e.message || 'Unknown error');
});
<\/script>
</body>
</html>`;
  }, [body, scripts]);

  return (
    <div className={`my-4 rounded-card overflow-hidden border border-line bg-surface-1 ${expanded ? "fixed inset-4 z-[300] shadow-2xl" : ""}`}>
      <div className="flex items-center justify-between px-3 py-2 bg-surface-2 border-b border-line">
        <div className="flex items-center gap-2">
          <div className="size-2 rounded-full bg-[var(--att-safe)] shadow-[0_0_6px_var(--att-safe)]" aria-hidden />
          <span className="text-[11px] font-medium text-ink-2 uppercase tracking-wider">Live Visualizer</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setKey(k => k + 1); setError(null); }}
            className="sd-press size-7 flex items-center justify-center rounded-lg hover:bg-surface-3 text-ink-3 hover:text-ink-1 transition-colors"
            title="Restart"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={() => setExpanded(e => !e)}
            className="sd-press size-7 flex items-center justify-center rounded-lg hover:bg-surface-3 text-ink-3 hover:text-ink-1 transition-colors"
            title={expanded ? "Minimize" : "Fullscreen"}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>
      </div>
      <div className={`relative ${expanded ? 'h-[calc(100%-36px)]' : 'h-[420px]'}`}>
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-2 bg-surface-1 z-10">
            <AlertTriangle size={24} />
            <span className="text-xs">{error}</span>
          </div>
        )}
        <iframe
          key={key}
          srcDoc={srcDoc}
          className="w-full h-full"
          style={{ border: "none", background: "transparent" }}
          sandbox="allow-scripts allow-same-origin"
          title="Live Visualizer"
        />
      </div>
    </div>
  );
}