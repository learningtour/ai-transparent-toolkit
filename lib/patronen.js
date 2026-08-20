// Deterministische detectie van persoonsgegevens in tekst.
//
// Alles hier draait lokaal en zonder AI: reguliere expressies plus echte
// validatie (11-proef voor BSN, mod-97 voor IBAN, Luhn voor betaalkaarten).
// De lokale AI-pass (lib/llm.js) vult aan waar patronen tekortschieten:
// namen, gezondheidsgegevens, religie, etniciteit — de bijzondere
// categorieën uit artikel 9 AVG.

// ---------- Validators ----------

// Elfproef voor het burgerservicenummer: 9*d1 + 8*d2 … 2*d8 − d9 ≡ 0 (mod 11).
export function geldigBsn(s) {
  const d = s.replace(/\D/g, '');
  if (d.length !== 9) return false;
  if (/^(\d)\1{8}$/.test(d)) return false; // 000000000, 111111111 … zijn testwaarden
  let som = 0;
  for (let i = 0; i < 8; i++) som += (9 - i) * Number(d[i]);
  som -= Number(d[8]);
  return som % 11 === 0;
}

// IBAN-controle volgens ISO 13616 (mod-97 == 1).
export function geldigIban(s) {
  const iban = s.replace(/[\s.-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const herschikt = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of herschikt) {
    const waarde = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const cijfer of waarde) rest = (rest * 10 + Number(cijfer)) % 97;
  }
  return rest === 1;
}

// Luhn-controle voor betaalkaartnummers.
export function geldigLuhn(s) {
  const d = s.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  if (/^(\d)\1+$/.test(d)) return false;
  let som = 0, dubbel = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dubbel) { n *= 2; if (n > 9) n -= 9; }
    som += n;
    dubbel = !dubbel;
  }
  return som % 10 === 0;
}

// ---------- Detectors ----------
//
// ernst:      hoog | middel | laag
// categorie:  identificatie | contact | financieel | bijzonder | technisch | geheim
// avg:        korte juridische duiding voor het rapport

