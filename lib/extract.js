// Tekst uit bestanden halen — volledig lokaal, zonder npm-dependencies.
//
// Ondersteund: platte tekst (txt/md/csv/json/xml/html/srt/vtt/code), Office
// (docx/xlsx/pptx via zip + inflate), OpenDocument (odt/ods/odp), PDF (via
// pdftotext als dat er is, anders een ingebouwde extractor) en RTF.
// Afbeeldingen worden herkend maar niet gelezen: die gaan naar de visie-pass
// of komen als "handmatig controleren" in het rapport.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export const TEKST_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'yml', 'yaml',
  'html', 'htm', 'srt', 'vtt', 'log', 'ini', 'cfg', 'conf', 'sql', 'js', 'mjs', 'ts',
  'py', 'php', 'java', 'cs', 'rb', 'go', 'sh', 'css', 'tex', 'rst', 'eml', 'vcf', 'ics'
]);
export const ZIP_EXTS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
export const AFBEELDING_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'heic']);
export const MEDIA_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'mp3', 'wav', 'm4a', 'flac', 'ogg']);

// Standaard leeslimiet: grote bestanden worden afgekapt, niet overgeslagen.
export const MAX_BYTES = 32 * 1024 * 1024;

// ---------- ZIP (docx, xlsx, pptx, odf) ----------

function zipInhoud(buf) {
  // Eind-van-centrale-directory zoeken (staat achteraan, evt. met comment).
  let eocd = -1;
  const ondergrens = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= ondergrens; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('geen geldig zip-archief');

  const aantal = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < aantal; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const methode = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const naamLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lokaalOff = buf.readUInt32LE(off + 42);
    const naam = buf.toString('utf8', off + 46, off + 46 + naamLen);
    entries.push({ naam, methode, compSize, lokaalOff });
    off += 46 + naamLen + extraLen + commentLen;
  }
  return entries;
}

function zipLees(buf, entry) {
  const lo = entry.lokaalOff;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) return null;
  const naamLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + naamLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  try {
    if (entry.methode === 0) return data;
    if (entry.methode === 8) return zlib.inflateRawSync(data);
  } catch { /* beschadigd onderdeel: overslaan */ }
  return null;
}

const ENTITEITEN = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function xmlNaarTekst(xml) {
  return xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<(?:w:br|w:cr)\b[^>]*\/?>/g, '\n')
    .replace(/<\/(?:w:p|a:p|text:p|text:h)>/g, '\n')
    .replace(/<\/(?:w:tc|a:tc)>/g, '\t')
    .replace(/<\/(?:w:tr|a:tr|table:table-row)>/g, '\n')
    .replace(/<\/(?:si|c)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITEITEN[n.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function uitZip(buf) {
  const entries = zipInhoud(buf);
  // Volgorde: hoofdtekst, dan gedeelde strings/notities/commentaren.
  const interessant = entries.filter(e =>
    /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(e.naam) ||
    /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml|comments\d*\.xml)$/.test(e.naam) ||
    /^ppt\/(slides\/slide\d+\.xml|notesSlides\/notesSlide\d+\.xml|comments\/.*\.xml)$/.test(e.naam) ||
    /^(content|meta|styles)\.xml$/.test(e.naam) ||
    /^docProps\/(core|app)\.xml$/.test(e.naam));

  if (interessant.length === 0) throw new Error('geen leesbare documentonderdelen in het archief');

  const delen = [];
  for (const e of interessant) {
    const data = zipLees(buf, e);
    if (!data) continue;
    const tekst = xmlNaarTekst(data.toString('utf8')).trim();
    if (tekst) delen.push(`--- ${e.naam} ---\n${tekst}`);
  }
  return delen.join('\n\n');
}

// ---------- PDF ----------

function pdfStrings(inhoud) {
  const uit = [];
  // Tekst staat tussen BT/ET in Tj/TJ/'/"-operatoren.
  const tekstBlokken = inhoud.match(/BT[\s\S]{0,200000}?ET/g) || [inhoud];
  for (const blok of tekstBlokken) {
    let m;
    const re = /(\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]+>)\s*(?:Tj|TJ|'|")|\[((?:[^\][]|\\\])*)\]\s*TJ/g;
    while ((m = re.exec(blok)) !== null) {
      const stukken = [];
      if (m[1]) stukken.push(m[1]);
      if (m[2]) {
        const sub = m[2].match(/\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]+>/g) || [];
        stukken.push(...sub);
      }
      for (const s of stukken) {
        if (s.startsWith('<')) {
          const hex = s.slice(1, -1).replace(/\s/g, '');
          let t = '';
          for (let i = 0; i + 1 < hex.length; i += 2) {
            const code = parseInt(hex.slice(i, i + 2), 16);
            if (code >= 32 || code === 10) t += String.fromCharCode(code);
          }
          uit.push(t);
        } else {
          uit.push(s.slice(1, -1)
            .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
            .replace(/\\n/g, '\n').replace(/\\r/g, '\n').replace(/\\t/g, '\t')
            .replace(/\\([()\\])/g, '$1'));
        }
      }
      uit.push(' ');
    }
    uit.push('\n');
  }
  return uit.join('');
}

