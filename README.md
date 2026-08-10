# AI Transparent toolkit

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
beeld (Art. 50(5): melden bij eerste blootstelling). Dat hercodeert de video;
zonder `--badge` is het pure stream copy zonder kwaliteitsverlies.

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

## English

Local labeling of large video/audio files under Article 50 of the EU AI Act.
Files never leave your machine: only a SHA-256 fingerprint plus metadata go to
app.aitransparent.eu, which signs and registers the manifest; ffmpeg then
embeds the label locally (stream copy). Requires an
[AI Transparent](https://aitransparent.eu) API key (Pro/Premium) — labeling
does not work without the service. `ait check` (detection) is public and
needs no account.

---

© LearningTour · [aitransparent.eu](https://aitransparent.eu) ·
Dit is een hulpmiddel voor naleving en vormt geen juridisch advies.
