// De scan zelf: bestand → tekst → patronen + lokale AI → oordeel.
//
// Twee lagen die elkaar aanvullen:
//  1. patronen  — snel, exact, geen model nodig (BSN met 11-proef, IBAN, …);
//  2. lokale AI — namen, adressen, gezondheids- en andere art. 9-gegevens die
//     je met reguliere expressies nooit betrouwbaar vindt.
// Zonder bereikbaar model blijft laag 1 gewoon werken; het rapport vermeldt
// dan dat de scan beperkt was.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { haalTekst, inStukken, soortVan, AFBEELDING_EXTS } from './extract.js';
import { zoekPatronen, maskeer, ERNST_RANG } from './patronen.js';
import { analyseerTekst, analyseerAfbeelding } from './llm.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };

// Types die een persoon aanwijzen. Zonder één daarvan is "diagnose ADHD" een
// onderwerp, geen persoonsgegeven — een handleiding over ADHD hoort geen
// hoog risico te krijgen.
const IDENTIFICEREND = new Set([
  'bsn', 'email', 'telefoon', 'postcode', 'geboortedatum', 'paspoortnummer',
  'big', 'leerlingnummer', 'iban', 'betaalkaart', 'digid', 'kenteken',
  'naam', 'adres', 'contact', 'identificatie'
]);

/**
 * Weegt de bijzondere categorieën (art. 9 AVG) tegen de rest van het document.
 * Alleen als er iemand identificeerbaar is, is een gevoelig onderwerp ook een
 * gevoelig persoonsgegeven.
 */
function weegBijzondere(bevindingen) {
  const iemandHerkenbaar = bevindingen.some(b => IDENTIFICEREND.has(b.type));
  if (iemandHerkenbaar) return bevindingen;
  return bevindingen.map(b => (b.signaal && b.categorie === 'bijzonder')
    ? {
      ...b,
      ernst: 'laag',
      label: `${b.label} (onderwerp)`,
      avg: 'Gevoelig onderwerp, maar er is niemand identificeerbaar in dit bestand. Let op combinaties met andere bronnen.'
    }
    : b);
}

function ontdubbel(bevindingen) {
  const gezien = new Map();
  for (const b of bevindingen) {
    // Trefwoordsignalen (art. 9 AVG) horen per categorie één regel te zijn,
    // ook als ze zowel in de bestandsnaam als in de tekst voorkomen.
    const sleutel = b.signaal && b.termen
      ? `signaal:${b.type}`
      : `${b.type}:${String(b.waarde).toLowerCase().trim()}`;
    const bestaand = gezien.get(sleutel);
    if (!bestaand) { gezien.set(sleutel, { ...b, aantal: b.aantal || 1 }); continue; }
    if (b.termen && bestaand.termen) {
      const samen = [...new Set([...bestaand.termen, ...b.termen])];
      bestaand.termen = samen;
      bestaand.waarde = samen.join(', ');
      bestaand.gemaskeerd = bestaand.waarde;
      bestaand.aantal = samen.length;
      // De vindplaats in de tekst zegt meer dan die in de bestandsnaam.
      if (bestaand.inBestandsnaam && !b.inBestandsnaam) {
        bestaand.inBestandsnaam = false;
        bestaand.regel = b.regel;
        bestaand.context = b.context;
      }
      continue;
    }
    bestaand.aantal++;
    // Een patroontreffer weegt zwaarder dan een AI-vermoeden: die bron wint.
    if (bestaand.bron === 'ai' && b.bron === 'patroon') Object.assign(bestaand, b, { aantal: bestaand.aantal });
    if (ERNST_RANG[b.ernst] > ERNST_RANG[bestaand.ernst]) bestaand.ernst = b.ernst;
  }
  return [...gezien.values()].sort((a, b) => ERNST_RANG[b.ernst] - ERNST_RANG[a.ernst] || a.type.localeCompare(b.type));
}

export function oordeel(bevindingen, { leesbaar = true } = {}) {
  if (!leesbaar) return 'onbekend';
  let hoogste = 'geen';
  for (const b of bevindingen) if (ERNST_RANG[b.ernst] > ERNST_RANG[hoogste]) hoogste = b.ernst;
  return hoogste;
}

