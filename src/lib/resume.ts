import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Document, Packer, Paragraph, HeadingLevel } from "docx";

export type ResumeData = {
  name: string;
  title: string;
  email: string;
  phone: string;
  location: string;
  links: string;
  summary: string;
  education: Array<{ school: string; degree: string; year: string; detail: string }>;
  experience: Array<{ role: string; org: string; period: string; detail: string }>;
  projects: Array<{ name: string; detail: string }>;
  skills: string;
};

export const EMPTY_RESUME: ResumeData = {
  name: "", title: "", email: "", phone: "", location: "", links: "",
  summary: "", education: [], experience: [], projects: [], skills: "",
};

export const SAMPLE_RESUME: ResumeData = {
  name: "Aarav Sharma",
  title: "Computer Science Undergraduate",
  email: "aarav.sharma@example.com",
  phone: "+91 98765 43210",
  location: "Nagpur, India",
  links: "github.com/aarav | linkedin.com/in/aarav",
  summary: "Second-year CS student focused on networks and full-stack projects. JNCIA certified, hackathon finalist.",
  education: [
    { school: "Ramdeobaba University, Nagpur", degree: "B.Tech Computer Science", year: "2024 – 2028", detail: "CGPA 8.6. Coursework: CN, OS, DBMS." },
  ],
  experience: [
    { role: "Technical Volunteer", org: "College Hackathon Cell", period: "2025 – Present", detail: "Ran campus network for 200-participant events. Built check-in dashboard." },
  ],
  projects: [
    { name: "StudyDesk", detail: "Notes, file tools and AI help app. Capacitor + React, 500+ users on campus." },
  ],
  skills: "Python, Java, C, React, Junos OS, Git, Wireshark",
};

export type ResumeTemplate = {
  id: string;
  name: string;
  blurb: string;
  accent: [number, number, number];
  header: "center" | "left" | "bar" | "sidebar";
  rule: boolean;
  nameSize: number;
  sectionSpacing: number;
};

export const RESUME_TEMPLATES: ResumeTemplate[] = [
  { id: "classic", name: "Classic", blurb: "Centered, timeless", accent: [0.15, 0.15, 0.18], header: "center", rule: true, nameSize: 24, sectionSpacing: 10 },
  { id: "modern", name: "Modern", blurb: "Left header, violet", accent: [0.42, 0.36, 0.94], header: "left", rule: true, nameSize: 24, sectionSpacing: 10 },
  { id: "minimal", name: "Minimal", blurb: "Airy, small caps", accent: [0.4, 0.4, 0.45], header: "left", rule: false, nameSize: 22, sectionSpacing: 14 },
  { id: "sidebar", name: "Sidebar", blurb: "Dark side column", accent: [0.16, 0.16, 0.2], header: "sidebar", rule: false, nameSize: 22, sectionSpacing: 9 },
  { id: "compact", name: "Compact", blurb: "Dense one-pager", accent: [0.2, 0.2, 0.25], header: "left", rule: true, nameSize: 20, sectionSpacing: 7 },
  { id: "boldbar", name: "Bold Bar", blurb: "Big name banner", accent: [0.42, 0.36, 0.94], header: "bar", rule: false, nameSize: 26, sectionSpacing: 10 },
  { id: "elegant", name: "Elegant", blurb: "Thin rules, spaced", accent: [0.35, 0.3, 0.55], header: "center", rule: true, nameSize: 23, sectionSpacing: 13 },
  { id: "mono", name: "Mono Tech", blurb: "Terminal feel", accent: [0.1, 0.35, 0.25], header: "left", rule: false, nameSize: 22, sectionSpacing: 10 },
  { id: "corporate", name: "Corporate", blurb: "Navy, formal", accent: [0.1, 0.2, 0.4], header: "left", rule: true, nameSize: 23, sectionSpacing: 10 },
  { id: "fresher", name: "Fresher", blurb: "Education first", accent: [0.75, 0.3, 0.2], header: "center", rule: true, nameSize: 24, sectionSpacing: 11 },
];

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
  }
  return btoa(s);
}

type PDFFont = Awaited<ReturnType<PDFDocument["embedFont"]>>;

