#!/usr/bin/env node
// AI Transparent toolkit — lokaal grote bestanden labelen, rapport online.
//
// De content blijft op deze machine. Alleen de SHA-256-fingerprint en de
// labelmetadata gaan naar app.aitransparent.eu; het ondertekende manifest komt
// terug en wordt lokaal in het bestand gebed (ffmpeg, stream copy). Daarna is
// het label publiek verifieerbaar op de verify-pagina.
//
// `ait logo` brandt daarnaast een zichtbaar AI-logo in het beeld. De badge
// (logo + korte tekst) wordt hier in Node zelf getekend als PNG en met het
// ffmpeg-filter `overlay` over de video gelegd. Zo is er geen `drawtext`
// (libfreetype) nodig: die ontbreekt in de standaard Homebrew-ffmpeg.
//
// Vereist: Node 20+, ffmpeg/ffprobe in PATH. Geen npm-dependencies.
// Andere ffmpeg gebruiken: zet AIT_FFMPEG en AIT_FFPROBE op het pad.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);

const CONFIG_DIR = path.join(os.homedir(), '.config', 'ai-transparent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_URL = 'https://app.aitransparent.eu';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const FFMPEG = process.env.AIT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.AIT_FFPROBE || 'ffprobe';

const EMBED_EXTS = new Set(['mp4', 'mov', 'm4a', 'mkv', 'webm', 'mp3', 'flac', 'ogg', 'wav', 'aac', 'mpg', 'avi']);
const MOV_EXTS = new Set(['mp4', 'mov', 'm4a', 'm4v']);

// ---------- Hulpjes ----------

const bold = s => `\x1b[1m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;

function fail(msg) {
  console.error(red('✘ ') + msg);
  process.exit(1);
}

function humanSize(bytes) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0, v = bytes;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function loadConfig() {
  try {
    return JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function saveConfig(cfg) {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

async function api(cfg, pathname, { method = 'GET', body = null, auth = true } = {}) {
  const headers = {};
  if (auth) headers['X-API-Key'] = cfg.apiKey;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(cfg.apiUrl + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    fail(`Geen verbinding met ${cfg.apiUrl} — ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function requireConfig() {
  const cfg = await loadConfig();
  if (!cfg?.apiKey) {
    fail(`Nog niet ingelogd. Haal je API-sleutel op in het portaal (${DEFAULT_URL}/portal, kaart "API-sleutel")\n  en draai:  ait login`);
  }
  return cfg;
}

async function hasFfmpeg() {
  try { await pexec(FFMPEG, ['-version']); await pexec(FFPROBE, ['-version']); return true; }
  catch { return false; }
}

// Streaming SHA-256 met voortgang — geschikt voor bestanden van tientallen GB's.
function sha256File(file, label = 'hashen') {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 });
    let done = 0, lastDraw = 0;
    stream.on('data', chunk => {
      hash.update(chunk);
      done += chunk.length;
      const now = Date.now();
      if (size > 50e6 && now - lastDraw > 300) {
        lastDraw = now;
        const pct = ((done / size) * 100).toFixed(0);
        process.stderr.write(`\r  ${dim(`${label}: ${pct}% van ${humanSize(size)}`)}   `);
      }
    });
    stream.on('end', () => {
      if (size > 50e6) process.stderr.write('\r' + ' '.repeat(60) + '\r');
      resolve(hash.digest('hex'));
    });
    stream.on('error', reject);
  });
}

function outputPathFor(file, override) {
  if (override) return override;
  const ext = path.extname(file);
  return path.join(path.dirname(file), path.basename(file, ext) + '.ailabel' + ext);
}

// ---------- ffmpeg: inbedden, uitlezen ----------

// De AILABEL-tags die `ait check` (ffprobe) weer uitleest.
function metaArgs(compact, extra = {}) {
  const tags = {
    AILABEL_ID: compact.id,
    AILABEL_DST: compact.digitalSourceType,
    AILABEL_SIG: compact.sig,
    AILABEL_KEYID: compact.keyId,
    AILABEL_SHA256: compact.sha256Original,
    AILABEL_VERIFY: compact.verifyUrl,
    ...extra,
    comment: `${compact.disclosure} [${compact.id}] ${compact.verifyUrl}`
  };
  return Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
}

async function embedTags(inFile, outFile, compact) {
  const ext = path.extname(inFile).slice(1).toLowerCase();
  // Geen hercodering: snel, ook bij enorme bestanden.
  const args = ['-y', '-i', inFile, '-map', '0', '-c', 'copy', ...metaArgs(compact)];
  if (MOV_EXTS.has(ext)) args.push('-movflags', 'use_metadata_tags');
  args.push(outFile);
  await pexec(FFMPEG, args, { maxBuffer: 64 * 1024 * 1024 });
}

async function probeTags(file) {
  try {
    const { stdout } = await pexec(FFPROBE,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]);
    const info = JSON.parse(stdout);
    const tags = Object.assign({}, info.format?.tags,
      ...(info.streams || []).map(s => s.tags || {}));
    const get = key => {
      for (const [k, v] of Object.entries(tags)) if (k.toLowerCase() === key.toLowerCase()) return v;
      return null;
    };
    return { id: get('AILABEL_ID'), verify: get('AILABEL_VERIFY'), comment: get('comment') };
  } catch {
    return { id: null, verify: null, comment: null };
  }
}

// ---------- Zichtbaar logo (1/4): TrueType-lettertype lezen ----------

// Leest precies genoeg van een .ttf/.ttc om tekst te tekenen: tekenkaart (cmap),
// breedtes (hmtx), kerning (kern) en de glyph-contouren (glyf/loca).
class TtfFont {
  constructor(buf) {
    this.b = buf;
    let off = 0;
    if (buf.toString('latin1', 0, 4) === 'ttcf') off = buf.readUInt32BE(12); // eerste lettertype uit de collectie
    if (buf.toString('latin1', off, off + 4) === 'OTTO') {
      throw new Error('OpenType met CFF-contouren (.otf) wordt niet ondersteund; kies een .ttf');
    }
    this.t = {};
    const n = buf.readUInt16BE(off + 4);
    for (let i = 0; i < n; i++) {
      const r = off + 12 + 16 * i;
      this.t[buf.toString('latin1', r, r + 4)] = buf.readUInt32BE(r + 8);
    }
    for (const need of ['head', 'hhea', 'hmtx', 'maxp', 'cmap', 'loca', 'glyf']) {
      if (this.t[need] === undefined) throw new Error(`tabel "${need}" ontbreekt`);
    }
    this.upem = buf.readUInt16BE(this.t.head + 18);
    this.longLoca = buf.readInt16BE(this.t.head + 50) === 1;
    this.numGlyphs = buf.readUInt16BE(this.t.maxp + 4);
    this.numHM = buf.readUInt16BE(this.t.hhea + 34);
    this.glyphOf = this.#cmap();
    this.kern = this.#kern();
    const h = this.box(this.glyphOf(0x48)); // hoogte van de hoofdletter H
    this.capHeight = (h ? h[3] : this.upem * 0.72) / this.upem;
  }

