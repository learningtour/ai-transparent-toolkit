#!/usr/bin/env python3
"""glu-scan — privacyscan vóór upload naar de GLU Analysetool.

Controleert bestanden op persoonsgegevens vóórdat je ze uploadt. Alles draait
op deze computer: patronen met echte validatie (elfproef, mod-97, Luhn) plus
een lokaal taalmodel in LM Studio of Ollama. Er gaat niets naar internet.

Eén bestand, alleen de standaardbibliotheek van Python. Niets installeren.

    python3 glu_scan.py                    het venster openen (sleep bestanden erin)
    python3 glu_scan.py scan uploads/      vanaf de commandoregel
    python3 glu_scan.py scan map --zonder-ai --html rapport.html

Vereist Python 3.9 of nieuwer.

© LearningTour · MIT-licentie · Een scan is een hulpmiddel, geen garantie.
"""

import argparse
import html as _html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path

VERSIE = "1.0.0"
STANDAARD_ENDPOINT = "http://localhost:1234/v1"   # LM Studio
STANDAARD_POORT = 7817

# ---------------------------------------------------------------------------
# Kleur in de terminal
# ---------------------------------------------------------------------------

if sys.platform == "win32":
    os.system("")  # zet ANSI-kleuren aan in oudere Windows-vensters

_KLEUR_AAN = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _kleur(code):
    def toepassen(tekst):
        return f"\033[{code}m{tekst}\033[0m" if _KLEUR_AAN else str(tekst)
    return toepassen


vet = _kleur("1")
grijs = _kleur("2")
groen = _kleur("32")
geel = _kleur("33")
rood = _kleur("31")
blauw = _kleur("36")

ERNST_RANG = {"geen": 0, "laag": 1, "middel": 2, "hoog": 3}
KLEUR_VAN = {"geen": groen, "laag": blauw, "middel": geel, "hoog": rood, "onbekend": grijs}
TEKEN_VAN = {"geen": "✔", "laag": "•", "middel": "⚠", "hoog": "✘", "onbekend": "?"}


def stop(bericht, code=1):
    print(rood("✘ ") + bericht, file=sys.stderr)
    sys.exit(code)


def leesbare_omvang(bytes_):
    waarde = float(bytes_ or 0)
    for eenheid in ("B", "kB", "MB", "GB", "TB"):
        if waarde < 1000 or eenheid == "TB":
            return f"{waarde:.0f} {eenheid}" if eenheid == "B" or waarde >= 100 else f"{waarde:.1f} {eenheid}"
        waarde /= 1000
    return f"{waarde:.1f} TB"


# ---------------------------------------------------------------------------
# Validators — geen "lijkt op", maar echt narekenen
# ---------------------------------------------------------------------------

def geldig_bsn(waarde):
    """Elfproef: 9·d1 + 8·d2 … 2·d8 − d9 moet deelbaar zijn door 11."""
    cijfers = re.sub(r"\D", "", waarde)
    if len(cijfers) != 9 or len(set(cijfers)) == 1:
        return False
    som = sum((9 - i) * int(cijfers[i]) for i in range(8)) - int(cijfers[8])
    return som % 11 == 0


def geldig_iban(waarde):
    """ISO 13616: herschikken, letters naar cijfers, rest bij deling door 97 is 1."""
    iban = re.sub(r"[\s.\-]", "", waarde).upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{10,30}", iban):
        return False
    herschikt = iban[4:] + iban[:4]
    getal = "".join(ch if ch.isdigit() else str(ord(ch) - 55) for ch in herschikt)
    return int(getal) % 97 == 1


def geldig_luhn(waarde):
    cijfers = re.sub(r"\D", "", waarde)
    if not 13 <= len(cijfers) <= 19 or len(set(cijfers)) == 1:
        return False
    som, dubbel = 0, False
    for teken in reversed(cijfers):
        getal = int(teken)
        if dubbel:
            getal *= 2
            if getal > 9:
                getal -= 9
        som += getal
        dubbel = not dubbel
    return som % 10 == 0


# ---------------------------------------------------------------------------
# Detectors
# ---------------------------------------------------------------------------
#
# ernst      : hoog | middel | laag
# categorie  : identificatie | contact | financieel | technisch | geheim
# avg        : korte juridische duiding voor in het rapport
# valideer   : extra controle op de treffer
# context    : trefwoorden die in de buurt moeten staan, anders is het ruis

DETECTORS = [
    {
        "type": "bsn",
        "label": "Burgerservicenummer",
        "ernst": "hoog",
        "categorie": "identificatie",
        "avg": "Nationaal identificatienummer — art. 87 AVG / art. 46 UAVG: alleen bij wettelijke grondslag.",
        # Niet middenin een langere reeks, maar wél aan het eind van een zin.
        "regex": re.compile(r"(?<!\d)(?<!\d[ .\-])(\d{9}|\d{3}[ .\-]\d{3}[ .\-]\d{3})(?!\d)(?![ .\-]\d)"),
        "valideer": geldig_bsn,
    },
    {
        "type": "iban",
        "label": "Bankrekeningnummer (IBAN)",
        "ernst": "middel",
        "categorie": "financieel",
        "avg": "Financieel persoonsgegeven — art. 4 lid 1 AVG.",
        "regex": re.compile(r"\b[A-Z]{2}\d{2} ?(?:[A-Z0-9]{4} ?){2,7}[A-Z0-9]{1,4}\b"),
        "valideer": geldig_iban,
    },
    {
        "type": "betaalkaart",
        "label": "Betaalkaartnummer",
        "ernst": "hoog",
        "categorie": "financieel",
        "avg": "Betaalgegeven — hoort niet in analysemateriaal (art. 32 AVG, PCI-DSS).",
        "regex": re.compile(r"\b(?:\d[ \-]?){12,18}\d\b"),
        "valideer": geldig_luhn,
    },
    {
        "type": "email",
        "label": "E-mailadres",
        "ernst": "middel",
        "categorie": "contact",
        "avg": "Direct identificerend contactgegeven — art. 4 lid 1 AVG.",
        "regex": re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}\b"),
        # Voorbeeldadressen zijn geen persoonsgegeven.
        "valideer": lambda m: not re.search(
            r"@(?:example\.(?:com|org|net)|test\.|localhost|domein\.nl|voorbeeld\.nl)", m, re.I),
    },
    {
        "type": "telefoon",
        "label": "Telefoonnummer",
        "ernst": "middel",
        "categorie": "contact",
        "avg": "Direct identificerend contactgegeven — art. 4 lid 1 AVG.",
        "regex": re.compile(
            r"(?<!\w)(?<!\d\.)(?:(?:\+31|0031)[ \-]?\(?0?\)?[ \-]?[1-9](?:[ \-]?\d){8}"
            r"|0[1-9](?:[ \-]?\d){8})(?!\w)(?!\.\d)"),
        "valideer": lambda m: len(re.sub(r"\D", "", m)) >= 9,
    },
    {
        "type": "postcode",
        "label": "Postcode (NL)",
        "ernst": "middel",
        "categorie": "contact",
        "avg": "Met huisnummer herleidbaar tot één adres — art. 4 lid 1 AVG.",
        "regex": re.compile(r"\b[1-9]\d{3} ?[A-Za-z]{2}\b"),
    },
    {
        "type": "geboortedatum",
        "label": "Geboortedatum",
        "ernst": "middel",
        "categorie": "identificatie",
        "avg": "In combinatie met een naam direct identificerend — art. 4 lid 1 AVG.",
        "regex": re.compile(
            r"\b(?:(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:19|20)\d{2}"
            r"|(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b"),
        # Zonder contextwoord is een datum gewoon een datum.
        "context": re.compile(r"\b(geb(?:oren|\.|oortedatum)?|geboortejaar|dob|birth|leeftijd)\b", re.I),
    },
    {
        "type": "paspoortnummer",
        "label": "Paspoort- of ID-kaartnummer",
        "ernst": "hoog",
        "categorie": "identificatie",
        "avg": "Identiteitsdocument — nummer of kopie is vrijwel nooit nodig voor analyse.",
        "regex": re.compile(r"\b[A-Z]{2}[A-Z0-9]{6}\d\b"),
        "context": re.compile(r"\b(paspoort|passport|id-?kaart|identiteitsbewijs|documentnummer|rijbewijs)\b", re.I),
    },
    {
        "type": "big",
        "label": "BIG-nummer (zorgverlener)",
        "ernst": "middel",
        "categorie": "identificatie",
        "avg": "Beroepsregistratienummer, herleidbaar tot één persoon.",
        "regex": re.compile(r"\b\d{11}\b"),
        "context": re.compile(r"\bbig[- ]?(nummer|nr|registratie)?\b", re.I),
    },
    {
        "type": "leerlingnummer",
        "label": "Leerling-, student- of medewerkernummer",
        "ernst": "middel",
        "categorie": "identificatie",
        "avg": "Pseudo-identificator: binnen de organisatie herleidbaar tot één persoon.",
        "regex": re.compile(r"\b\d{6,10}\b"),
        "context": re.compile(
            r"\b(leerling|student|deelnemer|cursist|medewerker|personeels|dossier|pgn|onderwijs)"
            r"[- ]?(nummer|nr|id)\b", re.I),
    },
    {
        "type": "kenteken",
        "label": "Kenteken",
        "ernst": "laag",
        "categorie": "identificatie",
        "avg": "Indirect identificerend via het RDW-register.",
        "regex": re.compile(
            r"\b(?:[A-Z]{2}-\d{2}-\d{2}|\d{2}-[A-Z]{2}-\d{2}|\d{2}-\d{2}-[A-Z]{2}|[A-Z]{2}-\d{2}-[A-Z]{2}"
            r"|[A-Z]{2}-[A-Z]{2}-\d{2}|\d{2}-[A-Z]{2}-[A-Z]{2}|\d{2}-[A-Z]{3}-\d|\d-[A-Z]{3}-\d{2}"
            r"|[A-Z]{2}-\d{3}-[A-Z]|[A-Z]-\d{3}-[A-Z]{2})\b"),
    },
    {
        "type": "ipadres",
        "label": "IP-adres",
        "ernst": "laag",
        "categorie": "technisch",
        "avg": "Online identificator — art. 4 lid 1 AVG (HvJ EU, Breyer).",
        "regex": re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b"),
        "valideer": lambda m: not re.match(r"^(?:0\.|127\.|255\.255)", m) and m != "1.1.1.1",
    },
    {
        "type": "geheim",
        "label": "Wachtwoord, sleutel of token",
        "ernst": "hoog",
        "categorie": "geheim",
        "avg": "Geen persoonsgegeven, wél een direct beveiligingsrisico — art. 32 AVG.",
        "regex": re.compile(
            r"(?:\b(?:wachtwoord|password|passwd|pwd|geheim|secret|api[_-]?key|token|bearer)\b\s*[:=]\s*\S{4,}"
            r"|\bsk-[A-Za-z0-9]{16,}|\bghp_[A-Za-z0-9]{20,}|\batk_[A-Za-z0-9]{16,}|\bAKIA[A-Z0-9]{16}\b)", re.I),
    },
    {
        "type": "digid",
        "label": "DigiD-gegevens",
        "ernst": "hoog",
        "categorie": "geheim",
        "avg": "Inloggegevens van de overheid — nooit delen.",
        "regex": re.compile(r"\bdigid\b[^\n]{0,40}?(?:gebruikersnaam|wachtwoord|code|inlog)", re.I),
    },
]

