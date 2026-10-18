import { createWorker } from "tesseract.js";
import { b64ToBytes } from "./store";
import type { ParsedClass } from "./ai";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const TIME_RE = /\d{1,2}([:.]\d{2})?\s*[-–—~to]+\s*\d{1,2}([:.]\d{2})?/i;
const DAY_RE =
  /\b(mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b/i;

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

function drawToCanvas(img: HTMLImageElement | HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  c.getContext("2d", { willReadFrequently: true })!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** 90° either way or 180°. Phone photos arrive in any of the four upright
 *  orientations, so all of them are candidates. */
function rotateCanvas(src: HTMLCanvasElement, rotation: "ccw" | "cw" | "180"): HTMLCanvasElement {
  const c = document.createElement("canvas");
  if (rotation === "180") {
    c.width = src.width;
    c.height = src.height;
  } else {
    c.width = src.height;
    c.height = src.width;
  }
  const ctx = c.getContext("2d")!;
  if (rotation === "ccw") {
    ctx.translate(0, c.height);
    ctx.rotate(-Math.PI / 2);
  } else if (rotation === "cw") {
    ctx.translate(c.width, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(c.width, c.height);
    ctx.rotate(Math.PI);
  }
  ctx.drawImage(src, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------
// Numeric core — faithful ports of the steps validated in ocr-lab/lab.py.
// All maths is plain typed-array work: deterministic, canvas-independent.
// ---------------------------------------------------------------------------

const sat8 = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
const trunc8 = (v: number): number => {
  const t = Math.trunc(v);
  return t < 0 ? 0 : t > 255 ? 255 : t;
};
const clutch = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** sRGB byte → linear (0..1). */
const SRGB_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const s = i / 255;
  SRGB_LIN[i] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** cv2 8-bit L channel (CIELAB L* × 2.55, rounded) — used for the edge mask. */
function labL8(r: number, g: number, b: number): number {
  const Y = 0.2126729 * SRGB_LIN[r]! + 0.7151522 * SRGB_LIN[g]! + 0.0721750 * SRGB_LIN[b]!;
  const fy = Y > 0.008856 ? Math.cbrt(Y) : 7.787037037037037 * Y + 0.13793103448275862;
  return sat8((116 * fy - 16) * 2.55);
}

const labF = (t: number): number =>
  t > 0.008856451679035631 ? Math.cbrt(t) : 7.787037037037037 * t + 0.13793103448275862;

/** Full cv2-compatible 8-bit LAB for a whole RGB buffer (L×2.55, a+128, b+128). */
function labOf(rgb: Uint8Array, n: number): { L: Float32Array; A: Float32Array; B: Float32Array } {
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const rl = SRGB_LIN[rgb[i * 3]!]!;
    const gl = SRGB_LIN[rgb[i * 3 + 1]!]!;
    const bl = SRGB_LIN[rgb[i * 3 + 2]!]!;
    const X = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl;
    const Y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
    const Z = 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl;
    const fx = labF(X / 0.95047);
    const fy = labF(Y);
    const fz = labF(Z / 1.08883);
    L[i] = sat8((116 * fy - 16) * 2.55);
    A[i] = sat8(500 * (fx - fy) + 128);
    B[i] = sat8(200 * (fy - fz) + 128);
  }
  return { L, A, B };
}

/** Otsu split from a 256-bin histogram (cv2 THRESH_OTSU equivalent). */
function otsuFromHist(hist: Int32Array): number {
  let total = 0;
  let sum = 0;
  for (let t = 0; t < 256; t++) {
    total += hist[t]!;
    sum += t * hist[t]!;
  }
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestT = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return bestT;
}

/** Sobel 3×3 magnitude with BORDER_REFLECT_101 (cv2 default). */
function sobelMag(L: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const rc = (v: number, n: number) => (v < 0 ? -v : v >= n ? 2 * n - v - 2 : v);
  for (let y = 0; y < h; y++) {
    const ym = rc(y - 1, h) * w;
    const y0 = y * w;
    const yp = rc(y + 1, h) * w;
    for (let x = 0; x < w; x++) {
      const xm = rc(x - 1, w);
      const xp = rc(x + 1, w);
      const gx = L[yp + xp]! + 2 * L[y0 + xp]! + L[ym + xp]! - (L[yp + xm]! + 2 * L[y0 + xm]! + L[ym + xm]!);
      const gy = L[ym + xm]! + 2 * L[ym + x]! + L[ym + xp]! - (L[yp + xm]! + 2 * L[yp + x]! + L[yp + xp]!);
      out[y0 + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

/** Positions of runs in a 0..1 projection that exceed thr (cv2 line scan). */
function linePositions(proj: Float32Array | number[], thr: number, minGap: number, maxThick = 9): number[] {
  const pos: number[] = [];
  let runStart = -1;
  for (let i = 0; i < proj.length; i++) {
    if (proj[i]! > thr) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart <= maxThick) pos.push(Math.floor((runStart + i - 1) / 2));
      runStart = -1;
    }
  }
  if (runStart >= 0) pos.push(Math.floor((runStart + proj.length - 1) / 2));
  // dedupe with min gap (cv2 pipeline's _dedupe)
  const out: number[] = [];
  for (const v of pos.sort((a, b) => a - b)) {
    if (!out.length || v - out[out.length - 1]! >= minGap) out.push(v);
    else out[out.length - 1] = Math.floor((out[out.length - 1]! + v) / 2);
  }
  return out;
}

/** Morphological opening with a horizontal RECT kernel (cv2 semantics —
 *  out-of-image positions never count, so border lines survive). */
function openH(edge: Uint8Array, w: number, h: number, len: number): Uint8Array {
  const a = Math.floor(len / 2);
  const ero = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let ok = 1;
      for (let i = 0; i < len; i++) {
        const xx = x - a + i;
        if (xx < 0 || xx >= w) continue;
        if (!edge[row + xx]) {
          ok = 0;
          break;
        }
      }
      ero[row + x] = ok;
    }
  }
  const dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let ok = 0;
      for (let i = 0; i < len; i++) {
        const xx = x - a + i;
        if (xx < 0 || xx >= w) continue;
        if (ero[row + xx]) {
          ok = 1;
          break;
        }
      }
      dil[row + x] = ok;
    }
  }
  return dil;
}

/** Vertical twin of openH. */
function openV(edge: Uint8Array, w: number, h: number, len: number): Uint8Array {
  const a = Math.floor(len / 2);
  const ero = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let ok = 1;
      for (let i = 0; i < len; i++) {
        const yy = y - a + i;
        if (yy < 0 || yy >= h) continue;
        if (!edge[yy * w + x]) {
          ok = 0;
          break;
        }
      }
      ero[y * w + x] = ok;
    }
  }
  const dil = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let ok = 0;
      for (let i = 0; i < len; i++) {
        const yy = y - a + i;
        if (yy < 0 || yy >= h) continue;
        if (ero[yy * w + x]) {
          ok = 1;
          break;
        }
      }
      dil[y * w + x] = ok;
    }
  }
  return dil;
}