  #cmap() {
    const b = this.b, base = this.t.cmap;
    let best = null, score = 0;
    for (let i = 0, n = b.readUInt16BE(base + 2); i < n; i++) {
      const pid = b.readUInt16BE(base + 4 + i * 8), eid = b.readUInt16BE(base + 6 + i * 8);
      const so = base + b.readUInt32BE(base + 8 + i * 8), fmt = b.readUInt16BE(so);
      const s = fmt === 12 && (pid === 0 || (pid === 3 && eid === 10)) ? 2
        : fmt === 4 && (pid === 0 || (pid === 3 && eid === 1)) ? 1 : 0;
      if (s > score) { best = { so, fmt }; score = s; }
    }
    if (!best) throw new Error('geen Unicode-tekenkaart (cmap)');
    const { so, fmt } = best;
    if (fmt === 12) {
      const groups = [];
      for (let i = 0, n = b.readUInt32BE(so + 12); i < n; i++) {
        const g = so + 16 + i * 12;
        groups.push([b.readUInt32BE(g), b.readUInt32BE(g + 4), b.readUInt32BE(g + 8)]);
      }
      return cp => {
        for (const [s, e, gid] of groups) if (cp >= s && cp <= e) return gid + cp - s;
        return 0;
      };
    }
    const seg2 = b.readUInt16BE(so + 6);
    const ends = so + 14, starts = ends + seg2 + 2, deltas = starts + seg2, ranges = deltas + seg2;
    return cp => {
      if (cp > 0xffff) return 0;
      for (let i = 0; i < seg2 / 2; i++) {
        if (cp > b.readUInt16BE(ends + i * 2)) continue;
        const start = b.readUInt16BE(starts + i * 2);
        if (cp < start) return 0;
        const delta = b.readUInt16BE(deltas + i * 2), ro = b.readUInt16BE(ranges + i * 2);
        if (ro === 0) return (cp + delta) & 0xffff;
        const g = b.readUInt16BE(ranges + i * 2 + ro + (cp - start) * 2);
        return g === 0 ? 0 : (g + delta) & 0xffff;
      }
      return 0;
    };
  }

  // Klassieke kern-tabel (formaat 0). Het Apple-formaat slaan we over: dan geen kerning.
  #kern() {
    const map = new Map(), b = this.b, o = this.t.kern;
    if (o === undefined || b.readUInt16BE(o) !== 0) return map;
    let p = o + 4;
    for (let i = 0, n = b.readUInt16BE(o + 2); i < n; i++) {
      const cov = b.readUInt16BE(p + 4), pairs = b.readUInt16BE(p + 6);
      if ((cov >> 8) !== 0) break; // ander subtabelformaat: stoppen
      if ((cov & 0x7) === 1) { // horizontaal, geen minimum- of kruiswaarden
        for (let j = 0; j < pairs; j++) {
          const q = p + 14 + j * 6;
          map.set(b.readUInt16BE(q) * 65536 + b.readUInt16BE(q + 2), b.readInt16BE(q + 4));
        }
      }
      p += 14 + pairs * 6; // niet het lengteveld: dat loopt over bij grote tabellen
    }
    return map;
  }

  advance(gid) {
    return this.b.readUInt16BE(this.t.hmtx + Math.min(gid, this.numHM - 1) * 4);
  }

  #offset(gid) {
    if (gid >= this.numGlyphs) return -1;
    const b = this.b, lo = this.t.loca;
    const s = this.longLoca ? b.readUInt32BE(lo + gid * 4) : b.readUInt16BE(lo + gid * 2) * 2;
    const e = this.longLoca ? b.readUInt32BE(lo + gid * 4 + 4) : b.readUInt16BE(lo + gid * 2 + 2) * 2;
    return e > s ? this.t.glyf + s : -1;
  }

  box(gid) {
    const p = this.#offset(gid);
    return p < 0 ? null : [1, 2, 3, 4].map(i => this.b.readInt16BE(p + i * 2));
  }

  // Contouren in font-eenheden: [[{x, y, on}, …], …]
  contours(gid, depth = 0) {
    const p = this.#offset(gid), b = this.b;
    if (p < 0 || depth > 8) return [];
    const nc = b.readInt16BE(p);
    if (nc >= 0) {
      const ends = [];
      for (let i = 0; i < nc; i++) ends.push(b.readUInt16BE(p + 10 + i * 2));
      const nPts = nc ? ends[nc - 1] + 1 : 0;
      let q = p + 10 + nc * 2;
      q += 2 + b.readUInt16BE(q); // hinting-instructies overslaan
      const flags = [];
      while (flags.length < nPts) {
        const fl = b[q++];
        flags.push(fl);
        if (fl & 8) for (let r = b[q++]; r > 0; r--) flags.push(fl);
      }
      const coords = (short, same) => {
        const out = [];
        let v = 0;
        for (const fl of flags) {
          if (fl & short) { const d = b[q++]; v += (fl & same) ? d : -d; }
          else if (!(fl & same)) { v += b.readInt16BE(q); q += 2; }
          out.push(v);
        }
        return out;
      };
      const xs = coords(2, 16), ys = coords(4, 32);
      const out = [];
      let s = 0;
      for (const e of ends) {
        const c = [];
        for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
        out.push(c);
        s = e + 1;
      }
      return out;
    }
    // Samengestelde glyph (bijv. een letter met accent).
    const out = [];
    let q = p + 10, more = true;
    const f2 = o => b.readInt16BE(o) / 16384;
    while (more) {
      const fl = b.readUInt16BE(q), sub = b.readUInt16BE(q + 2);
      q += 4;
      let dx, dy;
      if (fl & 1) { dx = b.readInt16BE(q); dy = b.readInt16BE(q + 2); q += 4; }
      else { dx = b.readInt8(q); dy = b.readInt8(q + 1); q += 2; }
      if (!(fl & 2)) { dx = 0; dy = 0; } // uitlijnen op punten: zeldzaam, niet ondersteund
      let a = 1, bb = 0, c = 0, d = 1;
      if (fl & 8) { a = d = f2(q); q += 2; }
      else if (fl & 0x40) { a = f2(q); d = f2(q + 2); q += 4; }
      else if (fl & 0x80) { a = f2(q); bb = f2(q + 2); c = f2(q + 4); d = f2(q + 6); q += 8; }
      for (const ct of this.contours(sub, depth + 1)) {
        out.push(ct.map(pt => ({ x: a * pt.x + c * pt.y + dx, y: bb * pt.x + d * pt.y + dy, on: pt.on })));
      }
      more = !!(fl & 0x20);
    }
    return out;
  }
}