# Trefwoorden voor de bijzondere categorieën van artikel 9 AVG. Een treffer is
# een signaal over het onderwerp, geen bewijs dat er een persoon in het spel is;
# zie weeg_bijzondere().
BIJZONDER = [
    ("gezondheid", "Gezondheidsgegevens", re.compile(
        r"\b(diagnose|ziektebeeld|medicatie|medicijn(?:en)?|recept|huisarts|specialist|psycholoog|psychiater"
        r"|therapie|behandelplan|ggz|autisme|adhd|add|dyslexie|dyscalculie|depressie|burn-?out|zwanger(?:schap)?"
        r"|ziekmelding|ziekteverzuim|verzuimdossier|arbo(?:arts|dienst)|revalidatie|allergie|diabetes|kanker"
        r"|epilepsie|handicap|beperking|rolstoel)\b", re.I)),
    ("etniciteit", "Etniciteit, ras of nationaliteit", re.compile(
        r"\b(etniciteit|afkomst|ras|nationaliteit|migratieachtergrond|allochtoon|autochtoon|asielzoeker"
        r"|vluchteling|statushouder|geboorteland|moedertaal|inburgering)\b", re.I)),
    ("religie", "Religieuze of levensbeschouwelijke overtuiging", re.compile(
        r"\b(religie|geloof(?:sovertuiging)?|kerk(?:elijk|genootschap)?|moskee|synagoge|islamitisch|christelijk"
        r"|katholiek|protestants|joods|hindoe|boeddhis(?:t|tisch)|athe[ïi]st|levensbeschouwing|ramadan"
        r"|gebedsruimte)\b", re.I)),
    ("politiek", "Politieke opvatting of vakbondslidmaatschap", re.compile(
        r"\b(politieke (?:voorkeur|partij|opvatting)|stemgedrag|vakbond(?:slidmaatschap)?|fnv|cnv|aob"
        r"|ondernemingsraad|stakingsactie)\b", re.I)),
    ("seksueel", "Seksuele geaardheid of seksleven", re.compile(
        r"\b(seksuele (?:geaardheid|voorkeur|ori[ëe]ntatie)|homoseksueel|lesbisch|biseksueel|transgender"
        r"|non-?binair|lhbti\+?|coming-?out|genderidentiteit)\b", re.I)),
    ("strafrechtelijk", "Strafrechtelijke gegevens", re.compile(
        r"\b(strafblad|justitieel|veroordeling|verdachte|aangifte|politierapport|proces-?verbaal|reclassering"
        r"|detentie|taakstraf|vog)\b", re.I)),
    ("biometrie", "Biometrische gegevens", re.compile(
        r"\b(vingerafdruk|irisscan|gezichtsherkenning|stemafdruk|biometri(?:e|sch)|dna-?profiel)\b", re.I)),
]

# Namen zijn met patronen niet betrouwbaar te vinden; dit is bewust een grove
# heuristiek die alleen met een contextwoord ernaast meetelt. Het echte werk
# doet het lokale model.
NAAM_HEURISTIEK = re.compile(
    r"\b[A-Z][a-zà-ÿ]{2,}(?:\s+(?:van der|van den|van de|van 't|van|de|den|der|ter|te|op de|in 't|'t"
    r"|el|al|bin|ben|di|da|dos|von|le|la))?\s+[A-Z][a-zà-ÿ]{2,}\b")
NAAM_CONTEXT = re.compile(
    r"\b(naam|dhr|mevr|mw|heer|mevrouw|geachte|beste|ondergetekende|leerling|student|deelnemer|medewerker"
    r"|docent|cli[eë]nt|pati[ëe]nt|contactpersoon|t\.a\.v\.)\b", re.I)

MAX_PER_SOORT = 25


def maskeer(waarde):
    """Verbergt het midden, zodat het rapport zelf geen nieuw lek wordt."""
    tekst = str(waarde)
    if "@" in tekst:
        lokaal, _, domein = tekst.partition("@")
        return lokaal[:2] + "•" * max(3, len(lokaal) - 2) + "@" + domein
    if len(tekst) <= 4:
        return "•" * len(tekst)
    return tekst[:2] + "•" * max(3, len(tekst) - 4) + tekst[-2:]


def _regelnummers(tekst):
    """Posities van alle regeleindes, zodat een regelnummer opzoeken snel is."""
    posities, start = [], tekst.find("\n")
    while start != -1:
        posities.append(start)
        start = tekst.find("\n", start + 1)
    return posities


def _regel_van(index, posities):
    import bisect
    return bisect.bisect_left(posities, index) + 1


def _context_rond(tekst, index, lengte, marge=70):
    start = max(0, index - marge)
    eind = min(len(tekst), index + lengte + marge)
    kern = re.sub(r"\s+", " ", tekst[start:eind]).strip()
    return ("…" if start > 0 else "") + kern + ("…" if eind < len(tekst) else "")


# Een BSN of telefoonnummer voldoet ook aan het patroon van een leerlingnummer.
# De specifieke treffer wint; de generieke verdwijnt.
GENERIEK = {"leerlingnummer", "big", "betaalkaart"}


def _weg_met_dubbele_nummers(bevindingen):
    specifiek = set()
    for b in bevindingen:
        if b["type"] not in GENERIEK:
            cijfers = re.sub(r"\D", "", str(b["waarde"]))
            if len(cijfers) >= 6:
                specifiek.add(cijfers)
    uit = []
    for b in bevindingen:
        if b["type"] in GENERIEK:
            cijfers = re.sub(r"\D", "", str(b["waarde"]))
            if any(bekend == cijfers or bekend in cijfers or cijfers in bekend for bekend in specifiek):
                continue
        uit.append(b)
    return uit


def zoek_patronen(tekst, waarschuw=None):
    """Doorzoekt tekst op persoonsgegevens. Geeft een lijst bevindingen terug."""
    if not tekst:
        return []

    bevindingen, gezien, per_soort, overgeslagen = [], set(), {}, {}
    posities = _regelnummers(tekst)

    def voeg_toe(soort, label, ernst, categorie, avg, waarde, index, **extra):
        sleutel = (soort, waarde.lower())
        if sleutel in gezien:
            return
        gezien.add(sleutel)
        aantal = per_soort.get(soort, 0)
        if aantal >= MAX_PER_SOORT:
            # Niet stilzwijgend afkappen: duizend adressen mogen niet lezen als 25.
            overgeslagen[label] = overgeslagen.get(label, 0) + 1
            return
        per_soort[soort] = aantal + 1
        bevinding = {
            "type": soort, "label": label, "ernst": ernst, "categorie": categorie, "avg": avg,
            "waarde": waarde, "gemaskeerd": maskeer(waarde),
            "regel": _regel_van(index, posities), "context": _context_rond(tekst, index, len(waarde)),
            "bron": "patroon", "aantal": 1,
        }
        bevinding.update(extra)
        bevindingen.append(bevinding)

    for d in DETECTORS:
        for treffer in d["regex"].finditer(tekst):
            waarde = treffer.group(0).strip()
            if d.get("valideer") and not d["valideer"](waarde):
                continue
            if d.get("context"):
                omgeving = tekst[max(0, treffer.start() - 120): treffer.end() + 120]
                if not d["context"].search(omgeving):
                    continue
            voeg_toe(d["type"], d["label"], d["ernst"], d["categorie"], d["avg"], waarde, treffer.start())

    # Bijzondere categorieën: één regel per soort, met de gevonden termen erbij.
    for soort, label, patroon in BIJZONDER:
        termen = {}
        for treffer in patroon.finditer(tekst):
            term = treffer.group(0).lower()
            termen.setdefault(term, treffer.start())
            if len(termen) >= 10:
                break
        if not termen:
            continue
        eerste = min(termen.values())
        lijst = list(termen)
        bevindingen.append({
            "type": soort, "label": label, "ernst": "hoog", "categorie": "bijzonder",
            "avg": "Bijzondere categorie — art. 9 AVG: verwerking verboden, tenzij een uitzondering geldt.",
            "waarde": ", ".join(lijst),
            "gemaskeerd": ", ".join(lijst),   # trefwoorden, geen waarden: niet maskeren
            "regel": _regel_van(eerste, posities), "context": _context_rond(tekst, eerste, len(lijst[0])),
            "bron": "patroon", "signaal": True, "termen": lijst, "aantal": len(lijst),
        })

    # Namen — alleen met een contextwoord in de buurt.
    gevonden_namen = 0
    for treffer in NAAM_HEURISTIEK.finditer(tekst):
        if gevonden_namen >= 15:
            break
        omgeving = tekst[max(0, treffer.start() - 100): treffer.end() + 40]
        if not NAAM_CONTEXT.search(omgeving):
            continue
        gevonden_namen += 1
        voeg_toe("naam", "Mogelijke persoonsnaam", "middel", "identificatie",
                 "Direct identificerend — art. 4 lid 1 AVG.", treffer.group(0), treffer.start(), signaal=True)

    if waarschuw:
        for label, aantal in overgeslagen.items():
            waarschuw(f"{label}: nog {aantal} andere unieke treffer(s) gevonden; "
                      f"alleen de eerste {MAX_PER_SOORT} staan in het rapport.")

    return _weg_met_dubbele_nummers(bevindingen)


# ---------------------------------------------------------------------------
# Tekst uit bestanden halen
# ---------------------------------------------------------------------------

