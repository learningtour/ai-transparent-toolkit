#!/usr/bin/env python3
"""Tests voor privacy_scan.py. Draaien met:  python3 -m unittest -v

De AI-kant wordt getest tegen een nagebootste LM Studio-server, zodat de hele
keten (endpoint → JSON → filtering → oordeel) getest is zonder dat er een model
geïnstalleerd hoeft te zijn.
"""

import json
import os
import tempfile
import threading
import unittest
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import privacy_scan as g


def schrijf(map_, naam, inhoud):
    pad = Path(map_) / naam
    if isinstance(inhoud, bytes):
        pad.write_bytes(inhoud)
    else:
        pad.write_text(inhoud, encoding="utf-8")
    return pad


class NagebootstModel:
    """Een minimale LM Studio-server voor de tests."""

    def __init__(self, antwoord, weiger_json_modus=False):
        buiten = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _stuur(self, code, data):
                ruw = json.dumps(data).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(ruw)))
                self.end_headers()
                self.wfile.write(ruw)

            def do_GET(self):
                self._stuur(200, {"data": [{"id": "test-model-7b"}]})

            def do_POST(self):
                lengte = int(self.headers.get("Content-Length") or 0)
                verzoek = json.loads(self.rfile.read(lengte) or b"{}")
                if buiten.weiger_json_modus and "response_format" in verzoek:
                    return self._stuur(400, {"error": "response_format niet ondersteund"})
                self._stuur(200, {"choices": [{"message": {"content": buiten.antwoord}}]})

        self.antwoord = antwoord
        self.weiger_json_modus = weiger_json_modus
        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.endpoint = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()


class TestValidators(unittest.TestCase):
    def test_bsn_elfproef(self):
        self.assertTrue(g.geldig_bsn("111222333"))
        self.assertTrue(g.geldig_bsn("123456782"))
        self.assertFalse(g.geldig_bsn("123456789"))
        self.assertFalse(g.geldig_bsn("000000000"))
        self.assertFalse(g.geldig_bsn("11122233"))

    def test_iban_mod97(self):
        self.assertTrue(g.geldig_iban("NL91ABNA0417164300"))
        self.assertTrue(g.geldig_iban("NL91 ABNA 0417 1643 00"))
        self.assertTrue(g.geldig_iban("DE89370400440532013000"))
        self.assertFalse(g.geldig_iban("NL91ABNA0417164301"))

    def test_luhn(self):
        self.assertTrue(g.geldig_luhn("4539578763621486"))
        self.assertFalse(g.geldig_luhn("4539578763621487"))
        self.assertFalse(g.geldig_luhn("1111111111111111"))

    def test_maskeren_lekt_niet(self):
        self.assertEqual(g.maskeer("111222333"), "11•••••33")
        self.assertTrue(g.maskeer("jan.jansen@school.nl").endswith("@school.nl"))
        self.assertNotIn("jansen", g.maskeer("jan.jansen@school.nl"))
        self.assertEqual(g.maskeer("abc"), "•••")