const FONT_CANDIDATES = [
  path.join(HERE, 'fonts', 'DejaVuSans.ttf'),            // meegeleverd (zelfde als de badge voor afbeeldingen)
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',     // Linux
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/Library/Fonts/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',        // macOS
  'C:\\Windows\\Fonts\\arial.ttf'                         // Windows
];

function loadFont(explicit) {
  const list = explicit ? [explicit] : [process.env.AIT_FONT, ...FONT_CANDIDATES].filter(Boolean);
  for (const p of list) {
    if (!fs.existsSync(p)) continue;
    try {
      const font = new TtfFont(fs.readFileSync(p));
      font.path = p;
      return font;
    } catch (err) {
      if (explicit) fail(`Lettertype ${p} is niet bruikbaar: ${err.message}`);
    }
  }
  fail(explicit ? `Lettertype niet gevonden: ${explicit}` : 'Geen lettertype gevonden. Geef er een op met --font <pad.ttf>.');
}

// ---------- Zichtbaar logo (2/4): vormen, rasteren, PNG ----------

// Punten op een boog; hoeken in radialen, beeldcoördinaten (y omlaag).
function arcPoints(cx, cy, r, a0, a1, out = []) {
  const n = Math.max(2, Math.min(720, Math.ceil(Math.abs(a1 - a0) * r)));
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

// Alle vormen lopen met de klok mee; een gat is een vorm in omgekeerde richting.
function roundedRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const q = Math.PI / 2, p = [];
  arcPoints(x + w - r, y + r, r, -q, 0, p);
  arcPoints(x + w - r, y + h - r, r, 0, q, p);
  arcPoints(x + r, y + h - r, r, q, 2 * q, p);
  arcPoints(x + r, y + r, r, 2 * q, 3 * q, p);
  return p;
}

const circle = (cx, cy, r) => arcPoints(cx, cy, r, 0, 2 * Math.PI);

// Een boog met lijndikte sw (zonder kapjes).
function arcBand(cx, cy, r, sw, a0, a1) {
  return arcPoints(cx, cy, r + sw / 2, a0, a1).concat(arcPoints(cx, cy, r - sw / 2, a0, a1).reverse());
}

// Het AI Transparent-logo uit de appbar van app.aitransparent.eu (viewBox 200×200):
// blauw vlak met rx 30, drie witte bogen (lijndikte 15, ronde uiteinden) en een stip.
function logoShapes(ox, oy, size) {
  const k = size / 200, cx = ox + 100 * k, cy = oy + 100 * k, sw = 15 * k;
  const symbol = [circle(cx, cy, 13 * k)];
  const arcs = [ // [x1, y1, x2, y2, r] uit de SVG-paden, middelpunt (100, 100), sweep-flag 1
    [136.00, 37.65, 64.00, 37.65, 72],
    [83.94, 134.44, 83.94, 65.56, 38],
    [116.06, 65.56, 116.06, 134.44, 38]
  ];
  for (const [x1, y1, x2, y2, r] of arcs) {
    const a0 = Math.atan2(y1 - 100, x1 - 100);
    let a1 = Math.atan2(y2 - 100, x2 - 100);
    while (a1 <= a0) a1 += 2 * Math.PI; // sweep-flag 1: de hoek neemt toe
    symbol.push(arcBand(cx, cy, r * k, sw, a0, a1));
    for (const a of [a0, a1]) symbol.push(circle(cx + r * k * Math.cos(a), cy + r * k * Math.sin(a), sw / 2));
  }
  return { square: roundedRect(ox, oy, size, size, 30 * k), symbol };
}

// TrueType-contour (kwadratische Bézier) → polygoon in pixels.
function contourPolygon(pts, tf) {
  if (pts.length < 2) return null;
  const ex = [];
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    ex.push(p);
    if (!p.on && !q.on) ex.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, on: true }); // impliciet punt
  });
  const s = ex.findIndex(p => p.on);
  const seq = ex.slice(s).concat(ex.slice(0, s));
  const poly = [tf(seq[0].x, seq[0].y)];
  for (let i = 1; i <= seq.length; i++) {
    const p = seq[i % seq.length];
    if (p.on) { poly.push(tf(p.x, p.y)); continue; }
    const st = poly[poly.length - 1], c = tf(p.x, p.y);
    const e = seq[(i + 1) % seq.length], end = tf(e.x, e.y);
    const len = Math.hypot(c[0] - st[0], c[1] - st[1]) + Math.hypot(end[0] - c[0], end[1] - c[1]);
    const n = Math.max(2, Math.min(32, Math.ceil(len / 1.5)));
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      poly.push([u * u * st[0] + 2 * u * t * c[0] + t * t * end[0], u * u * st[1] + 2 * u * t * c[1] + t * t * end[1]]);
    }
    i++;
  }
  return poly;
}

// Tekst meten en (optioneel) als polygonen opbouwen. px = lettergrootte (em) in pixels.
function shapeText(font, text, px, x0 = 0, baseline = 0, withPolys = false) {
  const s = px / font.upem, polys = [], missing = [];
  let pen = 0, prev = -1;
  for (const ch of text) {
    const gid = font.glyphOf(ch.codePointAt(0));
    if (gid === 0 && ch.trim()) missing.push(ch);
    if (prev >= 0) pen += font.kern.get(prev * 65536 + gid) || 0;
    if (withPolys) {
      const ox = pen;
      for (const ct of font.contours(gid)) {
        const poly = contourPolygon(ct, (x, y) => [x0 + (ox + x) * s, baseline - y * s]);
        if (poly) polys.push(poly);
      }
    }
    pen += font.advance(gid);
    prev = gid;
  }
  return { width: pen * s, polys, missing };
}

// Dekking per pixel (0..1) volgens de niet-nul-windingsregel: 16 subscanlijnen per
// pixelrij en exacte horizontale dekking. Dat geeft nette anti-aliasing.
function fillMask(polys, W, H) {
  const S = 16, mask = new Float32Array(W * H), edges = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
      if (y0 === y1) continue;
      edges.push(y0 < y1
        ? { ya: y0, yb: y1, x: x0, dx: (x1 - x0) / (y1 - y0), dir: 1 }
        : { ya: y1, yb: y0, x: x1, dx: (x0 - x1) / (y0 - y1), dir: -1 });
    }
  }
  if (!edges.length) return mask;
  edges.sort((a, b) => a.ya - b.ya);
  const yTop = Math.max(0, Math.floor(edges[0].ya));
  const yEnd = Math.min(H, Math.ceil(edges.reduce((m, e) => Math.max(m, e.yb), 0)));
  const xs = [];
  for (let py = yTop; py < yEnd; py++) {
    for (let s = 0; s < S; s++) {
      const sy = py + (s + 0.5) / S;
      xs.length = 0;
      for (const e of edges) {
        if (e.ya > sy) break;
        if (sy < e.yb) xs.push([e.x + (sy - e.ya) * e.dx, e.dir]);
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0, from = 0;
      for (const [x, d] of xs) {
        const before = wind;
        wind += d;
        if (before === 0 && wind !== 0) from = x;
        else if (before !== 0 && wind === 0) addSpan(mask, py * W, W, from, x, 1 / S);
      }
    }
  }
  return mask;
}