function pdfIntern(buf) {
  const ruw = buf.toString('latin1'); // 1 byte = 1 teken, dus indexen kloppen
  let tekst = '';
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(ruw)) !== null) {
    const start = m.index + m[0].length;
    const eind = ruw.indexOf('endstream', start);
    if (eind < 0) break;
    re.lastIndex = eind;
    const rauw = buf.subarray(start, eind);
    let inhoud;
    try {
      inhoud = zlib.inflateSync(rauw).toString('latin1');
    } catch {
      inhoud = rauw.toString('latin1');
    }
    if (!/BT|Tj|TJ/.test(inhoud)) continue;
    tekst += pdfStrings(inhoud);
  }
  return tekst.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function uitPdf(bestand, buf) {
  try {
    const { stdout } = await pexec('pdftotext', ['-q', '-enc', 'UTF-8', bestand, '-'], {
      maxBuffer: 64 * 1024 * 1024
    });
    if (stdout && stdout.trim().length > 20) return { tekst: stdout, notitie: null };
  } catch { /* pdftotext ontbreekt of faalt: eigen extractor */ }
  const tekst = pdfIntern(buf);
  if (tekst.length < 20) {
    return {
      tekst,
      notitie: 'PDF leverde nauwelijks tekst op — waarschijnlijk een scan of afbeelding. Installeer poppler (pdftotext) of controleer dit bestand handmatig.'
    };
  }
  return { tekst, notitie: 'PDF gelezen met de ingebouwde extractor; installeer poppler (pdftotext) voor een nauwkeuriger resultaat.' };
}

// ---------- RTF ----------

function uitRtf(ruw) {
  return ruw
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- Publieke API ----------

export function soortVan(bestand) {
  const ext = path.extname(bestand).slice(1).toLowerCase();
  if (TEKST_EXTS.has(ext)) return 'tekst';
  if (ZIP_EXTS.has(ext)) return 'document';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'rtf') return 'rtf';
  if (AFBEELDING_EXTS.has(ext)) return 'afbeelding';
  if (MEDIA_EXTS.has(ext)) return 'media';
  return 'onbekend';
}

function lijktBinair(buf) {
  const n = Math.min(buf.length, 4096);
  let raar = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) raar++;
  }
  return raar / Math.max(1, n) > 0.1;
}

/**
 * Haalt tekst uit één bestand.
 * @returns {{tekst:string, soort:string, afgekapt:boolean, notitie:string|null, leesbaar:boolean}}
 */