export const ADVIES = {
  geen: 'Geen persoonsgegevens gevonden — uploaden kan.',
  laag: 'Alleen licht identificerende gegevens — meestal geen bezwaar, controleer de bevindingen.',
  middel: 'Persoonsgegevens gevonden — verwijder of anonimiseer ze vóór het uploaden.',
  hoog: 'Gevoelige gegevens gevonden — niet uploaden zonder deze eerst te verwijderen.',
  onbekend: 'Dit bestand kon niet gelezen worden — controleer de inhoud handmatig.'
};

/**
 * Scant één bestand.
 * @param {string} bestand
 * @param {object} cfg      instellingen (endpoint, model, stukGrootte…)
 * @param {object} opties   { zonderAi, visie, opVoortgang }
 */
export async function scanBestand(bestand, cfg, opties = {}) {
  const { zonderAi = false, visie = false, opVoortgang = () => {}, naam: naamOverride = null } = opties;
  // naamOverride: bij de web-app staat het bestand onder een tijdelijke naam op
  // schijf, terwijl we de échte naam willen tonen en meescannen.
  const naam = naamOverride || path.basename(bestand);
  const start = Date.now();
  const waarschuwingen = [];

  const extract = await haalTekst(bestand, { maxBytes: cfg.maxBytes });
  if (extract.notitie) waarschuwingen.push(extract.notitie);
  if (extract.afgekapt) waarschuwingen.push('Bestand is groter dan de leeslimiet; alleen het eerste deel is gescand.');

  const bevindingen = [];
  let samenvatting = '';
  let aiGebruikt = false;

  // De bestandsnaam zelf lekt vaak al: "verzuim_jan_de_vries_BSN.pdf".
  for (const b of zoekPatronen(naam.replace(/[_\-.]/g, ' '))) {
    bevindingen.push({ ...b, inBestandsnaam: true, context: naam, regel: 0 });
  }

  const isAfbeelding = AFBEELDING_EXTS.has(path.extname(bestand).slice(1).toLowerCase());

  if (extract.tekst) {
    bevindingen.push(...zoekPatronen(extract.tekst, { opWaarschuwing: w => waarschuwingen.push(w) }));

    if (!zonderAi) {
      const alleStukken = inStukken(extract.tekst, cfg.stukGrootte);
      const stukken = alleStukken.slice(0, cfg.maxStukken);
      const totaal = alleStukken.length;
      if (totaal > stukken.length) {
        waarschuwingen.push(`Tekst opgeknipt in ${totaal} stukken; alleen de eerste ${stukken.length} zijn met AI beoordeeld (--max-stukken verhoogt dit).`);
      }
      const samenvattingen = [];
      for (const [i, stuk] of stukken.entries()) {
        opVoortgang({ fase: 'ai', stuk: i + 1, van: stukken.length, bestand: naam });
        try {
          const uit = await analyseerTekst(cfg, stuk.tekst, { bestandsnaam: naam });
          aiGebruikt = true;
          bevindingen.push(...uit.bevindingen.map(b => ({
            ...b,
            gemaskeerd: maskeer(b.waarde),
            categorie: 'ai',
            regel: null,
            context: b.toelichting
          })));
          if (uit.samenvatting) samenvattingen.push(uit.samenvatting);
        } catch (err) {
          waarschuwingen.push(`AI-analyse van deel ${i + 1}/${stukken.length} mislukt: ${err.message}`);
          break; // één kapotte verbinding betekent meestal: model weg
        }
      }
      samenvatting = samenvattingen[0] || '';
    }
  } else if (isAfbeelding && visie && !zonderAi) {
    opVoortgang({ fase: 'visie', bestand: naam });
    try {
      const ext = path.extname(bestand).slice(1).toLowerCase();
      const data = await fsp.readFile(bestand);
      const uit = await analyseerAfbeelding(cfg, data.toString('base64'), MIME[ext] || 'image/png', { bestandsnaam: naam });
      aiGebruikt = true;
      bevindingen.push(...uit.bevindingen.map(b => ({ ...b, gemaskeerd: maskeer(b.waarde), categorie: 'ai', regel: null, context: b.toelichting })));
      samenvatting = uit.samenvatting;
      extract.leesbaar = true;
    } catch (err) {
      waarschuwingen.push(`Visie-analyse mislukt: ${err.message}`);
    }
  }

  const uniek = weegBijzondere(ontdubbel(bevindingen));
  const verdict = oordeel(uniek, { leesbaar: extract.leesbaar || uniek.length > 0 });

  return {
    bestand,
    naam,
    bytes: extract.bytes,
    soort: extract.soort,
    leesbaar: extract.leesbaar,
    tekstLengte: extract.tekst.length,
    aiGebruikt,
    oordeel: verdict,
    advies: ADVIES[verdict],
    samenvatting,
    bevindingen: uniek,
    waarschuwingen,
    duurMs: Date.now() - start
  };
}

