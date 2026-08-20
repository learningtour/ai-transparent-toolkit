# glu-scan — privacyscan vóór upload

Controleer bestanden op persoonsgegevens *voordat* je ze in de **GLU
Analysetool** zet. Alles gebeurt op je eigen computer: er gaat geen bestand
naar internet, er is geen account nodig, en zonder internetverbinding werkt
het net zo goed.

Onderdeel van de [AI Transparent toolkit](../README.md).

## Beginnen

Download deze drie bestanden (knop **Code → Download ZIP** bovenaan de
repository, of los via *Raw*):

- `glu_scan.py` — het programma zelf, één bestand
- `Start GLU Scan.command` — startknop voor Mac
- `Start GLU Scan.bat` — startknop voor Windows

Zet ze in dezelfde map en dubbelklik de startknop voor jouw computer. Je
browser opent een venster waar je bestanden in sleept. Klaar.

Werkt het dubbelklikken niet, dan kan het ook vanaf de commandoregel:

```bash
python3 glu_scan.py            # het venster openen
```

> **Python nodig.** Mac en Windows leveren Python tegenwoordig niet meer
> standaard mee. Is het er nog niet, dan zegt de startknop dat en verwijst hij
> naar [python.org/downloads](https://www.python.org/downloads/) — gratis, één
> installatie van een paar minuten. Zet op Windows bij het installeren het
> vinkje bij *Add python.exe to PATH*. Verder is er niets te installeren: het
> programma gebruikt alleen wat in Python zelf zit.

## Zonder AI werkt het al — mét AI ziet het meer

Direct na het starten doet de scan de **patrooncontrole**: burgerservicenummer
(nagerekend met de elfproef), IBAN (mod-97), betaalkaart (Luhn), e-mailadres,
telefoonnummer, postcode, geboortedatum, paspoort-, BIG- en leerlingnummer,
wachtwoorden en sleutels, plus signalen voor de bijzondere categorieën van
artikel 9 AVG.

Wil je ook **namen en adressen in lopende tekst** laten herkennen, en
combinaties die iemand indirect identificeren? Installeer dan
[LM Studio](https://lmstudio.ai), download een instruct-model (bijvoorbeeld
`qwen2.5-7b-instruct`) en zet in het tabblad *Developer* de server op
*Running*. De scan vindt hem vanzelf op `http://localhost:1234/v1`. Ook dat
model draait op je eigen computer.

[Ollama](https://ollama.com) kan ook:

```bash
ollama pull llama3.1
python3 glu_scan.py config --endpoint http://localhost:11434/v1 --model llama3.1
```

Draait er geen model, dan zegt het venster dat en gaat de patrooncontrole
gewoon door.

## Wat er gelezen wordt

txt, md, csv, json, xml, html, docx, xlsx, pptx, odt, ods, odp, pdf, rtf en
broncode. Audio en video worden niet getranscribeerd, afbeeldingen niet
gelezen; die krijgen het advies om zelf te kijken. Ook de **bestandsnaam**
wordt gescand, want `verzuim_jan_de_vries_BSN.pdf` lekt al voordat iemand het
bestand opent.

## Ook vanaf de commandoregel

```bash
python3 glu_scan.py scan uploads/                        # een hele map
python3 glu_scan.py scan dossier.docx --zonder-ai        # zonder model
python3 glu_scan.py scan uploads/ --html rapport.html    # rapport bewaren
python3 glu_scan.py scan notulen.txt --redigeer          # geschoonde kopie
```

De exitcode maakt er een poortwachter van: **0** = onder de drempel, **2** =
persoonsgegevens gevonden (niet uploaden), **1** = fout.

```bash
python3 glu_scan.py scan uploads/ --stil --json rapport.json || echo "eerst opschonen"
```

Alle opties en achtergrond staan in de [handleiding](HANDLEIDING.md).

## Testen

```bash
python3 -m unittest -v
```

28 tests. De AI-kant draait tegen een nagebootste LM Studio-server, dus er
hoeft geen model geïnstalleerd te zijn.

## Twee versies, dezelfde scan

| | |
|---|---|
| `glu_scan.py` | Eén Python-bestand. Dit is de versie om te downloaden en te gebruiken. |
| `glu-scan.js` + `lib/` | Dezelfde scanner in Node.js, voor wie al met `ait` uit deze toolkit werkt. `cd glu-scan && npm link`, daarna `glu-scan ui`. |

Ze doen hetzelfde en tonen hetzelfde venster.

## Privacy van de scanner zelf

- Het venster luistert alleen op `127.0.0.1` en weigert verzoeken van buiten.
- Bestanden die je erin sleept, gaan naar een tijdelijk bestand (alleen
  leesbaar voor jou) dat direct na de scan wordt verwijderd.
- Rapporten tonen waarden **gemaskeerd** (`11•••••33`), tenzij je
  `--toon-waarden` gebruikt.
- Een AI-server die niet op je eigen computer draait, wordt geweigerd tenzij je
  daar expliciet om vraagt met `--sta-extern`.

Een scan is een hulpmiddel, geen garantie en geen juridisch advies. Controleer
altijd zelf wat je uploadt.