TEKST_EXTS = {
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson", "xml", "yml", "yaml",
    "html", "htm", "srt", "vtt", "log", "ini", "cfg", "conf", "sql", "js", "mjs", "ts",
    "py", "php", "java", "cs", "rb", "go", "sh", "css", "tex", "rst", "eml", "vcf", "ics",
}
ZIP_EXTS = {"docx", "xlsx", "pptx", "odt", "ods", "odp"}
AFBEELDING_EXTS = {"png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "heic"}
MEDIA_EXTS = {"mp4", "mov", "mkv", "webm", "avi", "mp3", "wav", "m4a", "flac", "ogg"}

MAX_BYTES = 32 * 1024 * 1024

_ONDERDELEN = re.compile(
    r"^(?:word/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml"
    r"|xl/(?:sharedStrings\.xml|worksheets/sheet\d+\.xml|comments\d*\.xml)"
    r"|ppt/(?:slides/slide\d+\.xml|notesSlides/notesSlide\d+\.xml|comments/.*\.xml)"
    r"|(?:content|meta|styles)\.xml"
    r"|docProps/(?:core|app)\.xml)$")

_ENTITEITEN = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " "}


def _xml_naar_tekst(xml):
    tekst = re.sub(r"<w:tab\b[^>]*/?>", "\t", xml)
    tekst = re.sub(r"<(?:w:br|w:cr)\b[^>]*/?>", "\n", tekst)
    tekst = re.sub(r"</(?:w:p|a:p|text:p|text:h)>", "\n", tekst)
    tekst = re.sub(r"</(?:w:tc|a:tc)>", "\t", tekst)
    tekst = re.sub(r"</(?:w:tr|a:tr|table:table-row)>", "\n", tekst)
    tekst = re.sub(r"</(?:si|c)>", "\n", tekst)
    tekst = re.sub(r"<[^>]+>", "", tekst)
    tekst = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), tekst)
    tekst = re.sub(r"&#x([0-9a-fA-F]+);", lambda m: chr(int(m.group(1), 16)), tekst)
    tekst = re.sub(r"&([a-zA-Z]+);", lambda m: _ENTITEITEN.get(m.group(1).lower(), m.group(0)), tekst)
    tekst = re.sub(r"[ \t]+\n", "\n", tekst)
    return re.sub(r"\n{3,}", "\n\n", tekst)


def _uit_zip(pad):
    """docx, xlsx, pptx en OpenDocument zijn zipbestanden met XML erin."""
    delen = []
    with zipfile.ZipFile(pad) as archief:
        namen = [n for n in archief.namelist() if _ONDERDELEN.match(n)]
        if not namen:
            raise ValueError("geen leesbare documentonderdelen in het archief")
        for naam in namen:
            try:
                inhoud = archief.read(naam).decode("utf-8", "replace")
            except Exception:
                continue
            tekst = _xml_naar_tekst(inhoud).strip()
            if tekst:
                delen.append(f"--- {naam} ---\n{tekst}")
    return "\n\n".join(delen)


_PDF_TEKST = re.compile(rb"(\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>)\s*(?:Tj|TJ|'|\")"
                        rb"|\[((?:[^\]\[]|\\\])*)\]\s*TJ", re.S)
_PDF_STUK = re.compile(rb"\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>", re.S)


def _pdf_stukken_naar_tekst(inhoud):
    uit = []
    for treffer in _PDF_TEKST.finditer(inhoud):
        stukken = []
        if treffer.group(1):
            stukken.append(treffer.group(1))
        if treffer.group(2):
            stukken.extend(_PDF_STUK.findall(treffer.group(2)))
        for stuk in stukken:
            if stuk.startswith(b"<"):
                hexcijfers = re.sub(rb"\s", b"", stuk[1:-1])
                letters = [chr(int(hexcijfers[i:i + 2], 16)) for i in range(0, len(hexcijfers) - 1, 2)]
                uit.append("".join(c for c in letters if c == "\n" or ord(c) >= 32))
            else:
                ruw = stuk[1:-1].decode("latin-1")
                ruw = re.sub(r"\\(\d{1,3})", lambda m: chr(int(m.group(1), 8)), ruw)
                ruw = ruw.replace("\\n", "\n").replace("\\r", "\n").replace("\\t", "\t")
                uit.append(re.sub(r"\\([()\\])", r"\1", ruw))
        uit.append(" ")
    return "".join(uit)


def _pdf_intern(data):
    """Eenvoudige eigen pdf-lezer: streams uitpakken en de tekstoperatoren lezen."""
    tekst, positie = [], 0
    while True:
        start = data.find(b"stream", positie)
        if start == -1:
            break
        begin = start + 6
        if data[begin:begin + 2] == b"\r\n":
            begin += 2
        elif data[begin:begin + 1] in (b"\n", b"\r"):
            begin += 1
        eind = data.find(b"endstream", begin)
        if eind == -1:
            break
        positie = eind
        ruw = data[begin:eind]
        try:
            inhoud = zlib.decompress(ruw)
        except zlib.error:
            inhoud = ruw
        if b"BT" in inhoud or b"Tj" in inhoud or b"TJ" in inhoud:
            tekst.append(_pdf_stukken_naar_tekst(inhoud))
    samen = re.sub(r"[ \t]{2,}", " ", "".join(tekst))
    return re.sub(r"\n{3,}", "\n\n", samen).strip()


def _uit_pdf(pad, data):
    if shutil.which("pdftotext"):
        try:
            klaar = subprocess.run(["pdftotext", "-q", "-enc", "UTF-8", str(pad), "-"],
                                   capture_output=True, timeout=120)
            uit = klaar.stdout.decode("utf-8", "replace")
            if len(uit.strip()) > 20:
                return uit, None
        except Exception:
            pass
    tekst = _pdf_intern(data)
    if len(tekst) < 20:
        return tekst, ("PDF leverde nauwelijks tekst op — waarschijnlijk een scan of afbeelding. "
                       "Controleer dit bestand handmatig, of installeer poppler (pdftotext).")
    return tekst, ("PDF gelezen met de ingebouwde lezer; installeer poppler (pdftotext) "
                   "voor een nauwkeuriger resultaat.")


def _uit_rtf(ruw):
    tekst = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), ruw)
    tekst = re.sub(r"\\par[d]?\b", "\n", tekst)
    tekst = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", tekst)
    return re.sub(r"\n{3,}", "\n\n", tekst.replace("{", "").replace("}", "")).strip()


def soort_van(pad):
    ext = Path(pad).suffix.lstrip(".").lower()
    if ext in TEKST_EXTS:
        return "tekst"
    if ext in ZIP_EXTS:
        return "document"
    if ext == "pdf":
        return "pdf"
    if ext == "rtf":
        return "rtf"
    if ext in AFBEELDING_EXTS:
        return "afbeelding"
    if ext in MEDIA_EXTS:
        return "media"
    return "onbekend"


def _lijkt_binair(data):
    stuk = data[:4096]
    if b"\0" in stuk:
        return True
    raar = sum(1 for b in stuk if b < 9 or 13 < b < 32)
    return stuk and raar / len(stuk) > 0.1


def haal_tekst(pad, max_bytes=MAX_BYTES):
    """Geeft (tekst, soort, leesbaar, notitie, afgekapt, bytes) van één bestand."""
    pad = Path(pad)
    soort = soort_van(pad)
    omvang = pad.stat().st_size
    afgekapt = omvang > max_bytes
    basis = {"soort": soort, "bytes": omvang, "afgekapt": afgekapt, "notitie": None, "leesbaar": True}

    if soort == "afbeelding":
        return dict(basis, tekst="", leesbaar=False,
                    notitie="Afbeelding: tekst in beeld wordt niet gelezen. Bekijk dit bestand zelf.")
    if soort == "media":
        return dict(basis, tekst="", leesbaar=False,
                    notitie="Audio of video wordt niet getranscribeerd. Controleer beeld en geluid zelf.")

    try:
        with open(pad, "rb") as bestand:
            data = bestand.read(max_bytes)

        if soort == "document":
            if afgekapt:
                raise ValueError("archief te groot om betrouwbaar te lezen")
            return dict(basis, tekst=_uit_zip(pad))
        if soort == "pdf":
            tekst, notitie = _uit_pdf(pad, data)
            return dict(basis, tekst=tekst, notitie=notitie, leesbaar=bool(tekst))
        if soort == "rtf":
            return dict(basis, tekst=_uit_rtf(data.decode("utf-8", "replace")))
        if soort == "onbekend" and _lijkt_binair(data):
            return dict(basis, tekst="", leesbaar=False,
                        notitie="Binair bestand van een onbekend type — niet gelezen. Controleer zelf wat erin zit.")

        tekst = data.decode("utf-8", "replace")
        if pad.suffix.lower() in (".html", ".htm"):
            tekst = re.sub(r"<script[\s\S]*?</script>", " ", tekst, flags=re.I)
            tekst = re.sub(r"<style[\s\S]*?</style>", " ", tekst, flags=re.I)
            tekst = _xml_naar_tekst(tekst)   # commentaar blijft staan: daar zit vaak juist iets in
        return dict(basis, tekst=tekst)
    except Exception as fout:
        return dict(basis, tekst="", leesbaar=False, notitie=f"Kon dit bestand niet uitpakken: {fout}")


NEGEER = re.compile(r"(^|[/\\])(node_modules|\.git|\.venv|__pycache__|dist|build)([/\\]|$)")


def verzamel_bestanden(pad, maximum=500):
    pad = Path(pad)
    if pad.is_file():
        return [pad]
    gevonden = []
    for kind in sorted(pad.rglob("*")):
        if len(gevonden) >= maximum:
            break
        if kind.is_file() and not kind.name.startswith(".") and not NEGEER.search(str(kind)):
            gevonden.append(kind)
    return gevonden


def in_stukken(tekst, grootte=6000, overlap=200):
    """Knipt tekst in blokken die in een lokaal model passen."""
    if len(tekst) <= grootte:
        return [tekst]
    stukken, positie = [], 0
    while positie < len(tekst):
        eind = min(len(tekst), positie + grootte)
        if eind < len(tekst):
            grens = tekst.rfind("\n", positie, eind)
            if grens > positie + int(grootte * 0.6):
                eind = grens
        stukken.append(tekst[positie:eind])
        if eind >= len(tekst):
            break
        positie = eind - overlap
    return stukken


# ---------------------------------------------------------------------------
# Het lokale taalmodel
# ---------------------------------------------------------------------------
#
# Werkt met LM Studio, Ollama, llama.cpp — alles met een OpenAI-compatibel
# /v1/chat/completions-endpoint. Harde regel: het moet op deze machine draaien.
# Dat is de hele reden van dit programma.

import urllib.error
import urllib.request

LOKALE_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"}

SYSTEEM_PROMPT = """Je bent een privacy-analist die documenten controleert vóór ze geüpload worden naar een analysetool.
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
Verzin nooit fragmenten die niet letterlijk in de tekst staan."""


