import { readFileSync } from "fs";
import { crc32, deflateSync } from "zlib";

const FONT = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "'": ["01100", "01100", "00100", "00000", "00000", "00000", "00000"],
  "$": ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"]
};

function hexColor(input) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(input || ""));
  const hex = m ? m[1] : "D94B3D";
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function fill(buf, w, x, y, rw, rh, rgb, height) {
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(w, x + rw), y1 = Math.min(height, y + rh);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * w + xx) * 3;
      buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2];
    }
  }
}

function textWidth(text, scale) {
  return String(text || "").length * 6 * scale;
}

function drawText(buf, w, h, text, x, y, scale, rgb) {
  let cx = x;
  for (const ch of String(text || "").toUpperCase()) {
    const g = FONT[ch] || FONT[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (g[row][col] === "1") fill(buf, w, cx + col * scale, y + row * scale, scale, scale, rgb, h);
      }
    }
    cx += 6 * scale;
  }
}

function clean(text) {
  return String(text || "").replace(/[’‘]/g, "'").toUpperCase().replace(/[^A-Z0-9 .'-]+/g, " ").replace(/\s+/g, " ").trim();
}

function fit(text, maxWidth, scale) {
  let t = clean(text);
  while (t && textWidth(t, scale) > maxWidth) t = t.slice(0, -1).trim();
  return t || "HUSTLE";
}

function scaleToFit(text, maxWidth, preferred) {
  const t = clean(text);
  let scale = preferred;
  while (scale > 4 && textWidth(t, scale) > maxWidth) scale -= 1;
  return scale;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function fillPoly(buf, w, h, points, rgb) {
  const ys = points.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        const t = (y - a[1]) / (b[1] - a[1]);
        xs.push(a[0] + t * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i]));
      const x1 = Math.min(w - 1, Math.floor(xs[i + 1]));
      for (let x = x0; x <= x1; x++) {
        const at = (y * w + x) * 3;
        buf[at] = rgb[0]; buf[at + 1] = rgb[1]; buf[at + 2] = rgb[2];
      }
    }
  }
}

// Same two slashes as favicon.svg, scaled from its 192 viewBox.
export function iconPng(size, maskable) {
  const buf = Buffer.alloc(size * size * 3);
  const ink = [14, 16, 18];
  const orange = [255, 91, 20];
  const cream = [245, 243, 237];
  fill(buf, size, 0, 0, size, size, ink, size);
  const pad = maskable ? size * 0.1 : 0;
  const scale = (size - pad * 2) / 192;
  const map = (pts) => pts.map(([x, y]) => [pad + x * scale, pad + y * scale]);
  fillPoly(buf, size, size, map([[86, 34], [125, 34], [90, 142], [51, 142]]), orange);
  fillPoly(buf, size, size, map([[145, 34], [165, 34], [130, 142], [110, 142]]), cream);
  const band = map([[0, 160], [192, 160], [192, 192], [0, 192]]);
  fillPoly(buf, size, size, band, ink);
  const stripe = (size - pad * 2) / 192 * 26;
  for (let x = pad - stripe; x < size; x += stripe * 2) {
    fillPoly(buf, size, size, [[x, pad + 192 * scale], [x + stripe, pad + 192 * scale], [x + stripe + (32 * scale), pad + 160 * scale], [x + 32 * scale, pad + 160 * scale]], orange);
  }
  return pngFromRgb(buf, size, size);
}

function ogPriceLine() {
  let season = "fall";
  try {
    const src = readFileSync(new URL("../../config/season.js", import.meta.url), "utf8");
    season = (src.match(/const SEASON = "([a-z]+)"/) || [])[1] || "fall";
  } catch { /* fall wording if the season file cannot be read */ }
  return season === "snow" ? "$9.99 FOR THE WHOLE WINTER" : "$9.99 FOR THE SEASON";
}

function pngFromRgb(buf, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    buf.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

export function homeOgPng() {
  const w = 1200, h = 630;
  const buf = Buffer.alloc(w * h * 3, 0);
  const bar = [217, 75, 61];
  const ink = [241, 239, 234];
  const mute = [210, 206, 198];
  fill(buf, w, 0, 0, w, h, [32, 38, 44], h);
  fill(buf, w, 0, 0, w, 28, bar, h);
  const lines = [
    ["YOUR KID'S FIRST", 8, ink],
    ["NEIGHBORHOOD BUSINESS", 7, ink],
    [ogPriceLine(), scaleToFit(ogPriceLine(), 1080, 8), bar],
    ["NEVER AUTO-RENEWS", 5, mute]
  ];
  let y = 150;
  for (const [text, scale, rgb] of lines) {
    drawText(buf, w, h, text, 64, y, scale, rgb);
    y += scale * 7 + 28;
  }
  drawText(buf, w, h, "HUSTLE BUILDER", 64, 560, 4, bar);
  return pngFromRgb(buf, w, h);
}

export function cardPng({ title, line, accent, theme } = {}) {
  const w = 1200, h = 630;
  const buf = Buffer.alloc(w * h * 3, 0);
  const bar = hexColor(accent);
  const neighbor = theme === "neighbor";
  const ink = neighbor ? [32, 59, 48] : [241, 239, 234];
  const mute = neighbor ? [83, 102, 91] : [210, 206, 198];
  fill(buf, w, 0, 0, w, h, neighbor ? [251, 248, 242] : [32, 38, 44], h);
  fill(buf, w, 0, 0, w, 28, bar, h);
  const titleMax = 1040;
  const lineMax = 1040;
  let titleScale = 12;
  let lineScale = 6;
  while (titleScale > 5 && textWidth(clean(title || "Hustle Builder"), titleScale) > titleMax) titleScale -= 1;
  while (lineScale > 3 && textWidth(clean(line || "Book a day"), lineScale) > lineMax) lineScale -= 1;
  const name = fit(title || "Hustle Builder", titleMax, titleScale);
  const sub = fit(line || "Book a day", lineMax, lineScale);
  drawText(buf, w, h, name, 64, 190, titleScale, ink);
  drawText(buf, w, h, sub, 64, 190 + titleScale * 8 + 28, lineScale, mute);
  drawText(buf, w, h, "HUSTLE BUILDER", 64, 560, 4, bar);
  return pngFromRgb(buf, w, h);
}