/** Separable INTER_AREA resize for a 3-channel buffer (float accumulation,
 *  one rounding at the end — same as cv2's single pass). */
function areaResize3(src: Uint8Array, w: number, h: number, outW: number, outH: number): Uint8Array {
  const tmp = new Float32Array(outW * h * 3);
  const sx = w / outW;
  for (let y = 0; y < h; y++) {
    const rowIn = y * w * 3;
    for (let k = 0; k < outW; k++) {
      const s0 = k * sx;
      const s1 = s0 + sx;
      const i0 = Math.floor(s0);
      const i1 = Math.min(w, Math.ceil(s1));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = i0; i < i1; i++) {
        const wt = Math.min(i + 1, s1) - Math.max(i, s0);
        const j = rowIn + i * 3;
        r += src[j]! * wt;
        g += src[j + 1]! * wt;
        b += src[j + 2]! * wt;
      }
      const o = (y * outW + k) * 3;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
    }
  }
  const out = new Uint8Array(outW * outH * 3);
  const sy = h / outH;
  const norm = 1 / (sx * sy);
  for (let k = 0; k < outH; k++) {
    const s0 = k * sy;
    const s1 = s0 + sy;
    const i0 = Math.floor(s0);
    const i1 = Math.min(h, Math.ceil(s1));
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = i0; i < i1; i++) {
        const wt = Math.min(i + 1, s1) - Math.max(i, s0);
        const j = (i * outW + x) * 3;
        r += tmp[j]! * wt;
        g += tmp[j + 1]! * wt;
        b += tmp[j + 2]! * wt;
      }
      const o = (k * outW + x) * 3;
      out[o] = sat8(r * norm);
      out[o + 1] = sat8(g * norm);
      out[o + 2] = sat8(b * norm);
    }
  }
  return out;
}

/** Per-channel median blur with replicate border (cv2.medianBlur). */
function median3ch(src: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const r = k >> 1;
  const out = new Uint8Array(src.length);
  const win = new Uint8Array(k * k);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < 3; ch++) {
        let m = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = clutch(y + dy, 0, h - 1);
          for (let dx = -r; dx <= r; dx++) {
            const xx = clutch(x + dx, 0, w - 1);
            win[m++] = src[(yy * w + xx) * 3 + ch]!;
          }
        }
        // small fixed-size sort (k² ≤ 25)
        for (let a = 1; a < m; a++) {
          const v = win[a]!;
          let b = a - 1;
          while (b >= 0 && win[b]! > v) {
            win[b + 1] = win[b]!;
            b--;
          }
          win[b + 1] = v;
        }
        out[(y * w + x) * 3 + ch] = win[m >> 1]!;
      }
    }
  }
  return out;
}

/** Bicubic (a = -0.75) separable upscale, replicate border (cv2 INTER_CUBIC). */
function cubicUp3(src: Uint8Array, w: number, h: number, outW: number, outH: number): Uint8Array {
  const AW = -0.75;
  const kern = (x: number): number => {
    const t = Math.abs(x);
    if (t < 1) return ((AW + 2) * t - (AW + 3)) * t * t + 1;
    if (t < 2) return (((t - 5) * t + 8) * t - 4) * AW;
    return 0;
  };
  const tmp = new Float32Array(outW * h * 3);
  const sxr = w / outW;
  for (let k = 0; k < outW; k++) {
    const center = (k + 0.5) * sxr - 0.5;
    const i0 = Math.floor(center);
    const ws = new Float32Array(4);
    let wsum = 0;
    for (let t = 0; t < 4; t++) {
      const wt = kern(center - (i0 - 1 + t));
      ws[t] = wt;
      wsum += wt;
    }
    for (let y = 0; y < h; y++) {
      const rowIn = y * w * 3;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let t = 0; t < 4; t++) {
        const xx = clutch(i0 - 1 + t, 0, w - 1);
        const j = rowIn + xx * 3;
        const wt = ws[t]! / wsum;
        r += src[j]! * wt;
        g += src[j + 1]! * wt;
        b += src[j + 2]! * wt;
      }
      const o = (y * outW + k) * 3;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
    }
  }
  const out = new Uint8Array(outW * outH * 3);
  const syr = h / outH;
  for (let k = 0; k < outH; k++) {
    const center = (k + 0.5) * syr - 0.5;
    const i0 = Math.floor(center);
    const ws = new Float32Array(4);
    let wsum = 0;
    for (let t = 0; t < 4; t++) {
      const wt = kern(center - (i0 - 1 + t));
      ws[t] = wt;
      wsum += wt;
    }
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let t = 0; t < 4; t++) {
        const yy = clutch(i0 - 1 + t, 0, h - 1);
        const j = (yy * outW + x) * 3;
        const wt = ws[t]! / wsum;
        r += tmp[j]! * wt;
        g += tmp[j + 1]! * wt;
        b += tmp[j + 2]! * wt;
      }
      const o = (k * outW + x) * 3;
      out[o] = sat8(r);
      out[o + 1] = sat8(g);
      out[o + 2] = sat8(b);
    }
  }
  return out;
}

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const lanczos4 = (x: number): number => {
  const t = Math.abs(x);
  return t >= 4 ? 0 : sinc(t) * sinc(t / 4);
};

