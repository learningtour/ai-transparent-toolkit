// Lokale web-app: sleep bestanden erin, zie meteen wat je beter niet uploadt.
//
// De server luistert alleen op 127.0.0.1 en schrijft uploads naar een tijdelijk
// bestand dat na de scan direct wordt verwijderd. Er is geen route naar buiten:
// de enige uitgaande verbinding is die naar het lokale model.

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { scanBestand, samenvatten } from './scan.js';
import { modellen } from './llm.js';
import { PAGINA } from './pagina.js';

const MAX_UPLOAD = 200 * 1024 * 1024;

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function leesBody(req, limiet = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const delen = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limiet) { reject(new Error(`bestand groter dan ${Math.round(limiet / 1e6)} MB`)); req.destroy(); return; }
      delen.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(delen)));
    req.on('error', reject);
  });
}

export function startServer(cfg, opties = {}) {
  const { poort = 7817, zonderAi = false, visie = false } = opties;

  const server = http.createServer(async (req, res) => {
    // Alleen verzoeken van deze machine; en geen CORS, dus geen andere site
    // kan de scanner op de achtergrond aanroepen.
    const afzender = req.socket.remoteAddress || '';
    if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(afzender)) {
      res.writeHead(403).end('alleen lokaal');
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');

    try {
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        const html = PAGINA;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && req.url === '/api/status') {
        let lijst = [], fout = null;
        try { lijst = await modellen(cfg.endpoint); }
        catch (err) { fout = err.message; }
        json(res, 200, {
          endpoint: cfg.endpoint,
          model: cfg.model || lijst[0] || null,
          modellen: lijst,
          modelBeschikbaar: lijst.length > 0,
          fout,
          zonderAi,
          visie
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/api/scan') {
        const ruweNaam = req.headers['x-bestandsnaam'] || 'bestand.txt';
        let naam;
        try { naam = decodeURIComponent(ruweNaam); } catch { naam = ruweNaam; }
        naam = naam.replace(/[/\\]/g, '_').slice(0, 200);
        const zonderAiNu = req.headers['x-zonder-ai'] === '1' || zonderAi;
        const data = await leesBody(req);
        const tijdelijk = path.join(os.tmpdir(),
          `glu-scan-${crypto.randomBytes(8).toString('hex')}${path.extname(naam) || '.bin'}`);
        await fsp.writeFile(tijdelijk, data, { mode: 0o600 });
        try {
          const resultaat = await scanBestand(tijdelijk, cfg, { zonderAi: zonderAiNu, visie, naam });
          resultaat.bestand = naam; // niet het tijdelijke pad teruggeven
          json(res, 200, resultaat);
        } finally {
          await fsp.rm(tijdelijk, { force: true });
        }
        return;
      }

      if (req.method === 'POST' && req.url === '/api/samenvatting') {
        const body = JSON.parse((await leesBody(req, 5e6)).toString('utf8'));
        json(res, 200, samenvatten(body.resultaten || [], cfg.drempel));
        return;
      }

      res.writeHead(404).end('niet gevonden');
    } catch (err) {
      json(res, 500, { fout: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // Poort 0 laat het besturingssysteem kiezen; lees dus terug wat het werd.
    server.listen(poort, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
