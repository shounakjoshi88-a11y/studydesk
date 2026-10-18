// src/components/ChartBlock.tsx
//
// Renders <CHART>...</CHART> and <MERMAID>...</MERMAID> blocks
// that the model embeds inside its answers.

import { useMemo, useState, useEffect, useRef } from "react";
import { fixMalformedTags } from "../lib/chat-utils";
import {
  BarChart, Bar,
  LineChart, Line, Area, AreaChart,
  PieChart, Pie, Cell,
  ScatterChart, Scatter, ZAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, LabelList,
} from "recharts";

// ─── Types ──────────────────────────────────────────────────
interface ChartDataset {
  label: string;
  data: number[];
  color?: string;
  /** for scatter: array of {x,y} instead of flat number[] */
  points?: { x: number; y: number }[];
  type?: "bar" | "line" | "area"; // for mixed bar/line charts
}

interface ChartSpec {
  type: "bar" | "line" | "area" | "pie" | "doughnut" | "scatter";
  title?: string;
  subtitle?: string;
  labels: string[];
  datasets: ChartDataset[];
  xLabel?: string;
  yLabel?: string;
  /** Show data labels on bars */
  showValues?: boolean;
  /** Format numbers: "number" | "currency" | "percent" */
  valueFormat?: "number" | "currency" | "percent";
  /** Show a horizontal reference line (e.g. average) */
  referenceLine?: { value: number; label?: string; color?: string };
  /** Bar layout: "vertical" | "horizontal" */
  layout?: "vertical" | "horizontal";
  /** Stack bars/areas */
  stacked?: boolean;
}

// ─── Default palette ─────────────────────────────────────────
const DEFAULT_COLORS = [
  "#6366f1", "#10b981", "#f59e0b", "#ef4444",
  "#3b82f6", "#8b5cf6", "#06b6d4", "#84cc16",
  "#f97316", "#ec4899", "#14b8a6", "#a855f7",
];

// ─── Number formatter ─────────────────────────────────────────
function formatValue(n: number, fmt?: ChartSpec["valueFormat"]): string {
  if (fmt === "currency") return `$${n.toLocaleString()}`;
  if (fmt === "percent") return `${n}%`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Shared Tooltip style ─────────────────────────────────────
/** Tooltip chrome follows the app tokens, not a second grey scale. */
const tooltipStyle = {
  background: "var(--surface-3)",
  border: "1px solid var(--line-strong)",
  borderRadius: 10,
  fontSize: 12,
  color: "var(--ink-1)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
};

// ─── Chart wrapper ────────────────────────────────────────────
function ChartWrapper({ title, subtitle, children }: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="my-5 rounded-card border border-line bg-surface-1 overflow-hidden shadow-xl">
      {/* Header bar */}
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-line bg-surface-2">
        <span className="text-[11px] font-semibold tracking-[0.18em] uppercase text-brand">
          ▪ Chart
        </span>
        {title && (
          <span className="ml-1 text-sm font-medium text-ink-1 truncate">
            {title}
          </span>
        )}
      </div>
      {subtitle && (
        <p className="px-4 pt-2 text-xs text-ink-2">{subtitle}</p>
      )}
      <div className="p-4 pb-3">{children}</div>
    </div>
  );
}

