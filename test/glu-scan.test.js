// Tests voor de privacyscanner. Draaien met: npm test
//
// De AI-pad wordt getest tegen een nagebootste LM Studio-server, zodat de
// volledige keten (endpoint → JSON → filtering → oordeel) getest is zonder dat
// er een model geïnstalleerd hoeft te zijn.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { geldigBsn, geldigIban, geldigLuhn, zoekPatronen, maskeer } from '../lib/patronen.js';
import { haalTekst, inStukken, soortVan } from '../lib/extract.js';
import { isLokaal, analyseerTekst, modellen } from '../lib/llm.js';
import { scanBestand, samenvatten, redigeer, oordeel } from '../lib/scan.js';
import { startServer } from '../lib/server.js';
import { naarJson, naarHtml } from '../lib/rapport.js';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'glu-scan-test-'));
const schrijf = async (naam, inhoud) => {
  const p = path.join(tmp, naam);
  await fsp.writeFile(p, inhoud);
  return p;
};

// ---------- Validators ----------

test('BSN wordt met de elfproef gevalideerd', () => {
  assert.ok(geldigBsn('111222333'));
  assert.ok(geldigBsn('123456782'));
  assert.ok(!geldigBsn('123456789'), 'voldoet niet aan de elfproef');
  assert.ok(!geldigBsn('000000000'), 'nullenreeks is geen BSN');
  assert.ok(!geldigBsn('11122233'), 'te kort');
});

test('IBAN wordt met mod-97 gevalideerd', () => {
  assert.ok(geldigIban('NL91ABNA0417164300'));
  assert.ok(geldigIban('NL91 ABNA 0417 1643 00'), 'spaties toegestaan');
  assert.ok(geldigIban('DE89370400440532013000'));
  assert.ok(!geldigIban('NL91ABNA0417164301'), 'verkeerd controlegetal');
});

test('betaalkaart wordt met Luhn gevalideerd', () => {
  assert.ok(geldigLuhn('4539578763621486'));
  assert.ok(!geldigLuhn('4539578763621487'));
  assert.ok(!geldigLuhn('1111111111111111'), 'herhaalde cijfers zijn testdata');
});

test('maskeren laat de waarde niet lekken', () => {
  assert.equal(maskeer('111222333'), '11•••••33');
  assert.match(maskeer('jan.jansen@school.nl'), /^ja•+@school\.nl$/);
  assert.equal(maskeer('abc'), '•••');
});

// ---------- Patronen ----------

test('patronen vinden de kerngegevens en negeren ruis', () => {
  const tekst = [
    'Leerling: Jan de Vries',
    'BSN: 111222333',
    'IBAN NL91ABNA0417164300',
    'E-mail: jan@school.nl',
    'Telefoon 06-12345678',
    'Postcode 3512 JD',
    'Geboortedatum: 14-03-2009',
    'Ordernummer 400123456789 uit 2024'
  ].join('\n');
  const types = zoekPatronen(tekst).map(b => b.type);
  for (const verwacht of ['bsn', 'iban', 'email', 'telefoon', 'postcode', 'geboortedatum', 'naam']) {
    assert.ok(types.includes(verwacht), `${verwacht} niet gevonden`);
  }
});

test('nummers aan het eind van een zin worden ook herkend', () => {
  // Een te strenge lookahead miste eerder "BSN 111222333." met een punt erachter.
  const heeft = (tekst, type) => zoekPatronen(tekst).some(b => b.type === type);
  assert.ok(heeft('BSN 111222333.', 'bsn'));
  assert.ok(heeft('(BSN 111222333)', 'bsn'));
  assert.ok(heeft('bsn 111.222.333!', 'bsn'));
  assert.ok(heeft('Bel 06-12345678.', 'telefoon'));
  // …maar een nummer middenin een langere reeks nog steeds niet.
  assert.ok(!heeft('Ordernummer 400123456789 uit 2024', 'bsn'));
  assert.ok(!heeft('versie 1.111222333.2 van het bestand', 'bsn'));
});

test('voorbeeldadressen en losse datums leveren geen bevinding op', () => {
  const b = zoekPatronen('Mail naar info@example.com. De vergadering is op 12-05-2024.');
  assert.equal(b.length, 0);
});

test('een BSN wordt niet ook als leerlingnummer geteld', () => {
  const b = zoekPatronen('Leerlingnummer en BSN staan hier: 111222333');
  assert.equal(b.filter(x => x.type === 'bsn').length, 1);
  assert.equal(b.filter(x => x.type === 'leerlingnummer').length, 0);
});

