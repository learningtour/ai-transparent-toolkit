#!/usr/bin/env node
// AI Transparent toolkit — lokaal grote bestanden labelen, rapport online.
//
// De content blijft op deze machine. Alleen de SHA-256-fingerprint en de
// labelmetadata gaan naar app.aitransparent.eu; het ondertekende manifest komt
// terug en wordt lokaal in het bestand gebed (ffmpeg, stream copy). Daarna is
// het label publiek verifieerbaar op de verify-pagina.
//
// Vereist: Node 20+, ffmpeg/ffprobe in PATH. Geen npm-dependencies.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

const CONFIG_DIR = path.join(os.homedir(), '.config', 'ai-transparent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_URL = 'https://app.aitransparent.eu';

const EMBED_EXTS = new Set(['mp4', 'mov', 'm4a', 'mkv', 'webm', 'mp3', 'flac', 'ogg', 'wav', 'aac', 'mpg', 'avi']);
const MOV_EXTS = new Set(['mp4', 'mov', 'm4a']);

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
  try { await pexec('ffmpeg', ['-version']); await pexec('ffprobe', ['-version']); return true; }
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

// ---------- ffmpeg: inbedden, badge, uitlezen ----------

async function embedTags(inFile, outFile, compact, { badge = null } = {}) {
  const ext = path.extname(inFile).slice(1).toLowerCase();
  const meta = [
    '-metadata', `AILABEL_ID=${compact.id}`,
    '-metadata', `AILABEL_DST=${compact.digitalSourceType}`,
    '-metadata', `AILABEL_SIG=${compact.sig}`,
    '-metadata', `AILABEL_KEYID=${compact.keyId}`,
    '-metadata', `AILABEL_SHA256=${compact.sha256Original}`,
    '-metadata', `AILABEL_VERIFY=${compact.verifyUrl}`,
    '-metadata', `comment=${compact.disclosure} [${compact.id}] ${compact.verifyUrl}`
  ];
  const args = ['-y', '-i', inFile, '-map', '0'];
  if (badge) {
    // Zichtbare disclosure aan het begin (Art. 50(5): bij eerste blootstelling).
    const safe = badge.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
    const font = fs.existsSync('/System/Library/Fonts/Helvetica.ttc')
      ? ':fontfile=/System/Library/Fonts/Helvetica.ttc' : '';
    args.push('-vf',
      `drawtext=text='${safe}'${font}:fontcolor=white:fontsize=h/22:box=1:boxcolor=0x0a1f4d@0.82:boxborderw=12:x=24:y=h-th-24:enable='between(t,0,6)'`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'copy');
  } else {
    args.push('-c', 'copy'); // geen hercodering: snel, ook bij enorme bestanden
  }
  args.push(...meta);
  if (MOV_EXTS.has(ext)) args.push('-movflags', 'use_metadata_tags');
  args.push(outFile);
  await pexec('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
}

async function probeTags(file) {
  try {
    const { stdout } = await pexec('ffprobe',
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

function parseLabelFlags(args) {
  const flags = { files: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--bewerkt' || a === '--manipulated') flags.manipulated = true;
    else if (a === '--deepfake') flags.deepFake = true;
    else if (a === '--badge') flags.badge = true;
    else if (a === '--lang') flags.lang = args[++i];
    else if (a === '--systeem' || a === '--system') flags.system = args[++i];
    else if (a === '--model') flags.model = args[++i];
    else if (a === '--output' || a === '-o') flags.output = args[++i];
    else if (a.startsWith('--')) fail(`Onbekende optie: ${a}`);
    else flags.files.push(a);
  }
  return flags;
}

async function cmdLabel(args) {
  const cfg = await requireConfig();
  const f = parseLabelFlags(args);
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
    let reg;
    try {
      reg = await api(cfg, '/api/v1/label/remote', { method: 'POST', body: {
        sha256: sha,
        filename: path.basename(file),
        manipulated: !!f.manipulated,
        deepFake: !!f.deepFake,
        lang: f.lang || 'nl',
        generator: { system: f.system, model: f.model }
      } });
    } catch (err) {
      fail(`Registreren mislukt: ${err.message}`);
    }
    console.log(`  ${green('✔')} label ${bold(reg.labelId)} geregistreerd`);

    // 3. Manifest lokaal in het bestand bedden (stream copy — geen hercodering)
    const canEmbed = ffmpegOk && EMBED_EXTS.has(ext);
    let outFile = null;
    const techniques = [];
    if (canEmbed) {
      outFile = outputPathFor(file, f.output);
      const badgeText = f.badge ? reg.badgeText : null;
      if (f.badge) console.log(`  ${yellow('•')} zichtbare badge (eerste 6 s) — dit hercodeert de video en kan even duren`);
      process.stderr.write(`  ${dim('markering inbedden…')}`);
      try {
        await embedTags(file, outFile, reg.compact, { badge: badgeText });
        process.stderr.write('\r' + ' '.repeat(40) + '\r');
        techniques.push('media-metadata (ffmpeg-tags, lokaal)');
        if (f.badge) techniques.push('visible-label-overlay (lokaal)');
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
    if (outFile) {
      const shaMarked = await sha256File(outFile, 'gemarkeerd bestand hashen');
      try {
        await api(cfg, '/api/v1/label/remote/complete', { method: 'POST', body: {
          labelId: reg.labelId, sha256Marked: shaMarked, techniques
        } });
      } catch (err) {
        console.log(`  ${yellow('⚠')} afronden bij register mislukt: ${err.message}`);
      }
    }

    // 5. Sidecar-manifest naast het bestand
    const sidecar = (outFile || file) + '.manifest.json';
    await fsp.writeFile(sidecar, JSON.stringify(reg.manifest, null, 2));

    console.log(`  ${dim('disclosure:')} ${reg.disclosure.text}`);
    console.log(`  ${dim('verifieer: ')} ${reg.verifyUrl}`);
    console.log(`  ${dim('manifest:  ')} ${path.basename(sidecar)}`);
  }
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
  ait check <bestand>
  ait logout

De content blijft op deze machine; alleen de SHA-256-fingerprint en metadata
gaan naar het register. --badge brandt de zichtbare disclosure in de eerste
6 seconden van de video (hercodeert; zonder --badge is het stream copy).

${dim('Bestanden controleren op persoonsgegevens vóór upload: glu-scan (zie docs/glu-scan.md)')}`;

try {
  switch (cmd) {
    case 'login': await cmdLogin(rest); break;
    case 'logout': await cmdLogout(); break;
    case 'whoami': await cmdWhoami(); break;
    case 'label': await cmdLabel(rest); break;
    case 'check': await cmdCheck(rest); break;
    default: console.log(HELP); process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  fail(err.message);
}