// ─── Bar / Line / Area / Mixed ────────────────────────────────
function BarLineAreaChart({ spec }: { spec: ChartSpec }) {
  const isHorizontal = spec.layout === "horizontal";
  const isStacked = spec.stacked ?? false;

  const data = spec.labels.map((label, i) => {
    const point: Record<string, any> = { name: label };
    spec.datasets.forEach((ds) => {
      if (ds && Array.isArray(ds.data)) {
        point[ds.label] = ds.data[i] ?? 0;
      }
    });
    return point;
  });

  // Figure out which recharts component to use for each dataset
  // (supports mixed bar+line)
  const hasMixed = spec.datasets.some(
    (ds) => ds.type && ds.type !== spec.type
  );

  let ChartRoot: any = BarChart;
  if (spec.type === "line") ChartRoot = LineChart;
  if (spec.type === "area") ChartRoot = AreaChart;
  if (hasMixed) ChartRoot = BarChart; // recharts can mix Bar+Line in BarChart

  const chartHeight = spec.labels.length > 10 ? 340 : spec.labels.length > 6 ? 280 : 240;
  const xAngle = spec.labels.length > 6 ? -30 : 0;
  const xHeight = xAngle !== 0 ? 55 : 30;

  return (
    <ChartWrapper title={spec.title} subtitle={spec.subtitle}>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <ChartRoot
          data={data}
          layout={isHorizontal ? "vertical" : "horizontal"}
          margin={{ top: 10, right: 20, left: 10, bottom: xHeight }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--line)"
            vertical={!isHorizontal}
          />
          {isHorizontal ? (
            <>
              <XAxis type="number" tick={{ fontSize: 11, fill: "var(--ink-2)" }}
                tickFormatter={(v) => formatValue(v, spec.valueFormat)}
                label={spec.xLabel ? { value: spec.xLabel, position: "insideBottom", offset: -5, fill: "var(--ink-3)", fontSize: 11 } : undefined}
              />
              <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11, fill: "var(--ink-2)" }} />
            </>
          ) : (
            <>
              <XAxis
                {...({ dataKey: "name", tick: { fontSize: 11, fill: "var(--ink-2)", angle: xAngle, textAnchor: xAngle !== 0 ? "end" : "middle" } } as any)}
                height={xHeight}
                label={spec.xLabel ? { value: spec.xLabel, position: "insideBottom", offset: -10, fill: "var(--ink-3)", fontSize: 11 } : undefined}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--ink-2)" }}
                tickFormatter={(v) => formatValue(v, spec.valueFormat)}
                width={55}
                label={spec.yLabel ? { value: spec.yLabel, angle: -90, position: "insideLeft", fill: "var(--ink-3)", fontSize: 11 } : undefined}
              />
            </>
          )}
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={{ color: "var(--ink-1)", fontWeight: 600, marginBottom: 4 }}
            itemStyle={{ color: "var(--ink-2)" }}
            formatter={(value: any, name: any) => [formatValue(Number(value), spec.valueFormat), name ?? ""]}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, paddingTop: 12, color: "var(--ink-2)" }}
            iconType="circle"
            iconSize={8}
          />
          {spec.referenceLine && (
            <ReferenceLine
              y={spec.referenceLine.value}
              stroke={spec.referenceLine.color ?? "var(--att-caution)"}
              strokeDasharray="4 2"
              label={{ value: spec.referenceLine.label ?? `Ref: ${spec.referenceLine.value}`, fill: spec.referenceLine.color ?? "var(--att-caution-text)", fontSize: 11 }}
            />
          )}
          {spec.datasets.map((ds, i) => {
            const color = ds.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length];
            const dsType = ds.type ?? spec.type;

            if (dsType === "area") {
              return (
                <Area
                  key={ds.label}
                  type="monotone"
                  dataKey={ds.label}
                  stroke={color}
                  fill={`${color}28`}
                  strokeWidth={2}
                  dot={{ r: 3, fill: color, strokeWidth: 0 }}
                  activeDot={{ r: 5 }}
                  stackId={isStacked ? "stack" : undefined}
                >
                  {spec.showValues && <LabelList dataKey={ds.label} position="top" style={{ fontSize: 9, fill: color }} formatter={(v: any) => formatValue(Number(v), spec.valueFormat)} />}
                </Area>
              );
            }
            if (dsType === "line") {
              return (
                <Line
                  key={ds.label}
                  type="monotone"
                  dataKey={ds.label}
                  stroke={color}
                  strokeWidth={2.5}
                  dot={{ r: 3.5, fill: color, strokeWidth: 0 }}
                  activeDot={{ r: 6, strokeWidth: 2, stroke: "var(--surface-1)" }}
                >
                  {spec.showValues && <LabelList dataKey={ds.label} position="top" style={{ fontSize: 9, fill: color }} formatter={(v: any) => formatValue(Number(v), spec.valueFormat)} />}
                </Line>
              );
            }
            // default: bar
            return (
              <Bar
                key={ds.label}
                dataKey={ds.label}
                fill={color}
                radius={isHorizontal ? [0, 6, 6, 0] : [5, 5, 0, 0]}
                maxBarSize={60}
                stackId={isStacked ? "stack" : undefined}
              >
                {spec.showValues && <LabelList dataKey={ds.label} position={isHorizontal ? "right" : "top"} style={{ fontSize: 9, fill: color }} formatter={(v: any) => formatValue(Number(v), spec.valueFormat)} />}
              </Bar>
            );
          })}
        </ChartRoot>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

