# glu-scan — privacyscan vóór upload

Satelliet van de **GLU Analysetool**. Controleer bestanden op persoonsgegevens
*voordat* je ze uploadt. Alles gebeurt op je eigen computer: er gaat geen
bestand naar internet, er is geen account nodig, en zonder internetverbinding
werkt het net zo goed.

Onderdeel van de [AI Transparent toolkit](../README.md).

## Downloaden en starten

Ga naar de
[releasepagina](https://github.com/learningtour/ai-transparent-toolkit/releases)
en pak het bestand voor jouw computer:

| Download | Voor |
|---|---|
| `glu-scan-macos-arm64.zip` | Mac met Apple-chip (M1 en nieuwer) |
| `glu-scan-macos-x64.zip` | Mac met Intel-processor |
| `glu-scan-windows-x64.zip` | Windows |
| `glu-scan-linux-x64.zip` | Linux |

Uitpakken en dubbelklikken op **Start GLU Scan** (`.command` op Mac, `.bat` op
Windows). Je browser opent met een venster waar je bestanden in sleept. Klaar.

Node.js hoeft niet geïnstalleerd te zijn — dat zit in het bestand (vandaar de
omvang van ongeveer 120 MB).

> **De eerste keer waarschuwt je computer.** Het programma is niet ondertekend
> bij Apple of Microsoft, dus het systeem weet niet wie de maker is. Op Mac:
> klik met rechts op het bestand → *Openen* → nogmaals *Openen*. Op Windows:
> *Meer informatie* → *Toch uitvoeren*. Daarna start het gewoon met
> dubbelklikken. Ondertekenen kan alleen met een betaald ontwikkelaarsaccount
> bij Apple en Microsoft; zolang dat er niet is, hoort deze waarschuwing erbij.

## Zonder AI werkt het ook — mét AI ziet het meer

Direct na het starten doet de scan de **patrooncontrole**: burgerservicenummer
(met de elfproef), IBAN (mod-97), betaalkaart (Luhn), e-mailadres,
telefoonnummer, postcode, geboortedatum, paspoort-, BIG- en leerlingnummer,
wachtwoorden en sleutels, plus signalen voor de bijzondere categorieën van
artikel 9 AVG.

Wil je ook **namen en adressen in lopende tekst** laten herkennen, en
combinaties die iemand indirect identificeren? Installeer dan
[LM Studio](https://lmstudio.ai), download een instruct-model (bijvoorbeeld
`qwen2.5-7b-instruct`) en zet in het tabblad *Developer* de server op
*Running*. De scan vindt hem vanzelf op `http://localhost:1234/v1`. Ook dat
model draait op je eigen machine.

[Ollama](https://ollama.com) kan ook:

```bash
ollama pull llama3.1
glu-scan config --endpoint http://localhost:11434/v1 --model llama3.1
```

## Wat er gelezen wordt

txt, md, csv, json, xml, html, docx, xlsx, pptx, odt, ods, odp, pdf, rtf en
broncode. Afbeeldingen alleen met een visiemodel (`--visie`). Audio en video
worden niet getranscribeerd; die krijgen het advies om zelf te kijken. Ook de
**bestandsnaam** wordt gescand, want `verzuim_jan_de_vries_BSN.pdf` lekt al
voordat iemand het bestand opent.

## Ook vanaf de commandoregel

```bash
glu-scan ui                     # de web-app (hetzelfde als dubbelklikken)
glu-scan scan uploads/          # een map in één keer
glu-scan scan dossier.docx --zonder-ai --html rapport.html
```

De exitcode maakt er een poortwachter van: **0** = onder de drempel, **2** =
persoonsgegevens gevonden (niet uploaden), **1** = fout.

```bash
glu-scan scan uploads/ --stil --json rapport.json || echo "eerst opschonen"
```

Alle opties en achtergrond staan in de [handleiding](HANDLEIDING.md).

## Zelf draaien vanuit de broncode

Met [Node 20+](https://nodejs.org):

```bash
git clone https://github.com/learningtour/ai-transparent-toolkit.git
cd ai-transparent-toolkit/glu-scan
npm link          # maakt het commando `glu-scan` beschikbaar
npm test          # 29 tests, geen model nodig
```

De scanner zelf gebruikt **geen npm-dependencies**; alleen het bouwen van het
zelfstandige programma doet dat (esbuild en postject, zie `build/bouw.mjs`).

## Zelf een programma bouwen

```bash
npm install
npm run build     # resultaat in dist/
```

Dit bouwt voor het systeem waar je op zit — een Mac-programma maak je op een
Mac. De GitHub Action `.github/workflows/glu-scan.yml` doet alle platforms
tegelijk zodra er een tag `glu-scan-v…` gepusht wordt.

## Privacy van de scanner zelf

- De web-app luistert alleen op `127.0.0.1` en weigert verzoeken van buiten.
- Bestanden die je in het venster sleept, gaan naar een tijdelijk bestand
  (alleen leesbaar voor jou) dat direct na de scan wordt verwijderd.
- Rapporten tonen waarden **gemaskeerd** (`11•••••33`), tenzij je
  `--toon-waarden` gebruikt.
- Een AI-endpoint dat niet op je eigen machine draait, wordt geweigerd tenzij
  je daar expliciet om vraagt met `--sta-extern`.

Een scan is een hulpmiddel, geen garantie en geen juridisch advies. Controleer
altijd zelf wat je uploadt.
