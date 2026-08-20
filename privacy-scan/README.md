# privacy-scan — controleer bestanden vóór je ze deelt

Controleer bestanden op persoonsgegevens *voordat* je ze uploadt naar een
AI-dienst, een analysetool of een andere partij. Alles gebeurt op je eigen
computer: er gaat geen bestand naar internet, er is geen account nodig, en
zonder internetverbinding werkt het net zo goed.

> **Experimentele tool.** Een scan mist persoonsgegevens en meldt soms iets wat
> het niet is. Je blijft zelf verantwoordelijk voor wat je uploadt naar een
> AI-systeem of deelt met derden. Zie [Disclaimer](#disclaimer).

## Direct aan de slag

**1. Download** →
[**privacy-scan downloaden (zip)**](https://github.com/learningtour/ai-transparent-toolkit/archive/refs/heads/main.zip)

**2. Uitpakken** en de map `privacy-scan` openen.

**3. Dubbelklik de startknop:**

| Jouw computer | Dubbelklik |
|---|---|
| Mac | `Start Privacyscan.command` |
| Windows | `Start Privacyscan.bat` |

Je browser opent een venster. Sleep daar de bestanden in die je wilt uploaden,
en je ziet meteen wat erin staat aan persoonsgegevens. Sluit het zwarte venster
om te stoppen.

> **Python nodig — één keer.** Mac en Windows leveren Python tegenwoordig niet
> meer standaard mee. Ontbreekt het, dan zegt de startknop dat en verwijst hij
> naar [python.org/downloads](https://www.python.org/downloads/): gratis, een
> paar minuten. Zet op Windows bij het installeren het vinkje bij *Add
> python.exe to PATH*. Verder is er niets te installeren — de scanner is één
> bestand (`privacy_scan.py`) dat alleen gebruikt wat in Python zelf zit.

> **Mac waarschuwt de eerste keer.** Klik met rechts (of Ctrl+klik) op
> `Start Privacyscan.command` → *Openen* → nogmaals *Openen*. Dat is eenmalig;
> daarna volstaat dubbelklikken.

Liever vanaf de commandoregel?

```bash
python3 privacy_scan.py               # het venster openen
python3 privacy_scan.py scan uploads/ # of meteen een map scannen
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
python3 privacy_scan.py config --endpoint http://localhost:11434/v1 --model llama3.1
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
python3 privacy_scan.py scan uploads/                        # een hele map
python3 privacy_scan.py scan dossier.docx --zonder-ai        # zonder model
python3 privacy_scan.py scan uploads/ --html rapport.html    # rapport bewaren
python3 privacy_scan.py scan notulen.txt --redigeer          # geschoonde kopie
```

De exitcode maakt er een poortwachter van: **0** = onder de drempel, **2** =
persoonsgegevens gevonden (niet uploaden), **1** = fout.

```bash
python3 privacy_scan.py scan uploads/ --stil --json rapport.json || echo "eerst opschonen"
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

## Disclaimer

**Deze tool is experimenteel.** Een scan is een hulpmiddel, geen garantie.

- De scan **mist persoonsgegevens** (zeker namen zonder duidelijke context, en
  tekst in afbeeldingen of gescande pdf's) en **meldt soms iets wat het niet
  is**. Beoordeel de uitslag altijd zelf.
- **Jij blijft verantwoordelijk** voor wat je uploadt naar een AI-systeem of
  deelt met derden. Een groene uitslag is geen toestemming en geen vrijwaring.
- De uitkomst is **geen juridisch advies** en toont **geen naleving aan** van de
  AVG, de GDPR of enige andere wet. Twijfel je over een grondslag of een
  verwerkersovereenkomst, raadpleeg dan een jurist of je functionaris
  gegevensbescherming.
- Zet je met `--sta-extern` een AI-server buiten je eigen computer in, dan gaat
  de inhoud van je bestanden naar die server. Dat is jouw keuze en jouw
  verantwoordelijkheid.
- Geleverd **zonder enige garantie**, onder de [MIT-licentie](../LICENSE): de
  makers zijn niet aansprakelijk voor schade die uit het gebruik voortvloeit.

### Disclaimer (English)

**This tool is experimental.** A scan is an aid, not a guarantee.

- It **misses personal data** (especially names without clear context, and text
  in images or scanned PDFs) and sometimes **flags things that are not**. Always
  review the results yourself.
- **You remain responsible** for whatever you upload to an AI system or share
  with third parties. A clean result is neither permission nor indemnity.
- The output is **not legal advice** and **does not establish compliance** with
  the GDPR, the EU AI Act, or any other law. When in doubt about a lawful basis
  or a processing agreement, consult a lawyer or your data protection officer.
- If you point it at an AI server outside your own machine with `--sta-extern`,
  your file contents go to that server. That is your choice and your
  responsibility.
- Provided **without any warranty** under the [MIT licence](../LICENSE): the
  authors are not liable for any damages arising from its use.