class TestPatronen(unittest.TestCase):
    def soorten(self, tekst):
        return {b["type"] for b in g.zoek_patronen(tekst)}

    def test_kerngegevens(self):
        tekst = "\n".join([
            "Leerling: Jan de Vries", "BSN: 111222333", "IBAN NL91ABNA0417164300",
            "E-mail: jan@school.nl", "Telefoon 06-12345678", "Postcode 3512 JD",
            "Geboortedatum: 14-03-2009",
        ])
        gevonden = self.soorten(tekst)
        for verwacht in ("bsn", "iban", "email", "telefoon", "postcode", "geboortedatum", "naam"):
            self.assertIn(verwacht, gevonden)

    def test_ruis_wordt_genegeerd(self):
        self.assertEqual(g.zoek_patronen("Mail naar info@example.com. Vergadering op 12-05-2024."), [])

    def test_nummer_aan_het_eind_van_een_zin(self):
        # Een te strenge lookahead miste eerder "BSN 111222333." met een punt.
        self.assertIn("bsn", self.soorten("BSN 111222333."))
        self.assertIn("bsn", self.soorten("(BSN 111222333)"))
        self.assertIn("telefoon", self.soorten("Bel 06-12345678."))
        self.assertNotIn("bsn", self.soorten("Ordernummer 400123456789 uit 2024"))
        self.assertNotIn("bsn", self.soorten("versie 1.111222333.2 van het bestand"))

    def test_bsn_telt_niet_ook_als_leerlingnummer(self):
        gevonden = g.zoek_patronen("Leerlingnummer en BSN staan hier: 111222333")
        self.assertEqual(len([b for b in gevonden if b["type"] == "bsn"]), 1)
        self.assertEqual([b for b in gevonden if b["type"] == "leerlingnummer"], [])

    def test_bijzondere_categorie_is_een_regel(self):
        gevonden = [b for b in g.zoek_patronen("Diagnose ADHD, medicatie via de huisarts, therapie loopt.")
                    if b["type"] == "gezondheid"]
        self.assertEqual(len(gevonden), 1)
        self.assertGreaterEqual(len(gevonden[0]["termen"]), 3)
        self.assertEqual(gevonden[0]["gemaskeerd"], gevonden[0]["waarde"])   # trefwoorden niet maskeren

    def test_wachtwoorden(self):
        gevonden = g.zoek_patronen("wachtwoord: Zomer2025! en api_key=sk-abcdefghijklmnopqrst")
        self.assertTrue(any(b["type"] == "geheim" and b["ernst"] == "hoog" for b in gevonden))


class TestExtractie(unittest.TestCase):
    def setUp(self):
        self.map = tempfile.mkdtemp(prefix="privacy-scan-test-")

    def test_platte_tekst(self):
        pad = schrijf(self.map, "notitie.md", "# Titel\nBSN 111222333\n")
        uit = g.haal_tekst(pad)
        self.assertEqual(uit["soort"], "tekst")
        self.assertIn("111222333", uit["tekst"])

    def test_docx(self):
        pad = Path(self.map) / "test.docx"
        with zipfile.ZipFile(pad, "w") as archief:
            archief.writestr("word/document.xml",
                             "<w:document><w:body><w:p><w:r><w:t>BSN 111222333</w:t>"
                             "</w:r></w:p></w:body></w:document>")
        uit = g.haal_tekst(pad)
        self.assertEqual(uit["soort"], "document")
        self.assertIn("111222333", uit["tekst"])

    def test_afbeelding_wordt_gemarkeerd(self):
        pad = schrijf(self.map, "foto.png", b"\x89PNG\r\n\x1a\n")
        uit = g.haal_tekst(pad)
        self.assertFalse(uit["leesbaar"])
        self.assertIn("zelf", uit["notitie"])

    def test_stukken_met_overlap(self):
        tekst = "\n".join(f"regel {i}" for i in range(300))
        stukken = g.in_stukken(tekst, 500, 50)
        self.assertGreater(len(stukken), 3)
        self.assertTrue(all(len(s) <= 500 for s in stukken))


class TestLokaleAi(unittest.TestCase):
    def test_endpoint_moet_lokaal_zijn(self):
        self.assertTrue(g.is_lokaal("http://localhost:1234/v1"))
        self.assertTrue(g.is_lokaal("http://127.0.0.1:11434/v1"))
        self.assertTrue(g.is_lokaal("http://192.168.1.20:1234/v1"))
        self.assertFalse(g.is_lokaal("https://api.openai.com/v1"))

    def test_verzinsels_worden_weggefilterd(self):
        antwoord = "```json\n" + json.dumps({
            "bevindingen": [
                {"type": "naam", "label": "Naam van een leerling", "ernst": "middel",
                 "fragment": "Pieter van Dijk", "toelichting": "direct identificerend", "zekerheid": "hoog"},
                {"type": "gezondheid", "label": "Verzonnen", "ernst": "hoog",
                 "fragment": "staat niet in de tekst", "toelichting": "hallucinatie"},
            ],
            "samenvatting": "aanmeldformulier met naam",
        }) + "\n```"
        with NagebootstModel(antwoord) as model:
            bevindingen, samenvatting = g.analyseer_tekst(
                {"endpoint": model.endpoint, "model": "test-model-7b"},
                "Aanmeldformulier van Pieter van Dijk, groep 8.")
        self.assertEqual(len(bevindingen), 1)
        self.assertEqual(bevindingen[0]["waarde"], "Pieter van Dijk")
        self.assertEqual(samenvatting, "aanmeldformulier met naam")

    def test_server_zonder_json_modus(self):
        with NagebootstModel('{"bevindingen":[],"samenvatting":"niets gevonden"}',
                             weiger_json_modus=True) as model:
            bevindingen, samenvatting = g.analyseer_tekst(
                {"endpoint": model.endpoint, "model": "x"}, "Neutrale tekst.")
        self.assertEqual(bevindingen, [])
        self.assertEqual(samenvatting, "niets gevonden")

    def test_modellenlijst(self):
        with NagebootstModel("{}") as model:
            self.assertEqual(g.modellen(model.endpoint), ["test-model-7b"])