// ─── Pie / Doughnut ───────────────────────────────────────────
function PieDonutChart({ spec }: { spec: ChartSpec }) {
  const ds = spec.datasets[0];
  if (!ds || !Array.isArray(ds.data)) return null;

  const data = spec.labels.map((label, i) => ({
    name: label,
    value: ds.data[i] ?? 0,
  }));

  const total = data.reduce((s, d) => s + d.value, 0);
  const innerRadius = spec.type === "doughnut" ? "52%" : "0%";

  return (
    <ChartWrapper title={spec.title} subtitle={spec.subtitle}>
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius="72%"
            innerRadius={innerRadius}
            paddingAngle={3}
            label={({ name, percent }: any) =>
              `${name} ${((percent ?? 0) * 100).toFixed(1)}%`
            }
            labelLine={{ stroke: "var(--line-strong)", strokeWidth: 1 }}
          >
            {data.map((_, i) => (
              <Cell
                key={i}
                fill={DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
                stroke="rgba(0,0,0,0.15)"
                strokeWidth={1}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={{ color: "var(--ink-1)", fontWeight: 600 }}
            formatter={(value: any, name: any) => [
              `${formatValue(Number(value), spec.valueFormat)} (${((Number(value) / total) * 100).toFixed(1)}%)`,
              name,
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8, color: "var(--ink-2)" }} iconType="circle" iconSize={8} />
        </PieChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

// ─── Scatter ──────────────────────────────────────────────────
function ScatterPlot({ spec }: { spec: ChartSpec }) {
  return (
    <ChartWrapper title={spec.title} subtitle={spec.subtitle}>
      <ResponsiveContainer width="100%" height={280}>
        <ScatterChart margin={{ top: 10, right: 20, left: 10, bottom: 30 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
          <XAxis
            type="number"
            dataKey="x"
            name={spec.xLabel ?? "X"}
            tick={{ fontSize: 11, fill: "var(--ink-2)" }}
            label={spec.xLabel ? { value: spec.xLabel, position: "insideBottom", offset: -10, fill: "var(--ink-3)", fontSize: 11 } : undefined}
          />
          <YAxis
            type="number"
            dataKey="y"
            name={spec.yLabel ?? "Y"}
            tick={{ fontSize: 11, fill: "var(--ink-2)" }}
            tickFormatter={(v) => formatValue(v, spec.valueFormat)}
            width={55}
            label={spec.yLabel ? { value: spec.yLabel, angle: -90, position: "insideLeft", fill: "var(--ink-3)", fontSize: 11 } : undefined}
          />
          <ZAxis range={[40, 140]} />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ strokeDasharray: "3 3", stroke: "var(--line-strong)" }}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8, color: "var(--ink-2)" }} iconType="circle" iconSize={8} />
          {spec.datasets.map((ds, i) => {
            const color = ds.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length];
            const pts = ds.points ??
              ds.data.map((y, j) => ({ x: j, y }));
            return (
              <Scatter
                key={ds.label}
                name={ds.label}
                data={pts}
                fill={color}
                opacity={0.8}
              />
            );
          })}
        </ScatterChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

// ─── Strip JS-style comments from JSON ────────────────────────
// LLMs like to emit "// comment" inside JSON. We strip them.
function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\/[^\n]*/g, "")     // single-line // comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // block /* */ comments
    .trim();
}

// ─── CHART block renderer ─────────────────────────────────────
function ChartBlock({ raw }: { raw: string }) {
  const spec = useMemo<ChartSpec | null>(() => {
    try {
      const cleaned = stripJsonComments(raw.trim());
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed.datasets) || !Array.isArray(parsed.labels)) return null;
      return parsed as ChartSpec;
    } catch {
      return null;
    }
  }, [raw]);

  if (!spec) {
    return (
      <div className="my-3 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-700 dark:text-yellow-300">
        ⚠️ Could not render chart — invalid spec
      </div>
    );
  }

  if (spec.type === "pie" || spec.type === "doughnut") {
    return <PieDonutChart spec={spec} />;
  }
  if (spec.type === "scatter") {
    return <ScatterPlot spec={spec} />;
  }
  return <BarLineAreaChart spec={spec} />;
}

// ─── MERMAID block renderer ───────────────────────────────────
function MermaidBlock({ raw }: { raw: string }) {
  const [copied, setCopied] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(false);

    import("mermaid").then(({ default: mermaid }) => {
      if (cancelled) return;
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        // Mermaid injects these into its own <style>, so literal hex
        // (matching the token values) is safer than var() here. These have to
        // be updated by hand whenever the layer ramp moves, or a diagram
        // renders a shade lighter than the card it sits in.
        themeVariables: {
          background: "#0d1015",       /* --surface-1 */
          primaryColor: "#141a2b",
          primaryTextColor: "#eef1f6", /* --ink-1 */
          primaryBorderColor: "#2b3340", /* --line-strong */
          lineColor: "#6b7686",        /* --ink-3 */
          secondaryColor: "#14181f",   /* --surface-2 */
          tertiaryColor: "#1c212a",    /* --surface-3 */
          fontFamily: "IBM Plex Sans, system-ui, sans-serif",
          fontSize: "14px",
        },
      });
      mermaid.parseError = () => {};
      const ml = mermaid as any;
      if (ml.logger) { ml.logger.warn = () => {}; ml.logger.error = () => {}; }
      const trimmed = raw.trim();
      if (typeof mermaid.parse === "function") {
        try { (mermaid as any).parse(trimmed); } catch { if (!cancelled) setError(true); return; }
      }
      mermaid
        .render(idRef.current, trimmed)
        .then(({ svg: renderedSvg }) => {
          if (!cancelled) setSvg(renderedSvg);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [raw]);

  const copy = () => {
    navigator.clipboard.writeText(raw.trim()).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-5 rounded-card border border-line bg-surface-1 overflow-hidden shadow-xl">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-line bg-surface-2">
        <span className="text-[11px] font-semibold tracking-[0.18em] uppercase text-brand">
          ▪ Diagram
        </span>
        <button
          onClick={copy}
          className="text-[11px] text-ink-3 hover:text-ink-1 transition-colors"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      {/* Rendered SVG */}
      {svg && !error && (
        <div
          className="p-4 overflow-x-auto diagram-svg-wrapper"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}

      {/* Loading state */}
      {!svg && !error && (
        <div className="flex items-center gap-2 px-4 py-6 text-xs text-ink-3">
          <svg className="animate-spin h-3.5 w-3.5 text-brand" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          Rendering diagram…
        </div>
      )}

      {/* Fallback: show raw code if mermaid fails */}
      {error && (
        <pre className="p-4 text-xs font-mono text-ink-2 overflow-x-auto whitespace-pre leading-relaxed border-t border-line">
          {raw.trim()}
        </pre>
      )}
    </div>
  );
}

export type TextOrVisual =
  | { kind: "text"; content: string }
  | { kind: "chart"; raw: string }
  | { kind: "mermaid"; raw: string };

export function parseVisuals(content: string): TextOrVisual[] {
  const segments: TextOrVisual[] = [];
  const fixed = fixMalformedTags(content);
  const re = /<(?:CHART|MERMAID)>([\s\S]*?)<\/(?:CHART|MERMAID)>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(fixed)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", content: fixed.slice(lastIndex, match.index) });
    }
    const tagRaw = fixed.slice(match.index + 1, match.index + 1 + 10).toUpperCase();
    const tag = tagRaw.startsWith("MERMAID") ? "MERMAID" : "CHART";
    segments.push({
      kind: tag === "CHART" ? "chart" : "mermaid",
      raw: match[1] ?? "",
    });
    lastIndex = re.lastIndex;
  }

  if (lastIndex < fixed.length) {
    segments.push({ kind: "text", content: fixed.slice(lastIndex) });
  }

  return segments;
}

export function ContentWithVisuals({ content, renderText }: {
  content: string;
  renderText: (text: string, key: string | number) => React.ReactNode;
}) {
  const segments = useMemo(() => parseVisuals(content), [content]);

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "chart")   return <ChartBlock   key={i} raw={seg.raw} />;
        if (seg.kind === "mermaid") return <MermaidBlock key={i} raw={seg.raw} />;
        return renderText(seg.content, i);
      })}
    </>
  );
}

export type ChartData = ChartSpec;

export function ChartRenderer({ data }: { data: ChartData }) {
  if (!data || !Array.isArray(data.labels) || !Array.isArray(data.datasets)) {
    return (
      <div className="my-3 px-3 py-2 rounded-card bg-[var(--att-critical)]/10 border border-[var(--att-critical)]/25 text-xs text-critical-text">
        ⚠️ Invalid chart specifications (missing labels or datasets)
      </div>
    );
  }
  if (data.type === "pie" || data.type === "doughnut") {
    return <PieDonutChart spec={data} />;
  }
  if (data.type === "scatter") {
    return <ScatterPlot spec={data} />;
  }
  return <BarLineAreaChart spec={data} />;
}

export { ChartBlock, MermaidBlock };
