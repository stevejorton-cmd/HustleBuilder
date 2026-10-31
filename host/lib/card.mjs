import { crc32, deflateSync } from "zlib";

const FONT = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "'": ["01100", "01100", "00100", "00000", "00000", "00000", "00000"],
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
  const hex = m ? m[1] : "FF5B14";
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

export function cardPng({ title, line, accent } = {}) {
  const w = 1200, h = 630;
  const buf = Buffer.alloc(w * h * 3, 0);
  const bg = [27, 30, 33];
  const ink = [241, 239, 234];
  const mute = [210, 206, 198];
  const bar = hexColor(accent);
  fill(buf, w, 0, 0, w, h, bg, h);
  fill(buf, w, 0, 0, w, 28, bar, h);
  const titleScale = scaleToFit(title || "Hustle Builder", 1040, 12);
  const lineScale = scaleToFit(line || "Book a day", 1040, 6);
  const name = fit(title || "Hustle Builder", 1040, titleScale);
  const sub = fit(line || "Book a day", 1040, lineScale);
  drawText(buf, w, h, name, 72, 190, titleScale, ink);
  drawText(buf, w, h, sub, 72, 190 + titleScale * 8 + 36, lineScale, mute);
  drawText(buf, w, h, "HUSTLE BUILDER", 72, 500, 4, bar);
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