/** Lanczos-4 separable upscale of a 1-channel buffer (cv2 INTER_LANCZOS4). */
function lanczos4Up(src: Uint8Array, w: number, h: number, outW: number, outH: number): Uint8Array {
  const tmp = new Float32Array(outW * h);
  const sxr = w / outW;
  for (let k = 0; k < outW; k++) {
    const center = (k + 0.5) * sxr - 0.5;
    const i0 = Math.floor(center);
    const ws = new Float32Array(8);
    let wsum = 0;
    for (let t = 0; t < 8; t++) {
      const wt = lanczos4(center - (i0 - 3 + t));
      ws[t] = wt;
      wsum += wt;
    }
    for (let y = 0; y < h; y++) {
      const rowIn = y * w;
      let acc = 0;
      for (let t = 0; t < 8; t++) acc += src[rowIn + clutch(i0 - 3 + t, 0, w - 1)]! * (ws[t]! / wsum);
      tmp[y * outW + k] = acc;
    }
  }
  const out = new Uint8Array(outW * outH);
  const syr = h / outH;
  for (let k = 0; k < outH; k++) {
    const center = (k + 0.5) * syr - 0.5;
    const i0 = Math.floor(center);
    const ws = new Float32Array(8);
    let wsum = 0;
    for (let t = 0; t < 8; t++) {
      const wt = lanczos4(center - (i0 - 3 + t));
      ws[t] = wt;
      wsum += wt;
    }
    for (let x = 0; x < outW; x++) {
      let acc = 0;
      for (let t = 0; t < 8; t++) acc += tmp[clutch(i0 - 3 + t, 0, h - 1) * outW + x]! * (ws[t]! / wsum);
      out[k * outW + x] = sat8(acc);
    }
  }
  return out;
}

/** Separable Gaussian blur (BORDER_REFLECT_101), float output (cv2 float math). */
function gaussGray(src: Uint8Array, w: number, h: number, sigma: number, ksize: number): Float32Array {
  const c = ksize >> 1;
  const ws = new Float32Array(ksize);
  let wsum = 0;
  for (let i = 0; i < ksize; i++) {
    const d = i - c;
    const wt = Math.exp(-(d * d) / (2 * sigma * sigma));
    ws[i] = wt;
    wsum += wt;
  }
  for (let i = 0; i < ksize; i++) ws[i] = ws[i]! / wsum;
  const rc = (v: number, n: number) => (v < 0 ? -v : v >= n ? 2 * n - v - 2 : v);
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = 0; i < ksize; i++) acc += src[row + rc(x - c + i, w)]! * ws[i]!;
      tmp[row + x] = acc;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = 0; i < ksize; i++) acc += tmp[rc(y - c + i, h) * w + x]! * ws[i]!;
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** 8-connected component labelling with bounding boxes and areas. */
type CompStat = { x0: number; x1: number; y0: number; y1: number; area: number };

function analyzeComponents(mask: Uint8Array, W: number, H: number): { labels: Int32Array; stats: CompStat[] } {
  const labels = new Int32Array(W * H);
  const stats: CompStat[] = [];
  const stack: number[] = [];
  let cur = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    cur++;
    stack.push(i);
    labels[i] = cur;
    let x0 = W;
    let x1 = 0;
    let y0 = H;
    let y1 = 0;
    let area = 0;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p / W) | 0;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const q = ny * W + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = cur;
            stack.push(q);
          }
        }
      }
    }
    stats.push({ x0, x1, y0, y1, area });
  }
  return { labels, stats };
}

/** 3×3 morphological close (dilate → erode) with cv2's border semantics:
 *  out-of-image neighbours never trigger, and never block. */
function close3(mask: Uint8Array, W: number, H: number): Uint8Array {
  const dil = new Uint8Array(mask.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let hit = 0;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          if (mask[ny * W + nx]) {
            hit = 1;
            break;
          }
        }
      }
      dil[y * W + x] = hit;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          if (!dil[ny * W + nx]) {
            all = 0;
            break;
          }
        }
      }
      out[y * W + x] = all;
    }
  }
  return out;
}

/** Cell normaliser + OCR prep — the lab-proven recipe.
 *
 *  The background under the text is ESTIMATED locally and subtracted in
 *  CIELAB, so a cell that is yellow in one corner and magenta in the other
 *  has its own background there: text is whatever deviates from its local
 *  background, in luminance and chroma. Black-on-yellow and white-on-magenta
 *  normalise identically — no dark/light or inversion guessing needed.
 *  Leftover colour-boundary residue of diagonal-split cells is removed by
 *  shape, pinholes are closed, tiny grit is dropped, and the result is
 *  rendered anti-aliased, upscaled (Lanczos) and lightly unsharpened.
 *  Returns pic = null when the cell has nothing worth OCR-ing.
 *  `dbg` (used only by the ocr-lab harness) receives intermediate stages. */
type DbgHook = (
  stage: string,
  data: Uint8Array,
  w: number,
  h: number,
  info?: { thr?: number; maxD?: number; ink?: number }
) => void;

