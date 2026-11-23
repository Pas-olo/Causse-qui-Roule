// Télécharge une fois les polices (licence OFL, via Fontsource/jsDelivr) dans public/fonts/.
// Elles sont ensuite servies par le site lui-même : les visiteurs ne contactent jamais Google.
// Sans ces fichiers, le site utilise les polices du système (rien ne casse).
import fs from 'node:fs';

const FONTS = {
  'dm-sans': [400, 500, 700], fraunces: [600, 700], outfit: [400, 500, 700],
  'space-grotesk': [400, 500, 700], 'playfair-display': [600, 700], 'source-serif-4': [400, 600],
};
fs.mkdirSync('public/fonts', { recursive: true });
let ok = 0, ko = 0;
for (const [id, weights] of Object.entries(FONTS)) for (const w of weights) {
  const out = `public/fonts/${id}-${w}.woff2`;
  if (fs.existsSync(out)) { ok++; continue; }
  try {
    const r = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${w}-normal.woff2`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer())); ok++;
  } catch (e) { ko++; console.warn(`✗ ${id} ${w} : ${e.message}`); }
}
console.log(`Polices : ${ok} OK, ${ko} manquante(s).`);