export async function resumeToPdf(d: ResumeData, t: ResumeTemplate): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = t.id === "mono" ? await pdf.embedFont(StandardFonts.Courier) : font;
  const boldMono = t.id === "mono" ? await pdf.embedFont(StandardFonts.CourierBold) : bold;
  const accent = rgb(t.accent[0], t.accent[1], t.accent[2]);
  const ink = rgb(0.12, 0.12, 0.14);
  const grey = rgb(0.42, 0.42, 0.46);
  const PW = 595;
  const PH = 842;

  const sidebar = t.header === "sidebar";
  const M = 46;
  const leftX = sidebar ? 190 : M;
  const maxW = PW - (sidebar ? leftX + 36 : M * 2);
  let page = pdf.addPage([PW, PH]);
  let y = PH - 44;

  const newPage = () => {
    page = pdf.addPage([PW, PH]);
    y = PH - 44;
  };
  const need = (h: number) => {
    if (y - h < 40) newPage();
  };
  const wrap = (text: string, f: PDFFont, size: number, w: number): string[] => {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = "";
    for (const word of words) {
      const test = cur ? cur + " " + word : word;
      if (f.widthOfTextAtSize(test, size) > w && cur) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  };
  const para = (text: string, f: PDFFont, size: number, x: number, w: number, color = ink, gap = 4) => {
    for (const ln of wrap(text, f, size, w)) {
      need(size + 6);
      page.drawText(ln, { x, y: y - size, size, font: f, color });
      y -= size + gap;
    }
  };
  const sectionTitle = (s: string, x: number, w: number) => {
    need(24);
    y -= 2;
    const label = t.id === "minimal" ? s.toUpperCase() : s;
    page.drawText(label, { x, y: y - 11, size: 11, font: boldMono, color: accent });
    y -= 15;
    if (t.rule) {
      page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.8, color: accent });
      y -= 6;
    }
    y -= t.sectionSpacing - 8;
  };
  const bullet = (text: string, x: number, w: number) => {
    for (const ln of wrap(text, font, 9.5, w - 12)) {
      need(14);
      page.drawText("•", { x, y: y - 9.5, size: 9.5, font, color: grey });
      page.drawText(ln, { x: x + 12, y: y - 9.5, size: 9.5, font, color: ink });
      y -= 13.5;
    }
  };

  if (sidebar) {
    page.drawRectangle({ x: 0, y: 0, width: 168, height: PH, color: rgb(0.13, 0.13, 0.17) });
    const sx = 20;
    let sy = PH - 60;
    page.drawText(d.name || "Your Name", { x: sx, y: sy - 18, size: 19, font: bold, color: rgb(1, 1, 1) });
    sy -= 44;
    const sideLine = (label: string, val: string) => {
      if (!val.trim()) return;
      page.drawText(label, { x: sx, y: sy - 9, size: 8.5, font: boldMono, color: rgb(0.65, 0.63, 0.95) });
      sy -= 13;
      for (const ln of wrap(val, font, 9, 128)) {
        page.drawText(ln, { x: sx, y: sy - 9, size: 9, font, color: rgb(0.92, 0.92, 0.94) });
        sy -= 12;
      }
      sy -= 8;
    };
    sideLine("CONTACT", [d.email, d.phone, d.location, d.links].filter((s) => s.trim()).join("\n"));
    sideLine("SKILLS", d.skills.split(/[,;]/).map((s) => s.trim()).filter(Boolean).join("\n"));
  } else if (t.header === "bar") {
    page.drawRectangle({ x: 0, y: PH - 110, width: PW, height: 110, color: accent });
    const lines = wrap(d.name || "Your Name", bold, t.nameSize, PW - M * 2);
    let by = PH - 44;
    for (const ln of lines) {
      page.drawText(ln, { x: M, y: by - t.nameSize, size: t.nameSize, font: bold, color: rgb(1, 1, 1) });
      by -= t.nameSize + 4;
    }
    if (d.title.trim()) {
      page.drawText(d.title, { x: M, y: by - 11, size: 11, font, color: rgb(1, 1, 1) });
      by -= 18;
    }
    y = PH - 128;
  } else {
    const cx = t.header === "center";
    const drawC = (text: string, f: PDFFont, size: number, color: any) => {
      for (const ln of wrap(text, f, size, MAXW)) {
        need(size + 6);
        const w = f.widthOfTextAtSize(ln, size);
        page.drawText(ln, { x: cx ? (PW - w) / 2 : M, y: y - size, size, font: f, color });
        y -= size + 4;
      }
    };
    const MAXW = PW - M * 2;
    drawC(d.name || "Your Name", bold, t.nameSize, t.header === "center" ? ink : accent);
    if (d.title.trim()) drawC(d.title, font, 11, grey);
    const contact = [d.email, d.phone, d.location, d.links].filter((s) => s.trim()).join("  |  ");
    if (contact) drawC(contact, font, 8.5, grey);
    y -= 4;
    if (t.rule) {
      page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 1, color: accent });
      y -= 8;
    }
  }

  const X = leftX;
  const W = maxW;
  const entryHead = (left: string, right: string) => {
    need(16);
    const rl = right.trim();
    const rw = rl ? bold.widthOfTextAtSize(rl, 9) : 0;
    for (const ln of wrap(left, bold, 10, W - rw - 8)) {
      need(15);
      page.drawText(ln, { x: X, y: y - 10, size: 10, font: bold, color: ink });
      y -= 14;
    }
    if (rl) {
      page.drawText(rl, { x: X + W - rw, y: y + 0, size: 9, font, color: grey });
    }
  };

  if (d.summary.trim()) {
    sectionTitle("Summary", X, W);
    para(d.summary, font, 9.5, X, W);
    y -= 2;
  }
  const eduFirst = t.id === "fresher";
  const eduBlock = () => {
    if (!d.education.length) return;
    sectionTitle("Education", X, W);
    for (const e of d.education) {
      entryHead(`${e.degree}${e.school ? ` — ${e.school}` : ""}`, e.year);
      if (e.detail.trim()) bullet(e.detail, X, W);
      y -= 2;
    }
  };
  const expBlock = () => {
    if (!d.experience.length) return;
    sectionTitle("Experience", X, W);
    for (const e of d.experience) {
      entryHead(`${e.role}${e.org ? ` — ${e.org}` : ""}`, e.period);
      for (const ln of e.detail.split("\n").map((s) => s.trim()).filter(Boolean)) {
        bullet(ln.replace(/^[-*•]\s*/, ""), X, W);
      }
      y -= 2;
    }
  };
  if (eduFirst) {
    eduBlock();
    expBlock();
  } else {
    expBlock();
    eduBlock();
  }
  if (d.projects.length) {
    sectionTitle("Projects", X, W);
    for (const p of d.projects) {
      entryHead(p.name, "");
      if (p.detail.trim()) bullet(p.detail, X, W);
      y -= 2;
    }
  }
  if (d.skills.trim() && !sidebar) {
    sectionTitle("Skills", X, W);
    para(d.skills, font, 9.5, X, W);
  }

  return bytesToB64(await pdf.save());
}

