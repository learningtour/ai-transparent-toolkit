// Praten met een lokaal taalmodel — LM Studio, Ollama, llama.cpp of elke
// andere server met een OpenAI-compatibel /v1/chat/completions-endpoint.
//
// Harde regel: het endpoint moet op deze machine draaien. De hele reden van
// deze satelliet is dat mogelijk gevoelige bestanden nergens heen gaan.
// Wie bewust een andere host wil gebruiken, moet dat expliciet zeggen
// (--sta-extern) en krijgt een waarschuwing.

const LOKALE_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'host.docker.internal']);

export function isLokaal(endpoint) {
  try {
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
    return LOKALE_HOSTS.has(host) || host.endsWith('.local') || /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
  } catch {
    return false;
  }
}

async function haal(url, opties = {}, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opties, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Controleert of de lokale server draait en geeft de beschikbare modellen. */
export async function modellen(endpoint, { timeoutMs = 8000 } = {}) {
  const res = await haal(endpoint.replace(/\/$/, '') + '/models', {}, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} van ${endpoint}/models`);
  const data = await res.json();
  return (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
}

export function uitlegGeenServer(endpoint, { viaApp = false } = {}) {
  const slot = viaApp
    ? ['  Het venster werkt gewoon zonder model: je krijgt dan de',
       '  patrooncontrole (BSN, IBAN, e-mail, telefoon, wachtwoorden…).']
    : ['  Zonder model werkt de scan ook: `glu-scan scan <bestand> --zonder-ai`',
       '  doet dan alleen de patrooncontrole (BSN, IBAN, e-mail, telefoon…).'];
  return [
    `Geen lokaal model bereikbaar op ${endpoint}.`,
    '',
    '  LM Studio : tabblad "Developer" → Status "Running" (poort 1234),',
    '              laad een model en zet "Serve on local network" niet aan.',
    '  Ollama    : `ollama serve` draait al; gebruik',
    '              --endpoint http://localhost:11434/v1 --model llama3.1',
    '',
    ...slot
  ].join('\n');
}

const SYSTEEM = `Je bent een privacy-analist die documenten controleert vóór ze geüpload worden naar een analysetool.
Je zoekt persoonsgegevens volgens de AVG (GDPR) in Nederlandse en Engelse tekst.

Meld:
- direct identificerende gegevens: namen van personen, adressen, e-mailadressen, telefoonnummers, BSN, klant-, leerling- of personeelsnummers;
- indirect identificerende combinaties: functie + afdeling + geboortejaar, kleine groepen waarin iemand herkenbaar wordt;
- bijzondere categorieën (art. 9 AVG): gezondheid, etniciteit of afkomst, religie, politieke opvatting, vakbondslidmaatschap, seksuele geaardheid, biometrie, strafrechtelijke gegevens;
- vertrouwelijke bedrijfsgegevens en inloggegevens.

Meld NIET: namen van organisaties, publieke functienamen zonder persoon, algemene voorbeelden, verzonnen namen die duidelijk als voorbeeld zijn bedoeld, auteursnamen van openbaar gepubliceerde bronnen.

Antwoord uitsluitend met JSON, zonder uitleg eromheen:
{"bevindingen":[{"type":"naam|adres|contact|identificatie|gezondheid|etniciteit|religie|politiek|seksueel|strafrechtelijk|biometrie|financieel|vertrouwelijk","label":"korte omschrijving in het Nederlands","ernst":"laag|middel|hoog","fragment":"het letterlijke tekstfragment uit het document, maximaal 80 tekens","toelichting":"waarom dit een risico is, één zin","zekerheid":"laag|middel|hoog"}],"samenvatting":"één zin over wat er in dit fragment staat"}

Vind je niets, antwoord dan: {"bevindingen":[],"samenvatting":"geen persoonsgegevens aangetroffen"}
Verzin nooit fragmenten die niet letterlijk in de tekst staan.`;

function pakJson(inhoud) {
  if (!inhoud) return null;
  let s = inhoud.trim();
  // Modellen zetten er graag ```json omheen, of denken hardop in <think>.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const eind = s.lastIndexOf('}');
  if (start === -1 || eind <= start) return null;
  try {
    return JSON.parse(s.slice(start, eind + 1));
  } catch {
    return null;
  }
}

const ERNSTEN = new Set(['laag', 'middel', 'hoog']);

function normaliseer(data, bronTekst) {
  const uit = [];
  for (const b of (data?.bevindingen || []).slice(0, 40)) {
    const fragment = String(b.fragment ?? '').trim().slice(0, 200);
    if (!fragment) continue;
    // Hallucinatiefilter: het fragment moet echt in de tekst staan.
    const letterlijk = bronTekst.includes(fragment);
    const genormaliseerd = !letterlijk &&
      bronTekst.replace(/\s+/g, ' ').includes(fragment.replace(/\s+/g, ' '));
    if (!letterlijk && !genormaliseerd) continue;
    uit.push({
      type: String(b.type || 'onbekend').toLowerCase().slice(0, 30),
      label: String(b.label || 'Persoonsgegeven').slice(0, 120),
      ernst: ERNSTEN.has(String(b.ernst).toLowerCase()) ? String(b.ernst).toLowerCase() : 'middel',
      zekerheid: ERNSTEN.has(String(b.zekerheid).toLowerCase()) ? String(b.zekerheid).toLowerCase() : 'middel',
      waarde: fragment,
      toelichting: String(b.toelichting || '').slice(0, 300),
      bron: 'ai'
    });
  }
  return { bevindingen: uit, samenvatting: String(data?.samenvatting || '').slice(0, 400) };
}

async function chat(cfg, berichten, { timeoutMs, jsonModus = true } = {}) {
  const body = {
    model: cfg.model,
    messages: berichten,
    temperature: 0,
    max_tokens: cfg.maxTokens ?? 1200,
    stream: false
  };
  if (jsonModus) body.response_format = { type: 'json_object' };

  const res = await haal(cfg.endpoint.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify(body)
  }, timeoutMs ?? cfg.timeoutMs ?? 180000);

  if (!res.ok) {
    const tekst = await res.text().catch(() => '');
    // Niet elke lokale server kent response_format; dan zonder proberen.
    if (jsonModus && (res.status === 400 || res.status === 422)) {
      return chat(cfg, berichten, { timeoutMs, jsonModus: false });
    }
    throw new Error(`HTTP ${res.status}${tekst ? ' — ' + tekst.slice(0, 200) : ''}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/** Analyseert één stuk tekst met het lokale model. */
export async function analyseerTekst(cfg, tekst, { bestandsnaam = '' } = {}) {
  const inhoud = await chat(cfg, [
    { role: 'system', content: SYSTEEM },
    { role: 'user', content: `Bestand: ${bestandsnaam || 'onbekend'}\n\nTekst om te controleren:\n"""\n${tekst}\n"""` }
  ]);
  const data = pakJson(inhoud);
  if (!data) throw new Error('het model gaf geen bruikbare JSON terug');
  return normaliseer(data, tekst);
}

/** Analyseert een afbeelding met een visiemodel (LM Studio: bv. qwen2-vl, llava). */
export async function analyseerAfbeelding(cfg, base64, mime, { bestandsnaam = '' } = {}) {
  const inhoud = await chat({ ...cfg, model: cfg.visionModel || cfg.model }, [
    { role: 'system', content: SYSTEEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Afbeelding: ${bestandsnaam}. Lees alle zichtbare tekst en beoordeel of er persoonsgegevens in staan. Neem in "fragment" de letterlijk zichtbare tekst op. Meld ook herkenbare gezichten als type "biometrie".` },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
      ]
    }
  ]);
  const data = pakJson(inhoud);
  if (!data) throw new Error('het visiemodel gaf geen bruikbare JSON terug');
  // Bij beeld is er geen brontekst om fragmenten tegen te controleren; daarom
  // krijgt een visiebevinding standaard zekerheid "laag".
  return {
    samenvatting: String(data.samenvatting || '').slice(0, 400),
    bevindingen: (data.bevindingen || []).slice(0, 25).map(b => ({
      type: String(b.type || 'onbekend').toLowerCase().slice(0, 30),
      label: String(b.label || 'Persoonsgegeven in beeld').slice(0, 120),
      ernst: ERNSTEN.has(String(b.ernst).toLowerCase()) ? String(b.ernst).toLowerCase() : 'middel',
      zekerheid: ERNSTEN.has(String(b.zekerheid).toLowerCase()) ? String(b.zekerheid).toLowerCase() : 'laag',
      waarde: String(b.fragment ?? '').slice(0, 200) || '(zichtbaar in beeld)',
      toelichting: String(b.toelichting || '').slice(0, 300),
      bron: 'ai-visie'
    }))
  };
}