test('bijzondere categorieën komen samen in één bevinding per soort', () => {
  const b = zoekPatronen('Diagnose ADHD, medicatie via de huisarts, therapie loopt.');
  const gezondheid = b.filter(x => x.type === 'gezondheid');
  assert.equal(gezondheid.length, 1);
  assert.ok(gezondheid[0].termen.length >= 3);
  assert.equal(gezondheid[0].ernst, 'hoog');
  assert.equal(gezondheid[0].gemaskeerd, gezondheid[0].waarde, 'trefwoorden worden niet gemaskeerd');
});

test('wachtwoorden en sleutels worden als hoog risico gemeld', () => {
  const b = zoekPatronen('wachtwoord: Zomer2025! en api_key=sk-abcdefghijklmnopqrst');
  assert.ok(b.some(x => x.type === 'geheim' && x.ernst === 'hoog'));
});

// ---------- Extractie ----------

test('platte tekst en soortherkenning', async () => {
  const p = await schrijf('notitie.md', '# Titel\nBSN 111222333\n');
  assert.equal(soortVan(p), 'tekst');
  const uit = await haalTekst(p);
  assert.match(uit.tekst, /111222333/);
  assert.equal(uit.leesbaar, true);
});

test('docx wordt uitgepakt zonder externe library', async () => {
  // Minimale docx: één zip-entry met word/document.xml.
  const xml = Buffer.from('<w:document><w:body><w:p><w:r><w:t>BSN 111222333</w:t></w:r></w:p></w:body></w:document>', 'utf8');
  const comp = zlib.deflateRawSync(xml);
  const naam = Buffer.from('word/document.xml', 'utf8');
  const crc = 0; // niet gecontroleerd door onze lezer
  const lokaal = Buffer.concat([
    (() => { const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
      h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(xml.length, 22);
      h.writeUInt16LE(naam.length, 26); return h; })(),
    naam, comp
  ]);
  const centraal = Buffer.concat([
    (() => { const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 6); h.writeUInt16LE(8, 10);
      h.writeUInt32LE(crc, 16); h.writeUInt32LE(comp.length, 20); h.writeUInt32LE(xml.length, 24);
      h.writeUInt16LE(naam.length, 28); h.writeUInt32LE(0, 42); return h; })(),
    naam
  ]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centraal.length, 12); eocd.writeUInt32LE(lokaal.length, 16);

  const p = await schrijf('test.docx', Buffer.concat([lokaal, centraal, eocd]));
  const uit = await haalTekst(p);
  assert.match(uit.tekst, /111222333/);
  assert.equal(uit.soort, 'document');
});