function prepCell(c: HTMLCanvasElement, dbg?: DbgHook): { pic: HTMLCanvasElement | null; ink: number } {
  const W = c.width;
  const H = c.height;
  const n = W * H;
  if (n < 16 || W < 6 || H < 6) return { pic: null, ink: 0 };
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, W, H).data;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = d[i * 4]!;
    rgb[i * 3 + 1] = d[i * 4 + 1]!;
    rgb[i * 3 + 2] = d[i * 4 + 2]!;
  }

  // --- local background estimate: area-downscale → median → cubic-upscale
  const f = Math.max(2, Math.round(Math.min(H, W) / 14));
  const sh = Math.max(6, Math.floor(H / f));
  const sw = Math.max(6, Math.floor(W / f));
  let small = areaResize3(rgb, W, H, sw, sh);
  small = median3ch(small, sw, sh, Math.min(sw, sh) >= 12 ? 5 : 3);
  const bg = cubicUp3(small, sw, sh, W, H);

  // --- deviation from own background: 0.75·ΔL + 0.25·Δchroma (CIELAB)
  const lab1 = labOf(rgb, n);
  const lab2 = labOf(bg, n);
  if (dbg) {
    const l1 = new Uint8Array(n);
    const l2 = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      l1[i] = lab1.L[i]!;
      l2[i] = lab2.L[i]!;
    }
    dbg("a0_cropL", l1, W, H);
    dbg("a1_bgL", l2, W, H);
  }
  const diff = new Float32Array(n);
  let maxD = 0;
  for (let i = 0; i < n; i++) {
    const dA = lab1.A[i]! - lab2.A[i]!;
    const dB = lab1.B[i]! - lab2.B[i]!;
    const v = 0.75 * Math.abs(lab1.L[i]! - lab2.L[i]!) + 0.25 * Math.sqrt(dA * dA + dB * dB);
    diff[i] = v;
    if (v > maxD) maxD = v;
  }
  if (maxD < 26) return { pic: null, ink: 0 }; // flat cell — nothing written here

  // --- Otsu split of the deviation, closed pinholes
  const diff8 = new Uint8Array(n);
  const hist = new Int32Array(256);
  for (let i = 0; i < n; i++) {
    diff8[i] = trunc8(diff[i]!);
    hist[diff8[i]!]++;
  }
  dbg?.("a_diff8", diff8, W, H, { maxD });
  const thr = Math.max(20, otsuFromHist(hist) * 0.85);
  let mask: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = diff[i]! > thr ? 1 : 0;
  mask = close3(mask, W, H);
  dbg?.("b_maskClose", mask, W, H, { thr, maxD });

  // --- shape cleanup: colour-boundary residue, spanning bars, grit
  const { labels, stats } = analyzeComponents(mask, W, H);
  const cellArea = W * H;
  const maxDim = Math.max(W, H);
  const kill = new Set<number>();
  for (let ci = 0; ci < stats.length; ci++) {
    const st = stats[ci]!;
    const bw = st.x1 - st.x0 + 1;
    const bh = st.y1 - st.y0 + 1;
    const fill = st.area / Math.max(1, bw * bh);
    // A leftover diagonal-split edge is LARGE, ELONGATED, LOW box-fill —
    // a glyph never looks like that. Spanning bars and 1–3 px grit die too.
    const spanning = bw > 0.72 * W && bh > 0.72 * H;
    const sliver = st.area > 0.006 * cellArea && fill < 0.35 && Math.max(bw, bh) > 0.3 * maxDim;
    if (spanning || sliver || st.area < 4) kill.add(ci + 1);
  }
  for (let i = 0; i < n; i++) {
    const lb = labels[i]!;
    if (lb && kill.has(lb)) mask[i] = 0;
  }
  dbg?.("c_afterKill", mask, W, H);

  // --- border ring off: grid-line slivers hug the crop edges
  const r = Math.max(2, Math.round(Math.min(H, W) * 0.03));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x < r || y < r || x >= W - r || y >= H - r) mask[y * W + x] = 0;
    }
  }

  // --- anti-aliased render of the same decision
  const aa = new Uint8Array(n);
  let inkCount = 0;
  const softScale = 255 / Math.max(1, thr * 1.05);
  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      inkCount++;
      aa[i] = trunc8(255 - (diff[i]! - thr * 0.55) * softScale);
    } else {
      aa[i] = 255;
    }
  }
  const ink = inkCount / n;
  dbg?.("d_aa", aa, W, H);
  if (ink < 0.004 || ink > 0.6) return { pic: null, ink };

  // --- upscale (Lanczos), light unsharp, white padding
  const up = Math.min(Math.max(3.1, 64 / Math.max(1, Math.min(H, W))), 4.0);
  const outW = Math.max(8, Math.floor(W * up));
  const outH = Math.max(8, Math.floor(H * up));
  const big = lanczos4Up(aa, W, H, outW, outH);
  const blur = gaussGray(big, outW, outH, 1.4, 9);
  const pic = document.createElement("canvas");
  pic.width = outW + 32;
  pic.height = outH + 32;
  const pctx = pic.getContext("2d", { willReadFrequently: true })!;
  const img = pctx.createImageData(pic.width, pic.height);
  const pd = img.data;
  for (let i = 0; i < pd.length; i += 4) {
    pd[i] = 255;
    pd[i + 1] = 255;
    pd[i + 2] = 255;
    pd[i + 3] = 255;
  }
  for (let y = 0; y < outH; y++) {
    const srcRow = y * outW;
    const dstRow = (y + 16) * pic.width + 16;
    for (let x = 0; x < outW; x++) {
      const j = (dstRow + x) * 4;
      const v = sat8(1.6 * big[srcRow + x]! - 0.6 * blur[srcRow + x]!);
      pd[j] = v;
      pd[j + 1] = v;
      pd[j + 2] = v;
    }
  }
  pctx.putImageData(img, 0, 0);
  if (dbg) {
    const pg = new Uint8Array(pic.width * pic.height);
    for (let i = 0; i < pg.length; i++) pg[i] = pd[i * 4]!;
    dbg("e_pic", pg, pic.width, pic.height);
  }
  return { pic, ink };
}

const timeLike = (t: string): boolean => TIME_RE.test(t.replace(/\u00a0/g, " "));

/** Net "(" minus ")" — negative means a closing paren with no opener (the OCR
 *  dropped a "(", turning teacher initials "(PV)" into "FY)"). */
const parenBalance = (t: string): number => {
  let bal = 0;
  for (const ch of t) {
    if (ch === "(") bal++;
    else if (ch === ")") bal--;
  }
  return bal;
};

function matchDay(s: string): string | null {
  const m = DAY_RE.exec(s.toLowerCase());
  if (!m) return null;
  const pre = m[1]!.slice(0, 3);
  return DAYS.find((d) => d.toLowerCase() === pre) || null;
}

const FOOTER_SKIP = /prof\.|hod|dean|signature|principal|in.?charge|assoc|tim\w*\s*table|coordinator/i;

