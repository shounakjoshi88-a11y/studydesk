export type PcEntry = { name: string; path: string; dir: boolean; size: number; mtime: number };

async function get(url: string) {
  const r = await fetch(url);
  if (r.status === 401) throw new Error("PC_AUTH");
  if (!r.ok) throw new Error(`PC returned ${r.status}`);
  return r.json();
}

export async function pcBrowse(
  base: string, token: string, path?: string | null
): Promise<{ cwd: string | null; roots?: string[]; entries: PcEntry[] }> {
  const u = `${base.replace(/\/$/, "")}/browse?token=${encodeURIComponent(token)}${path ? `&path=${encodeURIComponent(path)}` : ""}`;
  return get(u);
}

export async function pcPull(base: string, token: string, path: string): Promise<{ name: string; data: string }> {
  const u = `${base.replace(/\/$/, "")}/pull?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;
  return get(u);
}

export async function pcPush(
  base: string, token: string, folder: string, name: string, data: string
): Promise<{ saved: string }> {
  const r = await fetch(`${base.replace(/\/$/, "")}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, path: folder, name, data }),
  });
  if (r.status === 401) throw new Error("PC_AUTH");
  if (!r.ok) throw new Error(`PC returned ${r.status}`);
  return r.json();
}