test('afbeeldingen en media worden gemarkeerd, niet gelezen', async () => {
  const p = await schrijf('foto.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
  const uit = await haalTekst(p);
  assert.equal(uit.leesbaar, false);
  assert.match(uit.notitie, /--visie/);
});

test('tekst wordt met overlap in stukken geknipt', () => {
  const tekst = Array.from({ length: 300 }, (_, i) => `regel ${i}`).join('\n');
  const stukken = inStukken(tekst, 500, 50);
  assert.ok(stukken.length > 3);
  assert.ok(stukken.every(s => s.tekst.length <= 500));
  assert.equal(stukken[0].offset, 0);
});

// ---------- Lokale AI (nagebootste server) ----------

function stubModel({ antwoord, statusJsonModus = 200 }) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test-model-7b' }] }));
      }
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const verzoek = JSON.parse(body || '{}');
        // Sommige lokale servers weigeren response_format: dat pad testen we hier.
        if (verzoek.response_format && statusJsonModus !== 200) {
          res.writeHead(statusJsonModus, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'response_format wordt niet ondersteund' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: antwoord } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, endpoint: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

test('externe endpoints worden herkend als niet-lokaal', () => {
  assert.ok(isLokaal('http://localhost:1234/v1'));
  assert.ok(isLokaal('http://127.0.0.1:11434/v1'));
  assert.ok(isLokaal('http://192.168.1.20:1234/v1'));
  assert.ok(!isLokaal('https://api.openai.com/v1'));
});

test('AI-bevindingen worden genormaliseerd en verzinsels weggefilterd', async () => {
  const { server, endpoint } = await stubModel({
    antwoord: '```json\n' + JSON.stringify({
      bevindingen: [
        { type: 'naam', label: 'Naam van een leerling', ernst: 'middel', fragment: 'Pieter van Dijk', toelichting: 'direct identificerend', zekerheid: 'hoog' },
        { type: 'gezondheid', label: 'Verzonnen', ernst: 'hoog', fragment: 'staat niet in de tekst', toelichting: 'hallucinatie' }
      ],
      samenvatting: 'aanmeldformulier met naam'
    }) + '\n```'
  });
  try {
    const uit = await analyseerTekst({ endpoint, model: 'test-model-7b' }, 'Aanmeldformulier van Pieter van Dijk, groep 8.');
    assert.equal(uit.bevindingen.length, 1, 'het verzonnen fragment hoort weggefilterd te zijn');
    assert.equal(uit.bevindingen[0].waarde, 'Pieter van Dijk');
    assert.equal(uit.bevindingen[0].bron, 'ai');
    assert.equal(uit.samenvatting, 'aanmeldformulier met naam');
  } finally { server.close(); }
});

test('een server zonder response_format-ondersteuning werkt alsnog', async () => {
  const { server, endpoint } = await stubModel({
    antwoord: '{"bevindingen":[],"samenvatting":"niets gevonden"}',
    statusJsonModus: 400
  });
  try {
    const uit = await analyseerTekst({ endpoint, model: 'x' }, 'Neutrale tekst.');
    assert.equal(uit.bevindingen.length, 0);
    assert.equal(uit.samenvatting, 'niets gevonden');
  } finally { server.close(); }
});

test('modellenlijst komt van het lokale endpoint', async () => {
  const { server, endpoint } = await stubModel({ antwoord: '{}' });
  try {
    assert.deepEqual(await modellen(endpoint), ['test-model-7b']);
  } finally { server.close(); }
});

// ---------- Scan ----------

test('scan combineert patronen en AI tot één oordeel', async () => {
  const { server, endpoint } = await stubModel({
    antwoord: JSON.stringify({
      bevindingen: [{ type: 'naam', label: 'Persoonsnaam', ernst: 'middel', fragment: 'Sanne Bakker', toelichting: 'identificeert een persoon', zekerheid: 'hoog' }],
      samenvatting: 'dossierfragment met een naam'
    })
  });
  try {
    const p = await schrijf('dossier.txt', 'Dossier van Sanne Bakker.\nBSN: 111222333\n');
    const r = await scanBestand(p, { endpoint, model: 'test-model-7b', stukGrootte: 6000, maxStukken: 10 });
    assert.equal(r.oordeel, 'hoog');
    assert.ok(r.aiGebruikt);
    assert.ok(r.bevindingen.some(b => b.type === 'bsn' && b.bron === 'patroon'));
    assert.ok(r.bevindingen.some(b => b.waarde === 'Sanne Bakker' && b.bron === 'ai'));
    assert.equal(r.samenvatting, 'dossierfragment met een naam');
  } finally { server.close(); }
});

test('zonder bereikbaar model blijft de patrooncontrole werken', async () => {
  const p = await schrijf('kort.txt', 'BSN 111222333');
  const r = await scanBestand(p, { endpoint: 'http://127.0.0.1:1/v1', model: 'x' }, { zonderAi: true });
  assert.equal(r.aiGebruikt, false);
  assert.equal(r.oordeel, 'hoog');
});

test('een AI-storing maakt de scan beperkt, niet stuk', async () => {
  const p = await schrijf('storing.txt', 'Postcode 3512 JD, huisnummer 12');
  const r = await scanBestand(p, { endpoint: 'http://127.0.0.1:1/v1', model: 'x', timeoutMs: 500 });
  assert.equal(r.aiGebruikt, false);
  assert.ok(r.waarschuwingen.some(w => /AI-analyse/.test(w)));
  assert.equal(r.oordeel, 'middel', 'patronen leveren nog steeds een oordeel');
});

test('een gevoelig onderwerp zonder identificeerbare persoon is geen hoog risico', async () => {
  const uitleg = await schrijf('over-adhd.md', 'Deze handleiding legt uit wat een diagnose ADHD betekent en welke medicatie voorkomt.');
  const r1 = await scanBestand(uitleg, {}, { zonderAi: true });
  assert.equal(r1.oordeel, 'laag', 'algemene uitleg over een onderwerp is geen persoonsgegeven');
  assert.match(r1.bevindingen.find(b => b.type === 'gezondheid').label, /onderwerp/);

  const dossier = await schrijf('dossier-adhd.md', 'Diagnose ADHD bij leerling, BSN 111222333.');
  const r2 = await scanBestand(dossier, {}, { zonderAi: true });
  assert.equal(r2.oordeel, 'hoog', 'met een identificerend gegeven erbij wél');
  assert.equal(r2.bevindingen.find(b => b.type === 'gezondheid').ernst, 'hoog');
});

test('persoonsgegevens in de bestandsnaam tellen mee', async () => {
  const p = await schrijf('dossier-bsn-111222333.txt', 'niets bijzonders hier');
  const r = await scanBestand(p, {}, { zonderAi: true });
  assert.ok(r.bevindingen.some(b => b.inBestandsnaam && b.type === 'bsn'));
});

test('oordeel en drempel bepalen het uploadadvies', () => {
  assert.equal(oordeel([]), 'geen');
  assert.equal(oordeel([{ ernst: 'laag' }, { ernst: 'hoog' }]), 'hoog');
  const s = samenvatten([
    { naam: 'a.txt', oordeel: 'geen' },
    { naam: 'b.txt', oordeel: 'hoog' }
  ], 'middel');
  assert.equal(s.hoogsteOordeel, 'hoog');
  assert.deepEqual(s.geblokkeerd, ['b.txt']);
  const soepel = samenvatten([{ naam: 'a.txt', oordeel: 'laag' }], 'hoog');
  assert.equal(soepel.geblokkeerd.length, 0);
});

test('onleesbare bestanden worden niet als schoon gepresenteerd', () => {
  const s = samenvatten([{ naam: 'scan.pdf', oordeel: 'onbekend' }, { naam: 'ok.txt', oordeel: 'geen' }], 'middel');
  assert.deepEqual(s.onleesbaar, ['scan.pdf']);
  assert.match(s.uploadAdvies, /niet lezen/);
});

test('te veel treffers van één soort levert een waarschuwing op', async () => {
  const regels = Array.from({ length: 40 }, (_, i) => `deelnemer${i}@school.nl`).join('\n');
  const p = await schrijf('veel.csv', regels);
  const r = await scanBestand(p, {}, { zonderAi: true });
  assert.ok(r.bevindingen.filter(b => b.type === 'email').length <= 25);
  assert.ok(r.waarschuwingen.some(w => /andere unieke treffer/.test(w)), 'afkappen moet gemeld worden');
});

test('redigeren vervangt waarden maar laat trefwoorden staan', async () => {
  // Met contextwoord ervoor: zonder "Leerling:" vindt de heuristiek de naam
  // niet — daarvoor is de AI-laag.
  const p = await schrijf('te-schonen.txt', 'Leerling: Jan de Vries, BSN 111222333, diagnose ADHD.');
  const r = await scanBestand(p, {}, { zonderAi: true });
  const { pad, vervangen } = await redigeer(p, r);
  const uit = await fsp.readFile(pad, 'utf8');
  assert.ok(vervangen >= 1);
  assert.ok(!uit.includes('111222333'));
  assert.match(uit, /\[GEREDIGEERD:bsn\]/);
  assert.match(uit, /diagnose ADHD/, 'onderwerp blijft leesbaar');
  assert.ok(!uit.includes('Jan de Vries'), 'de naam hoort wél vervangen te zijn');

  // Wat overblijft mag geen persoonsgegeven meer bevatten.
  const na = await scanBestand(pad, {}, { zonderAi: true });
  assert.ok(['geen', 'laag'].includes(na.oordeel), `geschoonde tekst kreeg ${na.oordeel}`);
});

// ---------- Rapport ----------

test('rapporten maskeren waarden tenzij dat expliciet uit staat', async () => {
  const p = await schrijf('rapportje.txt', 'BSN 111222333');
  const r = await scanBestand(p, {}, { zonderAi: true });
  const s = samenvatten([r], 'middel');

  const gemaskeerd = JSON.stringify(naarJson([r], s));
  assert.ok(!gemaskeerd.includes('111222333'));
  const volledig = JSON.stringify(naarJson([r], s, { toonWaarden: true }));
  assert.ok(volledig.includes('111222333'));

  const html = naarHtml([r], s);
  assert.ok(!html.includes('111222333'));
  assert.match(html, /<!doctype html>/i);
});

// ---------- Web-app ----------

test('de web-app scant een geüpload bestand en luistert alleen lokaal', async () => {
  const { server: model, endpoint } = await stubModel({ antwoord: '{"bevindingen":[],"samenvatting":"leeg"}' });
  const { server, url } = await startServer(
    { endpoint, model: 'test-model-7b', drempel: 'middel', stukGrootte: 6000, maxStukken: 10 },
    { poort: 0 }
  );
  try {
    assert.equal(server.address().address, '127.0.0.1', 'mag niet op alle interfaces luisteren');

    const pagina = await (await fetch(url + '/')).text();
    assert.match(pagina, /Privacyscan vóór upload/);

    const res = await fetch(url + '/api/scan', {
      method: 'POST',
      headers: { 'X-Bestandsnaam': encodeURIComponent('leerlingen.csv'), 'X-Zonder-Ai': '1' },
      body: 'naam;bsn\nJan;111222333\n'
    });
    const r = await res.json();
    assert.equal(r.naam, 'leerlingen.csv');
    assert.equal(r.oordeel, 'hoog');
    assert.ok(r.bevindingen.some(b => b.type === 'bsn'));
    assert.ok(!JSON.stringify(r).includes(os.tmpdir() + path.sep + 'glu-scan-'), 'geen tijdelijk pad lekken');

    const sam = await (await fetch(url + '/api/samenvatting', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultaten: [r] })
    })).json();
    assert.equal(sam.hoogsteOordeel, 'hoog');
  } finally {
    server.close(); model.close();
  }
});

test.after(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });
