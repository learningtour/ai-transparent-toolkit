#!/usr/bin/env node
// Bouwt glu-scan tot één zelfstandig programma: een bestand dat je downloadt
// en start, zonder dat Node.js geïnstalleerd hoeft te zijn.
//
// Werkwijze (Node's "single executable application"):
//   1. esbuild bundelt alle modules tot één CommonJS-bestand;
//   2. Node maakt daar een startblok van;
//   3. postject plakt dat blok in een kopie van het Node-programma zelf;
//   4. op macOS wordt de handtekening opnieuw gezet, anders weigert het systeem
//      het bestand te starten.
//
// Draaien:  npm run build        (bouwt voor het platform waar je op zit)
// Het resultaat komt in glu-scan/dist/.
//
// Let op: bouwen kan alleen voor het besturingssysteem waar je op werkt.
// Mac-programma's worden op een Mac gebouwd, Windows-programma's op Windows —
// daarvoor draait .github/workflows/glu-scan.yml op GitHub.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hier = path.dirname(fileURLToPath(import.meta.url));
const wortel = path.join(hier, '..');
const dist = path.join(wortel, 'dist');
const werk = path.join(dist, 'werk');

const groen = s => `\x1b[32m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;
const stap = (n, tekst) => console.log(`${dim(`[${n}/5]`)} ${tekst}`);

// De naam waaronder gebruikers het bestand downloaden.
const PLATFORM = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform] || process.platform;
const ARCH = { arm64: 'arm64', x64: 'x64' }[process.arch] || process.arch;
const NAAM = `glu-scan-${PLATFORM}-${ARCH}${process.platform === 'win32' ? '.exe' : ''}`;

function draai(cmd, args, opties = {}) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opties });
}

function binPad(naam) {
  const map = path.join(wortel, 'node_modules', '.bin');
  const kandidaat = path.join(map, process.platform === 'win32' ? `${naam}.cmd` : naam);
  if (!fs.existsSync(kandidaat)) {
    console.error(`\x1b[31m✘\x1b[0m ${naam} niet gevonden. Draai eerst: npm install`);
    process.exit(1);
  }
  return kandidaat;
}

await fsp.rm(werk, { recursive: true, force: true });
await fsp.mkdir(werk, { recursive: true });

// 1. Bundelen tot één bestand zonder imports.
stap(1, 'modules bundelen…');
const bundel = path.join(werk, 'glu-scan.cjs');
draai(binPad('esbuild'), [
  path.join(wortel, 'glu-scan.js'),
  '--bundle', '--platform=node', '--format=cjs', '--target=node20',
  '--define:GLU_VERPAKT=true',
  `--outfile=${bundel}`
], { shell: process.platform === 'win32' });

// 2. Startblok maken.
stap(2, 'startblok maken…');
const seaConfig = path.join(werk, 'sea.json');
await fsp.writeFile(seaConfig, JSON.stringify({
  main: bundel,
  output: path.join(werk, 'blob.blob'),
  disableExperimentalSEAWarning: true, // anders zie je bij elke start een waarschuwing
  useSnapshot: false,
  useCodeCache: true
}, null, 2));
draai(process.execPath, ['--experimental-sea-config', seaConfig]);

// 3. Kopie van Node maken en het blok erin plakken.
stap(3, 'programma samenstellen…');
const uit = path.join(dist, NAAM);
await fsp.mkdir(dist, { recursive: true });
await fsp.copyFile(process.execPath, uit);
await fsp.chmod(uit, 0o755);

if (process.platform === 'darwin') {
  // De bestaande handtekening klopt niet meer zodra we het bestand aanpassen.
  try { draai('codesign', ['--remove-signature', uit]); } catch { /* niet ondertekend */ }
}

const postjectArgs = [uit, 'NODE_SEA_BLOB', path.join(werk, 'blob.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
draai(binPad('postject'), postjectArgs, { shell: process.platform === 'win32' });

// 4. macOS: opnieuw ondertekenen, anders start het bestand niet.
stap(4, 'afronden…');
if (process.platform === 'darwin') {
  draai('codesign', ['--sign', '-', uit]);
}

// 5. Controleren dat het echt werkt.
stap(5, 'controleren…');
const proef = path.join(werk, 'proef.txt');
await fsp.writeFile(proef, 'Leerling: Jan de Vries, BSN 111222333.\n');
let code = 0;
try {
  draai(uit, ['scan', proef, '--zonder-ai', '--stil']);
} catch (err) {
  code = err.status;
}
if (code !== 2) {
  console.error(`\x1b[31m✘\x1b[0m Zelfcontrole mislukt: verwachtte exitcode 2 (persoonsgegevens gevonden), kreeg ${code}.`);
  process.exit(1);
}

await fsp.rm(werk, { recursive: true, force: true });
const mb = (fs.statSync(uit).size / 1e6).toFixed(0);
console.log(`\n${groen('✔')} ${path.relative(process.cwd(), uit)} ${dim(`(${mb} MB, Node ${process.version} inbegrepen)`)}`);
console.log(dim(`  Gebouwd op ${os.type()} ${process.arch}. Dit bestand werkt alleen op ${PLATFORM}/${ARCH}.`));