export async function haalTekst(bestand, { maxBytes = MAX_BYTES } = {}) {
  const soort = soortVan(bestand);
  const stat = await fsp.stat(bestand);
  const afgekapt = stat.size > maxBytes;

  const basis = { soort, afgekapt, notitie: null, leesbaar: true, bytes: stat.size };

  if (soort === 'afbeelding') {
    return { ...basis, tekst: '', leesbaar: false, notitie: 'Afbeelding: tekst in beeld wordt alleen gelezen met --visie (visiemodel in LM Studio).' };
  }
  if (soort === 'media') {
    return { ...basis, tekst: '', leesbaar: false, notitie: 'Audio/video wordt niet getranscribeerd. Controleer beeld en geluid handmatig, of label het bestand met `ait label`.' };
  }

  let buf;
  if (afgekapt) {
    const fh = await fsp.open(bestand, 'r');
    try {
      buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
      buf = buf.subarray(0, bytesRead);
    } finally { await fh.close(); }
  } else {
    buf = await fsp.readFile(bestand);
  }

  try {
    if (soort === 'document') {
      if (afgekapt) throw new Error('archief te groot om betrouwbaar te lezen');
      return { ...basis, tekst: uitZip(buf) };
    }
    if (soort === 'pdf') {
      const { tekst, notitie } = await uitPdf(bestand, buf);
      return { ...basis, tekst, notitie, leesbaar: tekst.length > 0 };
    }
    if (soort === 'rtf') return { ...basis, tekst: uitRtf(buf.toString('utf8')) };

    // Tekst of onbekend: alleen lezen als het geen binair bestand blijkt.
    if (soort === 'onbekend' && lijktBinair(buf)) {
      return { ...basis, tekst: '', leesbaar: false, notitie: 'Binair bestand van een onbekend type — niet gelezen. Controleer handmatig wat erin zit.' };
    }
    let tekst = buf.toString('utf8');
    if (path.extname(bestand).toLowerCase().match(/\.html?$/)) {
      tekst = tekst.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ');
      // HTML-commentaar bewust behouden: daar staan vaak juist persoonsgegevens in.
      tekst = xmlNaarTekst(tekst);
    }
    return { ...basis, tekst };
  } catch (err) {
    return { ...basis, tekst: '', leesbaar: false, notitie: `Kon dit bestand niet uitpakken: ${err.message}` };
  }
}

/** Loopt een map af en levert scanbare bestandspaden. */
export async function verzamelBestanden(pad, { maxBestanden = 500, negeer = /(^|\/)(node_modules|\.git|\.venv|__pycache__|dist|build)(\/|$)/ } = {}) {
  const stat = fs.statSync(pad);
  if (!stat.isDirectory()) return [pad];
  const uit = [];
  const wandel = async dir => {
    if (uit.length >= maxBestanden) return;
    for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
      if (uit.length >= maxBestanden) return;
      const vol = path.join(dir, item.name);
      if (negeer.test(vol.replace(/\\/g, '/'))) continue;
      if (item.isDirectory()) await wandel(vol);
      else if (item.isFile() && !item.name.startsWith('.')) uit.push(vol);
    }
  };
  await wandel(pad);
  return uit.sort();
}

/** Knipt tekst in stukken die in een lokaal model passen. */
export function inStukken(tekst, grootte = 6000, overlap = 200) {
  if (tekst.length <= grootte) return [{ tekst, offset: 0 }];
  const stukken = [];
  let i = 0;
  while (i < tekst.length) {
    let eind = Math.min(tekst.length, i + grootte);
    if (eind < tekst.length) {
      // Liefst op een alinea- of regelgrens knippen.
      const grens = tekst.lastIndexOf('\n', eind);
      if (grens > i + grootte * 0.6) eind = grens;
    }
    stukken.push({ tekst: tekst.slice(i, eind), offset: i });
    if (eind >= tekst.length) break;
    i = eind - overlap;
  }
  return stukken;
}