def is_lokaal(endpoint):
    from urllib.parse import urlparse
    host = (urlparse(endpoint).hostname or "").strip("[]")
    if host in LOKALE_HOSTS or host.endswith(".local"):
        return True
    return bool(re.match(r"^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)", host))


def _haal(url, data=None, timeout=20):
    verzoek = urllib.request.Request(url, data=data,
                                     headers={"Content-Type": "application/json"} if data else {})
    # Geen proxy: het endpoint hoort op deze machine te draaien.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(verzoek, timeout=timeout) as antwoord:
        return json.loads(antwoord.read().decode("utf-8"))


def modellen(endpoint, timeout=8):
    data = _haal(endpoint.rstrip("/") + "/models", timeout=timeout)
    lijst = data.get("data") or data.get("models") or []
    return [m.get("id") or m.get("name") for m in lijst if m.get("id") or m.get("name")]


def uitleg_geen_server(endpoint, via_app=False):
    slot = (["  Het venster werkt gewoon zonder model: je krijgt dan de",
             "  patrooncontrole (BSN, IBAN, e-mail, telefoon, wachtwoorden…)."]
            if via_app else
            ["  Zonder model werkt de scan ook: voeg --zonder-ai toe voor",
             "  alleen de patrooncontrole (BSN, IBAN, e-mail, telefoon…)."])
    return "\n".join([
        f"Geen lokaal model bereikbaar op {endpoint}.",
        "",
        '  LM Studio : tabblad "Developer" → Status "Running" (poort 1234),',
        '              laad een model en zet "Serve on local network" niet aan.',
        "  Ollama    : `ollama serve` draait al; gebruik",
        "              --endpoint http://localhost:11434/v1 --model llama3.1",
        "",
    ] + slot)


def _pak_json(inhoud):
    """Modellen zetten er graag ```json omheen, of denken hardop in <think>."""
    if not inhoud:
        return None
    tekst = re.sub(r"<think>[\s\S]*?</think>", "", inhoud, flags=re.I).strip()
    hek = re.search(r"```(?:json)?\s*([\s\S]*?)```", tekst, re.I)
    if hek:
        tekst = hek.group(1).strip()
    start, eind = tekst.find("{"), tekst.rfind("}")
    if start == -1 or eind <= start:
        return None
    try:
        return json.loads(tekst[start:eind + 1])
    except json.JSONDecodeError:
        return None


ERNSTEN = {"laag", "middel", "hoog"}


def _chat(instellingen, tekst, json_modus=True):
    body = {
        "model": instellingen["model"],
        "messages": [
            {"role": "system", "content": SYSTEEM_PROMPT},
            {"role": "user", "content": tekst},
        ],
        "temperature": 0,
        "max_tokens": 1200,
        "stream": False,
    }
    if json_modus:
        body["response_format"] = {"type": "json_object"}
    url = instellingen["endpoint"].rstrip("/") + "/chat/completions"
    try:
        data = _haal(url, json.dumps(body).encode("utf-8"), timeout=instellingen.get("timeout", 180))
    except urllib.error.HTTPError as fout:
        # Niet elke lokale server kent response_format; dan zonder proberen.
        if json_modus and fout.code in (400, 422):
            return _chat(instellingen, tekst, json_modus=False)
        raise RuntimeError(f"HTTP {fout.code} van het model") from None
    return (data.get("choices") or [{}])[0].get("message", {}).get("content", "")


def analyseer_tekst(instellingen, tekst, bestandsnaam=""):
    """Laat het lokale model één blok tekst beoordelen."""
    inhoud = _chat(instellingen,
                   f'Bestand: {bestandsnaam or "onbekend"}\n\nTekst om te controleren:\n"""\n{tekst}\n"""')
    data = _pak_json(inhoud)
    if data is None:
        raise RuntimeError("het model gaf geen bruikbare JSON terug")

    genormaliseerd = re.sub(r"\s+", " ", tekst)
    bevindingen = []
    for ruw in (data.get("bevindingen") or [])[:40]:
        fragment = str(ruw.get("fragment", "")).strip()[:200]
        if not fragment:
            continue
        # Hallucinatiefilter: wat niet in de tekst staat, gaat niet in het rapport.
        if fragment not in tekst and re.sub(r"\s+", " ", fragment) not in genormaliseerd:
            continue
        ernst = str(ruw.get("ernst", "")).lower()
        zekerheid = str(ruw.get("zekerheid", "")).lower()
        bevindingen.append({
            "type": str(ruw.get("type", "onbekend")).lower()[:30],
            "label": str(ruw.get("label", "Persoonsgegeven"))[:120],
            "ernst": ernst if ernst in ERNSTEN else "middel",
            "zekerheid": zekerheid if zekerheid in ERNSTEN else "middel",
            "waarde": fragment,
            "gemaskeerd": maskeer(fragment),
            "toelichting": str(ruw.get("toelichting", ""))[:300],
            "categorie": "ai",
            "bron": "ai",
            "regel": None,
            "aantal": 1,
        })
    return bevindingen, str(data.get("samenvatting", ""))[:400]


# ---------------------------------------------------------------------------
# De scan
# ---------------------------------------------------------------------------

ADVIES = {
    "geen": "Geen persoonsgegevens gevonden — uploaden kan.",
    "laag": "Alleen licht identificerende gegevens — meestal geen bezwaar, controleer de bevindingen.",
    "middel": "Persoonsgegevens gevonden — verwijder of anonimiseer ze vóór het uploaden.",
    "hoog": "Gevoelige gegevens gevonden — niet uploaden zonder deze eerst te verwijderen.",
    "onbekend": "Dit bestand kon niet gelezen worden — controleer de inhoud handmatig.",
}

# Types die een persoon aanwijzen. Zonder één daarvan is "diagnose ADHD" een
# onderwerp en geen persoonsgegeven: een handleiding over ADHD hoort geen hoog
# risico te krijgen.
IDENTIFICEREND = {"bsn", "email", "telefoon", "postcode", "geboortedatum", "paspoortnummer", "big",
                  "leerlingnummer", "iban", "betaalkaart", "digid", "kenteken",
                  "naam", "adres", "contact", "identificatie"}


def _ontdubbel(bevindingen):
    samen = {}
    volgorde = []
    for b in bevindingen:
        sleutel = ("signaal", b["type"]) if b.get("termen") else (b["type"], str(b["waarde"]).lower().strip())
        bestaand = samen.get(sleutel)
        if bestaand is None:
            samen[sleutel] = dict(b)
            volgorde.append(sleutel)
            continue
        if b.get("termen") and bestaand.get("termen"):
            termen = list(dict.fromkeys(bestaand["termen"] + b["termen"]))
            bestaand["termen"] = termen
            bestaand["waarde"] = ", ".join(termen)
            bestaand["gemaskeerd"] = bestaand["waarde"]
            bestaand["aantal"] = len(termen)
            # De vindplaats in de tekst zegt meer dan die in de bestandsnaam.
            if bestaand.get("in_bestandsnaam") and not b.get("in_bestandsnaam"):
                bestaand["in_bestandsnaam"] = False
                bestaand["regel"] = b["regel"]
            continue
        bestaand["aantal"] = bestaand.get("aantal", 1) + 1
        # Een patroontreffer weegt zwaarder dan een AI-vermoeden.
        if bestaand["bron"] == "ai" and b["bron"] == "patroon":
            aantal = bestaand["aantal"]
            bestaand.update(b)
            bestaand["aantal"] = aantal
        if ERNST_RANG[b["ernst"]] > ERNST_RANG[bestaand["ernst"]]:
            bestaand["ernst"] = b["ernst"]
    uit = [samen[s] for s in volgorde]
    uit.sort(key=lambda b: (-ERNST_RANG[b["ernst"]], b["type"]))
    return uit


def _weeg_bijzondere(bevindingen):
    """Een gevoelig onderwerp telt pas zwaar als er ook iemand identificeerbaar is."""
    if any(b["type"] in IDENTIFICEREND for b in bevindingen):
        return bevindingen
    for b in bevindingen:
        if b.get("signaal") and b.get("categorie") == "bijzonder":
            b["ernst"] = "laag"
            b["label"] = f"{b['label']} (onderwerp)"
            b["avg"] = ("Gevoelig onderwerp, maar er is niemand identificeerbaar in dit bestand. "
                        "Let op combinaties met andere bronnen.")
    return bevindingen


def oordeel_van(bevindingen, leesbaar=True):
    if not leesbaar:
        return "onbekend"
    hoogste = "geen"
    for b in bevindingen:
        if ERNST_RANG[b["ernst"]] > ERNST_RANG[hoogste]:
            hoogste = b["ernst"]
    return hoogste


def scan_bestand(pad, instellingen, zonder_ai=False, naam=None, voortgang=None):
    """Scant één bestand en geeft het volledige resultaat terug."""
    pad = Path(pad)
    # naam: bij de web-app staat het bestand onder een tijdelijke naam op schijf,
    # terwijl we de échte naam willen tonen en meescannen.
    toon_naam = naam or pad.name
    waarschuwingen = []

    uitpak = haal_tekst(pad, instellingen.get("max_bytes", MAX_BYTES))
    if uitpak["notitie"]:
        waarschuwingen.append(uitpak["notitie"])
    if uitpak["afgekapt"]:
        waarschuwingen.append("Bestand is groter dan de leeslimiet; alleen het eerste deel is gescand.")

    bevindingen = []
    samenvatting = ""
    ai_gebruikt = False

    # De bestandsnaam zelf lekt vaak al: "verzuim_jan_de_vries_BSN.pdf".
    for b in zoek_patronen(re.sub(r"[_\-.]", " ", toon_naam)):
        b.update({"in_bestandsnaam": True, "context": toon_naam, "regel": 0})
        bevindingen.append(b)

    if uitpak["tekst"]:
        bevindingen.extend(zoek_patronen(uitpak["tekst"], waarschuw=waarschuwingen.append))

        if not zonder_ai:
            alle = in_stukken(uitpak["tekst"], instellingen.get("stuk_grootte", 6000))
            maximum = instellingen.get("max_stukken", 40)
            stukken = alle[:maximum]
            if len(alle) > len(stukken):
                waarschuwingen.append(
                    f"Tekst opgeknipt in {len(alle)} stukken; alleen de eerste {len(stukken)} zijn "
                    f"met AI beoordeeld (--max-stukken verhoogt dit).")
            for nummer, stuk in enumerate(stukken, 1):
                if voortgang:
                    voortgang(toon_naam, nummer, len(stukken))
                try:
                    gevonden, korte = analyseer_tekst(instellingen, stuk, toon_naam)
                except Exception as fout:
                    waarschuwingen.append(f"AI-analyse van deel {nummer}/{len(stukken)} mislukt: {fout}")
                    break   # één kapotte verbinding betekent meestal: model weg
                ai_gebruikt = True
                bevindingen.extend(gevonden)
                if korte and not samenvatting:
                    samenvatting = korte

    uniek = _weeg_bijzondere(_ontdubbel(bevindingen))
    leesbaar = uitpak["leesbaar"] or bool(uniek)
    oordeel = oordeel_van(uniek, leesbaar)

    return {
        "bestand": str(pad), "naam": toon_naam, "bytes": uitpak["bytes"], "soort": uitpak["soort"],
        "leesbaar": leesbaar, "ai_gebruikt": ai_gebruikt, "oordeel": oordeel, "advies": ADVIES[oordeel],
        "samenvatting": samenvatting, "bevindingen": uniek, "waarschuwingen": waarschuwingen,
    }


