// src/components/XlsxPreview.tsx
import React, { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { Download, Search, Table as TableIcon, Loader2, X } from "lucide-react";
import * as XLSX from "xlsx";

interface XlsxPreviewProps {
  base64: string;
  filename: string;
  onClose: () => void;
  onDownload: () => void;
}

export function XlsxPreview({ base64, filename, onClose, onDownload }: XlsxPreviewProps) {
  const [data, setData] = useState<any[][]>([]);
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setLoading(true);
    try {
      const binary = atob(base64);
      const workbook = XLSX.read(binary, { type: "binary" });
      const sheetNames = workbook.SheetNames;
      if (!sheetNames || sheetNames.length === 0) throw new Error("No sheets found");
      setSheets(sheetNames);
      
      const firstName = sheetNames[0];
      if (!firstName) throw new Error("No sheet name found");
      const firstSheet = workbook.Sheets[firstName];
      if (!firstSheet) throw new Error("Empty sheet");
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 }) as any[][];
      setData(rows);
    } catch (err) {
      console.error("XLSX parse error:", err);
    } finally {
      setLoading(false);
    }
  }, [base64]);

  const filteredData = useMemo(() => {
    if (!search.trim()) return data;
    const q = search.toLowerCase();
    return data.filter(row => 
      row.some(cell => String(cell).toLowerCase().includes(q))
    );
  }, [data, search]);

  if (loading) return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="size-8 animate-spin text-brand/30" />
    </div>
  );

  return (
    <div className="flex-1 flex flex-col bg-surface-1 h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-line shrink-0">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <TableIcon className="size-4 shrink-0 text-brand" />
          <div className="truncate">
            <p className="text-sm font-medium text-foreground truncate">{filename}</p>
            <p className="tnum text-[11px] text-ink-2">{data.length} rows detected</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex items-center bg-surface-2 border border-line rounded-card px-2.5 py-1.5 focus-within:border-brand transition-all">
            <Search className="size-3 text-ink-3 mr-2" />
            <input 
              type="text" 
              placeholder="Search rows..." 
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="bg-transparent outline-none text-xs text-ink-1 placeholder:text-ink-2 w-32"
            />
          </div>
          <button onClick={onDownload} className="sd-press p-2.5 rounded-card text-ink-3 hover:text-ink-1 transition-all">
            <Download className="size-4" />
          </button>
          <button onClick={onClose} className="sd-press p-2.5 rounded-card text-ink-3 hover:text-ink-1 transition-all">
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* Table Area */}
      <div className="flex-1 overflow-auto bg-background" style={{ scrollbarWidth: "none" }}>
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-surface-2 border-b border-line">
            <tr>
              <th className="tnum px-3 py-2 text-left text-ink-2 font-medium border-r border-line w-10">#</th>
              {data[0]?.map((col, i) => (
                <th key={i} className="px-4 py-2 text-left text-ink-1 font-semibold border-r border-line min-w-[120px]">
                  {String(col || `Col ${i + 1}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredData.slice(1).map((row, ri) => (
              <tr key={ri} className="border-b border-line hover:bg-surface-1 transition-colors">
                <td className="tnum px-3 py-2 text-ink-3 text-center border-r border-line bg-surface-1">{ri + 1}</td>
                {row.map((cell, ci) => (
                  <td key={ci} className="px-4 py-2 text-ink-2 border-r border-line whitespace-nowrap truncate max-w-[300px]">
                    {String(cell ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {filteredData.length === 0 && (
          <div className="h-64 flex flex-col items-center justify-center opacity-20">
            <Search className="size-12 mb-4" />
            <p className="text-sm font-bold uppercase tracking-widest">No matching rows</p>
          </div>
        )}
      </div>

      {/* Sheet Tabs if multiple */}
      {sheets.length > 1 && (
        <div className="flex items-center gap-1 px-4 py-2 bg-surface-2 border-t border-line overflow-x-auto shrink-0">
          {sheets.map((name, i) => (
            <button
              key={name}
              onClick={() => setActiveSheet(i)}
              className={`sd-press px-3 py-1 rounded-card text-[11px] font-bold transition-all ${
                activeSheet === i ? "bg-brand text-background" : "bg-surface-3 text-ink-2 hover:bg-surface-3/70"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