export async function resumeToDocx(d: ResumeData, t: ResumeTemplate): Promise<string> {
  const { Document, Packer, Paragraph, HeadingLevel } = await import("docx");
  const kids: InstanceType<typeof Paragraph>[] = [];
  kids.push(new Paragraph({ text: d.name || "Your Name", heading: HeadingLevel.TITLE }));
  if (d.title.trim()) kids.push(new Paragraph({ text: d.title }));
  const contact = [d.email, d.phone, d.location, d.links].filter((s) => s.trim()).join(" | ");
  if (contact) kids.push(new Paragraph({ text: contact }));
  const sec = (s: string) => kids.push(new Paragraph({ text: s, heading: HeadingLevel.HEADING_1 }));
  if (d.summary.trim()) {
    sec("Summary");
    kids.push(new Paragraph({ text: d.summary }));
  }
  const eduKids = () => {
    if (!d.education.length) return;
    sec("Education");
    for (const e of d.education) {
      kids.push(new Paragraph({ text: `${e.degree}${e.school ? ` — ${e.school}` : ""} (${e.year})` }));
      if (e.detail.trim()) kids.push(new Paragraph({ text: e.detail, bullet: { level: 0 } }));
    }
  };
  const expKids = () => {
    if (!d.experience.length) return;
    sec("Experience");
    for (const e of d.experience) {
      kids.push(new Paragraph({ text: `${e.role}${e.org ? ` — ${e.org}` : ""} (${e.period})` }));
      for (const ln of e.detail.split("\n").map((s) => s.trim()).filter(Boolean)) {
        kids.push(new Paragraph({ text: ln.replace(/^[-*•]\s*/, ""), bullet: { level: 0 } }));
      }
    }
  };
  if (t.id === "fresher") {
    eduKids();
    expKids();
  } else {
    expKids();
    eduKids();
  }
  if (d.projects.length) {
    sec("Projects");
    for (const p of d.projects) {
      kids.push(new Paragraph({ text: p.name }));
      if (p.detail.trim()) kids.push(new Paragraph({ text: p.detail, bullet: { level: 0 } }));
    }
  }
  if (d.skills.trim()) {
    sec("Skills");
    kids.push(new Paragraph({ text: d.skills }));
  }
  void t;
  const doc = new Document({ sections: [{ children: kids }] });
  const blob = await Packer.toBlob(doc);
  return bytesToB64(new Uint8Array(await blob.arrayBuffer()));
}
