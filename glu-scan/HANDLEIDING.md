# glu-scan — handleiding

Alle opties en achtergrond. Wil je alleen downloaden en beginnen, lees dan de
[README](README.md).

Satelliet van de **GLU Analysetool**. Controleert bestanden op persoonsgegevens
vóórdat je ze uploadt. De hele scan draait op je eigen machine: patronen met
echte validatie plus een lokaal taalmodel in **LM Studio**, **Ollama** of
llama.cpp. Er gaat geen byte naar een clouddienst.

De redenering erachter is dezelfde als bij `ait label`: wat gevoelig is, hoort
niet zomaar op een server terecht te komen — ook niet bij de controle daarop.

## Snel beginnen

Kant-en-klaar programma voor Mac of Windows:
[releasepagina](https://github.com/learningtour/ai-transparent-toolkit/releases)
→ uitpakken → dubbelklik **Start GLU Scan**.

Vanuit de broncode, met Node 20+:

```bash
git clone https://github.com/learningtour/ai-transparent-toolkit.git
cd ai-transparent-toolkit/glu-scan
npm link                    # maakt het commando `glu-scan` beschikbaar

glu-scan ui                 # web-app: sleep je bestanden erin
glu-scan scan uploads/      # of vanaf de commandoregel
```

De scanner gebruikt geen npm-dependencies; alleen het bouwen van het
zelfstandige programma doet dat.

## Een lokaal model klaarzetten

**LM Studio** (het makkelijkst): installeer LM Studio, download een instruct-model
(bijvoorbeeld `qwen2.5-7b-instruct` of `llama-3.1-8b-instruct`), open het tabblad
**Developer** en zet de server op **Running**. Standaard luistert die op
`http://localhost:1234/v1` — precies wat `glu-scan` verwacht.

**Ollama**:

```bash
ollama pull llama3.1
glu-scan config --endpoint http://localhost:11434/v1 --model llama3.1
```

Controleren of het werkt:

```bash
glu-scan modellen
```

Geen model? Dan werkt de patrooncontrole gewoon door:

```bash
glu-scan scan dossier.docx --zonder-ai
```

## De twee lagen van de scan

**1. Patronen — exact, snel, geen model nodig.**
Niet alleen "ziet eruit als", maar echt gevalideerd:

| Gegeven | Controle | Ernst |
|---|---|---|
| Burgerservicenummer | elfproef (9·d₁ + 8·d₂ … 2·d₈ − d₉ ≡ 0 mod 11) | hoog |
| Betaalkaartnummer | Luhn | hoog |
| Wachtwoord, API-sleutel, token | patroon + context | hoog |
| DigiD-gegevens | patroon + context | hoog |
| IBAN | mod-97 (ISO 13616) | middel |
| E-mailadres, telefoonnummer | patroon (voorbeelddomeinen uitgesloten) | middel |
| Postcode, geboortedatum | patroon + contextwoorden | middel |
| Paspoort-, BIG-, leerlingnummer | patroon + contextwoorden | middel |
| Kenteken, IP-adres | patroon | laag |

Daarnaast trefwoordsignalen voor de **bijzondere categorieën van artikel 9 AVG**:
gezondheid, etniciteit, religie, politieke opvatting en vakbond, seksuele
geaardheid, strafrechtelijke gegevens, biometrie. Die worden per categorie
samengevat in één bevinding met de aangetroffen termen.

Zo'n signaal weegt alleen zwaar als er in hetzelfde bestand ook iemand
identificeerbaar is. Een handleiding *over* ADHD is geen dossier *van* een
leerling met ADHD: staat er geen naam, BSN, adres of ander identificerend
gegeven bij, dan komt het onderwerp als `laag` in het rapport, met de
kanttekening dat combinatie met andere bronnen alsnog herleidbaar kan zijn.

**2. Lokale AI — voor wat patronen missen.**
Namen, adressen in lopende tekst, indirect identificerende combinaties
("de enige docent Frans in het team, geboren in 1974"), en of een
gezondheidsterm daadwerkelijk over een persoon gaat. Antwoorden van het model
worden gecontroleerd: een fragment dat niet letterlijk in het document staat,
wordt weggegooid. Zo komt een hallucinatie niet in het rapport terecht.

De twee lagen worden samengevoegd en ontdubbeld; bij een dubbele treffer wint de
patrooncontrole, want die is aantoonbaar.

## Wat er gelezen kan worden

| Type | Hoe |
|---|---|
| txt, md, csv, json, xml, html, srt, code | direct |
| docx, xlsx, pptx, odt, ods, odp | zip + inflate, ingebouwd |
| pdf | `pdftotext` (poppler) als het geïnstalleerd is, anders de ingebouwde extractor |
| rtf | ingebouwd |
| png, jpg, webp… | alleen met `--visie` en een visiemodel (bv. `qwen2-vl`) |
| mp4, mp3, mov… | niet gelezen — komt als "handmatig controleren" in het rapport |

Ook de **bestandsnaam** wordt gescand: `verzuim_jan_de_vries_BSN.pdf` lekt al
voordat iemand het bestand opent.

## Oordeel en exitcode

| Oordeel | Betekenis |
|---|---|
| `geen` | niets gevonden — uploaden kan |
| `laag` | licht identificerend (IP, kenteken) |
| `middel` | persoonsgegevens: naam, adres, e-mail, IBAN, geboortedatum |
| `hoog` | BSN, gezondheid en andere art. 9-gegevens, wachtwoorden, betaalkaart |
| `onbekend` | bestand niet leesbaar — zelf controleren |

De exitcode maakt de scan bruikbaar als poortwachter in een script of
uploadknop: **0** = onder de drempel, **2** = boven de drempel (niet uploaden),
**1** = fout. De drempel staat standaard op `middel`:

```bash
glu-scan scan uploads/ --stil --json rapport.json || {
  echo "Er staan persoonsgegevens in — upload geblokkeerd."
  exit 1
}
```

## Opties

```
glu-scan scan <bestand of map…>
  --zonder-ai            alleen patrooncontrole
  --visie                afbeeldingen laten lezen door een visiemodel
  --redigeer             geschoonde kopie schrijven (alleen platte tekst)
  --toon-waarden         waarden volledig tonen (standaard gemaskeerd)
  --json [pad]           JSON-rapport (zonder pad naar stdout)
  --html <pad>           HTML-rapport
  --drempel laag|middel|hoog
  --endpoint <url>       lokale AI-server
  --model <naam>
  --max-stukken <n>      hoeveel tekstblokken maximaal naar de AI gaan
  --stil                 geen uitvoer, alleen exitcode en rapporten

glu-scan ui [--poort 7817]     lokale web-app
glu-scan modellen              welke modellen draaien er lokaal?
glu-scan config [--…]          instellingen tonen of wijzigen
```

Instellingen staan in `~/.config/ai-transparent/glu-scan.json` (0600).

## Redigeren

```bash
glu-scan scan notulen.txt --redigeer
# → notulen.geschoond.txt
```

Gevonden waarden worden vervangen door `[GEREDIGEERD:bsn]`, `[GEREDIGEERD:naam]`
enzovoort. Trefwoorden van bijzondere categorieën blijven staan: "diagnose"
weghalen maakt de tekst onleesbaar zonder iemand te beschermen. Redigeren werkt
alleen op platte tekst — bij docx of pdf zou de opmaak sneuvelen. Controleer het
resultaat altijd zelf.

## Privacy van de scanner zelf

- De web-app luistert uitsluitend op `127.0.0.1` en weigert verzoeken van buiten.
- Uploads in de web-app gaan naar een tijdelijk bestand (0600) dat direct na de
  scan wordt verwijderd.
- Rapporten tonen waarden **gemaskeerd** (`11•••••33`), tenzij je
  `--toon-waarden` gebruikt. Een privacyrapport vol persoonsgegevens verplaatst
  het probleem alleen maar.
- Een niet-lokaal AI-endpoint wordt geweigerd; wie dat toch wil, moet
  `--sta-extern` opgeven en krijgt een waarschuwing.

## Grenzen

Een scan is een hulpmiddel, geen garantie en geen juridisch advies.

- Namen zonder context worden door patronen gemist; daar is het model voor —
  en ook dat mist er soms een. Blijf zelf kijken.
- Gescande pdf's zonder tekstlaag leveren niets op; die krijgen het oordeel
  `onbekend`, niet `geen`.
- Kleine modellen (< 7B) melden vaker onzin of missen juist dingen. Voor serieus
  werk is een instruct-model van 7B of groter met een lange context prettiger.
- Alleen de eerste `--max-stukken` blokken tekst gaan naar de AI (standaard 40,
  circa 240.000 tekens); de patrooncontrole loopt wel over de hele tekst.

## Testen

```bash
cd glu-scan
npm test
```

De testsuite draait de AI-kant tegen een nagebootste LM Studio-server, dus er
hoeft geen model geïnstalleerd te zijn om de keten te controleren.

## Zelf een zelfstandig programma bouwen

```bash
cd glu-scan
npm install
npm run build
```

Het resultaat komt in `glu-scan/dist/` en werkt zonder dat Node.js
geïnstalleerd is. De bouwstap bundelt alle modules tot één bestand (esbuild),
maakt daar een startblok van (Node's *single executable application*) en plakt
dat in een kopie van Node zelf (postject). Op macOS wordt het resultaat opnieuw
ondertekend, anders weigert het systeem het te starten.

Bouwen kan alleen voor het besturingssysteem waar je op werkt. Alle platforms
tegelijk gaat via GitHub: push een tag `glu-scan-v1.0.0` en
`.github/workflows/glu-scan.yml` bouwt Mac (Apple Silicon en Intel), Windows en
Linux, en hangt de zip-bestanden onder Releases.

De programma's zijn **niet ondertekend** bij Apple of Microsoft. Gebruikers
krijgen daarom eenmalig een waarschuwing (zie `build/starters/LEESMIJ.txt`).
Wil je die waarschuwing weg, dan is een Apple Developer-account met
notarisatie en een Windows-codesigningcertificaat nodig; die stap zit bewust
niet in dit script, want daar horen sleutels bij die niet in een repository
thuishoren.
