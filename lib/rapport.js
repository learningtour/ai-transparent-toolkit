// Rapportage: naar de terminal, naar JSON (voor koppeling met de GLU
// Analysetool of een CI-stap) en naar een HTML-rapport dat je kunt bewaren.
//
// Waarden worden standaard gemaskeerd weergegeven. Een privacyrapport dat zelf
// vol persoonsgegevens staat, verplaatst het probleem alleen maar.

const bold = s => `\x1b[1m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;
const groen = s => `\x1b[32m${s}\x1b[0m`;
const geel = s => `\x1b[33m${s}\x1b[0m`;
const rood = s => `\x1b[31m${s}\x1b[0m`;
const blauw = s => `\x1b[36m${s}\x1b[0m`;

export const KLEUR = { geen: groen, laag: blauw, middel: geel, hoog: rood, onbekend: dim };
export const TEKEN = { geen: '✔', laag: '•', middel: '⚠', hoog: '✘', onbekend: '?' };

export function humanSize(bytes) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0, v = bytes || 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function toonResultaat(r, { toonWaarden = false } = {}) {
  const kleur = KLEUR[r.oordeel];
  console.log(`\n${bold(r.naam)} ${dim(`(${humanSize(r.bytes)}, ${r.soort})`)}`);
  console.log(`  ${kleur(TEKEN[r.oordeel] + ' ' + r.oordeel.toUpperCase())} — ${r.advies}`);
  if (r.samenvatting) console.log(`  ${dim('AI:')} ${r.samenvatting}`);

  if (r.bevindingen.length) {
    const perErnst = { hoog: [], middel: [], laag: [] };
    for (const b of r.bevindingen) (perErnst[b.ernst] || perErnst.laag).push(b);
    for (const ernst of ['hoog', 'middel', 'laag']) {
      for (const b of perErnst[ernst]) {
        const waarde = toonWaarden ? b.waarde : b.gemaskeerd || b.waarde;
        const plek = b.inBestandsnaam ? 'bestandsnaam' : b.regel ? `regel ${b.regel}` : b.bron === 'ai' ? 'ai' : '—';
        const herhaling = b.aantal > 1 ? dim(` ×${b.aantal}`) : '';
        console.log(`    ${KLEUR[ernst](TEKEN[ernst])} ${bold(b.label)}${herhaling} ${dim(`[${plek}]`)}`);
        console.log(`      ${waarde}`);
        if (b.avg) console.log(`      ${dim(b.avg)}`);
        else if (b.toelichting) console.log(`      ${dim(b.toelichting)}`);
      }
    }
  }
  for (const w of r.waarschuwingen) console.log(`  ${geel('⚠')} ${dim(w)}`);
  if (!r.aiGebruikt && r.leesbaar) {
    console.log(`  ${dim('(alleen patrooncontrole — geen lokaal model gebruikt)')}`);
  }
}

export function toonSamenvatting(s) {
  const kleur = KLEUR[s.hoogsteOordeel];
  console.log(`\n${bold('Samenvatting')}`);
  console.log(`  ${s.bestanden} bestand(en): ` + [
    s.telling.hoog ? rood(`${s.telling.hoog}× hoog`) : null,
    s.telling.middel ? geel(`${s.telling.middel}× middel`) : null,
    s.telling.laag ? blauw(`${s.telling.laag}× laag`) : null,
    s.telling.geen ? groen(`${s.telling.geen}× schoon`) : null,
    s.telling.onbekend ? dim(`${s.telling.onbekend}× onleesbaar`) : null
  ].filter(Boolean).join(' · '));
  console.log(`  ${kleur(TEKEN[s.hoogsteOordeel])} ${s.uploadAdvies}`);
  if (s.geblokkeerd.length) console.log(`  ${dim('opschonen:')} ${s.geblokkeerd.join(', ')}`);
}

export function naarJson(resultaten, samenvatting, { toonWaarden = false } = {}) {
  return {
    tool: 'glu-scan',
    versie: 1,
    tijdstip: new Date().toISOString(),
    samenvatting,
    bestanden: resultaten.map(r => ({
      naam: r.naam,
      pad: r.bestand,
      bytes: r.bytes,
      soort: r.soort,
      oordeel: r.oordeel,
      advies: r.advies,
      aiGebruikt: r.aiGebruikt,
      samenvattingAi: r.samenvatting,
      waarschuwingen: r.waarschuwingen,
      bevindingen: r.bevindingen.map(b => ({
        type: b.type,
        label: b.label,
        ernst: b.ernst,
        categorie: b.categorie,
        bron: b.bron,
        regel: b.regel,
        aantal: b.aantal || 1,
        waarde: toonWaarden ? b.waarde : b.gemaskeerd || null,
        avg: b.avg || null,
        toelichting: b.toelichting || null
      }))
    }))
  };
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function naarHtml(resultaten, s, { toonWaarden = false } = {}) {
  const rijen = resultaten.map(r => `
    <article class="kaart ${r.oordeel}">
      <header>
        <h2>${esc(r.naam)}</h2>
        <span class="badge ${r.oordeel}">${esc(r.oordeel)}</span>
      </header>
      <p class="advies">${esc(r.advies)}</p>
      ${r.samenvatting ? `<p class="ai">${esc(r.samenvatting)}</p>` : ''}
      ${r.bevindingen.length ? `<table>
        <thead><tr><th>Ernst</th><th>Soort</th><th>Waarde</th><th>Plek</th><th>Duiding</th></tr></thead>
        <tbody>${r.bevindingen.map(b => `<tr>
          <td><span class="badge ${esc(b.ernst)}">${esc(b.ernst)}</span></td>
          <td>${esc(b.label)}${b.aantal > 1 ? ` <em>×${b.aantal}</em>` : ''}</td>
          <td><code>${esc(toonWaarden ? b.waarde : b.gemaskeerd || b.waarde)}</code></td>
          <td>${b.inBestandsnaam ? 'bestandsnaam' : b.regel ? 'regel ' + b.regel : esc(b.bron)}</td>
          <td>${esc(b.avg || b.toelichting || '')}</td>
        </tr>`).join('')}</tbody>
      </table>` : '<p class="leeg">Geen bevindingen.</p>'}
      ${r.waarschuwingen.length ? `<ul class="waarschuwingen">${r.waarschuwingen.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    </article>`).join('');

  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacyscan — GLU Analysetool</title>
<style>
  :root { color-scheme: light dark; --rand:#d8dce5; --dim:#5b6478; --bg:#fff; --vlak:#f6f7fb; --tekst:#12162a; }
  @media (prefers-color-scheme: dark) { :root { --rand:#2b3145; --dim:#98a0b8; --bg:#0e1120; --vlak:#161a2c; --tekst:#e8eaf4; } }
  body { font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--tekst); }
  main { max-width:960px; margin:0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  .meta { color:var(--dim); margin:0 0 1.5rem; }
  .totaal { background:var(--vlak); border:1px solid var(--rand); border-radius:12px; padding:1rem 1.25rem; margin-bottom:1.5rem; }
  .kaart { border:1px solid var(--rand); border-radius:12px; padding:1rem 1.25rem; margin-bottom:1rem; background:var(--vlak); }
  .kaart header { display:flex; align-items:center; gap:.75rem; justify-content:space-between; }
  h2 { font-size:1.05rem; margin:0; overflow-wrap:anywhere; }
  .badge { font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; padding:.15rem .5rem; border-radius:999px; border:1px solid currentColor; white-space:nowrap; }
  .badge.hoog,.kaart.hoog .badge { color:#c62828; } .badge.middel { color:#b26a00; }
  .badge.laag { color:#0b6ea8; } .badge.geen { color:#1b7c3d; } .badge.onbekend { color:var(--dim); }
  .advies { margin:.5rem 0; } .ai { color:var(--dim); font-style:italic; margin:.25rem 0 .75rem; }
  table { width:100%; border-collapse:collapse; margin-top:.5rem; display:block; overflow-x:auto; }
  th,td { text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--rand); vertical-align:top; font-size:.9rem; }
  th { color:var(--dim); font-weight:600; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
  .leeg,.waarschuwingen { color:var(--dim); font-size:.9rem; }
  footer { color:var(--dim); font-size:.85rem; margin-top:2rem; border-top:1px solid var(--rand); padding-top:1rem; }
</style></head>
<body><main>
  <h1>Privacyscan vóór upload</h1>
  <p class="meta">GLU Analysetool · satelliet · ${esc(new Date().toLocaleString('nl-NL'))} · lokaal uitgevoerd, geen bestand heeft deze machine verlaten</p>
  <div class="totaal">
    <strong>${s.bestanden} bestand(en)</strong> — ${s.telling.hoog}× hoog, ${s.telling.middel}× middel, ${s.telling.laag}× laag, ${s.telling.geen}× schoon${s.telling.onbekend ? `, ${s.telling.onbekend}× onleesbaar` : ''}.
    <p style="margin:.5rem 0 0">${esc(s.uploadAdvies)}</p>
  </div>
  ${rijen}
  <footer>Gemaakt met glu-scan (AI Transparent toolkit). Waarden zijn ${toonWaarden ? 'volledig weergegeven — behandel dit rapport als vertrouwelijk' : 'gemaskeerd weergegeven'}. Een scan is een hulpmiddel, geen garantie en geen juridisch advies.</footer>
</main></body></html>`;
}