const DETECTORS = [
  {
    type: 'bsn',
    label: 'Burgerservicenummer',
    ernst: 'hoog',
    categorie: 'identificatie',
    avg: 'Nationaal identificatienummer — art. 87 AVG / art. 46 UAVG: alleen bij wettelijke grondslag.',
    // Niet ingebed in een langere cijferreeks, maar wél herkend aan het eind van
    // een zin: een punt telt alleen mee als er weer een cijfer op volgt.
    regex: /(?<!\d)(?<!\d[ .-])(\d{9}|\d{3}[ .-]\d{3}[ .-]\d{3})(?!\d)(?![ .-]\d)/g,
    valideer: m => geldigBsn(m)
  },
  {
    type: 'iban',
    label: 'Bankrekeningnummer (IBAN)',
    ernst: 'middel',
    categorie: 'financieel',
    avg: 'Financieel persoonsgegeven — art. 4 lid 1 AVG.',
    regex: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g,
    valideer: m => geldigIban(m)
  },
  {
    type: 'betaalkaart',
    label: 'Betaalkaartnummer',
    ernst: 'hoog',
    categorie: 'financieel',
    avg: 'Betaalgegeven — hoort niet in analysemateriaal (PCI-DSS, art. 32 AVG).',
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    valideer: m => geldigLuhn(m)
  },
  {
    type: 'email',
    label: 'E-mailadres',
    ernst: 'middel',
    categorie: 'contact',
    avg: 'Direct identificerend contactgegeven — art. 4 lid 1 AVG.',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
    // Voorbeeld- en systeemadressen leveren geen risico op.
    valideer: m => !/@(?:example\.(?:com|org|net)|test\.|localhost|domein\.nl|voorbeeld\.nl)/i.test(m)
  },
  {
    type: 'telefoon',
    label: 'Telefoonnummer',
    ernst: 'middel',
    categorie: 'contact',
    avg: 'Direct identificerend contactgegeven — art. 4 lid 1 AVG.',
    regex: /(?<!\w)(?<!\d\.)(?:(?:\+31|0031)[ -]?\(?0?\)?[ -]?[1-9](?:[ -]?\d){8}|0[1-9](?:[ -]?\d){8})(?!\w)(?!\.\d)/g,
    valideer: m => m.replace(/\D/g, '').length >= 9
  },
  {
    type: 'postcode',
    label: 'Postcode (NL)',
    ernst: 'middel',
    categorie: 'contact',
    avg: 'Met huisnummer herleidbaar tot één adres — art. 4 lid 1 AVG.',
    regex: /\b[1-9]\d{3}[ ]?[A-Za-z]{2}\b/g,
    valideer: m => /[A-Za-z]{2}$/.test(m.trim())
  },
  {
    type: 'geboortedatum',
    label: 'Geboortedatum',
    ernst: 'middel',
    categorie: 'identificatie',
    avg: 'In combinatie met een naam direct identificerend — art. 4 lid 1 AVG.',
    regex: /\b(?:(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:19|20)\d{2}|(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/g,
    // Alleen tellen als er contextwoorden in de buurt staan; losse datums zijn ruis.
    contextVereist: /\b(geb(?:oren|\.|oortedatum)?|geboortejaar|dob|birth|leeftijd|geboren\s+op)\b/i
  },
  {
    type: 'paspoortnummer',
    label: 'Paspoort- of ID-kaartnummer',
    ernst: 'hoog',
    categorie: 'identificatie',
    avg: 'Identiteitsdocument — kopie of nummer vrijwel nooit nodig voor analyse.',
    regex: /\b[A-Z]{2}[A-Z0-9]{6}\d\b/g,
    contextVereist: /\b(paspoort|passport|id-?kaart|identiteitsbewijs|documentnummer|rijbewijs)\b/i
  },
  {
    type: 'big',
    label: 'BIG-nummer (zorgverlener)',
    ernst: 'middel',
    categorie: 'identificatie',
    avg: 'Beroepsregistratienummer, herleidbaar tot één persoon.',
    regex: /\b\d{11}\b/g,
    contextVereist: /\bbig[- ]?(nummer|nr|registratie)?\b/i
  },
  {
    type: 'leerlingnummer',
    label: 'Leerling-, student- of medewerkernummer',
    ernst: 'middel',
    categorie: 'identificatie',
    avg: 'Pseudo-identificator: binnen de organisatie herleidbaar tot één persoon.',
    regex: /\b\d{6,10}\b/g,
    contextVereist: /\b(leerling|student|deelnemer|cursist|medewerker|personeels|dossier|pgn|onderwijsnummer)[- ]?(nummer|nr|id)\b/i
  },
  {
    type: 'kenteken',
    label: 'Kenteken',
    ernst: 'laag',
    categorie: 'identificatie',
    avg: 'Indirect identificerend via het RDW-register.',
    regex: /\b(?:[A-Z]{2}-\d{2}-\d{2}|\d{2}-[A-Z]{2}-\d{2}|\d{2}-\d{2}-[A-Z]{2}|[A-Z]{2}-\d{2}-[A-Z]{2}|[A-Z]{2}-[A-Z]{2}-\d{2}|\d{2}-[A-Z]{2}-[A-Z]{2}|\d{2}-[A-Z]{3}-\d|\d-[A-Z]{3}-\d{2}|[A-Z]{2}-\d{3}-[A-Z]|[A-Z]-\d{3}-[A-Z]{2})\b/g
  },
  {
    type: 'ipadres',
    label: 'IP-adres',
    ernst: 'laag',
    categorie: 'technisch',
    avg: 'Online identificator — art. 4 lid 1 AVG (HvJ EU, Breyer).',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    valideer: m => !/^(?:0\.|127\.|255\.255|10\.0\.0\.1$)/.test(m) && m !== '1.1.1.1'
  },
  {
    type: 'geheim',
    label: 'Wachtwoord, sleutel of token',
    ernst: 'hoog',
    categorie: 'geheim',
    avg: 'Geen persoonsgegeven, wél een direct beveiligingsrisico — art. 32 AVG.',
    regex: /(?:\b(?:wachtwoord|password|passwd|pwd|geheim|secret|api[_-]?key|token|bearer)\b\s*[:=]\s*\S{4,}|\bsk-[A-Za-z0-9]{16,}|\bghp_[A-Za-z0-9]{20,}|\batk_[A-Za-z0-9]{16,}|\bAKIA[A-Z0-9]{16}\b)/gi
  },
  {
    type: 'digid',
    label: 'DigiD-gegevens',
    ernst: 'hoog',
    categorie: 'geheim',
    avg: 'Inloggegevens van de overheid — nooit delen.',
    regex: /\bdigid\b[^\n]{0,40}?(?:gebruikersnaam|wachtwoord|code|inlog)/gi
  }
];

// Trefwoorden voor de bijzondere categorieën van artikel 9 AVG. Een treffer is
// een signaal, geen bewijs: de lokale AI beoordeelt of het écht om een persoon
// gaat. Zonder AI blijven ze als "let op" in het rapport staan.
const BIJZONDER = [
  {
    type: 'gezondheid',
    label: 'Gezondheidsgegevens',
    woorden: /\b(diagnose|ziektebeeld|medicatie|medicijn(?:en)?|recept|huisarts|specialist|psycholoog|psychiater|therapie|behandelplan|ggz|autisme|adhd|add|dyslexie|dyscalculie|depressie|burn-?out|zwanger(?:schap)?|ziekmelding|ziekteverzuim|verzuimdossier|arbo(?:arts|dienst)|revalidatie|allergie|diabetes|kanker|epilepsie|handicap|beperking|rolstoel|bsn-?zorg)\b/gi
  },
  {
    type: 'etniciteit',
    label: 'Etniciteit, ras of nationaliteit',
    woorden: /\b(etniciteit|afkomst|ras|nationaliteit|migratieachtergrond|allochtoon|autochtoon|asielzoeker|vluchteling|statushouder|geboorteland|moedertaal|inburgering)\b/gi
  },
  {
    type: 'religie',
    label: 'Religieuze of levensbeschouwelijke overtuiging',
    woorden: /\b(religie|geloof(?:sovertuiging)?|kerk(?:elijk|genootschap)?|moskee|synagoge|islamitisch|christelijk|katholiek|protestants|joods|hindoe|boeddhis(?:t|tisch)|atheïst|levensbeschouwing|ramadan|gebedsruimte)\b/gi
  },
  {
    type: 'politiek',
    label: 'Politieke opvatting of vakbondslidmaatschap',
    woorden: /\b(politieke (?:voorkeur|partij|opvatting)|stemgedrag|vakbond(?:slidmaatschap)?|fnv|cnv|aob|ondernemingsraad|stakingsactie)\b/gi
  },
  {
    type: 'seksueel',
    label: 'Seksuele geaardheid of seksleven',
    woorden: /\b(seksuele (?:geaardheid|voorkeur|oriëntatie)|homoseksueel|lesbisch|biseksueel|transgender|non-?binair|lhbti\+?|coming-?out|genderidentiteit)\b/gi
  },
  {
    type: 'strafrechtelijk',
    label: 'Strafrechtelijke gegevens',
    woorden: /\b(strafblad|justitieel|veroordeling|verdachte|aangifte|politierapport|proces-?verbaal|reclassering|detentie|taakstraf|vog|boeteclausule|schorsing wegens)\b/gi
  },
  {
    type: 'biometrie',
    label: 'Biometrische gegevens',
    woorden: /\b(vingerafdruk|irisscan|gezichtsherkenning|stemafdruk|biometri(?:e|sch)|dna-?profiel)\b/gi
  }
];

// Namen zijn met patronen niet betrouwbaar te vinden. Dit is bewust een grove
// heuristiek (voornaam + Nederlands tussenvoegsel + achternaam); de lokale AI
// doet het echte werk.
const NAAM_HEURISTIEK =
  /\b[A-Z][a-zà-ÿ]{2,}(?:\s+(?:van der|van den|van de|van 't|van|de|den|der|ter|te|op de|in 't|'t|el|al|bin|ben|di|da|dos|von|le|la))?\s+[A-Z][a-zà-ÿ]{2,}\b/g;

const NAAM_CONTEXT = /\b(naam|dhr|mevr|mw|heer|mevrouw|geachte|beste|ondergetekende|leerling|student|deelnemer|medewerker|docent|cli[eë]nt|patiënt|contactpersoon|t\.a\.v\.)\b/i;

// ---------- Uitvoering ----------

// Regelnummers: de nieuweregel-posities één keer opzoeken en daarna binair
// zoeken. Per bevinding opnieuw door de tekst lopen wordt bij een csv van een
// paar megabyte al pijnlijk traag.
function maakRegelIndex(tekst) {
  const posities = [];
  for (let i = tekst.indexOf('\n'); i !== -1; i = tekst.indexOf('\n', i + 1)) posities.push(i);
  return posities;
}

function regelVan(index, regelIndex) {
  let laag = 0, hoog = regelIndex.length;
  while (laag < hoog) {
    const mid = (laag + hoog) >> 1;
    if (regelIndex[mid] < index) laag = mid + 1;
    else hoog = mid;
  }
  return laag + 1;
}

function contextRond(tekst, index, lengte, marge = 70) {
  const start = Math.max(0, index - marge);
  const eind = Math.min(tekst.length, index + lengte + marge);
  return (start > 0 ? '…' : '') + tekst.slice(start, eind).replace(/\s+/g, ' ').trim() + (eind < tekst.length ? '…' : '');
}

// Maskeert een waarde zodat het rapport zelf geen nieuw lek wordt.
export function maskeer(waarde) {
  const s = String(waarde);
  if (s.includes('@')) {
    const [lokaal, domein] = s.split('@');
    return lokaal.slice(0, 2) + '•'.repeat(Math.max(3, lokaal.length - 2)) + '@' + domein;
  }
  if (s.length <= 4) return '•'.repeat(s.length);
  return s.slice(0, 2) + '•'.repeat(Math.max(3, s.length - 4)) + s.slice(-2);
}

export const ERNST_RANG = { geen: 0, laag: 1, middel: 2, hoog: 3 };

/**
 * Doorzoekt tekst op persoonsgegevens met patronen en validatie.
 * @returns {Array} bevindingen, ontdubbeld per type + waarde
 */
export function zoekPatronen(tekst, { maxPerType = 25, opWaarschuwing = null } = {}) {
  if (!tekst) return [];
  const bevindingen = [];
  const gezien = new Set();
  const regelIndex = maakRegelIndex(tekst);
  const overgeslagen = new Map(); // label → hoeveel unieke treffers buiten het rapport vielen
  const perType = new Map();

  const voegToe = (d, waarde, index, extra = {}) => {
    const sleutel = `${d.type}:${waarde.toLowerCase()}`;
    if (gezien.has(sleutel)) return;
    gezien.add(sleutel);
    const aantalVanType = perType.get(d.type) || 0;
    if (aantalVanType >= maxPerType) {
      // Niet stilzwijgend afkappen: een lijst met duizend e-mailadressen mag
      // niet lezen als "25 gevonden".
      overgeslagen.set(d.label, (overgeslagen.get(d.label) || 0) + 1);
      return;
    }
    perType.set(d.type, aantalVanType + 1);
    bevindingen.push({
      type: d.type,
      label: d.label,
      ernst: d.ernst,
      categorie: d.categorie,
      avg: d.avg,
      waarde,
      gemaskeerd: maskeer(waarde),
      regel: regelVan(index, regelIndex),
      context: contextRond(tekst, index, waarde.length),
      bron: 'patroon',
      ...extra
    });
  };

  for (const d of DETECTORS) {
    d.regex.lastIndex = 0;
    let m;
    while ((m = d.regex.exec(tekst)) !== null) {
      const waarde = m[0].trim();
      if (d.valideer && !d.valideer(waarde)) continue;
      if (d.contextVereist) {
        const omgeving = tekst.slice(Math.max(0, m.index - 120), m.index + waarde.length + 120);
        if (!d.contextVereist.test(omgeving)) continue;
      }
      voegToe(d, waarde, m.index);
    }
  }

  // Bijzondere categorieën (art. 9 AVG). Losse trefwoorden zijn geen
  // persoonsgegeven op zichzelf; ze wijzen op een onderwerp. Daarom één
  // bevinding per categorie, met de aangetroffen termen erbij — anders staat
  // het rapport vol met tien keer "gezondheidsgegevens".
  for (const b of BIJZONDER) {
    b.woorden.lastIndex = 0;
    const termen = new Map();
    let m;
    while ((m = b.woorden.exec(tekst)) !== null) {
      const term = m[0].toLowerCase();
      if (!termen.has(term)) termen.set(term, m.index);
      if (termen.size >= 10) break;
    }
    if (termen.size === 0) continue;
    const eerste = Math.min(...termen.values());
    const lijst = [...termen.keys()];
    bevindingen.push({
      type: b.type,
      label: b.label,
      ernst: 'hoog',
      categorie: 'bijzonder',
      avg: 'Bijzondere categorie — art. 9 AVG: verwerking verboden, tenzij een uitzondering geldt.',
      waarde: lijst.join(', '),
      gemaskeerd: lijst.join(', '), // trefwoorden, geen waarden: niet maskeren
      regel: regelVan(eerste, regelIndex),
      context: contextRond(tekst, eerste, lijst[0].length),
      bron: 'patroon',
      signaal: true,
      termen: lijst,
      aantal: termen.size
    });
  }

  // Namen — alleen met context, want de heuristiek is grof.
  NAAM_HEURISTIEK.lastIndex = 0;
  let n, namen = 0;
  while ((n = NAAM_HEURISTIEK.exec(tekst)) !== null && namen < 15) {
    const omgeving = tekst.slice(Math.max(0, n.index - 100), n.index + n[0].length + 40);
    if (!NAAM_CONTEXT.test(omgeving)) continue;
    namen++;
    voegToe({
      type: 'naam',
      label: 'Mogelijke persoonsnaam',
      ernst: 'middel',
      categorie: 'identificatie',
      avg: 'Direct identificerend — art. 4 lid 1 AVG.'
    }, n[0], n.index, { signaal: true });
  }

  if (opWaarschuwing) {
    for (const [label, n] of overgeslagen) {
      opWaarschuwing(`${label}: nog ${n} andere unieke treffer(s) gevonden; alleen de eerste ${maxPerType} staan in het rapport.`);
    }
  }
  return schoonOp(bevindingen);
}

// Een BSN of telefoonnummer voldoet ook aan het patroon van een
// leerlingnummer. De specifieke treffer wint; de generieke verdwijnt.
const GENERIEK = new Set(['leerlingnummer', 'big', 'betaalkaart']);

function schoonOp(bevindingen) {
  const specifiekeCijfers = new Set();
  for (const b of bevindingen) {
    if (GENERIEK.has(b.type)) continue;
    const cijfers = String(b.waarde).replace(/\D/g, '');
    if (cijfers.length >= 6) specifiekeCijfers.add(cijfers);
  }
  return bevindingen.filter(b => {
    if (!GENERIEK.has(b.type)) return true;
    const cijfers = String(b.waarde).replace(/\D/g, '');
    for (const bekend of specifiekeCijfers) {
      if (bekend === cijfers || bekend.includes(cijfers) || cijfers.includes(bekend)) return false;
    }
    return true;
  });
}

export { DETECTORS, BIJZONDER };
