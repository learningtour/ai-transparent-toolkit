#!/usr/bin/env node
// glu-scan — satelliet van de GLU Analysetool.
//
// Controleert bestanden op persoonsgegevens vóórdat ze geüpload worden.
// De scan draait volledig op deze machine: reguliere expressies met echte
// validatie (11-proef, mod-97, Luhn) plus een lokaal taalmodel in LM Studio,
// Ollama of llama.cpp. Er gaat geen byte naar een clouddienst.
//
// Vereist: Node 20+. Geen npm-dependencies.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { laadConfig, bewaarConfig, CONFIG_FILE, STANDAARD } from './lib/config.js';
import { verzamelBestanden } from './lib/extract.js';
import { modellen, isLokaal, uitlegGeenServer } from './lib/llm.js';
import { scanBestand, samenvatten, redigeer } from './lib/scan.js';
import { toonResultaat, toonSamenvatting, naarJson, naarHtml } from './lib/rapport.js';
import { startServer } from './lib/server.js';
import { ERNST_RANG } from './lib/patronen.js';

// Wordt door de bouwstap op true gezet in het zelfstandige programma
// (esbuild --define). In een gewone Node-installatie blijft het false.
const VERPAKT = typeof GLU_VERPAKT !== 'undefined' && GLU_VERPAKT;

