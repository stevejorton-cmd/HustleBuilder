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

function fillEllipse(buf, w, h, cx, cy, rx, ry, rgb) {
  if (rx < 1 || ry < 1) return;
  const x0 = Math.max(0, Math.floor(cx - rx - 1));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx + 1));
  const y0 = Math.max(0, Math.floor(cy - ry - 1));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) {
        const i = (y * w + x) * 3;
        buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2];
      }
    }
  }
}

function fillPoly(buf, w, h, pts, rgb) {
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...pts.map((p) => p[1]))));
  for (let y = y0; y <= y1; y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        const t = (y - a[1]) / (b[1] - a[1]);
        xs.push(a[0] + t * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.ceil(xs[i]));
      const xb = Math.min(w - 1, Math.floor(xs[i + 1]));
      for (let x = xa; x <= xb; x++) {
        const j = (y * w + x) * 3;
        buf[j] = rgb[0]; buf[j + 1] = rgb[1]; buf[j + 2] = rgb[2];
      }
    }
  }
}

const PET_IDS = ["dog", "cat", "fish", "bird", "small"];

function drawPet(buf, w, h, kind, ox, oy, s) {
  const E = (x, y, rx, ry, rgb) => fillEllipse(buf, w, h, ox + x * s, oy + y * s, rx * s, ry * s, rgb);
  const P = (pts, rgb) => fillPoly(buf, w, h, pts.map((p) => [ox + p[0] * s, oy + p[1] * s]), rgb);
  const cream = [246, 226, 184], tan = [226, 184, 122], nose = [224, 122, 95], ink = [28, 36, 34];
  const orange = [232, 146, 58], belly = [246, 201, 176], fish = [61, 143, 209], fin = [46, 111, 168];
  const gold = [246, 193, 75], beak = [224, 122, 95];
  if (kind === "cat") {
    E(88, 84, 36, 24, orange); E(80, 92, 16, 12, belly); E(50, 66, 22, 22, [242, 162, 74]);
    P([[34, 54], [26, 32], [46, 50]], orange); P([[58, 50], [72, 28], [66, 54]], orange);
    E(34, 74, 11, 7, belly); E(46, 62, 3.6, 3.6, ink);
  } else if (kind === "fish") {
    P([[108, 64], [146, 46], [146, 86]], fin);
    E(74, 66, 42, 24, fish); E(74, 74, 26, 10, [126, 182, 230]);
    P([[64, 46], [84, 30], [88, 56]], fin);
    E(46, 60, 6, 6, [255, 255, 255]); E(44, 60, 3, 3, ink);
  } else if (kind === "bird") {
    E(72, 84, 30, 22, gold); E(64, 82, 14, 11, orange); E(98, 66, 16, 16, [248, 213, 106]);
    P([[110, 64], [132, 70], [110, 78]], beak); E(102, 62, 3.4, 3.4, ink);
  } else if (kind === "small") {
    E(80, 88, 38, 26, tan); E(78, 66, 22, 22, cream);
    E(62, 52, 8, 8, [246, 226, 184]); E(94, 52, 8, 8, [246, 226, 184]);
    E(58, 74, 8, 6, [244, 182, 176]); E(98, 74, 8, 6, [244, 182, 176]);
    E(70, 64, 3.2, 3.2, ink); E(88, 64, 3.2, 3.2, ink); E(79, 74, 4, 3, nose);
  } else {
    E(90, 78, 38, 24, [243, 215, 166]); E(78, 86, 18, 12, [248, 235, 208]);
    E(46, 64, 24, 24, cream); E(30, 50, 10, 16, tan); E(28, 76, 14, 10, [248, 235, 208]);
    E(20, 74, 5.5, 4, nose); E(44, 60, 4.2, 4.2, ink); E(45.4, 58.6, 1.4, 1.4, [255, 255, 255]);
  }
}

export function cardPng({ title, line, accent, pets } = {}) {
  const list = Array.isArray(pets) ? pets.filter((p) => PET_IDS.includes(p)).slice(0, 5) : [];
  const w = 1200, h = 630;
  const buf = Buffer.alloc(w * h * 3, 0);
  const bar = hexColor(accent);
  const ink = [241, 239, 234];
  const mute = [210, 206, 198];
  if (list.length) {
    fill(buf, w, 0, 0, w, h, [20, 94, 99], h);
    fillEllipse(buf, w, h, 180, 90, 70, 28, [28, 122, 120]);
    fillEllipse(buf, w, h, 1040, 110, 54, 54, [246, 193, 75]);
    fill(buf, w, 0, 390, w, 240, [30, 107, 69], h);
    const slot = 400 / list.length;
    list.forEach((kind, i) => drawPet(buf, w, h, kind, 760 + i * slot, 430, Math.min(0.95, slot / 190)));
  } else {
    fill(buf, w, 0, 0, w, h, [27, 30, 33], h);
    fill(buf, w, 0, 0, w, 28, bar, h);
  }
  const titleMax = list.length ? 700 : 1040;
  const lineMax = list.length ? 700 : 1040;
  let titleScale = list.length ? 8 : 12;
  let lineScale = list.length ? 4 : 6;
  while (titleScale > 5 && textWidth(clean(title || "Hustle Builder"), titleScale) > titleMax) titleScale -= 1;
  while (lineScale > 3 && textWidth(clean(line || "Book a day"), lineScale) > lineMax) lineScale -= 1;
  const name = fit(title || "Hustle Builder", titleMax, titleScale);
  const sub = fit(line || "Book a day", lineMax, lineScale);
  drawText(buf, w, h, name, 64, list.length ? 150 : 190, titleScale, ink);
  drawText(buf, w, h, sub, 64, (list.length ? 150 : 190) + titleScale * 8 + 28, lineScale, mute);
    drawText(buf, w, h, "HUSTLE BUILDER", 64, 560, 4, list.length ? [246, 193, 75] : bar);
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