class TestScan(unittest.TestCase):
    def setUp(self):
        self.map = tempfile.mkdtemp(prefix="privacy-scan-test-")

    def test_patronen_en_ai_samen(self):
        antwoord = json.dumps({
            "bevindingen": [{"type": "naam", "label": "Persoonsnaam", "ernst": "middel",
                             "fragment": "Sanne Bakker", "toelichting": "identificeert iemand",
                             "zekerheid": "hoog"}],
            "samenvatting": "dossierfragment met een naam",
        })
        pad = schrijf(self.map, "dossier.txt", "Dossier van Sanne Bakker.\nBSN: 111222333\n")
        with NagebootstModel(antwoord) as model:
            r = g.scan_bestand(pad, {"endpoint": model.endpoint, "model": "test-model-7b"})
        self.assertEqual(r["oordeel"], "hoog")
        self.assertTrue(r["ai_gebruikt"])
        self.assertTrue(any(b["type"] == "bsn" and b["bron"] == "patroon" for b in r["bevindingen"]))
        self.assertTrue(any(b["waarde"] == "Sanne Bakker" and b["bron"] == "ai" for b in r["bevindingen"]))

    def test_zonder_model_blijft_de_patrooncontrole_werken(self):
        pad = schrijf(self.map, "kort.txt", "BSN 111222333")
        r = g.scan_bestand(pad, {}, zonder_ai=True)
        self.assertFalse(r["ai_gebruikt"])
        self.assertEqual(r["oordeel"], "hoog")

    def test_ai_storing_maakt_de_scan_beperkt_niet_stuk(self):
        pad = schrijf(self.map, "storing.txt", "Postcode 3512 JD, huisnummer 12")
        r = g.scan_bestand(pad, {"endpoint": "http://127.0.0.1:1/v1", "model": "x", "timeout": 1})
        self.assertFalse(r["ai_gebruikt"])
        self.assertTrue(any("AI-analyse" in w for w in r["waarschuwingen"]))
        self.assertEqual(r["oordeel"], "middel")

    def test_bestandsnaam_telt_mee(self):
        pad = schrijf(self.map, "dossier-bsn-111222333.txt", "niets bijzonders hier")
        r = g.scan_bestand(pad, {}, zonder_ai=True)
        self.assertTrue(any(b.get("in_bestandsnaam") and b["type"] == "bsn" for b in r["bevindingen"]))

    def test_gevoelig_onderwerp_zonder_persoon(self):
        uitleg = schrijf(self.map, "over-adhd.md",
                         "Deze handleiding legt uit wat een diagnose ADHD betekent en welke medicatie voorkomt.")
        r1 = g.scan_bestand(uitleg, {}, zonder_ai=True)
        self.assertEqual(r1["oordeel"], "laag")
        self.assertIn("onderwerp", next(b["label"] for b in r1["bevindingen"] if b["type"] == "gezondheid"))

        dossier = schrijf(self.map, "dossier-adhd.md", "Diagnose ADHD bij leerling, BSN 111222333.")
        r2 = g.scan_bestand(dossier, {}, zonder_ai=True)
        self.assertEqual(r2["oordeel"], "hoog")

    def test_te_veel_treffers_wordt_gemeld(self):
        regels = "\n".join(f"deelnemer{i}@school.nl" for i in range(40))
        pad = schrijf(self.map, "veel.csv", regels)
        r = g.scan_bestand(pad, {}, zonder_ai=True)
        self.assertLessEqual(len([b for b in r["bevindingen"] if b["type"] == "email"]), g.MAX_PER_SOORT)
        self.assertTrue(any("andere unieke treffer" in w for w in r["waarschuwingen"]))

    def test_drempel_en_onleesbaar(self):
        s = g.samenvatten([{"naam": "a.txt", "oordeel": "geen"}, {"naam": "b.txt", "oordeel": "hoog"}], "middel")
        self.assertEqual(s["hoogste_oordeel"], "hoog")
        self.assertEqual(s["geblokkeerd"], ["b.txt"])
        soepel = g.samenvatten([{"naam": "a.txt", "oordeel": "laag"}], "hoog")
        self.assertEqual(soepel["geblokkeerd"], [])
        onleesbaar = g.samenvatten([{"naam": "scan.pdf", "oordeel": "onbekend"}], "middel")
        self.assertEqual(onleesbaar["onleesbaar"], ["scan.pdf"])
        self.assertIn("niet lezen", onleesbaar["upload_advies"])

    def test_redigeren(self):
        pad = schrijf(self.map, "te-schonen.txt", "Leerling: Jan de Vries, BSN 111222333, diagnose ADHD.")
        r = g.scan_bestand(pad, {}, zonder_ai=True)
        uit, aantal = g.redigeer(pad, r)
        tekst = uit.read_text(encoding="utf-8")
        self.assertGreaterEqual(aantal, 1)
        self.assertNotIn("111222333", tekst)
        self.assertNotIn("Jan de Vries", tekst)
        self.assertIn("[GEREDIGEERD:bsn]", tekst)
        self.assertIn("diagnose ADHD", tekst)    # onderwerp blijft leesbaar
        na = g.scan_bestand(uit, {}, zonder_ai=True)
        self.assertIn(na["oordeel"], ("geen", "laag"))


