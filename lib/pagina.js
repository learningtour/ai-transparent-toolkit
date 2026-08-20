// De pagina van de lokale web-app. Eén bestand, geen build, geen CDN — alles
// wat hier binnenkomt blijft op de machine van de gebruiker.

export const PAGINA = `<!doctype html>
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
</body></html>`;