def samenvatten(resultaten, drempel="middel"):
    telling = {"geen": 0, "laag": 0, "middel": 0, "hoog": 0, "onbekend": 0}
    for r in resultaten:
        telling[r["oordeel"]] += 1
    hoogste = "geen"
    for r in resultaten:
        if r["oordeel"] != "onbekend" and ERNST_RANG[r["oordeel"]] > ERNST_RANG[hoogste]:
            hoogste = r["oordeel"]
    geblokkeerd = [r["naam"] for r in resultaten
                   if r["oordeel"] != "onbekend" and ERNST_RANG[r["oordeel"]] >= ERNST_RANG[drempel]]
    onleesbaar = [r["naam"] for r in resultaten if r["oordeel"] == "onbekend"]

    advies = ("Alle bestanden blijven onder de drempel — uploaden naar de GLU Analysetool kan."
              if not geblokkeerd else
              f'{len(geblokkeerd)} van {len(resultaten)} bestand(en) haalt de drempel "{drempel}" '
              f"of hoger. Schoon die eerst op.")
    if onleesbaar:
        # Onleesbaar is niet hetzelfde als schoon; dat hoort in het advies te staan.
        advies += f" {len(onleesbaar)} bestand(en) kon de scanner niet lezen — controleer die zelf."

    return {"bestanden": len(resultaten), "telling": telling, "hoogste_oordeel": hoogste,
            "drempel": drempel, "geblokkeerd": geblokkeerd, "onleesbaar": onleesbaar,
            "upload_advies": advies}


def redigeer(pad, resultaat, achtervoegsel=".geschoond"):
    """Vervangt gevonden waarden door labels. Alleen zinvol bij platte tekst."""
    pad = Path(pad)
    if soort_van(pad) != "tekst":
        raise ValueError(f"redigeren kan alleen bij platte tekst (dit is: {soort_van(pad)})")
    tekst = pad.read_text(encoding="utf-8", errors="replace")
    vervangen = 0
    # Trefwoorden van bijzondere categorieën blijven staan: "diagnose" weghalen
    # maakt de tekst onleesbaar zonder iemand te beschermen.
    waarden = {(str(b["waarde"]), b["type"]) for b in resultaat["bevindingen"]
               if not b.get("in_bestandsnaam") and b.get("categorie") != "bijzonder" and len(str(b["waarde"])) >= 3}
    for waarde, soort in sorted(waarden, key=lambda p: -len(p[0])):
        tekst, aantal = re.subn(re.escape(waarde), f"[GEREDIGEERD:{soort}]", tekst)
        vervangen += aantal
    uit = pad.with_name(pad.stem + achtervoegsel + pad.suffix)
    uit.write_text(tekst, encoding="utf-8")
    return uit, vervangen


# ---------------------------------------------------------------------------
# De pagina van de web-app (gelijk aan die van de Node-versie)
# ---------------------------------------------------------------------------

PAGINA = """<!doctype html>
<html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacyscan vóór upload — GLU Analysetool</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='13' font-size='13'%3E%F0%9F%9B%A1%3C/text%3E%3C/svg%3E">
<style>
  :root { color-scheme: light dark; --bg:#fff; --vlak:#f5f6fb; --rand:#dadfeb; --tekst:#131735; --dim:#5c6480; --accent:#2a4bd7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1020; --vlak:#161a2e; --rand:#2a3047; --tekst:#e9ebf6; --dim:#98a1bb; --accent:#7d95ff; } }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--tekst); }
  main { max-width:900px; margin:0 auto; padding:2rem 1.25rem 5rem; }
  h1 { font-size:1.6rem; margin:0 0 .25rem; }
  .sub { color:var(--dim); margin:0 0 1.25rem; }
  .status { display:flex; flex-wrap:wrap; gap:.5rem 1rem; align-items:center; background:var(--vlak); border:1px solid var(--rand); border-radius:10px; padding:.7rem 1rem; margin-bottom:1.25rem; font-size:.9rem; }
  .stip { width:.6rem; height:.6rem; border-radius:50%; background:var(--dim); display:inline-block; margin-right:.4rem; }
  .stip.aan { background:#1b9e4b; } .stip.uit { background:#c62828; }
  #zone { border:2px dashed var(--rand); border-radius:14px; padding:2.5rem 1.25rem; text-align:center; background:var(--vlak); cursor:pointer; transition:border-color .15s,background .15s; }
  #zone.over { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 10%, var(--vlak)); }
  #zone strong { display:block; font-size:1.05rem; margin-bottom:.35rem; }
  #zone span { color:var(--dim); font-size:.9rem; }
  .opties { display:flex; flex-wrap:wrap; gap:1rem; margin:1rem 0 1.5rem; font-size:.9rem; color:var(--dim); }
  .kaart { border:1px solid var(--rand); border-left-width:5px; border-radius:12px; background:var(--vlak); padding:1rem 1.15rem; margin-bottom:.9rem; }
  .kaart.hoog { border-left-color:#c62828; } .kaart.middel { border-left-color:#c98a00; }
  .kaart.laag { border-left-color:#1a76c4; } .kaart.geen { border-left-color:#1b9e4b; }
  .kaart.onbekend,.kaart.bezig { border-left-color:var(--dim); }
  .kop { display:flex; justify-content:space-between; align-items:center; gap:.75rem; }
  .kop h2 { font-size:1rem; margin:0; overflow-wrap:anywhere; }
  .badge { font-size:.72rem; text-transform:uppercase; letter-spacing:.05em; border:1px solid currentColor; border-radius:999px; padding:.1rem .55rem; white-space:nowrap; }
  .hoog .badge,.badge.hoog { color:#c62828; } .middel .badge,.badge.middel { color:#a06a00; }
  .laag .badge,.badge.laag { color:#1a76c4; } .geen .badge,.badge.geen { color:#1b9e4b; }
  .onbekend .badge,.bezig .badge,.badge.onbekend { color:var(--dim); }
  .advies { margin:.5rem 0 0; } .ai { color:var(--dim); font-style:italic; margin:.35rem 0 0; font-size:.92rem; }
  ul.bev { list-style:none; margin:.75rem 0 0; padding:0; }
  ul.bev li { padding:.4rem 0; border-top:1px solid var(--rand); font-size:.92rem; display:flex; gap:.6rem; flex-wrap:wrap; align-items:baseline; }
  ul.bev code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); padding:.05rem .35rem; border-radius:4px; overflow-wrap:anywhere; }
  ul.bev .duiding { color:var(--dim); flex-basis:100%; font-size:.85rem; }
  .waarschuwing { color:var(--dim); font-size:.85rem; margin-top:.6rem; }
  .totaal { border:1px solid var(--rand); border-radius:12px; padding:1rem 1.15rem; margin:1.5rem 0 1rem; background:var(--vlak); }
  button { font:inherit; border:1px solid var(--rand); background:var(--bg); color:var(--tekst); border-radius:8px; padding:.4rem .8rem; cursor:pointer; }
  button:hover { border-color:var(--accent); }
  footer { color:var(--dim); font-size:.85rem; margin-top:2.5rem; border-top:1px solid var(--rand); padding-top:1rem; }
  .spin { display:inline-block; width:.8rem; height:.8rem; border:2px solid var(--rand); border-top-color:var(--accent); border-radius:50%; animation:d .7s linear infinite; }
  @keyframes d { to { transform:rotate(360deg); } }
</style></head>
<body><main>
  <h1>Privacyscan vóór upload</h1>
  <p class="sub">Controleer bestanden op persoonsgegevens vóór je ze in de GLU Analysetool zet. Alles gebeurt op deze computer; er gaat niets naar internet.</p>

  <div class="status" id="status"><span class="spin"></span> lokaal model zoeken…</div>

  <div id="zone" tabindex="0" role="button" aria-label="Bestanden kiezen of hierheen slepen">
    <strong>Sleep bestanden hierheen</strong>
    <span>of klik om te kiezen — pdf, docx, xlsx, pptx, csv, txt, afbeeldingen…</span>
  </div>
  <input type="file" id="kies" multiple hidden>

  <div class="opties">
    <label><input type="checkbox" id="zonderAi"> alleen patronen (sneller, geen AI)</label>
    <label><input type="checkbox" id="toonWaarden"> waarden volledig tonen</label>
    <button id="wis" type="button">Lijst wissen</button>
  </div>

  <div id="totaal"></div>
  <div id="uitslag"></div>

  <footer>glu-scan · satelliet van de GLU Analysetool · onderdeel van de AI Transparent toolkit.
  Een scan is een hulpmiddel en geen garantie: controleer altijd zelf wat je uploadt.</footer>
</main>
<script>
const zone = document.getElementById('zone');
const kies = document.getElementById('kies');
const uitslag = document.getElementById('uitslag');
const totaalVak = document.getElementById('totaal');
const resultaten = [];

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const grootte = b => { const u=['B','kB','MB','GB']; let i=0,v=b||0; while(v>=1000&&i<u.length-1){v/=1000;i++;} return v.toFixed(i?1:0)+' '+u[i]; };

async function status() {
  const vak = document.getElementById('status');
  try {
    const s = await (await fetch('/api/status')).json();
    if (s.zonderAi) {
      // De scanner is met --zonder-ai gestart: dan doet een draaiend model niet mee.
      vak.innerHTML = '<span><span class="stip"></span>alleen patrooncontrole</span><span>AI staat uit voor deze sessie</span>';
    } else if (s.modelBeschikbaar) {
      vak.innerHTML = '<span><span class="stip aan"></span>lokaal model actief</span><span>' + esc(s.model || '?') + '</span><span>' + esc(s.endpoint) + '</span>';
    } else {
      vak.innerHTML = '<span><span class="stip uit"></span>geen lokaal model</span><span>' + esc(s.endpoint) + '</span><span>Start LM Studio (Developer → Running) of gebruik "alleen patronen".</span>';
    }
    if (s.zonderAi || !s.modelBeschikbaar) {
      const vinkje = document.getElementById('zonderAi');
      vinkje.checked = true;
      if (s.zonderAi) vinkje.disabled = true;
    }
  } catch {
    vak.innerHTML = '<span><span class="stip uit"></span>scanner niet bereikbaar</span>';
  }
}

function kaartHtml(r, toonWaarden) {
  const bev = (r.bevindingen || []).map(b => {
    const waarde = toonWaarden ? b.waarde : (b.gemaskeerd || b.waarde);
    const plek = b.inBestandsnaam ? 'bestandsnaam' : (b.regel ? 'regel ' + b.regel : b.bron);
    return '<li><span class="badge ' + esc(b.ernst) + '">' + esc(b.ernst) + '</span>' +
      '<strong>' + esc(b.label) + '</strong>' + (b.aantal > 1 ? ' <em>×' + b.aantal + '</em>' : '') +
      ' <code>' + esc(waarde) + '</code> <span class="duiding">' + esc(plek) + ' — ' + esc(b.avg || b.toelichting || '') + '</span></li>';
  }).join('');
  const waarsch = (r.waarschuwingen || []).map(w => '<p class="waarschuwing">⚠ ' + esc(w) + '</p>').join('');
  return '<article class="kaart ' + esc(r.oordeel) + '">' +
    '<div class="kop"><h2>' + esc(r.naam) + '</h2><span class="badge">' + esc(r.oordeel) + '</span></div>' +
    '<p class="advies">' + esc(r.advies) + '</p>' +
    (r.samenvatting ? '<p class="ai">' + esc(r.samenvatting) + '</p>' : '') +
    (bev ? '<ul class="bev">' + bev + '</ul>' : '') + waarsch +
    '<p class="waarschuwing">' + grootte(r.bytes) + ' · ' + esc(r.soort) + (r.aiGebruikt ? ' · met lokale AI' : ' · alleen patronen') + '</p></article>';
}

function teken() {
  const toonWaarden = document.getElementById('toonWaarden').checked;
  uitslag.innerHTML = resultaten.map(r => r.bezig
    ? '<article class="kaart bezig"><div class="kop"><h2>' + esc(r.naam) + '</h2><span class="badge"><span class="spin"></span> scannen</span></div></article>'
    : (r.fout
      ? '<article class="kaart onbekend"><div class="kop"><h2>' + esc(r.naam) + '</h2><span class="badge">fout</span></div><p class="advies">' + esc(r.fout) + '</p></article>'
      : kaartHtml(r, toonWaarden))).join('');
  tekenTotaal();
}

async function tekenTotaal() {
  const klaar = resultaten.filter(r => !r.bezig && !r.fout);
  if (!klaar.length) { totaalVak.innerHTML = ''; return; }
  const s = await (await fetch('/api/samenvatting', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resultaten: klaar })
  })).json();
  totaalVak.innerHTML = '<div class="totaal"><strong>' + s.bestanden + ' bestand(en)</strong> — ' +
    s.telling.hoog + '× hoog, ' + s.telling.middel + '× middel, ' + s.telling.laag + '× laag, ' + s.telling.geen + '× schoon' +
    '<p style="margin:.5rem 0 0">' + esc(s.uploadAdvies) + '</p></div>';
}

async function scan(bestanden) {
  for (const f of bestanden) {
    const rij = { naam: f.name, bezig: true };
    resultaten.push(rij); teken();
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: {
          'X-Bestandsnaam': encodeURIComponent(f.name),
          'X-Zonder-Ai': document.getElementById('zonderAi').checked ? '1' : '0',
          'Content-Type': 'application/octet-stream'
        },
        body: f
      });
      const data = await res.json();
      Object.assign(rij, data, { bezig: false, fout: data.fout || null });
    } catch (err) {
      Object.assign(rij, { bezig: false, fout: 'scan mislukt: ' + err.message });
    }
    teken();
  }
}

zone.addEventListener('click', () => kies.click());
zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') kies.click(); });
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
zone.addEventListener('dragleave', () => zone.classList.remove('over'));
zone.addEventListener('drop', e => {
  e.preventDefault(); zone.classList.remove('over');
  scan([...e.dataTransfer.files]);
});
kies.addEventListener('change', () => { scan([...kies.files]); kies.value = ''; });
document.getElementById('toonWaarden').addEventListener('change', teken);
document.getElementById('wis').addEventListener('click', () => { resultaten.length = 0; teken(); });
status();
</script>
</body></html>"""