class TestRapport(unittest.TestCase):
    def setUp(self):
        self.map = tempfile.mkdtemp(prefix="privacy-scan-test-")

    def test_rapporten_maskeren(self):
        pad = schrijf(self.map, "rapportje.txt", "BSN 111222333")
        r = g.scan_bestand(pad, {}, zonder_ai=True)
        s = g.samenvatten([r])
        self.assertNotIn("111222333", json.dumps(g.naar_json([r], s)))
        self.assertIn("111222333", json.dumps(g.naar_json([r], s, toon_waarden=True)))
        html = g.naar_html([r], s)
        self.assertNotIn("111222333", html)
        self.assertIn("<!doctype html>", html.lower())


class TestWebApp(unittest.TestCase):
    def test_venster_scant_en_luistert_alleen_lokaal(self):
        instellingen = {"endpoint": "http://127.0.0.1:1/v1", "model": "x", "drempel": "middel"}
        server = g._Server(("127.0.0.1", 0), g.maak_handler(instellingen, zonder_ai=True))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            self.assertEqual(server.server_address[0], "127.0.0.1")

            with urllib.request.urlopen(url + "/") as antwoord:
                pagina = antwoord.read().decode()
            self.assertIn("Privacyscan vóór upload", pagina)

            verzoek = urllib.request.Request(
                url + "/api/scan", data=b"naam;bsn\nJan;111222333\n",
                headers={"X-Bestandsnaam": "leerlingen.csv", "X-Zonder-Ai": "1"})
            with urllib.request.urlopen(verzoek) as antwoord:
                resultaat = json.loads(antwoord.read().decode())
            self.assertEqual(resultaat["naam"], "leerlingen.csv")
            self.assertEqual(resultaat["oordeel"], "hoog")
            self.assertNotIn(tempfile.gettempdir() + os.sep + "privacy-scan-", json.dumps(resultaat))

            verzoek = urllib.request.Request(
                url + "/api/samenvatting", data=json.dumps({"resultaten": [resultaat]}).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(verzoek) as antwoord:
                samenvatting = json.loads(antwoord.read().decode())
            self.assertEqual(samenvatting["hoogsteOordeel"], "hoog")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