/** Vat de resultaten van meerdere bestanden samen. */
export function samenvatten(resultaten, drempel = 'middel') {
  const telling = { geen: 0, laag: 0, middel: 0, hoog: 0, onbekend: 0 };
  for (const r of resultaten) telling[r.oordeel]++;
  let hoogste = 'geen';
  for (const r of resultaten) {
    if (r.oordeel === 'onbekend') continue;
    if (ERNST_RANG[r.oordeel] > ERNST_RANG[hoogste]) hoogste = r.oordeel;
  }
  const geblokkeerd = resultaten.filter(r => r.oordeel !== 'onbekend' && ERNST_RANG[r.oordeel] >= ERNST_RANG[drempel]);
  // Onleesbare bestanden zijn geen schone bestanden: dat hoort in het advies te
  // staan, anders leest een groene uitslag als een garantie die het niet is.
  const staart = telling.onbekend
    ? ` ${telling.onbekend} bestand(en) kon de scanner niet lezen — controleer die zelf.`
    : '';

  return {
    bestanden: resultaten.length,
    telling,
    hoogsteOordeel: hoogste,
    drempel,
    geblokkeerd: geblokkeerd.map(r => r.naam),
    onleesbaar: resultaten.filter(r => r.oordeel === 'onbekend').map(r => r.naam),
    uploadAdvies: (geblokkeerd.length === 0
      ? 'Alle bestanden blijven onder de drempel — uploaden naar de GLU Analysetool kan.'
      : `${geblokkeerd.length} van ${resultaten.length} bestand(en) haalt de drempel "${drempel}" of hoger. Schoon die eerst op.`) + staart
  };
}

/** Vervangt gevonden waarden door labels; alleen zinvol voor tekstbestanden. */
export async function redigeer(bestand, resultaat, { achtervoegsel = '.geschoond' } = {}) {
  const soort = soortVan(bestand);
  if (soort !== 'tekst') {
    throw new Error(`redigeren kan alleen bij platte tekst (dit is: ${soort})`);
  }
  let tekst = await fsp.readFile(bestand, 'utf8');
  let vervangen = 0;
  // Langste waarden eerst, anders knipt een korte match een langere doormidden.
  const waarden = [...new Set(resultaat.bevindingen
    // Trefwoorden van bijzondere categorieën zijn onderwerpen, geen waarden:
    // die blijven staan, anders wordt de tekst onleesbaar zonder dat er iets
    // veiliger wordt. Namen en nummers worden wél vervangen.
    .filter(b => !b.inBestandsnaam && b.categorie !== 'bijzonder' && b.waarde && String(b.waarde).length >= 3)
    .map(b => [String(b.waarde), b.type]))]
    .sort((a, b) => b[0].length - a[0].length);

  for (const [waarde, type] of waarden) {
    const deel = waarde.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(deel, 'g');
    tekst = tekst.replace(re, () => { vervangen++; return `[GEREDIGEERD:${type}]`; });
  }
  const ext = path.extname(bestand);
  const uit = path.join(path.dirname(bestand), path.basename(bestand, ext) + achtervoegsel + ext);
  await fsp.writeFile(uit, tekst);
  return { pad: uit, vervangen };
}
