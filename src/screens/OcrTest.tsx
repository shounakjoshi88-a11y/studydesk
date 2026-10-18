import { useEffect, useState } from "react";
import { scanTimetableImage } from "../lib/tableocr";
import type { ParsedClass } from "../lib/ai";

export function OcrTest() {
  const [log, setLog] = useState<string[]>([]);
  const [rows, setRows] = useState<ParsedClass[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dbg, setDbg] = useState<any>(null);
  const [grid, setGrid] = useState<any>(null);
  const [ms, setMs] = useState(0);
  useEffect(() => {
    (async () => {
      const t0 = Date.now();
      try {
        const r = await fetch("./test-timetable.jpg");
        const blob = await r.blob();
        const data = await new Promise<string>((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(",")[1]!);
          fr.onerror = rej;
          fr.readAsDataURL(blob);
        });
        const out = await scanTimetableImage(data, (s) =>
          setLog((l) => [...l.slice(-40), `${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`])
        );
        setRows(out);
        setMs(Date.now() - t0);
        setDbg((window as any).__ocrDebug || null);
        setGrid((window as any).__ocrGrid || null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setDbg((window as any).__ocrDebug || null);
        setGrid((window as any).__ocrGrid || null);
      }
    })();
  }, []);
  return (
    <div style={{ padding: 16, fontFamily: "monospace", fontSize: 12, background: "#111", color: "#eee", minHeight: "100vh" }}>
      <h2>OCR TEST {ms ? `(${(ms / 1000).toFixed(1)}s, ${rows?.length} rows)` : "(running…)"}</h2>
      {err && <p style={{ color: "#f66" }}>ERR: {err}</p>}
      {grid && (
        <div style={{ position: "relative", maxWidth: 700, marginTop: 8 }}>
          <img src="./test-timetable.jpg" style={{ width: "100%", display: "block" }} />
          <svg viewBox={`0 0 ${grid.w} ${grid.h}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
            {(grid.hLines || []).map((y: number, i: number) => (
              <line key={`h${i}`} x1="0" y1={y} x2={grid.w} y2={y} stroke="red" strokeWidth="2" opacity="0.8" />
            ))}
            {(grid.headerCols || []).map((x: number, i: number) => (
              <line key={`c${i}`} x1={x} y1="0" x2={x} y2={grid.h} stroke="lime" strokeWidth="2" opacity="0.8" />
            ))}
            {Object.entries(grid.kept || {}).map(([b, xs]: [string, any]) => (
              <g key={b}>
                {(xs || []).map((x: number, i: number) => (
                  <line key={i} x1={x} y1="0" x2={x} y2={grid.h} stroke="cyan" strokeWidth="1" opacity="0.5" strokeDasharray="4 3" />
                ))}
              </g>
            ))}
          </svg>
          <p style={{ fontSize: 11 }}>red = rows, green = header cols, cyan dashed = kept per data row</p>
          <pre style={{ fontSize: 10, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            master=[{(grid.headerCols || []).join(",")}]
            {(Object.entries(grid.kept || {}) as Array<[string, number[]]>).map(([b, xs]) => (
              <div key={b}>row{b}: [{xs.join(",")}]</div>
            ))}
          </pre>
        </div>
      )}
      {dbg && (
        <pre style={{ marginTop: 8, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          DEBUG hLines={dbg.hLines} bands={dbg.totalBands}{"\n"}
          {(dbg.bands || []).map((b: any, i: number) => (
            <div key={i}>band{b.b} cols={b.cols} score={b.score} | {(b.sample || []).join(" /// ")}</div>
          ))}
        </pre>
      )}
      <div>{log.map((l, i) => <div key={i}>{l}</div>)}</div>
      {rows && (
        <table border={1} cellPadding={4} style={{ marginTop: 12, borderCollapse: "collapse" }}>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}><td>{r.day}</td><td>{r.start}-{r.end}</td><td>{r.subject}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
