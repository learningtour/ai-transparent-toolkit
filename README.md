# AI Transparent toolkit

Twee commandoregelprogramma's die hetzelfde uitgangspunt delen: gevoelig
materiaal blijft op je eigen machine.

- **`ait`** (deze map) — lokaal **grote video- en audiobestanden** labelen
  conform Artikel 50 van de EU AI Act. Voor wie met de terminal werkt.
- **`privacy-scan`** ([map `privacy-scan/`](privacy-scan/)) — bestanden met
  **lokale AI** controleren op persoonsgegevens *vóór* je ze uploadt naar een
  AI-dienst of deelt met derden. Eén Python-bestand dat je downloadt en start;
  werkt op Mac en Windows.

## ait — labelen conform Art. 50

CLI voor het lokaal labelen van **grote video- en audiobestanden** conform
Artikel 50 van de EU AI Act — zonder dat de content je machine verlaat.

De toolkit hoort bij [AI Transparent](https://aitransparent.eu)
(*AI labeling for media & learning*). Alleen de SHA-256-fingerprint en de
labelmetadata gaan naar app.aitransparent.eu; daar wordt het manifest
cryptografisch ondertekend (Ed25519) en geregistreerd. De toolkit bedt het
label daarna lokaal in het bestand in via ffmpeg (stream copy — een bestand
van 50 GB is in seconden klaar). Elk label krijgt een publieke
verificatiepagina: `app.aitransparent.eu/verify/AIL-…`

> **Account vereist.** Labelen werkt uitsluitend met een geldige API-sleutel
> van een AI Transparent-account (Pro of Premium) — het ondertekende manifest
> komt van de server, niet uit deze code. Registreren kan op
> [app.aitransparent.eu/portal](https://app.aitransparent.eu/portal).
> Alleen `ait check` (controleren) werkt zonder account; detectie is bij
> AI Transparent altijd publiek.

## Installatie

Vereist: [Node 20+](https://nodejs.org) en [ffmpeg](https://ffmpeg.org)
(`brew install ffmpeg`).

```bash
git clone https://github.com/learningtour/ai-transparent-toolkit.git
cd ai-transparent-toolkit
npm link        # maakt het commando `ait` overal beschikbaar
```

Of zonder git, als los bestand:

```bash
curl -fsSL https://raw.githubusercontent.com/learningtour/ai-transparent-toolkit/main/ait.js -o /usr/local/bin/ait
chmod +x /usr/local/bin/ait
```

Bij deze losse installatie ontbreekt de map `fonts/`. `ait logo` gebruikt dan
een systeemlettertype (Arial op macOS, DejaVu Sans op Linux). Wil je het
lettertype van de huisstijl, installeer dan met git.

## Inloggen

Haal je API-sleutel op in het portaal
([app.aitransparent.eu/portal](https://app.aitransparent.eu/portal), kaart
"API-sleutel") en draai eenmalig:

```bash
ait login
```

De sleutel wordt opgeslagen in `~/.config/ai-transparent/config.json`
(0600, alleen jouw gebruiker). `ait logout` verwijdert hem weer.

## Gebruik

```bash
ait label productie.mp4 --systeem "Sora"     # AI-gegenereerd
ait label interview.mp4 --bewerkt            # met AI bewerkt
ait label promo.mp4 --deepfake --badge       # + zichtbare disclosure (eerste 6 s)
ait logo productie.mp4 --systeem "Sora"      # zichtbaar AI-logo + label (zie hieronder)
ait check productie.ailabel.mp4              # controleren tegen het register
ait whoami                                   # account + verbruik
```

Per bestand krijg je:

- `naam.ailabel.ext` — gemarkeerd bestand met AILABEL-metadatatags
  (label-ID, Ed25519-handtekening, verify-URL);
- `naam.ailabel.ext.manifest.json` — het volledige ondertekende manifest;
- een publieke verificatiepagina op app.aitransparent.eu;
- een registervermelding in je online omgeving (portaal → verbruik).

`--badge` brandt de zichtbare disclosure in de eerste 6 seconden van het
beeld, linksonder (Art. 50(5): melden bij eerste blootstelling). Het is
dezelfde badge als bij `ait logo`. Dat hercodeert de video; zonder `--badge`
is het pure stream copy zonder kwaliteitsverlies.

## Zichtbaar AI-logo: `ait logo`

`ait logo` brandt het AI Transparent-logo met een korte tekst in een hoek van
de video. Daarna labelt het de video, net als `ait label`: het label staat
ondertekend in het register, en het label-ID en de verify-URL staan in de
metadata van de video.

```bash
ait logo clip.mp4                                  # rechtsboven, de hele video
ait logo clip.mp4 --positie lo --seconden 6        # linksonder, alleen de eerste 6 s
ait logo clip.mp4 --tekst "Gemaakt met AI"         # eigen tekst
ait logo clip.mp4 --geen-tekst                     # alleen het logo
ait logo clip.mp4 --met-id                         # + regel met de verify-URL
ait logo clip.mp4 --bewerkt --systeem "Runway"     # met AI bewerkt, systeem in het label
ait logo clip.mp4 --voorbeeld                      # alleen een PNG van één frame, geen label
```

![De badge op een 1080p-video: alleen het logo (`--geen-tekst`), de standaard, en met `--met-id`](docs/logo-voorbeeld.png)

### Zo label je een video met logo

1. Log eenmalig in met `ait login`.
2. Maak een voorbeeld: `ait logo clip.mp4 --voorbeeld`.
3. Open `clip.logo-voorbeeld.png` en controleer de positie en de grootte.
4. Pas zo nodig `--positie` of `--grootte` aan en herhaal stap 2.
5. Label de video: `ait logo clip.mp4` met dezelfde opties, zonder `--voorbeeld`.
6. Controleer het resultaat: `ait check clip.ailabel.mp4`.

Een voorbeeld maakt geen label en telt niet mee in je verbruik.

### Opties

| Optie | Betekenis | Standaard |
| --- | --- | --- |
| `--positie` | `linksboven` (`lb`), `rechtsboven` (`rb`), `linksonder` (`lo`) of `rechtsonder` (`ro`). Engels mag ook: `top-left` enz. | `rechtsboven` |
| `--seconden <n>` | Toon het logo alleen in de eerste *n* seconden. | de hele video |
| `--tekst "<tekst>"` | Eigen tekst naast het logo, bijv. `"Gemaakt met AI"`. | de korte tekst van het label |
| `--geen-tekst` | Alleen het logo, zonder tekst. | — |
| `--met-id` | Tweede, kleine regel met de verify-URL (`app.aitransparent.eu/verify/AIL-…`). | — |
| `--grootte <factor>` | Schaal van de badge, van 0.3 tot 4. | `1` |
| `--crf <n>` | Kwaliteit van de hercodering; lager is beter en groter. | `18` (H.264), `31` (VP9) |
| `--font <pad.ttf>` | Ander TrueType-lettertype (`.ttf` of `.ttc`). | DejaVu Sans |
| `--voorbeeld` | Alleen een PNG van één frame; geen label, geen hercodering. | — |
| `--bewerkt`, `--deepfake`, `--lang`, `--systeem`, `--model`, `--output` | Zoals bij `ait label`. | — |

De korte tekst is dezelfde als op de zichtbare badge voor afbeeldingen in
AI Transparent: *AI-gegenereerd*, *AI-bewerkt* of *Deep fake · …*, en met
`--lang en` *AI-generated* of *AI-manipulated*.

### Ontwerp en maat

- **Logo**: het AI Transparent-logo uit de app (blauw `#003399`, witte bogen
  en stip), met dezelfde hoekafronding.
- **Tekst**: wit, in DejaVu Sans, het lettertype van de badge voor afbeeldingen.
  De balk achter de tekst is `#003399` met 92% dekking. Een lichte rand houdt
  de badge zichtbaar op donker beeld.
- **Maat**: de hoogte van de badge is 1/16 van de korte zijde van het beeld,
  minimaal 20 px. Bij 1080p is dat 68 px, bij 4K 135 px, bij 720p 45 px.
  Een verticale video (1080×1920) krijgt dus dezelfde maat als 1080p.
- **Marge**: minimaal 3% van de korte zijde. Is de tekst te breed voor het
  beeld, dan wordt de badge kleiner.
- **Rechtsboven** is de standaard: daar staat bij omroepen het zenderlogo, en
  het blijft vrij van ondertitels en de knoppen van spelers onderin.

`ait logo` houdt rekening met telefoonvideo's met een rotatie en met
niet-vierkante pixels (bijv. PAL 16:9). Het logo staat dan in de juiste hoek
en blijft vierkant in beeld.

### Bestandsformaten

| Invoer | Uitvoer | Video | Audio |
| --- | --- | --- | --- |
| `.mp4`, `.m4v`, `.mov` | zelfde container | H.264 (libx264) | ongewijzigd, anders AAC |
| `.mkv` | `.mkv` | H.264 | ongewijzigd |
| `.webm` | `.webm` | VP9 | ongewijzigd (Opus/Vorbis) |
| overige (`.avi`, `.mpg`, …) | `.mp4` | H.264 | AAC als het niet past |

Ondertitels gaan ongewijzigd mee. Het logo inbranden hercodeert de video en
kost dus tijd: in onze test duurde een 1080p-video van 8 seconden ongeveer
5 seconden (MacBook met Apple M-chip).

### Hoe `ait logo` werkt

1. ffprobe leest de resolutie, de rotatie en de pixelverhouding van de video.
2. `ait` berekent lokaal de SHA-256 van het origineel.
3. `POST /api/v1/label/remote` registreert het label; de server ondertekent het
   manifest.
4. `ait` tekent de badge zelf als PNG: het logo uit vormen, de tekst uit de
   contouren van het lettertype. Er zijn geen npm-pakketten voor nodig.
5. ffmpeg legt de PNG met het filter `overlay` over de video en schrijft in
   dezelfde gang de AILABEL-tags (label-ID, handtekening, verify-URL en
   `AILABEL_VISIBLE`, bijv. `logo rechtsboven, hele video`).
6. `POST /api/v1/label/remote/complete` meldt de fingerprint van de video met
   logo aan het register. De verify-pagina toont de techniek
   `visible-label-overlay`.

Waarom een eigen PNG en niet het ffmpeg-filter `drawtext`? De standaard
Homebrew-ffmpeg (`brew install ffmpeg`) heeft geen `drawtext`. Het filter
`overlay` zit in elke ffmpeg.

Gebruik je een andere ffmpeg? Zet dan de omgevingsvariabelen `AIT_FFMPEG` en
`AIT_FFPROBE` op het pad. `AIT_FONT` kiest een standaardlettertype.

## Hoe het werkt

1. `ait label` berekent lokaal (streaming) de SHA-256 van het bestand.
2. `POST /api/v1/label/remote` registreert het rapport; de server bouwt en
   ondertekent het manifest op basis van die fingerprint.
3. ffmpeg bedt het compacte manifest als metadatatags in een kopie van het
   bestand.
4. `POST /api/v1/label/remote/complete` meldt ook de fingerprint van het
   gemarkeerde bestand aan het register.
5. `ait check` leest de tags (ffprobe) én raadpleegt het publieke
   hash-endpoint — ook bij controle wordt niets geüpload.

Uploadlimieten van je abonnement gelden hier niet; het aantal labels per
maand telt wel mee.

## privacy-scan — controleer bestanden vóór je ze deelt

In de map [`privacy-scan/`](privacy-scan/). Controleert bestanden op
persoonsgegevens voordat ze geüpload worden naar een AI-dienst, een analysetool
of een andere partij, met een lokaal taalmodel in LM Studio of Ollama. Geen
account, geen internetverbinding, geen bestand dat je computer verlaat.

> **Experimentele tool.** Een scan mist persoonsgegevens en meldt soms iets wat
> het niet is. Je blijft zelf verantwoordelijk voor wat je uploadt of deelt; de
> uitkomst is geen juridisch advies. Zie de
> [disclaimer](privacy-scan/README.md#disclaimer).

**Beginnen:**
[download de zip](https://github.com/learningtour/ai-transparent-toolkit/archive/refs/heads/main.zip),
pak hem uit, open de map `privacy-scan` en dubbelklik `Start Privacyscan.command`
(Mac) of `Start Privacyscan.bat` (Windows). Je browser opent een venster waar je
bestanden in sleept. Verder is er niets te installeren; alleen Python 3 moet op
de computer staan.

Of vanaf de commandoregel:

```bash
python3 privacy_scan.py                                  # het venster openen
python3 privacy_scan.py scan uploads/                    # een hele map
python3 privacy_scan.py scan dossier.docx --zonder-ai    # zonder model: alleen patronen
```

Twee lagen die elkaar aanvullen:

1. **Patronen met echte validatie** — BSN via de elfproef, IBAN via mod-97,
   betaalkaart via Luhn, plus e-mail, telefoon, postcode, geboortedatum,
   paspoort-, BIG- en leerlingnummer, wachtwoorden en sleutels. Daarnaast
   signalen voor de bijzondere categorieën van artikel 9 AVG: gezondheid,
   etniciteit, religie, politiek, seksuele geaardheid, strafrecht, biometrie —
   die wegen alleen zwaar als er in hetzelfde bestand ook iemand
   identificeerbaar is.
2. **Lokale AI** — voor namen, adressen in lopende tekst en indirect
   identificerende combinaties die je met patronen nooit betrouwbaar vindt.
   Fragmenten die het model verzint maar niet in het document staan, worden
   weggefilterd.

Leesbaar: txt, md, csv, json, html, docx, xlsx, pptx, odt, pdf, rtf. De
bestandsnaam wordt meegescand.

De exitcode maakt er een poortwachter van: **0** = onder de drempel, **2** =
persoonsgegevens gevonden (niet uploaden), **1** = fout.

```bash
python3 privacy_scan.py scan uploads/ --stil --json rapport.json || echo "eerst opschonen"
```

Waarden staan gemaskeerd in het rapport (`11•••••33`), het venster luistert
alleen op `127.0.0.1`, en een niet-lokale AI-server wordt geweigerd tenzij je
daar expliciet om vraagt. Meer: [privacy-scan/README.md](privacy-scan/README.md) en de
[handleiding](privacy-scan/HANDLEIDING.md).

## English

Local labeling of large video/audio files under Article 50 of the EU AI Act.
Files never leave your machine: only a SHA-256 fingerprint plus metadata go to
app.aitransparent.eu, which signs and registers the manifest; ffmpeg then
embeds the label locally (stream copy). Requires an
[AI Transparent](https://aitransparent.eu) API key (Pro/Premium) — labeling
does not work without the service. `ait check` (detection) is public and
needs no account.

`ait logo <video>` burns a visible AI Transparent badge (logo plus a short
disclosure such as "AI-generated") into a corner of the video, then labels the
result the same way: signed in the registry, with the label ID and verify URL
in the file's metadata. Options: `--positie lb|rb|lo|ro` (also `top-left` etc.,
default top right), `--seconden <n>` (first *n* seconds only; default the whole
video), `--tekst "…"`, `--geen-tekst`, `--met-id`, `--grootte <factor>`,
`--voorbeeld` (render one PNG frame, no label). The badge scales with the
shorter side of the frame (1/16) and is rendered in Node itself and composited
with ffmpeg's `overlay` filter, so no `drawtext`/libfreetype is needed.

`privacy-scan` (in [`privacy-scan/`](privacy-scan/)) scans files for personal
data *before* they are uploaded to an AI service or shared with anyone else,
using deterministic checks (BSN eleven-proof, IBAN mod-97, Luhn) plus a local
LLM served by LM Studio or Ollama. Nothing is sent anywhere — no account, no
internet. Ships as a single Python file (`privacy_scan.py`, standard library
only) with double-click starters for macOS and Windows.

**This tool is experimental.** A scan misses personal data and sometimes flags
things that are not. You remain responsible for whatever you upload to an AI
system or share with third parties; the output is not legal advice and does not
establish compliance with the GDPR or any other law. Provided without any
warranty. See [privacy-scan/README.md](privacy-scan/README.md).

---

© LearningTour · [aitransparent.eu](https://aitransparent.eu) ·
Dit is een hulpmiddel voor naleving en vormt geen juridisch advies.