# ---------------------------------------------------------------------------
# De web-app
# ---------------------------------------------------------------------------
#
# Luistert uitsluitend op 127.0.0.1 en schrijft wat je erin sleept naar een
# tijdelijk bestand dat direct na de scan wordt verwijderd. De enige uitgaande
# verbinding is die naar het lokale model.

import http.server
import socketserver
import threading
import webbrowser

MAX_UPLOAD = 200 * 1024 * 1024


def maak_handler(instellingen, zonder_ai):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "glu-scan/" + VERSIE
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass    # geen serverlogboek: dat zou bestandsnamen bewaren

        def _antwoord(self, code, inhoud, mime="application/json; charset=utf-8"):
            data = inhoud if isinstance(inhoud, bytes) else str(inhoud).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def _alleen_lokaal(self):
            afzender = self.client_address[0]
            if afzender not in ("127.0.0.1", "::1"):
                self._antwoord(403, "alleen lokaal", "text/plain; charset=utf-8")
                return False
            return True

        def do_GET(self):
            if not self._alleen_lokaal():
                return
            if self.path in ("/", "/index.html") or self.path.startswith("/?"):
                return self._antwoord(200, PAGINA, "text/html; charset=utf-8")
            if self.path == "/api/status":
                lijst, fout = [], None
                try:
                    lijst = modellen(instellingen["endpoint"])
                except Exception as probleem:
                    fout = str(probleem)
                return self._antwoord(200, json.dumps({
                    "endpoint": instellingen["endpoint"],
                    "model": instellingen.get("model") or (lijst[0] if lijst else None),
                    "modellen": lijst, "modelBeschikbaar": bool(lijst),
                    "fout": fout, "zonderAi": zonder_ai, "visie": False,
                }))
            return self._antwoord(404, "niet gevonden", "text/plain; charset=utf-8")

        def do_POST(self):
            if not self._alleen_lokaal():
                return
            lengte = int(self.headers.get("Content-Length") or 0)
            if lengte > MAX_UPLOAD:
                return self._antwoord(413, json.dumps(
                    {"fout": f"bestand groter dan {MAX_UPLOAD // 10**6} MB"}))
            data = self.rfile.read(lengte)

            if self.path == "/api/samenvatting":
                try:
                    binnen = json.loads(data.decode("utf-8"))
                except ValueError:
                    return self._antwoord(400, json.dumps({"fout": "ongeldige invoer"}))
                return self._antwoord(200, json.dumps(
                    _naar_web(samenvatten(binnen.get("resultaten", []), instellingen.get("drempel", "middel")))))

            if self.path == "/api/scan":
                from urllib.parse import unquote
                ruw = self.headers.get("X-Bestandsnaam") or "bestand.txt"
                try:
                    naam = unquote(ruw)
                except Exception:
                    naam = ruw
                naam = re.sub(r"[/\\]", "_", naam)[:200]
                nu_zonder_ai = zonder_ai or self.headers.get("X-Zonder-Ai") == "1"

                achtervoegsel = Path(naam).suffix or ".bin"
                greep, tijdelijk = tempfile.mkstemp(prefix="glu-scan-", suffix=achtervoegsel)
                try:
                    with os.fdopen(greep, "wb") as bestand:
                        bestand.write(data)
                    os.chmod(tijdelijk, 0o600)
                    resultaat = scan_bestand(tijdelijk, instellingen, zonder_ai=nu_zonder_ai, naam=naam)
                    resultaat["bestand"] = naam       # niet het tijdelijke pad teruggeven
                    return self._antwoord(200, json.dumps(_naar_web(resultaat)))
                except Exception as fout:
                    return self._antwoord(500, json.dumps({"fout": str(fout)}))
                finally:
                    try:
                        os.remove(tijdelijk)
                    except OSError:
                        pass

            return self._antwoord(404, json.dumps({"fout": "niet gevonden"}))

    return Handler


def _naar_web(waarde):
    """Sleutelnamen omzetten naar wat de pagina verwacht (die komt uit de Node-versie)."""
    vertaling = {"in_bestandsnaam": "inBestandsnaam", "ai_gebruikt": "aiGebruikt",
                 "hoogste_oordeel": "hoogsteOordeel", "upload_advies": "uploadAdvies"}
    if isinstance(waarde, dict):
        return {vertaling.get(k, k): _naar_web(v) for k, v in waarde.items()}
    if isinstance(waarde, list):
        return [_naar_web(v) for v in waarde]
    return waarde


class _Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_webapp(instellingen, poort=STANDAARD_POORT, zonder_ai=False, open_browser=True):
    try:
        server = _Server(("127.0.0.1", poort), maak_handler(instellingen, zonder_ai))
    except OSError as fout:
        if getattr(fout, "errno", None) in (48, 98, 10048):
            stop(f"Poort {poort} is bezet. Kies een andere: --poort {poort + 1}")
        raise

    url = f"http://127.0.0.1:{server.server_address[1]}"
    print(f"\n{vet('Privacyscan')} draait op {vet(url)}")
    print(grijs("  Sleep bestanden in het venster. Alles blijft op deze computer."))
    print(grijs(f"  Model: {'geen (alleen patronen)' if zonder_ai else instellingen.get('model')}"
                f" · stoppen met Ctrl-C\n"))
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(grijs("\nGestopt."))
    finally:
        server.server_close()
    return server


# ---------------------------------------------------------------------------
# Rapportage
# ---------------------------------------------------------------------------
#
# Waarden staan standaard gemaskeerd. Een privacyrapport dat zelf vol
# persoonsgegevens staat, verplaatst het probleem alleen maar.