function addSpan(mask, row, W, a, b, w) {
  a = Math.max(0, a);
  b = Math.min(W, b);
  if (b <= a) return;
  const ia = Math.floor(a), ib = Math.floor(b);
  if (ia === ib) { mask[row + ia] += (b - a) * w; return; }
  mask[row + ia] += (ia + 1 - a) * w;
  for (let i = ia + 1; i < ib; i++) mask[row + i] += w;
  if (ib < W) mask[row + ib] += (b - ib) * w;
}

// Een laag over de afbeelding leggen (voorvermenigvuldigde alfa, kleuren 0..1).
function paint(buf, mask, [r, g, b], alpha) {
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] <= 0) continue;
    const c = Math.min(1, mask[i]) * alpha, inv = 1 - c, j = i * 4;
    buf[j] = r * c + buf[j] * inv;
    buf[j + 1] = g * c + buf[j + 1] * inv;
    buf[j + 2] = b * c + buf[j + 2] * inv;
    buf[j + 3] = c + buf[j + 3] * inv;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// RGBA-PNG (8 bit, rechte alfa) uit een voorvermenigvuldigde float-buffer.
function encodePng(W, H, buf) {
  const stride = W * 4 + 1, raw = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const j = (y * W + x) * 4, a = buf[j + 3], o = y * stride + 1 + x * 4;
      if (a <= 0) continue;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.max(0, Math.min(255, Math.round(buf[j + k] / a * 255)));
      raw[o + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bitdiepte
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- Zichtbaar logo (3/4): badge ontwerpen en plaatsen ----------

const BRAND = [0x00 / 255, 0x33 / 255, 0x99 / 255]; // #003399, AI Transparent-blauw
const WHITE = [1, 1, 1];
const POSITIES = ['linksboven', 'rechtsboven', 'linksonder', 'rechtsonder'];
const POSITIE_ALIAS = {
  lb: 'linksboven', rb: 'rechtsboven', lo: 'linksonder', ro: 'rechtsonder',
  'top-left': 'linksboven', 'top-right': 'rechtsboven', 'bottom-left': 'linksonder', 'bottom-right': 'rechtsonder',
  tl: 'linksboven', tr: 'rechtsboven', bl: 'linksonder', br: 'rechtsonder'
};
// Containers die we na het inbranden behouden; de rest wordt .mp4.
const LOGO_KEEP_EXTS = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm']);

function parsePositie(v) {
  const k = String(v).toLowerCase().trim().replace(/[\s_]+/g, '-');
  const p = POSITIES.includes(k.replace(/-/g, '')) ? k.replace(/-/g, '') : POSITIE_ALIAS[k];
  if (!p) fail(`Onbekende positie "${v}". Kies: linksboven (lb), rechtsboven (rb), linksonder (lo) of rechtsonder (ro).`);
  return p;
}

// Zelfde korte tekst als de zichtbare badge voor afbeeldingen (at_short_label in de app).
function kortLabel({ manipulated, deepFake, lang }) {
  const nl = (lang || 'nl') !== 'en';
  const base = manipulated ? (nl ? 'AI-bewerkt' : 'AI-manipulated') : (nl ? 'AI-gegenereerd' : 'AI-generated');
  return deepFake ? `Deep fake · ${base}` : base;
}

// Maten van de badge. Alles volgt uit de badgehoogte bh (= de zijde van het logo).
function badgeLayout(font, lines, bh) {
  const r = bh * 0.15;                               // hoekradius, gelijk aan het logo (rx 30 op 200)
  const rim = Math.max(1, Math.round(bh * 0.025));   // lichte rand: contrast op donker beeld
  let w = bh;
  const placed = [];
  if (lines.length) {
    const two = lines.length === 2;
    const sizes = lines.map(l => bh * (l.small ? (two ? 0.21 : 0.28) : (two ? 0.40 : 0.46)));
    const tx = bh * 1.28;
    const widths = lines.map((l, i) => shapeText(font, l.text, sizes[i]).width);
    w = tx + Math.max(...widths) + bh * 0.40;
    const caps = sizes.map(s => s * font.capHeight);
    const gap = two ? bh * 0.15 : 0;
    let y = bh / 2 - (caps.reduce((a, c) => a + c, 0) + gap) / 2;
    lines.forEach((l, i) => {
      y += caps[i];
      placed.push({ ...l, px: sizes[i], x: tx, baseline: y });
      y += gap;
    });
  }
  return { bh, w: Math.ceil(w), r, rim, lines: placed };
}

function renderBadge(font, L) {
  const pad = L.rim + 1;
  const W = L.w + 2 * pad, H = L.bh + 2 * pad;
  const buf = new Float32Array(W * H * 4);
  const outer = roundedRect(pad - L.rim, pad - L.rim, L.w + 2 * L.rim, L.bh + 2 * L.rim, L.r + L.rim);
  const inner = roundedRect(pad, pad, L.w, L.bh, L.r);
  paint(buf, fillMask([outer, inner.slice().reverse()], W, H), WHITE, 0.55);        // rand
  if (L.lines.length) paint(buf, fillMask([inner], W, H), BRAND, 0.92);           // balk achter de tekst
  const logo = logoShapes(pad, pad, L.bh);
  paint(buf, fillMask([logo.square], W, H), BRAND, 1);                            // logo-vlak
  paint(buf, fillMask(logo.symbol, W, H), WHITE, 1);                              // logo-symbool
  for (const l of L.lines) {
    const { polys } = shapeText(font, l.text, l.px, pad + l.x, pad + l.baseline, true);
    paint(buf, fillMask(polys, W, H), WHITE, l.small ? 0.85 : 1);
  }
  return { png: encodePng(W, H, buf), width: W, height: H, pad };
}

// Badge op maat van de video: hoogte 1/16 van de korte zijde (zoals de badge voor
// afbeeldingen), marge ≥ 3% van de korte zijde, nooit breder dan het beeld.
function planBadge(info, { grootte = 1, positie = 'rechtsboven' }, font, lines) {
  const Wd = info.width * info.sar, Hd = info.height; // weergavepixels
  const minSide = Math.min(Wd, Hd);
  const marginFor = bh => Math.round(Math.max(bh * 0.5, minSide * 0.03));
  let bh = Math.round(Math.min(minSide / 4, Math.max(20, (minSide / 16) * grootte)));
  let L = badgeLayout(font, lines, bh);
  const maxW = Wd - 2 * marginFor(bh);
  if (L.w > maxW) {
    bh = Math.max(12, Math.floor(bh * maxW / L.w));
    L = badgeLayout(font, lines, bh);
  }
  const m = marginFor(L.bh);
  const bx = positie.startsWith('rechts') ? Wd - L.w - m : m;
  const by = positie.endsWith('onder') ? Hd - L.bh - m : m;
  const img = renderBadge(font, L);
  return {
    ...img, layout: L, margin: m,
    // Positie en breedte in opgeslagen pixels (bij niet-vierkante pixels horizontaal gecorrigeerd).
    x: Math.round((bx - img.pad) / info.sar), y: Math.round(by - img.pad),
    scaledWidth: Math.max(1, Math.round(img.width / info.sar))
  };
}

function badgeLines(f, { text, verifyUrl }) {
  const lines = [];
  if (text) lines.push({ text });
  if (f.metId && verifyUrl) lines.push({ text: verifyUrl.replace(/^https?:\/\//, ''), small: true });
  return lines;
}

// ---------- Zichtbaar logo (4/4): ffmpeg ----------

async function probeVideo(file) {
  let info;
  try {
    const { stdout } = await pexec(FFPROBE,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 32 * 1024 * 1024 });
    info = JSON.parse(stdout);
  } catch {
    return null;
  }
  const streams = info.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v || !v.width || !v.height) return null;
  // Telefoonvideo's hebben vaak een rotatie; ffmpeg draait het beeld bij het decoderen.
  let rotation = 0;
  for (const sd of v.side_data_list || []) if (typeof sd.rotation === 'number') rotation = sd.rotation;
  if (!rotation && v.tags?.rotate) rotation = Number(v.tags.rotate) || 0;
  const swap = Math.abs(rotation) % 180 === 90;
  const [sn, sd] = String(v.sample_aspect_ratio || '1:1').split(':').map(Number);
  return {
    index: v.index,
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    sar: !swap && sn > 0 && sd > 0 ? sn / sd : 1,
    rotation,
    duration: Number(info.format?.duration) || Number(v.duration) || 0,
    bitRate: Number(v.bit_rate) || Number(info.format?.bit_rate) || 0,
    colorSpace: v.color_space || '',
    colorRange: v.color_range || '',
    audioCodecs: streams.filter(s => s.codec_type === 'audio').map(s => s.codec_name || '')
  };
}

// Welke audio ongewijzigd in de doelcontainer past; de rest wordt AAC (of Opus voor webm).
const AUDIO_COPY_OK = {
  mp4: /^(aac|mp3|ac3|eac3|alac)$/,
  m4v: /^(aac|mp3|ac3|eac3|alac)$/,
  mov: /^(aac|mp3|ac3|eac3|alac|pcm_\w+)$/,
  webm: /^(opus|vorbis)$/
};
const VIDEO_MIME = { mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm' };

function audioArgs(outExt, codecs, forceEncode = false) {
  const ok = AUDIO_COPY_OK[outExt] || /./;
  if (!forceEncode && codecs.every(c => ok.test(c))) return ['-c:a', 'copy'];
  return outExt === 'webm' ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '192k'];
}

async function listEncoders() {
  try {
    const { stdout } = await pexec(FFMPEG, ['-hide_banner', '-encoders'], { maxBuffer: 8 * 1024 * 1024 });
    return new Set(stdout.split('\n').map(l => l.trim().split(/\s+/)[1]).filter(Boolean));
  } catch {
    return new Set();
  }
}

function videoCodecArgs(outExt, encoders, crf, info) {
  if (outExt === 'webm') {
    if (!encoders.has('libvpx-vp9')) throw new Error('deze ffmpeg mist de VP9-encoder (libvpx-vp9) voor .webm');
    return ['-c:v', 'libvpx-vp9', '-crf', String(crf ?? 31), '-b:v', '0', '-row-mt', '1',
      '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p'];
  }
  if (encoders.has('libx264')) return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf ?? 18), '-pix_fmt', 'yuv420p'];
  if (encoders.has('h264_videotoolbox')) { // macOS-hardware, als libx264 ontbreekt
    const rate = Math.max(4e6, Math.round((info.bitRate || 0) * 1.5));
    return ['-c:v', 'h264_videotoolbox', '-b:v', String(rate), '-pix_fmt', 'yuv420p'];
  }
  throw new Error('deze ffmpeg heeft geen H.264-encoder (libx264)');
}

// Het filter: PNG omzetten met de kleurmatrix van de video (zodat #003399 klopt) en
// erover leggen; met --seconden alleen in de eerste N seconden.
function logoGraph(info, badge, seconden) {
  const cs = info.colorSpace;
  const matrix = cs === 'bt709' ? 'bt709'
    : /bt470bg|smpte170m/.test(cs) ? 'bt601'
    : cs.startsWith('bt2020') ? 'bt2020'
    : (info.height >= 720 || info.width >= 1280 ? 'bt709' : 'bt601');
  const range = info.colorRange === 'pc' ? 'pc' : 'tv';
  const enable = seconden ? `:enable='lte(t,${seconden})'` : '';
  return `[1:v]scale=w=${badge.scaledWidth}:h=${badge.height}:out_color_matrix=${matrix}:out_range=${range},format=yuva420p[lg];`
    + `[0:${info.index}][lg]overlay=x=${badge.x}:y=${badge.y}${enable}[v]`;
}

function runFfmpeg(args, duration, label) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const tty = process.stderr.isTTY;
    let err = '', rest = '', last = 0;
    p.stdout.on('data', d => {
      const lines = (rest + d).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (!m || !duration || !tty || Date.now() - last < 250) continue;
        last = Date.now();
        const pct = Math.min(100, (Number(m[1]) / 1e6 / duration) * 100);
        process.stderr.write(`\r  ${dim(`${label}: ${pct.toFixed(0)}%`)}   `);
      }
    });
    p.stderr.on('data', d => { err = (err + d).slice(-8000); });
    p.on('error', e => reject(new Error(`${FFMPEG} start niet: ${e.message}`)));
    p.on('close', code => {
      if (tty) process.stderr.write('\r' + ' '.repeat(50) + '\r');
      if (code === 0) resolve();
      else reject(new Error(err.trim().split('\n').slice(-4).join(' | ') || `ffmpeg stopte met code ${code}`));
    });
  });
}