const hhmm = (mins: number): string =>
  `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

/** Parse one cell like "9:00 - 10:00" or "1-2 PM" into minutes (no day context). */
function parseRangeRaw(cell: string): { start: number; end: number } | null {
  let s = cell.replace(/\./g, ":").replace(/[–—]/g, "-").replace(/~/g, "-");
  s = s.replace(/\s+/g, " ").trim();
  let suf: string | null = null;
  const m = s.match(/([AP])\s*\.?\s*M\.?\s*$/i);
  if (m) {
    suf = m[1]!.toUpperCase();
    s = s.slice(0, m.index).trim();
  }
  const parts = s.split(/\s*(?:-|to)\s*/i);
  if (parts.length < 2) return null;
  const one = (p: string): number | null => {
    const mm = p.trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!mm) return null;
    let hh = parseInt(mm[1]!, 10);
    const mi = parseInt(mm[2] || "0", 10);
    // "11:88" / "5:99" are OCR slips, not times — refuse them so the cell
    // can be re-read instead of poisoning the slot table.
    if (hh > 23 || mi > 59) return null;
    if (suf === "P" && hh < 12) hh += 12;
    if (suf === "A" && hh === 12) hh = 0;
    return hh * 60 + mi;
  };
  const a = one(parts[0]!);
  const b = one(parts[1]!);
  if (a === null || b === null) return null;
  return { start: a, end: b };
}

/** Header row cells → slots with day-rollover context ("12:00 - 1:00", "1-2").
 *  A cell that can't become a sane range (zero/negative length, > 5h) is a
 *  misread, not a slot — leave it null so the caller can re-read the cell. */
function parseHeaderSlots(cells: string[]): Array<{ start: string; end: string } | null> {
  let prevEnd = -1;
  return cells.map((cell) => {
    const r = parseRangeRaw(cell);
    if (!r) return null;
    let { start, end } = r;
    if (prevEnd >= 0 && start < prevEnd) start += 720;
    if (end <= start) end += 720;
    const dur = end - start;
    if (dur <= 0 || dur > 300) return null;
    prevEnd = end;
    return { start: hhmm(start), end: hhmm(end) };
  });
}

/** Column span of a cell against header boundaries (fractional overlap). */
function spanOf(x0: number, x1: number, hb: number[]): [number, number] | null {
  let s = -1;
  let e = -1;
  for (let j = 0; j < hb.length - 1; j++) {
    const ov = Math.min(x1, hb[j + 1]!) - Math.max(x0, hb[j]!);
    if (ov > (x1 - x0) * 0.28) {
      if (s < 0) s = j;
      e = j;
    }
  }
  return s < 0 ? null : [s, e];
}

/** Light post-fixes for very common OCR slips (lab-validated). */
function cleanSubject(s: string): string {
  let t = s.replace(/\u2019/g, "'").replace(/[`\u00b4']/g, "");
  t = t.replace(/[^\x20-\x7E\n]/g, ""); // stray Greek/symbol misreads (keep \n: becomes a space below)
  t = t.replace(/\.\s*\//g, " /"); // 'X)./ Y' → 'X) / Y'
  t = t.replace(/\b([A-Z]{1,4})-\s+(\d)/g, "$1-$2"); // "DT- 206" → "DT-206"
  // Stray punctuation OCR glues onto acronyms/groups: '(C1),' 'ITP:(C3)'
  t = t.replace(/([A-Za-z0-9)\]])\s*[.,:;]+(?=\s*[/(\[])/g, "$1");
  t = t.replace(/[.,:;]+(?=\s*\/|\s*$)/g, "");
  t = t.replace(/\s*\/\s*/g, " / ");
  t = t.replace(/\s+/g, " ").trim();
  // OCR sometimes leaves a stray mark from a cell edge at either end.
  t = t.replace(/^[\s=_.:;,|/\\~+*-]+/, "").replace(/[\s=_.:;,|/\\~+*-]+$/, "");
  // A lone leading 1/l in an ALL-CAPS acronym is almost always an I ("1TP").
  t = t.replace(/\S+/g, (tok) => (/^[1l][A-Z]{2,}$/.test(tok) ? "I" + tok.slice(1) : tok));
  return t;
}

type CellBox = { x0: number; y0: number; x1: number; y1: number };

/** A range with real clock times (needs a colon) — distinguishes
 *  "3:00 to 3:30" from cell numbers like "(4-5)". */
const COLON_TIME_RE = /\d{1,2}:\d{2}\s*(?:-|\u2013|\u2014|~|to)\s*\d{1,2}(?::\d{2})?/i;

const toMin = (s: string): number => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

/** Shift a clock range into the table's day window (12-hour dial). */
function mapIntoWindow(a: number, b: number, winStart: number, winEnd: number): { s: number; e: number } | null {
  for (const off of [0, 720]) {
    const s = a + off;
    let e = b + off;
    if (e <= s) e += 720;
    if (s >= winStart && e <= winEnd && e > s) return { s, e };
  }
  return null;
}

/** A cell that visually merged several timetable sub-rows carries one timed
 *  entry per line ("RECESS (3:00 to 3:30)" over "CN TRAINING (3:30 TO 5:30
 *  PM"). Split it into one class per timed line — the line's own clock times
 *  beat the cell's column span. Returns null unless the cell is clearly that
 *  shape (≥2 timed lines), so normal cells are untouched. */
function splitSelfTimed(
  raw: string,
  day: string,
  covered: Array<{ start: string; end: string }>,
  slots: Array<{ start: string; end: string } | null>
): ParsedClass[] | null {
  const lines = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const all = slots.filter(Boolean) as Array<{ start: string; end: string }>;
  if (!all.length) return null;
  const winStart = toMin(all[0]!.start);
  const winEnd = toMin(all[all.length - 1]!.end);
  const covStart = Math.min(...covered.map((c) => toMin(c.start)));
  const covEnd = Math.max(...covered.map((c) => toMin(c.end)));
  const out: ParsedClass[] = [];
  for (const ln of lines) {
    const m = COLON_TIME_RE.exec(ln);
    if (!m) {
      if (out.length && ln.length <= 4) continue; // "PM" tail of a wrapped line
      if (out.length && !/\d/.test(ln)) {
        out[out.length - 1]!.subject = (out[out.length - 1]!.subject + " " + ln).slice(0, 44);
        continue; // wrapped continuation text
      }
      return null;
    }
    const r = parseRangeRaw(m[0]);
    if (!r) return null;
    const abs = mapIntoWindow(r.start, r.end, winStart, winEnd);
    if (!abs || abs.s >= covEnd || abs.e <= covStart) return null;
    const subject = cleanSubject(
      ln
        .replace(m[0], " ")
        .replace(/\(\s*\)/g, " ")
        .replace(/[([{]\s*$/, "")
        .replace(/^[\s)\]}]+/, "")
    );
    if (!subject) return null;
    out.push({ subject: subject.slice(0, 44), day, start: hhmm(abs.s), end: hhmm(abs.e), room: "" });
  }
  return out.length >= 2 ? out : null;
}