const bold = s => `\x1b[1m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;
const groen = s => `\x1b[32m${s}\x1b[0m`;
const geel = s => `\x1b[33m${s}\x1b[0m`;
const rood = s => `\x1b[31m${s}\x1b[0m`;

function fail(msg, code = 1) {
  console.error(rood('✘ ') + msg);
  process.exit(code);
}

// ---------- Argumenten ----------

function parseVlaggen(args) {
  const v = { paden: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--zonder-ai') v.zonderAi = true;
    else if (a === '--visie') v.visie = true;
    else if (a === '--toon-waarden') v.toonWaarden = true;
    else if (a === '--redigeer') v.redigeer = true;
    else if (a === '--stil') v.stil = true;
    else if (a === '--sta-extern') v.staExtern = true;
    else if (a === '--json') v.json = args[i + 1]?.startsWith('--') || !args[i + 1] ? '-' : args[++i];
    else if (a === '--html') v.html = args[++i];
    else if (a === '--endpoint') v.endpoint = args[++i];
    else if (a === '--model') v.model = args[++i];
    else if (a === '--visie-model') v.visionModel = args[++i];
    else if (a === '--drempel') v.drempel = args[++i];
    else if (a === '--max-stukken') v.maxStukken = Number(args[++i]);
    else if (a === '--stuk-grootte') v.stukGrootte = Number(args[++i]);
    else if (a === '--poort') v.poort = Number(args[++i]);
    else if (a === '--timeout') v.timeoutMs = Number(args[++i]) * 1000;
    else if (a === '--help' || a === '-h') v.help = true;
    else if (a.startsWith('--')) fail(`Onbekende optie: ${a}`);
    else v.paden.push(a);
  }
  return v;
}

async function configMetVlaggen(v) {
  const cfg = await laadConfig();
  for (const sleutel of ['endpoint', 'model', 'visionModel', 'drempel', 'maxStukken', 'stukGrootte', 'timeoutMs']) {
    if (v[sleutel] !== undefined) cfg[sleutel] = v[sleutel];
  }
  if (!['laag', 'middel', 'hoog'].includes(cfg.drempel)) fail('--drempel moet laag, middel of hoog zijn.');
  if (!isLokaal(cfg.endpoint) && !v.staExtern) {
    fail(`${cfg.endpoint} draait niet op deze machine.\n` +
      '  Deze scanner is er juist om te voorkomen dat gevoelige bestanden je computer verlaten.\n' +
      '  Weet je zeker dat je een externe server wilt gebruiken? Voeg --sta-extern toe.');
  }
  if (!isLokaal(cfg.endpoint)) {
    console.error(geel('⚠ ') + `Externe AI-server (${cfg.endpoint}): de inhoud van je bestanden gaat naar die server.`);
  }
  return cfg;
}

// Zoekt een bruikbaar model als er geen is opgegeven.
async function zorgVoorModel(cfg, { verplicht = true, viaApp = false } = {}) {
  try {
    const lijst = await modellen(cfg.endpoint);
    if (lijst.length === 0) throw new Error('de server draait maar heeft geen model geladen');
    if (!cfg.model) cfg.model = lijst[0];
    else if (!lijst.includes(cfg.model)) {
      // LM Studio accepteert ook gedeeltelijke namen; alleen waarschuwen.
      const gok = lijst.find(m => m.includes(cfg.model));
      if (gok) cfg.model = gok;
      else console.error(geel('⚠ ') + `Model "${cfg.model}" staat niet in de lijst van ${cfg.endpoint}. Beschikbaar: ${lijst.join(', ')}`);
    }
    return true;
  } catch (err) {
    if (verplicht) {
      // "fetch failed" van undici zegt de gebruiker niets.
      const reden = /fetch failed|ECONNREFUSED/.test(err.message) ? 'geen verbinding' : err.message;
      console.error(geel('⚠ ') + reden);
      console.error(dim(uitlegGeenServer(cfg.endpoint, { viaApp })));
      console.error(geel('→ ') + (viaApp
        ? 'De app start gewoon; de AI-laag staat uit.\n'
        : 'De scan gaat verder met alleen de patrooncontrole.\n'));
    }
    return false;
  }
}

// ---------- Commando's ----------

async function cmdScan(args) {
  const v = parseVlaggen(args);
  if (v.help || v.paden.length === 0) return console.log(HELP_SCAN);
  const cfg = await configMetVlaggen(v);

  let zonderAi = !!v.zonderAi;
  if (!zonderAi) {
    const ok = await zorgVoorModel(cfg);
    if (!ok) zonderAi = true;
  }

  // Paden uitpakken (mappen worden doorlopen).
  const bestanden = [];
  for (const pad of v.paden) {
    if (!fs.existsSync(pad)) fail(`Niet gevonden: ${pad}`);
    bestanden.push(...await verzamelBestanden(pad));
  }
  if (bestanden.length === 0) fail('Geen bestanden om te scannen.');

  if (!v.stil) {
    console.log(`\n${bold('Privacyscan vóór upload')} ${dim(`— ${bestanden.length} bestand(en), ${zonderAi ? 'alleen patronen' : `lokaal model: ${cfg.model}`}`)}`);
  }

  const resultaten = [];
  for (const bestand of bestanden) {
    const opVoortgang = ({ fase, stuk, van, bestand: naam }) => {
      if (v.stil || !process.stderr.isTTY) return;
      const tekst = fase === 'visie' ? 'beeld beoordelen…' : `AI-analyse ${stuk}/${van}`;
      process.stderr.write(`\r  ${dim(`${naam}: ${tekst}`)}          `);
    };
    let r;
    try {
      r = await scanBestand(bestand, cfg, { zonderAi, visie: v.visie, opVoortgang });
    } catch (err) {
      console.error(`\n${rood('✘')} ${path.basename(bestand)}: ${err.message}`);
      continue;
    }
    if (!v.stil && process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(72) + '\r');
    resultaten.push(r);
    if (!v.stil) toonResultaat(r, { toonWaarden: v.toonWaarden });

    if (v.redigeer && r.bevindingen.length) {
      try {
        const { pad, vervangen } = await redigeer(bestand, r);
        console.log(`  ${groen('✔')} geschoonde kopie: ${bold(path.basename(pad))} ${dim(`(${vervangen} vervanging(en))`)}`);
      } catch (err) {
        console.log(`  ${geel('⚠')} redigeren overgeslagen: ${err.message}`);
      }
    }
  }

  const s = samenvatten(resultaten, cfg.drempel);
  if (!v.stil) toonSamenvatting(s);

  if (v.json) {
    const data = JSON.stringify(naarJson(resultaten, s, { toonWaarden: v.toonWaarden }), null, 2);
    if (v.json === '-') console.log(data);
    else { await fsp.writeFile(v.json, data); console.log(`  ${dim('rapport:')} ${v.json}`); }
  }
  if (v.html) {
    await fsp.writeFile(v.html, naarHtml(resultaten, s, { toonWaarden: v.toonWaarden }));
    console.log(`  ${dim('rapport:')} ${v.html}`);
  }

  // Exitcode zodat een script of upload-knop hierop kan sturen. Geen
  // process.exit(): dat kan de laatste uitvoer afkappen als er naar een pipe
  // of bestand geschreven wordt.
  const blokkeert = ERNST_RANG[s.hoogsteOordeel] >= ERNST_RANG[cfg.drempel];
  process.exitCode = blokkeert ? 2 : 0;
}

async function cmdUi(args) {
  const v = parseVlaggen(args);
  const cfg = await configMetVlaggen(v);
  const zonderAi = !!v.zonderAi || !(await zorgVoorModel(cfg, { viaApp: true }));
  const poort = v.poort || 7817;

  let uit;
  try {
    uit = await startServer(cfg, { poort, zonderAi, visie: v.visie });
  } catch (err) {
    if (err.code === 'EADDRINUSE') fail(`Poort ${poort} is bezet. Kies een andere: glu-scan ui --poort ${poort + 1}`);
    fail(err.message);
  }

  console.log(`\n${bold('Privacyscan')} draait op ${bold(uit.url)}`);
  console.log(dim('  Sleep bestanden in het venster. Alles blijft op deze machine.'));
  console.log(dim(`  Model: ${zonderAi ? 'geen (alleen patronen)' : cfg.model} · stoppen met Ctrl-C\n`));

  // Browser openen waar dat kan; lukt het niet, dan staat de URL er hierboven.
  const [opener, openArgs] = process.platform === 'darwin' ? ['open', [uit.url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', uit.url]]
      : ['xdg-open', [uit.url]];
  execFile(opener, openArgs, () => {});
}

async function cmdModellen(args) {
  const v = parseVlaggen(args);
  const cfg = await configMetVlaggen(v);
  let lijst;
  try {
    lijst = await modellen(cfg.endpoint);
  } catch (err) {
    console.error(rood('✘ ') + err.message);
    return console.error('\n' + uitlegGeenServer(cfg.endpoint));
  }
  console.log(`${bold(cfg.endpoint)} ${dim(`— ${lijst.length} model(len)`)}`);
  for (const m of lijst) console.log(`  ${m === cfg.model ? groen('●') : dim('○')} ${m}`);
  if (!cfg.model) console.log(dim(`\n  Geen voorkeursmodel ingesteld; de eerste uit deze lijst wordt gebruikt.\n  Vastleggen: glu-scan config --model ${lijst[0] || '<naam>'}`));
}

async function cmdConfig(args) {
  const v = parseVlaggen(args);
  const cfg = await laadConfig();
  const wijzigingen = ['endpoint', 'model', 'visionModel', 'drempel', 'maxStukken', 'stukGrootte', 'timeoutMs']
    .filter(k => v[k] !== undefined);

  if (wijzigingen.length === 0) {
    console.log(`${bold('Instellingen')} ${dim(CONFIG_FILE)}`);
    for (const [k, standaard] of Object.entries(STANDAARD)) {
      const waarde = cfg[k];
      console.log(`  ${k.padEnd(14)} ${waarde ?? dim('(niet ingesteld)')}${waarde === standaard ? dim(' (standaard)') : ''}`);
    }
    console.log(dim('\n  Wijzigen: glu-scan config --endpoint http://localhost:11434/v1 --model llama3.1'));
    return;
  }
  for (const k of wijzigingen) cfg[k] = v[k];
  if (cfg.drempel && !['laag', 'middel', 'hoog'].includes(cfg.drempel)) fail('drempel moet laag, middel of hoog zijn.');
  const pad = await bewaarConfig(cfg);
  console.log(groen('✔') + ` Opgeslagen in ${pad}`);
  for (const k of wijzigingen) console.log(`  ${k} = ${cfg[k]}`);
}

// ---------- Main ----------

const HELP_SCAN = `${bold('glu-scan scan')} <bestand of map…> [opties]

  --zonder-ai            alleen patrooncontrole, geen model nodig
  --visie                afbeeldingen laten lezen door een visiemodel
  --redigeer             schrijf een geschoonde kopie (alleen platte tekst)
  --toon-waarden         gevonden waarden volledig tonen (standaard gemaskeerd)
  --json [pad]           JSON-rapport (zonder pad: naar stdout)
  --html <pad>           HTML-rapport om te bewaren of te delen
  --drempel laag|middel|hoog   vanaf wanneer uploaden wordt afgeraden (standaard middel)
  --endpoint <url>       lokale AI-server (standaard ${STANDAARD.endpoint})
  --model <naam>         model in die server
  --max-stukken <n>      hoeveel tekstblokken maximaal naar de AI gaan
  --stil                 geen terminaluitvoer, alleen exitcode en rapporten

Exitcode: 0 = onder de drempel, 2 = boven de drempel (niet uploaden), 1 = fout.`;

const HELP = `${bold('glu-scan')} — privacyscan vóór upload naar de GLU Analysetool

  glu-scan ui [--poort 7817]        lokale web-app: bestanden erin slepen
  glu-scan scan <bestand of map…>   scannen vanaf de commandoregel
  glu-scan modellen                 welke modellen draaien er lokaal?
  glu-scan config [--endpoint …]    instellingen tonen of wijzigen

De scan draait volledig op deze machine: patronen met echte validatie (BSN via
de 11-proef, IBAN via mod-97, betaalkaart via Luhn) plus een lokaal taalmodel
in LM Studio of Ollama voor namen, adressen en bijzondere persoonsgegevens
(art. 9 AVG). Zonder model werkt de patrooncontrole gewoon: --zonder-ai.

${dim('Uitgebreide opties: glu-scan scan --help')}`;

// Geen top-level await: zo blijft dit bestand bundelbaar tot één zelfstandig
// programma voor Mac en Windows (zie build/bouw.mjs).
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'scan': case 'check': return cmdScan(rest);
    case 'ui': case 'app': return cmdUi(rest);
    case 'modellen': case 'models': return cmdModellen(rest);
    case 'config': return cmdConfig(rest);
    default:
      // Dubbelgeklikt programma zonder argumenten: meteen de web-app starten,
      // want daar heeft iemand die geen terminal gebruikt iets aan.
      if (!cmd && VERPAKT) return cmdUi([]);
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch(err => fail(err.stack?.split('\n').slice(0, 2).join('\n') || err.message));