def toon_resultaat(resultaat, toon_waarden=False):
    oordeel = resultaat["oordeel"]
    kleur = KLEUR_VAN[oordeel]
    kop = f"{leesbare_omvang(resultaat['bytes'])}, {resultaat['soort']}"
    print(f"\n{vet(resultaat['naam'])} {grijs('(' + kop + ')')}")
    print(f"  {kleur(TEKEN_VAN[oordeel] + ' ' + oordeel.upper())} — {resultaat['advies']}")
    if resultaat["samenvatting"]:
        print(f"  {grijs('AI:')} {resultaat['samenvatting']}")

    for ernst in ("hoog", "middel", "laag"):
        for b in resultaat["bevindingen"]:
            if b["ernst"] != ernst:
                continue
            waarde = b["waarde"] if toon_waarden else b.get("gemaskeerd") or b["waarde"]
            if b.get("in_bestandsnaam"):
                plek = "bestandsnaam"
            elif b.get("regel"):
                plek = f"regel {b['regel']}"
            else:
                plek = b["bron"]
            aantal = b.get("aantal", 1)
            herhaling = grijs(f" ×{aantal}") if aantal > 1 else ""
            print(f"    {KLEUR_VAN[ernst](TEKEN_VAN[ernst])} {vet(b['label'])}{herhaling} {grijs('[' + plek + ']')}")
            print(f"      {waarde}")
            duiding = b.get("avg") or b.get("toelichting")
            if duiding:
                print(f"      {grijs(duiding)}")

    for waarschuwing in resultaat["waarschuwingen"]:
        print(f"  {geel('⚠')} {grijs(waarschuwing)}")
    if not resultaat["ai_gebruikt"] and resultaat["leesbaar"]:
        print(f"  {grijs('(alleen patrooncontrole — geen lokaal model gebruikt)')}")


def toon_samenvatting(s):
    delen = []
    for ernst, tekst in (("hoog", "hoog"), ("middel", "middel"), ("laag", "laag")):
        if s["telling"][ernst]:
            delen.append(KLEUR_VAN[ernst](f"{s['telling'][ernst]}× {tekst}"))
    if s["telling"]["geen"]:
        delen.append(groen(f"{s['telling']['geen']}× schoon"))
    if s["telling"]["onbekend"]:
        delen.append(grijs(f"{s['telling']['onbekend']}× onleesbaar"))
    print(f"\n{vet('Samenvatting')}")
    print(f"  {s['bestanden']} bestand(en): " + " · ".join(delen))
    print(f"  {KLEUR_VAN[s['hoogste_oordeel']](TEKEN_VAN[s['hoogste_oordeel']])} {s['upload_advies']}")
    if s["geblokkeerd"]:
        print(f"  {grijs('opschonen:')} {', '.join(s['geblokkeerd'])}")


def naar_json(resultaten, samenvatting, toon_waarden=False):
    return {
        "tool": "glu-scan", "versie": 1,
        "tijdstip": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "samenvatting": samenvatting,
        "bestanden": [{
            "naam": r["naam"], "pad": r["bestand"], "bytes": r["bytes"], "soort": r["soort"],
            "oordeel": r["oordeel"], "advies": r["advies"], "aiGebruikt": r["ai_gebruikt"],
            "samenvattingAi": r["samenvatting"], "waarschuwingen": r["waarschuwingen"],
            "bevindingen": [{
                "type": b["type"], "label": b["label"], "ernst": b["ernst"],
                "categorie": b.get("categorie"), "bron": b["bron"], "regel": b.get("regel"),
                "aantal": b.get("aantal", 1),
                "waarde": b["waarde"] if toon_waarden else b.get("gemaskeerd"),
                "avg": b.get("avg"), "toelichting": b.get("toelichting"),
            } for b in r["bevindingen"]],
        } for r in resultaten],
    }


def naar_html(resultaten, s, toon_waarden=False):
    esc = _html.escape

    def kaart(r):
        rijen = []
        for b in r["bevindingen"]:
            aantal = b.get("aantal", 1)
            herhaling = f" <em>×{aantal}</em>" if aantal > 1 else ""
            waarde = b["waarde"] if toon_waarden else (b.get("gemaskeerd") or b["waarde"])
            if b.get("in_bestandsnaam"):
                plek = "bestandsnaam"
            elif b.get("regel"):
                plek = "regel " + str(b["regel"])
            else:
                plek = b["bron"]
            rijen.append(
                "<tr><td><span class='badge {e}'>{e}</span></td><td>{label}{herhaling}</td>"
                "<td><code>{waarde}</code></td><td>{plek}</td><td>{duiding}</td></tr>".format(
                    e=esc(b["ernst"]), label=esc(b["label"]), herhaling=herhaling,
                    waarde=esc(waarde), plek=esc(plek),
                    duiding=esc(b.get("avg") or b.get("toelichting") or "")))
        rijen = "".join(rijen)
        tabel = (f"<table><thead><tr><th>Ernst</th><th>Soort</th><th>Waarde</th><th>Plek</th>"
                 f"<th>Duiding</th></tr></thead><tbody>{rijen}</tbody></table>"
                 if rijen else "<p class='leeg'>Geen bevindingen.</p>")
        waarschuwingen = ("<ul class='waarschuwingen'>"
                          + "".join(f"<li>{esc(w)}</li>" for w in r["waarschuwingen"]) + "</ul>"
                          if r["waarschuwingen"] else "")
        ai = f"<p class='ai'>{esc(r['samenvatting'])}</p>" if r["samenvatting"] else ""
        return (f"<article class='kaart {r['oordeel']}'><header><h2>{esc(r['naam'])}</h2>"
                f"<span class='badge {r['oordeel']}'>{r['oordeel']}</span></header>"
                f"<p class='advies'>{esc(r['advies'])}</p>{ai}{tabel}{waarschuwingen}</article>")

    tijd = __import__("datetime").datetime.now().strftime("%d-%m-%Y %H:%M")
    return f"""<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacyscan — GLU Analysetool</title>
<style>
  :root {{ color-scheme: light dark; --rand:#d8dce5; --dim:#5b6478; --bg:#fff; --vlak:#f6f7fb; --tekst:#12162a; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --rand:#2b3145; --dim:#98a0b8; --bg:#0e1120; --vlak:#161a2c; --tekst:#e8eaf4; }} }}
  body {{ font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--tekst); }}
  main {{ max-width:960px; margin:0 auto; }}
  h1 {{ font-size:1.5rem; margin:0 0 .25rem; }}
  .meta {{ color:var(--dim); margin:0 0 1.5rem; }}
  .totaal, .kaart {{ background:var(--vlak); border:1px solid var(--rand); border-radius:12px; padding:1rem 1.25rem; margin-bottom:1rem; }}
  .kaart header {{ display:flex; align-items:center; gap:.75rem; justify-content:space-between; }}
  h2 {{ font-size:1.05rem; margin:0; overflow-wrap:anywhere; }}
  .badge {{ font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; padding:.15rem .5rem; border-radius:999px; border:1px solid currentColor; white-space:nowrap; }}
  .badge.hoog {{ color:#c62828; }} .badge.middel {{ color:#b26a00; }}
  .badge.laag {{ color:#0b6ea8; }} .badge.geen {{ color:#1b7c3d; }} .badge.onbekend {{ color:var(--dim); }}
  .advies {{ margin:.5rem 0; }} .ai {{ color:var(--dim); font-style:italic; margin:.25rem 0 .75rem; }}
  table {{ width:100%; border-collapse:collapse; margin-top:.5rem; display:block; overflow-x:auto; }}
  th,td {{ text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--rand); vertical-align:top; font-size:.9rem; }}
  th {{ color:var(--dim); font-weight:600; }}
  code {{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }}
  .leeg,.waarschuwingen {{ color:var(--dim); font-size:.9rem; }}
  footer {{ color:var(--dim); font-size:.85rem; margin-top:2rem; border-top:1px solid var(--rand); padding-top:1rem; }}
</style></head>
<body><main>
  <h1>Privacyscan vóór upload</h1>
  <p class="meta">GLU Analysetool · {tijd} · lokaal uitgevoerd, geen bestand heeft deze computer verlaten</p>
  <div class="totaal"><strong>{s['bestanden']} bestand(en)</strong> — {s['telling']['hoog']}× hoog,
    {s['telling']['middel']}× middel, {s['telling']['laag']}× laag, {s['telling']['geen']}× schoon.
    <p style="margin:.5rem 0 0">{_html.escape(s['upload_advies'])}</p></div>
  {"".join(kaart(r) for r in resultaten)}
  <footer>Gemaakt met glu-scan {VERSIE}. Waarden zijn {'volledig weergegeven — behandel dit rapport als vertrouwelijk' if toon_waarden else 'gemaskeerd weergegeven'}.
  Een scan is een hulpmiddel, geen garantie en geen juridisch advies.</footer>
</main></body></html>"""


# ---------------------------------------------------------------------------
# Instellingen
# ---------------------------------------------------------------------------

CONFIG_BESTAND = Path.home() / ".config" / "ai-transparent" / "glu-scan.json"
STANDAARD = {
    "endpoint": STANDAARD_ENDPOINT,
    "model": None,
    "drempel": "middel",
    "timeout": 180,
    "stuk_grootte": 6000,
    "max_stukken": 40,
}