/** Crop one cell from a candidate's canvas at source resolution with a
 *  proportional inset so grid lines and their anti-aliasing never become
 *  "text". Returns null for degenerate slivers. */
function cropAt(
  src: HTMLCanvasElement,
  fx: number,
  fy: number,
  box: CellBox,
  inset: number
): HTMLCanvasElement | null {
  const sx0 = Math.round(box.x0 * fx) + inset;
  const sy0 = Math.round(box.y0 * fy) + inset;
  const sx1 = Math.round(box.x1 * fx) - inset;
  const sy1 = Math.round(box.y1 * fy) - inset;
  if (sx1 - sx0 < 6 || sy1 - sy0 < 6) return null;
  const c = document.createElement("canvas");
  c.width = sx1 - sx0;
  c.height = sy1 - sy0;
  c.getContext("2d", { willReadFrequently: true })!.drawImage(src, sx0, sy0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

type Band = { y0: number; y1: number; cols: number[] };

type Structure = {
  w: number;
  h: number;
  hlines: number[];
  bands: Band[];
  medianCols: number;
};

/** Grid structure of one canvas — the lab's stage-2, ported exactly:
 *  CIELAB-L Sobel edges, adaptive Otsu threshold, long-run opening, then
 *  line positions per projection (with edge snapping). OCR-free. */
function detectStructure(src: HTMLCanvasElement): Structure | null {
  const w0 = src.width;
  const h0 = src.height;
  const scale = Math.min(1, 1700 / w0);
  const sw = Math.max(1, Math.floor(w0 * scale));
  const sh = Math.max(1, Math.floor(h0 * scale));
  const work = sw === w0 && sh === h0 ? src : drawToCanvas(src, sw, sh);
  const w = work.width;
  const h = work.height;
  const d = work.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = labL8(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!);

  const mag = sobelMag(L, w, h);
  const hist = new Int32Array(256);
  for (let i = 0; i < mag.length; i++) hist[trunc8(mag[i]! / 4)]++;
  const thr = Math.max(28, Math.min(90, otsuFromHist(hist) * 0.75));
  const edge = new Uint8Array(w * h);
  for (let i = 0; i < mag.length; i++) edge[i] = mag[i]! / 4 > thr ? 1 : 0;

  // Keep only long straight runs (grid strokes survive, text does not).
  const Lk = Math.max(12, Math.round(Math.min(w, h) / 26));
  const hmask = openH(edge, w, h, Lk);
  const vmask = openV(edge, w, h, Lk);

  const hproj = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let cnt = 0;
    for (let x = 0; x < w; x++) cnt += hmask[y * w + x]!;
    hproj[y] = cnt / w;
  }
  const hlines = linePositions(hproj, 0.45, Math.max(6, Math.floor(h / 80)));
  if (hlines.length < 3) return null;
  // Snap the extreme lines to the frame edges when close (photos crop the border).
  if (hlines[0]! > 8) hlines.unshift(0);
  if (h - hlines[hlines.length - 1]! > 8) hlines.push(h);

  const bands: Band[] = [];
  for (let i = 0; i < hlines.length - 1; i++) {
    const y0 = hlines[i]!;
    const y1 = hlines[i + 1]!;
    if (y1 - y0 < Math.max(8, Math.floor(h / 60))) continue;
    const vproj = new Float32Array(w);
    const rows = Math.max(1, y1 - y0 - 3);
    for (let x = 0; x < w; x++) {
      let cnt = 0;
      for (let y = y0 + 2; y < y1 - 1; y++) cnt += vmask[y * w + x]!;
      vproj[x] = cnt / rows;
    }
    let cols = linePositions(vproj, 0.42, Math.max(10, Math.floor(w / 90)));
    if (cols.length < 2) cols = [0, w];
    else {
      if (cols[0]! > 6) cols.unshift(0);
      if (w - cols[cols.length - 1]! > 6) cols.push(w);
    }
    bands.push({ y0, y1, cols });
  }
  if (bands.length < 2) return null;
  const counts = bands.map((b) => Math.max(0, b.cols.length - 1)).sort((a, b) => a - b);
  const medianCols = counts[Math.floor(counts.length / 2)] || 0;
  return { w, h, hlines, bands, medianCols };
}

// ---------------------------------------------------------------------------
// Debug surface for the ocr-lab harness (Node). The app itself only uses
// scanTimetableImage; these exports let the harness reproduce grid detection
// and single-cell normalisation outside the app to compare against lab.py.
// ---------------------------------------------------------------------------
export const __lab = { rotateCanvas, detectStructure, cropAt, prepCell, drawToCanvas, loadImg, analyzeComponents, otsuFromHist };

export async function scanTimetableImage(
  base64: string,
  onStage: (s: string) => void
): Promise<ParsedClass[]> {
  onStage("Finding the table grid…");
  const bytes = b64ToBytes(base64);
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "image/jpeg" }));
  let worker: any = null;
  try {
    const full = await loadImg(url);
    const base = drawToCanvas(full, full.naturalWidth, full.naturalHeight);

    onStage("Reading table cells…");
    worker = await createWorker("eng");
    await worker.setParameters({ tessedit_pageseg_mode: "6" } as any);

    const ocrPic = async (pic: HTMLCanvasElement): Promise<{ text: string; conf: number }> => {
      const { data } = await worker.recognize(pic);
      const text = String(data?.text || "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const conf = typeof data?.confidence === "number" ? data.confidence : 0;
      return { text, conf };
    };

    // Tiny type (e.g. 12 px digits squeezed into a 9-column table) binarises
    // into blobs at source resolution, so the mask pipeline misreads it. A
    // plain grayscale upscale lets tesseract do its own thresholding and reads
    // the same cell cleanly. Below this confidence the binary read is suspect,
    // so try the grayscale read too and take it only when clearly better.
    const CONF_TRY_GRAY = 80;
    const GRAY_CONF_MARGIN = 12;

    const grayUp4 = (c: HTMLCanvasElement): HTMLCanvasElement => {
      const W = Math.max(8, Math.round(c.width * 4));
      const H = Math.max(8, Math.round(c.height * 4));
      const out = document.createElement("canvas");
      out.width = W;
      out.height = H;
      const ctx = out.getContext("2d", { willReadFrequently: true })!;
      ctx.imageSmoothingEnabled = true;
      (ctx as any).imageSmoothingQuality = "high";
      ctx.drawImage(c, 0, 0, W, H);
      return out;
    };

    type Cand = {
      src: HTMLCanvasElement;
      S: Structure;
      fx: number;
      fy: number;
      cache: Map<string, string>;
    };
    const makeCand = (src: HTMLCanvasElement): Cand | null => {
      const S = detectStructure(src);
      if (!S) return null;
      return { src, S, fx: src.width / S.w, fy: src.height / S.h, cache: new Map<string, string>() };
    };
    const grayKey = (inset: number, box: CellBox): string =>
      `gray:${inset}:${box.x0},${box.y0},${box.x1},${box.y1}`;
    const readCell = async (
      cand: Cand,
      box: CellBox,
      inset: number,
      mode: "auto" | "v0" = "auto"
    ): Promise<string> => {
      const key = `${mode}:${inset}:${box.x0},${box.y0},${box.x1},${box.y1}`;
      const hit = cand.cache.get(key);
      if (hit !== undefined) return hit;
      let t = "";
      let tConf = -1;
      const crop = cropAt(cand.src, cand.fx, cand.fy, box, inset);
      if (crop) {
        const { pic } = prepCell(crop);
        if (pic) {
          try {
            const r0 = await ocrPic(pic);
            t = r0.text;
            tConf = r0.conf;
            // Diagonal-split cells holding several "/"-separated subject
            // groups read badly on BOTH paths, but the binary read keeps the
            // group structure — never trade that for a grayscale gamble.
            if (mode === "auto" && r0.conf < CONF_TRY_GRAY && !r0.text.includes(" / ")) {
              const r1 = await ocrPic(grayUp4(crop));
              cand.cache.set(grayKey(inset, box), r1.text);
              if (r1.conf > r0.conf + GRAY_CONF_MARGIN) {
                t = r1.text;
                tConf = r1.conf;
              }
            }
            // A ")" with no "(" means the OCR dropped an opening paren —
            // teacher initials "(PV)" come back as "FY)". The binary pipeline
            // re-run on the 4x upscale repairs those tiny cells (conf 90+
            // against 70s for the broken reads), so take it when what it
            // reads is balanced and at least as confident.
            if (mode === "auto" && t && !t.includes(" / ") && parenBalance(t) < 0) {
              const { pic: pic4 } = prepCell(grayUp4(crop));
              if (pic4) {
                const r4 = await ocrPic(pic4);
                if (r4.text && parenBalance(r4.text) === 0 && r4.conf >= tConf) {
                  t = r4.text;
                  tConf = r4.conf;
                }
              }
            }
          } catch {
            t = "";
          }
        }
      }
      cand.cache.set(key, t);
      return t;
    };
    /** Grayscale re-read of one cell (own cache namespace) — the header's
     *  time labels use it when the binary read didn't parse as a real range. */
    const readCellGray = async (cand: Cand, box: CellBox, inset: number): Promise<string> => {
      const key = grayKey(inset, box);
      const hit = cand.cache.get(key);
      if (hit !== undefined) return hit;
      let t = "";
      const crop = cropAt(cand.src, cand.fx, cand.fy, box, inset);
      if (crop) {
        try {
          t = (await ocrPic(grayUp4(crop))).text;
        } catch {
          t = "";
        }
      }
      cand.cache.set(key, t);
      return t;
    };

    /** Light header probe: how many time-like cells show up in this
     *  orientation? Cheap way to tell a rotated photo where text reads
     *  sideways from one that reads normally. Scans the widest bands (the
     *  grid rows) rather than the first ones — a timetable can sit under a
     *  tall multi-row header block, so the time row isn't always at the top. */
    const probe = async (cand: Cand): Promise<number> => {
      let score = 0;
      const widest = cand.S.bands
        .map((b, i) => ({ i, c: b.cols.length - 1 }))
        .sort((a, b) => b.c - a.c)
        .slice(0, 3)
        .map((x) => x.i);
      for (const b of widest) {
        const band = cand.S.bands[b]!;
        const k = Math.min(6, band.cols.length - 1);
        for (let j = 0; j < k; j++) {
          const box = { x0: band.cols[j]!, y0: band.y0, x1: band.cols[j + 1]!, y1: band.y1 };
          if (timeLike(await readCell(cand, box, 3, "v0"))) score++;
        }
      }
      return score;
    };

    const run = async (cand: Cand): Promise<ParsedClass[] | null> => {
      const { w, bands } = cand.S;
      onStage("Reading table cells…");
      // Read every band's cells — the header is whichever band holds the
      // most time labels, wherever it sits in the table.
      const bandsCells: string[][] = [];
      for (let bi = 0; bi < bands.length; bi++) {
        const band = bands[bi]!;
        const row: string[] = [];
        for (let j = 0; j < band.cols.length - 1; j++) {
          const box = { x0: band.cols[j]!, y0: band.y0, x1: band.cols[j + 1]!, y1: band.y1 };
          row.push(await readCell(cand, box, 2));
        }
        bandsCells.push(row);
        onStage(`Reading row ${bi + 1} of ${bands.length}…`);
      }
      let hdrIdx = -1;
      let hdrScore = 0;
      for (let bi = 0; bi < bandsCells.length; bi++) {
        const sc = bandsCells[bi]!.filter((t) => timeLike(t)).length;
        if (sc > hdrScore) {
          hdrIdx = bi;
          hdrScore = sc;
        }
      }
      (window as any).__ocrGrid = {
        w: cand.S.w,
        h: cand.S.h,
        hLines: cand.S.hlines.length,
        bandCount: bands.length,
        colsPerBand: bands.map((b) => Math.max(0, b.cols.length - 1)),
        headerIdx: hdrIdx,
        headerScore: hdrScore,
      };
      if (hdrScore < 2) return null;
      const hcols = bands[hdrIdx]!.cols;
      const hrow = bandsCells[hdrIdx]!;
      // The header row's whole job is the time labels. Where the binary read
      // didn't yield a real range (tiny fonts binarise into blobs), re-read
      // the cell the grayscale way before settling for no slot there.
      const hband = bands[hdrIdx]!;
      let hdrFallback = 0;
      for (let j = 0; j < hrow.length; j++) {
        if (hrow[j]!.trim() === "" || parseRangeRaw(hrow[j]!)) continue;
        const box = { x0: hband.cols[j]!, y0: hband.y0, x1: hband.cols[j + 1]!, y1: hband.y1 };
        const alt = await readCellGray(cand, box, 2);
        if (alt && parseRangeRaw(alt)) {
          hrow[j] = alt;
          hdrFallback++;
        }
      }
      const slots = parseHeaderSlots(hrow);
      (window as any).__ocrGrid.slots = slots;
      (window as any).__ocrGrid.headerFallback = hdrFallback;
      const validSlots = slots.filter(Boolean).length;
      if (validSlots < 2) return null;

      const classes: Array<{ cls: ParsedClass; bi: number }> = [];
      let currentDay = "Mon";
      let dayHits = 0;
      let lastDayBand = -1;
      for (let bi = hdrIdx + 1; bi < bandsCells.length; bi++) {
        const row = bandsCells[bi]!;
        const cols = bands[bi]!.cols;
        let rowHasDay = false;
        for (let j = 0; j < Math.min(2, row.length); j++) {
          const day = matchDay(row[j]!);
          if (day) {
            currentDay = day;
            dayHits++;
            rowHasDay = true;
            break;
          }
        }
        if (rowHasDay) lastDayBand = bi;
        const combined = row.join(" ");
        if (FOOTER_SKIP.test(combined)) continue;
        for (let j = 0; j < row.length; j++) {
          const x0 = cols[j]!;
          const x1 = cols[j + 1]!;
          if (x1 - x0 < w * 0.02) continue;
          const span = spanOf(x0, x1, hcols);
          if (!span) continue;
          const covered = slots.slice(span[0], span[1] + 1).filter(Boolean) as Array<{
            start: string;
            end: string;
          }>;
          if (!covered.length) continue;
          const raw = row[j]!;
          // A cell that merged several sub-rows can carry its own clock times
          // ("RECESS (3:00 to 3:30)" over "CN TRAINING (3:30 TO 5:30 PM)") —
          // then one class per timed line beats one wrong 2-hour block.
          const subs = splitSelfTimed(raw, currentDay, covered, slots);
          if (subs) {
            for (const c of subs) classes.push({ cls: c, bi });
            continue;
          }
          const subject = cleanSubject(raw);
          if (subject.length < 2) continue;
          if (DAY_RE.test(subject) && subject.length < 14) continue;
          classes.push({
            cls: {
              subject: subject.slice(0, 44),
              day: currentDay,
              start: covered[0]!.start,
              end: covered[covered.length - 1]!.end,
              room: "",
            },
            bi,
          });
        }
        if (classes.length > 200) break;
      }
      // Rows below the last day-labelled row are signature blocks, not
      // classes — keep at most one continuation band (row-spanned day cells).
      const kept = lastDayBand >= 0 ? classes.filter((c) => c.bi <= lastDayBand + 1) : classes;
      // One real cell can read twice (line-splits) — same day+slot can only
      // be one class, so keep the longer subject.
      const mergedByKey = new Map<string, ParsedClass>();
      const order: string[] = [];
      for (const { cls } of kept) {
        const key = `${cls.day}|${cls.start}|${cls.end}`;
        const prev = mergedByKey.get(key);
        if (prev) {
          if (cls.subject.length > prev.subject.length) mergedByKey.set(key, cls);
        } else {
          mergedByKey.set(key, cls);
          order.push(key);
        }
      }
      const final = order.map((k) => mergedByKey.get(k)!);
      if (!final.length) return null;
      // Orientation sanity: a real timetable names its days somewhere. If
      // nothing matched AND the header is weak, this is likely a rotated
      // photo whose text scored a couple of accidental time-like hits —
      // better to let the other orientations try.
      if (dayHits === 0 && hdrScore < 4) return null;
      return final;
    };

    // ---- Orientation handling -------------------------------------------------
    // The photo can arrive upright, sideways (either way) or upside-down.
    // Structure alone can't tell text uprightness, so: cheap structural pass
    // first; if the grid looks like a rotated table (more bands than
    // columns), probe the rotated candidates before the original; otherwise
    // keep the original first (unchanged behaviour for normal photos) and
    // fall back to rotations only if it fails. Rotated candidates are built
    // one at a time (memory-safe on big phone photos).
    const base0 = makeCand(base);
    const portraitish = !!base0 && base0.S.bands.length > base0.S.medianCols + 1;
    const queue: Array<Cand | "ROT"> = [];
    if (portraitish && base0) queue.push("ROT", base0);
    else {
      if (base0) queue.push(base0);
      queue.push("ROT");
    }
    for (const item of queue) {
      if (item !== "ROT") {
        const res = await run(item);
        if (res) return res;
        continue;
      }
      onStage("Checking image rotation…");
      let bestRot: "ccw" | "cw" | "180" | null = null;
      let bestScore = 0;
      for (const rot of ["ccw", "cw", "180"] as const) {
        const c = makeCand(rotateCanvas(base, rot));
        if (!c) continue;
        const s = await probe(c);
        if (s > bestScore) {
          bestScore = s;
          bestRot = rot;
        }
      }
      if (bestRot && bestScore >= 2) {
        const c = makeCand(rotateCanvas(base, bestRot));
        if (c) {
          const res = await run(c);
          if (res) return res;
        }
      }
    }
    throw new Error("NO_GRID");
  } finally {
    try {
      if (worker) await worker.terminate();
    } catch {
      /* noop */
    }
    URL.revokeObjectURL(url);
  }
}
