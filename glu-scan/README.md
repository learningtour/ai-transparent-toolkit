# glu-scan — privacyscan vóór upload

Controleer bestanden op persoonsgegevens *voordat* je ze in de **GLU
Analysetool** zet. Alles gebeurt op je eigen computer: er gaat geen bestand
naar internet, er is geen account nodig, en zonder internetverbinding werkt het
net zo goed.

## Direct aan de slag

**1. Download** →
[**glu-scan downloaden (zip)**](https://github.com/learningtour/ai-transparent-toolkit/archive/refs/heads/main.zip)

**2. Uitpakken** en de map `glu-scan` openen.

**3. Dubbelklik de startknop:**

| Jouw computer | Dubbelklik |
|---|---|
| Mac | `Start GLU Scan.command` |
| Windows | `Start GLU Scan.bat` |

Je browser opent een venster. Sleep daar de bestanden in die je wilt uploaden,
en je ziet meteen wat erin staat aan persoonsgegevens. Sluit het zwarte venster
om te stoppen.

> **Python nodig — één keer.** Mac en Windows leveren Python tegenwoordig niet
> meer standaard mee. Ontbreekt het, dan zegt de startknop dat en verwijst hij
> naar [python.org/downloads](https://www.python.org/downloads/): gratis, een
> paar minuten. Zet op Windows bij het installeren het vinkje bij *Add
> python.exe to PATH*. Verder is er niets te installeren — de scanner is één
> bestand (`glu_scan.py`) dat alleen gebruikt wat in Python zelf zit.

> **Mac waarschuwt de eerste keer.** Klik met rechts (of Ctrl+klik) op
> `Start GLU Scan.command` → *Openen* → nogmaals *Openen*. Dat is eenmalig;
> daarna volstaat dubbelklikken.

Liever vanaf de commandoregel?

```bash
python3 glu_scan.py               # het venster openen
python3 glu_scan.py scan uploads/ # of meteen een map scannen
```

Onderdeel van de [AI Transparent toolkit](../README.md).

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
hoeft geen model geïnstalleerd te zijn om de hele keten te controleren.

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