def laad_config():
    instellingen = dict(STANDAARD)
    try:
        instellingen.update(json.loads(CONFIG_BESTAND.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return instellingen


def bewaar_config(instellingen):
    CONFIG_BESTAND.parent.mkdir(parents=True, exist_ok=True)
    afwijkend = {k: v for k, v in instellingen.items() if STANDAARD.get(k) != v}
    CONFIG_BESTAND.write_text(json.dumps(afwijkend, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        os.chmod(CONFIG_BESTAND, 0o600)
    except OSError:
        pass
    return CONFIG_BESTAND


def zorg_voor_model(instellingen, via_app=False):
    """Zoekt een bruikbaar model. Geeft False als er geen bereikbaar is."""
    try:
        lijst = modellen(instellingen["endpoint"])
        if not lijst:
            raise RuntimeError("de server draait maar heeft geen model geladen")
    except Exception as fout:
        reden = "geen verbinding" if isinstance(fout, (OSError, urllib.error.URLError)) else str(fout)
        print(geel("⚠ ") + reden, file=sys.stderr)
        print(grijs(uitleg_geen_server(instellingen["endpoint"], via_app)), file=sys.stderr)
        print(geel("→ ") + ("De app start gewoon; de AI-laag staat uit.\n" if via_app
                            else "De scan gaat verder met alleen de patrooncontrole.\n"), file=sys.stderr)
        return False

    gekozen = instellingen.get("model")
    if not gekozen:
        instellingen["model"] = lijst[0]
    elif gekozen not in lijst:
        # LM Studio accepteert ook gedeeltelijke namen; alleen waarschuwen.
        gok = next((m for m in lijst if gekozen in m), None)
        if gok:
            instellingen["model"] = gok
        else:
            print(geel("⚠ ") + f'Model "{gekozen}" staat niet in de lijst van {instellingen["endpoint"]}. '
                               f"Beschikbaar: {', '.join(lijst)}", file=sys.stderr)
    return True


def instellingen_met_vlaggen(argumenten):
    instellingen = laad_config()
    for sleutel in ("endpoint", "model", "drempel", "timeout", "stuk_grootte", "max_stukken"):
        waarde = getattr(argumenten, sleutel, None)
        if waarde is not None:
            instellingen[sleutel] = waarde
    if instellingen["drempel"] not in ERNST_RANG or instellingen["drempel"] == "geen":
        stop("--drempel moet laag, middel of hoog zijn.")
    if not is_lokaal(instellingen["endpoint"]) and not getattr(argumenten, "sta_extern", False):
        stop(f"{instellingen['endpoint']} draait niet op deze computer.\n"
             "  Dit programma bestaat juist om te voorkomen dat gevoelige bestanden je computer verlaten.\n"
             "  Weet je zeker dat je een externe server wilt gebruiken? Voeg --sta-extern toe.")
    if not is_lokaal(instellingen["endpoint"]):
        print(geel("⚠ ") + f"Externe AI-server ({instellingen['endpoint']}): de inhoud van je bestanden "
                           "gaat naar die server.", file=sys.stderr)
    return instellingen


# ---------------------------------------------------------------------------
# Commandoregel
# ---------------------------------------------------------------------------

def cmd_scan(argumenten):
    instellingen = instellingen_met_vlaggen(argumenten)
    zonder_ai = argumenten.zonder_ai
    if not zonder_ai and not zorg_voor_model(instellingen):
        zonder_ai = True

    bestanden = []
    for pad in argumenten.paden:
        if not Path(pad).exists():
            stop(f"Niet gevonden: {pad}")
        bestanden.extend(verzamel_bestanden(pad))
    if not bestanden:
        stop("Geen bestanden om te scannen.")

    if not argumenten.stil:
        model = "alleen patronen" if zonder_ai else f"lokaal model: {instellingen['model']}"
        print(f"\n{vet('Privacyscan vóór upload')} {grijs(f'— {len(bestanden)} bestand(en), {model}')}")

    def voortgang(naam, nummer, totaal):
        if not argumenten.stil and sys.stderr.isatty():
            sys.stderr.write(f"\r  {grijs(f'{naam}: AI-analyse {nummer}/{totaal}')}          ")

    resultaten = []
    for bestand in bestanden:
        try:
            resultaat = scan_bestand(bestand, instellingen, zonder_ai=zonder_ai, voortgang=voortgang)
        except Exception as fout:
            print(f"\n{rood('✘')} {Path(bestand).name}: {fout}", file=sys.stderr)
            continue
        if not argumenten.stil and sys.stderr.isatty():
            sys.stderr.write("\r" + " " * 72 + "\r")
        resultaten.append(resultaat)
        if not argumenten.stil:
            toon_resultaat(resultaat, argumenten.toon_waarden)

        if argumenten.redigeer and resultaat["bevindingen"]:
            try:
                uit, aantal = redigeer(bestand, resultaat)
                print(f"  {groen('✔')} geschoonde kopie: {vet(uit.name)} {grijs(f'({aantal} vervanging(en))')}")
            except Exception as fout:
                print(f"  {geel('⚠')} redigeren overgeslagen: {fout}")

    s = samenvatten(resultaten, instellingen["drempel"])
    if not argumenten.stil:
        toon_samenvatting(s)

    if argumenten.json is not None:
        data = json.dumps(naar_json(resultaten, s, argumenten.toon_waarden), indent=2, ensure_ascii=False)
        if argumenten.json == "-":
            print(data)
        else:
            Path(argumenten.json).write_text(data, encoding="utf-8")
            print(f"  {grijs('rapport:')} {argumenten.json}")
    if argumenten.html:
        Path(argumenten.html).write_text(naar_html(resultaten, s, argumenten.toon_waarden), encoding="utf-8")
        print(f"  {grijs('rapport:')} {argumenten.html}")

    # Exitcode zodat een script of uploadknop hierop kan sturen.
    return 2 if ERNST_RANG[s["hoogste_oordeel"]] >= ERNST_RANG[instellingen["drempel"]] else 0


def cmd_ui(argumenten):
    instellingen = instellingen_met_vlaggen(argumenten)
    zonder_ai = argumenten.zonder_ai or not zorg_voor_model(instellingen, via_app=True)
    start_webapp(instellingen, poort=argumenten.poort, zonder_ai=zonder_ai)
    return 0


def cmd_modellen(argumenten):
    instellingen = instellingen_met_vlaggen(argumenten)
    try:
        lijst = modellen(instellingen["endpoint"])
    except Exception as fout:
        print(rood("✘ ") + str(fout), file=sys.stderr)
        print("\n" + uitleg_geen_server(instellingen["endpoint"]), file=sys.stderr)
        return 1
    print(f"{vet(instellingen['endpoint'])} {grijs(f'— {len(lijst)} model(len)')}")
    for model in lijst:
        print(f"  {groen('●') if model == instellingen.get('model') else grijs('○')} {model}")
    if not instellingen.get("model") and lijst:
        print(grijs(f"\n  Geen voorkeursmodel ingesteld; de eerste uit deze lijst wordt gebruikt."
                    f"\n  Vastleggen: glu_scan.py config --model {lijst[0]}"))
    return 0


def cmd_config(argumenten):
    instellingen = laad_config()
    wijzigingen = {s: getattr(argumenten, s) for s in ("endpoint", "model", "drempel", "timeout",
                                                       "stuk_grootte", "max_stukken")
                   if getattr(argumenten, s, None) is not None}
    if not wijzigingen:
        print(f"{vet('Instellingen')} {grijs(str(CONFIG_BESTAND))}")
        for sleutel, standaard in STANDAARD.items():
            waarde = instellingen.get(sleutel)
            achtervoegsel = grijs(" (standaard)") if waarde == standaard else ""
            print(f"  {sleutel:<14} {waarde if waarde is not None else grijs('(niet ingesteld)')}{achtervoegsel}")
        print(grijs("\n  Wijzigen: glu_scan.py config --endpoint http://localhost:11434/v1 --model llama3.1"))
        return 0
    instellingen.update(wijzigingen)
    if instellingen["drempel"] not in ("laag", "middel", "hoog"):
        stop("drempel moet laag, middel of hoog zijn.")
    pad = bewaar_config(instellingen)
    print(groen("✔") + f" Opgeslagen in {pad}")
    for sleutel, waarde in wijzigingen.items():
        print(f"  {sleutel} = {waarde}")
    return 0


def bouw_parser():
    parser = argparse.ArgumentParser(
        prog="glu_scan.py",
        description="Privacyscan vóór upload naar de GLU Analysetool. Alles draait op deze computer.",
        epilog="Zonder argumenten opent het venster waar je bestanden in kunt slepen.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--versie", action="version", version=f"glu-scan {VERSIE}")
    sub = parser.add_subparsers(dest="commando")

    def gedeeld(p):
        p.add_argument("--endpoint", help=f"lokale AI-server (standaard {STANDAARD_ENDPOINT})")
        p.add_argument("--model", help="naam van het model in die server")
        p.add_argument("--zonder-ai", action="store_true", dest="zonder_ai",
                       help="alleen patrooncontrole, geen model nodig")
        p.add_argument("--sta-extern", action="store_true", dest="sta_extern",
                       help="sta een AI-server toe die niet op deze computer draait")
        p.add_argument("--timeout", type=int, help="seconden wachten op het model (standaard 180)")

    scan = sub.add_parser("scan", help="bestanden of mappen scannen")
    scan.add_argument("paden", nargs="+", metavar="BESTAND")
    gedeeld(scan)
    scan.add_argument("--drempel", choices=["laag", "middel", "hoog"],
                      help="vanaf welke ernst uploaden wordt afgeraden (standaard middel)")
    scan.add_argument("--redigeer", action="store_true", help="geschoonde kopie schrijven (platte tekst)")
    scan.add_argument("--toon-waarden", action="store_true", dest="toon_waarden",
                      help="waarden volledig tonen (standaard gemaskeerd)")
    scan.add_argument("--json", nargs="?", const="-", metavar="PAD", help="JSON-rapport (zonder pad: naar het scherm)")
    scan.add_argument("--html", metavar="PAD", help="HTML-rapport om te bewaren")
    scan.add_argument("--stil", action="store_true", help="geen uitvoer, alleen exitcode en rapporten")
    scan.add_argument("--stuk-grootte", type=int, dest="stuk_grootte", help=argparse.SUPPRESS)
    scan.add_argument("--max-stukken", type=int, dest="max_stukken",
                      help="hoeveel tekstblokken maximaal naar de AI gaan (standaard 40)")

    ui = sub.add_parser("ui", help="het venster openen (sleep bestanden erin)")
    gedeeld(ui)
    ui.add_argument("--poort", type=int, default=STANDAARD_POORT)
    ui.add_argument("--drempel", choices=["laag", "middel", "hoog"])

    lijst = sub.add_parser("modellen", help="welke modellen draaien er lokaal?")
    gedeeld(lijst)
    lijst.add_argument("--drempel", choices=["laag", "middel", "hoog"], help=argparse.SUPPRESS)

    conf = sub.add_parser("config", help="instellingen tonen of wijzigen")
    conf.add_argument("--endpoint")
    conf.add_argument("--model")
    conf.add_argument("--drempel", choices=["laag", "middel", "hoog"])
    conf.add_argument("--timeout", type=int)
    conf.add_argument("--stuk-grootte", type=int, dest="stuk_grootte")
    conf.add_argument("--max-stukken", type=int, dest="max_stukken")
    return parser


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = bouw_parser()

    # Dubbelgeklikt of gestart zonder argumenten: meteen het venster openen.
    # Aan een hulptekst over commandoregelopties heeft niemand dan iets.
    if not argv:
        argv = ["ui"]

    argumenten = parser.parse_args(argv)
    if argumenten.commando == "scan":
        return cmd_scan(argumenten)
    if argumenten.commando == "ui":
        return cmd_ui(argumenten)
    if argumenten.commando == "modellen":
        return cmd_modellen(argumenten)
    if argumenten.commando == "config":
        return cmd_config(argumenten)
    parser.print_help()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
