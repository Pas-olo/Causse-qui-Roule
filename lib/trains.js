// Prochains départs SNCF (API publique Gares & Connexions), avec cache et tolérance aux pannes.
// Les gares et leurs « paniers » de destinations viennent de la configuration (page /admin).
import { SNCF_BASE } from './config.js';

const hm = d => new Date(d).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Pour les tests : SNCF_API remplace l'adresse de l'API officielle.
const apiUrl = u => process.env.SNCF_API ? u.replace(SNCF_BASE, process.env.SNCF_API) : u;

// Panier d'une destination : le premier dont un mot-clé apparaît dans le nom, sinon le dernier (« tout le reste »).
export function groupOf(st, dest) {
  const d = norm(dest);
  const i = st.groups.findIndex(g => g.match.some(m => m && d.includes(norm(m))));
  return i >= 0 ? i : st.groups.length - 1;
}

// Destinations vues récemment, par gare, pour les classer depuis /admin.
const seen = new Map();   // gare → Map(destination → dernière fois vue)
export const seenDestinations = () => Object.fromEntries([...seen].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1]).map(([dest, t]) => ({ dest, t }))]));

async function station(st) {
  const r = await fetch(apiUrl(st.api), { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${st.name}: HTTP ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error(`${st.name}: réponse inattendue`);
  const now = Date.now(), groups = st.groups.map(g => ({ label: g.label, times: [], cancelled: [] }));
  // Statuts SNCF : « SUPPRESSION_TOTALE » (train supprimé), « SUPPRESSION_PARTIELLE » (ne circule que sur une partie du trajet).
  const status = t => `${t.informationStatus?.trainStatus || ''} ${t.traffic?.eventStatus || ''}`.toUpperCase();
  const isCancelled = t => /SUPPRESS/.test(status(t)) && !/PARTIEL/.test(status(t));
  const list = data.filter(t => t?.traffic && +new Date(t.actualTime || t.scheduledTime) >= now)
    .sort((a, b) => new Date(a.actualTime || a.scheduledTime) - new Date(b.actualTime || b.scheduledTime));
  const mem = seen.get(st.name) || new Map(); seen.set(st.name, mem);
  for (const t of data) if (t?.traffic?.destination) mem.set(String(t.traffic.destination), now);
  for (const [d, ts] of mem) if (now - ts > 30 * 864e5) mem.delete(d);
  for (const t of list) {
    const g = groups[groupOf(st, t.traffic.destination)];
    if (g.times.length >= 2) continue;
    // Un train supprimé ne prend pas de place : on le signale à part, et on affiche le suivant.
    if (isCancelled(t)) { if (g.cancelled.length < 3) g.cancelled.push(hm(t.scheduledTime)); continue; }
    g.times.push({ time: hm(t.scheduledTime), delay: Number(t.informationStatus?.delay) || 0, dest: String(t.traffic.destination || ''),
      car: t.trainMode === 'CAR', partial: /PARTIEL/.test(status(t)) });
  }
  return { name: st.name, url: st.link, groups };
}

let cache = { t: 0, key: '', v: null }, inflight = null;
// Renvoie { stations } ; une gare en panne n'empêche pas d'afficher l'autre.
export async function trains(stations) {
  const key = JSON.stringify(stations);            // si la config change, on ignore le cache
  if (cache.v && cache.key === key && Date.now() - cache.t < 60e3) return cache.v;
  inflight ??= (async () => {
    const res = await Promise.allSettled(stations.map(station));
    const prev = cache.key === key ? cache.v?.stations || [] : [];
    const out = res.map((r, i) => {
      const st = stations[i];
      if (r.status === 'fulfilled') return r.value;
      console.warn('[trains]', r.reason?.message || r.reason);
      // On ressert l'ancienne valeur si elle a moins de 30 min.
      const old = prev.find(s => s.name === st.name && !s.error);
      return old && Date.now() - cache.t < 30 * 60e3 ? { ...old, stale: true } : { name: st.name, url: st.link, error: true, groups: [] };
    });
    const v = { stations: out, updated: new Date().toISOString() };
    if (out.some(s => !s.error && !s.stale) || !out.length) cache = { t: Date.now(), key, v };
    return v;
  })().finally(() => { inflight = null; });
  return inflight;
}