async function withBadgeFile(badge, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ait-logo-'));
  try {
    const png = path.join(dir, 'badge.png');
    await fsp.writeFile(png, badge.png);
    return await fn(png);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// Logo inbranden + AILABEL-tags in één ffmpeg-gang. Audio en ondertitels gaan
// ongewijzigd mee; past de audio niet in de container, dan wordt die AAC/Opus.
async function encodeWithLogo({ inFile, outFile, info, badge, seconden, compact, extraTags, encoders, crf }) {
  const outExt = path.extname(outFile).slice(1).toLowerCase();
  const tmpOut = path.join(path.dirname(outFile),
    `.${path.basename(outFile, path.extname(outFile))}.tmp-${process.pid}.${outExt}`);
  await withBadgeFile(badge, async png => {
    const head = ['-y', '-i', inFile, '-i', png, '-filter_complex', logoGraph(info, badge, seconden),
      '-map', '[v]', '-map', '0:a?', '-map', '0:s?'];
    if (outExt === 'mkv') head.push('-map', '0:t?'); // bijlagen (lettertypen van ondertitels)
    const tail = [...videoCodecArgs(outExt, encoders, crf, info), '-c:s', 'copy', ...metaArgs(compact, extraTags)];
    if (MOV_EXTS.has(outExt)) tail.push('-movflags', '+faststart+use_metadata_tags');
    const audio = audioArgs(outExt, info.audioCodecs);
    try {
      try {
        await runFfmpeg([...head, ...tail, ...audio, tmpOut], info.duration, 'logo inbranden');
      } catch (err) {
        // Onverwachte audio die toch niet past: nog één keer, met omgezette audio.
        const copied = audio[1] === 'copy' && info.audioCodecs.length;
        if (!copied || !/codec|tag|container|not supported|invalid argument/i.test(err.message)) throw err;
        await runFfmpeg([...head, ...tail, ...audioArgs(outExt, info.audioCodecs, true), tmpOut],
          info.duration, 'logo inbranden (audio omzetten)');
      }
      await fsp.rename(tmpOut, outFile);
    } finally {
      await fsp.rm(tmpOut, { force: true });
    }
  });
}

// Eén frame met het logo als PNG, om positie en grootte te controleren.
async function previewFrame({ inFile, outPng, info, badge }) {
  const t = Math.min(1, (info.duration || 0) / 2);
  await withBadgeFile(badge, png => runFfmpeg(['-y', '-ss', String(t), '-i', inFile, '-i', png,
    '-filter_complex', logoGraph(info, badge, null), '-map', '[v]', '-frames:v', '1', '-update', '1', outPng], 0, 'voorbeeld'));
}

// ---------- Register (gedeeld door label en logo) ----------

async function registerRemote(cfg, file, sha, f, mediaType) {
  let reg;
  try {
    reg = await api(cfg, '/api/v1/label/remote', { method: 'POST', body: {
      sha256: sha,
      filename: path.basename(file),
      ...(mediaType ? { mediaType } : {}),
      manipulated: !!f.manipulated,
      deepFake: !!f.deepFake,
      lang: f.lang || 'nl',
      generator: { system: f.system, model: f.model }
    } });
  } catch (err) {
    fail(`Registreren mislukt: ${err.message}`);
  }
  console.log(`  ${green('✔')} label ${bold(reg.labelId)} geregistreerd`);
  return reg;
}

async function completeRemote(cfg, labelId, outFile, techniques) {
  const shaMarked = await sha256File(outFile, 'gemarkeerd bestand hashen');
  try {
    await api(cfg, '/api/v1/label/remote/complete', { method: 'POST', body: { labelId, sha256Marked: shaMarked, techniques } });
  } catch (err) {
    console.log(`  ${yellow('⚠')} afronden bij register mislukt: ${err.message}`);
  }
}

async function writeSidecarAndSummary(reg, outFile) {
  const sidecar = outFile + '.manifest.json';
  await fsp.writeFile(sidecar, JSON.stringify(reg.manifest, null, 2));
  console.log(`  ${dim('disclosure:')} ${reg.disclosure.text}`);
  console.log(`  ${dim('verifieer: ')} ${reg.verifyUrl}`);
  console.log(`  ${dim('manifest:  ')} ${path.basename(sidecar)}`);
}

function fmtDuur(sec) {
  const s = Math.round(sec || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- Commando's ----------

async function cmdLogin(args) {
  const urlIdx = args.indexOf('--url');
  const apiUrl = (urlIdx !== -1 ? args[urlIdx + 1] : DEFAULT_URL).replace(/\/$/, '');
  const keyIdx = args.indexOf('--key');
  let apiKey = keyIdx !== -1 ? args[keyIdx + 1] : null;

  if (!apiKey) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    apiKey = await new Promise(res => rl.question(
      `API-sleutel (portaal → kaart "API-sleutel" op ${apiUrl}/portal): `, a => { rl.close(); res(a.trim()); }));
  }
  if (!apiKey?.startsWith('atk_')) fail('Dat is geen geldige sleutel (begint met atk_).');

  const cfg = { apiUrl, apiKey };
  let me;
  try {
    me = await api(cfg, '/api/v1/me');
  } catch (err) {
    fail(`Sleutel geweigerd door ${apiUrl}: ${err.message}`);
  }
  await saveConfig(cfg);
  console.log(green('✔') + ` Ingelogd als ${bold(me.org.company)} (${me.org.planName})`);
  console.log(dim(`  Config: ${CONFIG_FILE}`));
}

async function cmdWhoami() {
  const cfg = await requireConfig();
  const me = await api(cfg, '/api/v1/me');
  const o = me.org;
  console.log(`${bold(o.company)} — ${o.planName} · ${o.labelsThisMonth}/${o.includedLabelsPerMonth} labels deze maand · ${cfg.apiUrl}`);
}

async function cmdLogout() {
  await fsp.rm(CONFIG_FILE, { force: true });
  console.log(green('✔') + ' Uitgelogd (sleutel lokaal verwijderd).');
}

function parseFlags(args, { logo = false } = {}) {
  const flags = { files: [] };
  const value = (i, a) => {
    if (i >= args.length || args[i].startsWith('--')) fail(`Optie ${a} verwacht een waarde.`);
    return args[i];
  };
  const number = (i, a, min, max) => {
    const n = Number(value(i, a));
    if (!Number.isFinite(n) || n < min || n > max) fail(`Optie ${a} verwacht een getal van ${min} tot ${max}.`);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--bewerkt' || a === '--manipulated') flags.manipulated = true;
    else if (a === '--deepfake') flags.deepFake = true;
    else if (a === '--lang') flags.lang = value(++i, a);
    else if (a === '--systeem' || a === '--system') flags.system = value(++i, a);
    else if (a === '--model') flags.model = value(++i, a);
    else if (a === '--output' || a === '-o') flags.output = value(++i, a);
    else if (!logo && a === '--badge') flags.badge = true;
    else if (logo && (a === '--positie' || a === '--position')) flags.positie = parsePositie(value(++i, a));
    else if (logo && (a === '--seconden' || a === '--duur' || a === '--seconds')) flags.seconden = number(++i, a, 0.1, 86400);
    else if (logo && (a === '--tekst' || a === '--text')) flags.tekst = value(++i, a).trim() || fail('Lege --tekst; gebruik --geen-tekst voor alleen het logo.');
    else if (logo && (a === '--geen-tekst' || a === '--no-text')) flags.geenTekst = true;
    else if (logo && (a === '--met-id' || a === '--with-id')) flags.metId = true;
    else if (logo && (a === '--grootte' || a === '--size')) flags.grootte = number(++i, a, 0.3, 4);
    else if (logo && a === '--crf') flags.crf = number(++i, a, 0, 63);
    else if (logo && a === '--font') flags.font = value(++i, a);
    else if (logo && (a === '--voorbeeld' || a === '--preview')) flags.voorbeeld = true;
    else if (a.startsWith('--')) fail(`Onbekende optie: ${a}`);
    else flags.files.push(a);
  }
  if (flags.lang && !['nl', 'en'].includes(flags.lang)) fail('--lang is nl of en.');
  return flags;
}

async function cmdLabel(args) {
  const cfg = await requireConfig();
  const f = parseFlags(args);
  if (f.files.length === 0) fail('Geef minimaal één bestand op: ait label <bestand>');
  if (f.output && f.files.length > 1) fail('--output kan alleen bij één bestand.');
  const ffmpegOk = await hasFfmpeg();

  for (const file of f.files) {
    if (!fs.existsSync(file)) fail(`Bestand niet gevonden: ${file}`);
    const size = fs.statSync(file).size;
    const ext = path.extname(file).slice(1).toLowerCase();
    console.log(`\n${bold(path.basename(file))} ${dim(`(${humanSize(size)})`)}`);

    // 1. Lokale fingerprint
    const sha = await sha256File(file, 'fingerprint berekenen');
    console.log(`  ${dim('sha256:')} ${sha.slice(0, 16)}…`);

    // 2. Rapport registreren in de online omgeving (alleen metadata, geen content)
    const reg = await registerRemote(cfg, file, sha, f);

    // 3. Manifest lokaal in het bestand bedden (stream copy — geen hercodering).
    //    Met --badge: zelfde logo-badge als `ait logo`, linksonder, eerste 6 s.
    const canEmbed = ffmpegOk && EMBED_EXTS.has(ext);
    let outFile = null;
    const techniques = [];
    if (canEmbed) {
      outFile = outputPathFor(file, f.output);
      const video = f.badge ? await probeVideo(file) : null;
      if (f.badge && !video) console.log(`  ${yellow('⚠')} geen videostream gevonden; --badge overgeslagen`);
      if (video) {
        console.log(`  ${yellow('•')} zichtbare badge (eerste 6 s) — dit hercodeert de video en kan even duren`);
        if (!f.output && !LOGO_KEEP_EXTS.has(ext)) outFile = outFile.replace(/\.[^.]+$/, '.mp4');
      } else {
        process.stderr.write(`  ${dim('markering inbedden…')}`);
      }
      try {
        if (video) {
          const zichtbaar = 'logo linksonder, eerste 6 s';
          const badge = planBadge(video, { positie: 'linksonder' }, loadFont(), [{ text: reg.badgeText }]);
          await encodeWithLogo({ inFile: file, outFile, info: video, badge, seconden: 6, compact: reg.compact,
            extraTags: { AILABEL_VISIBLE: zichtbaar }, encoders: await listEncoders() });
          techniques.push('media-metadata (ffmpeg-tags, lokaal)', `visible-label-overlay (${zichtbaar}, lokaal)`);
        } else {
          await embedTags(file, outFile, reg.compact);
          process.stderr.write('\r' + ' '.repeat(40) + '\r');
          techniques.push('media-metadata (ffmpeg-tags, lokaal)');
        }
        console.log(`  ${green('✔')} gemarkeerd bestand: ${bold(path.basename(outFile))}`);
      } catch (err) {
        process.stderr.write('\n');
        console.log(`  ${yellow('⚠')} inbedden mislukt (${err.message.split('\n')[0]}); label steunt op register + manifest`);
        outFile = null;
      }
    } else if (!ffmpegOk) {
      console.log(`  ${yellow('⚠')} ffmpeg niet gevonden — geen inbedding; label steunt op register + manifest`);
    } else {
      console.log(`  ${yellow('⚠')} .${ext} ondersteunt geen metadata-inbedding hier; label steunt op register + manifest`);
    }

    // 4. Afronden: hash van het gemarkeerde bestand naar het register
    if (outFile) await completeRemote(cfg, reg.labelId, outFile, techniques);

    // 5. Sidecar-manifest naast het bestand
    await writeSidecarAndSummary(reg, outFile || file);
  }
}

async function cmdLogo(args) {
  const f = parseFlags(args, { logo: true });
  if (f.files.length === 0) fail('Geef minimaal één video op: ait logo <video>');
  if (f.output && f.files.length > 1) fail('--output kan alleen bij één bestand.');
  if (!(await hasFfmpeg())) fail(`ffmpeg/ffprobe niet gevonden (${FFMPEG}). Installeer met: brew install ffmpeg`);
  const font = !f.geenTekst || f.metId ? loadFont(f.font) : null;
  const cfg = f.voorbeeld ? ((await loadConfig()) || { apiUrl: DEFAULT_URL }) : await requireConfig();
  const encoders = f.voorbeeld ? null : await listEncoders();
  for (const file of f.files) await logoOne(file, f, { cfg, font, encoders });
}

async function logoOne(file, f, { cfg, font, encoders }) {
  if (!fs.existsSync(file)) fail(`Bestand niet gevonden: ${file}`);
  const info = await probeVideo(file);
  if (!info) fail(`${path.basename(file)}: geen videostream gevonden. ait logo werkt alleen op video.`);
  const ext = path.extname(file).slice(1).toLowerCase();
  const stem = path.join(path.dirname(file), path.basename(file, path.extname(file)));
  const positie = f.positie || 'rechtsboven';
  const zichtbaar = `logo ${positie}, ${f.seconden ? `eerste ${f.seconden} s` : 'hele video'}`;
  const opts = { grootte: f.grootte || 1, positie };
  console.log(`\n${bold(path.basename(file))} ${dim(`(${info.width}×${info.height}, ${fmtDuur(info.duration)}, ${humanSize(fs.statSync(file).size)})`)}`);

  const warnMissing = lines => {
    const missing = [...new Set(lines.flatMap(l => shapeText(font, l.text, 10).missing))];
    if (missing.length) console.log(`  ${yellow('⚠')} niet in het lettertype: ${missing.join(' ')} (kies een ander met --font)`);
  };
  const warnSmall = badge => {
    const tiny = badge.layout.lines.find(l => l.px < 9);
    if (tiny) console.log(`  ${yellow('⚠')} de regel "${tiny.text}" is maar ${tiny.px.toFixed(0)} px hoog en slecht leesbaar; vergroot met --grootte of laat --met-id weg`);
  };

  // Voorbeeld: één frame met het logo, zonder label en zonder verbruik.
  if (f.voorbeeld) {
    const text = f.geenTekst ? null : (f.tekst ?? kortLabel(f));
    const lines = badgeLines(f, { text, verifyUrl: `${cfg.apiUrl}/verify/AIL-VOORBEELD0000` });
    if (font) warnMissing(lines);
    const badge = planBadge(info, opts, font, lines);
    warnSmall(badge);
    const outPng = f.output || `${stem}.logo-voorbeeld.png`;
    await previewFrame({ inFile: file, outPng, info, badge });
    console.log(`  ${green('✔')} voorbeeld: ${bold(path.basename(outPng))} ${dim(`(${zichtbaar}; logo ${badge.layout.bh} px, badge ${badge.layout.w}×${badge.layout.bh} px, marge ${badge.margin} px${font ? `, lettertype ${path.basename(font.path)}` : ''})`)}`);
    console.log(`  ${dim('Geen label aangemaakt. Draai zonder --voorbeeld om te labelen.')}`);
    return;
  }

  // 1. Lokale fingerprint van het origineel
  const sha = await sha256File(file, 'fingerprint berekenen');
  console.log(`  ${dim('sha256:')} ${sha.slice(0, 16)}…`);

  // 2. Label registreren (alleen fingerprint en metadata gaan naar de server)
  const outFile = f.output || `${stem}.ailabel.${LOGO_KEEP_EXTS.has(ext) ? ext : 'mp4'}`;
  if (path.resolve(outFile) === path.resolve(file)) fail('--output mag niet gelijk zijn aan de invoer; kies een ander pad.');
  const outExt = path.extname(outFile).slice(1).toLowerCase();
  const reg = await registerRemote(cfg, file, sha, f, VIDEO_MIME[outExt] || 'video/mp4');

  // 3. Logo inbranden en AILABEL-tags (label-ID, verify-URL) inbedden, in één gang
  const text = f.geenTekst ? null : (f.tekst ?? reg.badgeText ?? kortLabel(f));
  const lines = badgeLines(f, { text, verifyUrl: reg.verifyUrl });
  if (font) warnMissing(lines);
  const badge = planBadge(info, opts, font, lines);
  warnSmall(badge);
  console.log(`  ${yellow('•')} ${zichtbaar} (${badge.layout.bh} px) inbranden — dit hercodeert de video`);
  try {
    await encodeWithLogo({ inFile: file, outFile, info, badge, seconden: f.seconden, compact: reg.compact,
      extraTags: { AILABEL_VISIBLE: zichtbaar }, encoders, crf: f.crf });
  } catch (err) {
    fail(`Inbranden mislukt: ${err.message}\n  Het label ${reg.labelId} staat wel in het register: ${reg.verifyUrl}`);
  }
  console.log(`  ${green('✔')} gemarkeerd bestand: ${bold(path.basename(outFile))}`);

  // 4. Fingerprint van de gemarkeerde video naar het register
  await completeRemote(cfg, reg.labelId, outFile,
    ['media-metadata (ffmpeg-tags, lokaal)', `visible-label-overlay (${zichtbaar}, lokaal)`]);

  // 5. Sidecar-manifest en samenvatting
  await writeSidecarAndSummary(reg, outFile);
}

async function cmdCheck(args) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file) fail('Geef een bestand op: ait check <bestand>');
  if (!fs.existsSync(file)) fail(`Bestand niet gevonden: ${file}`);
  const cfg = (await loadConfig()) || { apiUrl: DEFAULT_URL, apiKey: null };

  console.log(`\n${bold(path.basename(file))}`);
  const tags = await probeTags(file);
  if (tags.id) console.log(`  ${green('✔')} ingebedde markering: ${bold(tags.id)}`);
  else console.log(`  ${dim('geen ingebedde AILABEL-tags gevonden (of geen mediabestand)')}`);

  const sha = await sha256File(file, 'fingerprint berekenen');
  let report;
  try {
    report = await api(cfg, `/api/v1/detect/hash/${sha}`, { auth: false });
  } catch (err) {
    fail(`Register niet bereikbaar: ${err.message}`);
  }
  if (report.isAiLabeled) {
    console.log(`  ${green('✔')} ${report.verdict}`);
    const sig = report.signatureValid === null ? '—' : report.signatureValid ? green('geldig') : red('ONGELDIG');
    console.log(`  ${dim('handtekening:')} ${sig}`);
    if (report.manifest) console.log(`  ${dim('verifieer:   ')} ${cfg.apiUrl}/verify/${report.manifest.id}`);
  } else if (tags.id) {
    console.log(`  ${yellow('⚠')} tags aanwezig maar fingerprint onbekend in het register — bestand mogelijk bewerkt na labeling`);
    console.log(`  ${dim('controleer het ID online:')} ${cfg.apiUrl}/verify/${tags.id}`);
  } else {
    console.log(`  ${yellow('•')} ${report.verdict}`);
  }
}

// ---------- Main ----------

const [cmd, ...rest] = process.argv.slice(2);
const HELP = `${bold('AI Transparent toolkit')} — lokaal grote bestanden labelen, rapport online

  ait login [--key atk_…] [--url ${DEFAULT_URL}]
  ait whoami
  ait label <bestand…> [--bewerkt] [--deepfake] [--badge] [--lang nl|en]
                       [--systeem <naam>] [--model <naam>] [--output <pad>]
  ait logo <video…>    [--positie lb|rb|lo|ro] [--seconden <n>] [--tekst "<tekst>"]
                       [--geen-tekst] [--met-id] [--grootte <factor>] [--voorbeeld]
                       [--crf <n>] [--font <pad.ttf>] + de opties van ait label
  ait check <bestand>
  ait logout

De content blijft op deze machine; alleen de SHA-256-fingerprint en metadata
gaan naar het register. --badge brandt de zichtbare disclosure in de eerste
6 seconden van de video (hercodeert; zonder --badge is het stream copy).
ait logo brandt het AI Transparent-logo met korte tekst in een hoek van de
video (standaard rechtsboven, de hele video) en labelt het resultaat.
--voorbeeld maakt alleen een PNG van één frame, zonder label.

${dim('Bestanden controleren op persoonsgegevens vóór upload: privacy-scan/ (submap)')}`;

try {
  switch (cmd) {
    case 'login': await cmdLogin(rest); break;
    case 'logout': await cmdLogout(); break;
    case 'whoami': await cmdWhoami(); break;
    case 'label': await cmdLabel(rest); break;
    case 'logo': await cmdLogo(rest); break;
    case 'check': await cmdCheck(rest); break;
    default: console.log(HELP); process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  fail(err.message);
}
