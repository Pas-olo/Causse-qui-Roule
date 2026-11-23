// Configuration du site, modifiable depuis /admin et stockée dans data/config.json.
// Les secrets (tokens, mot de passe admin) restent dans .env et n'apparaissent jamais ici.
import fs from 'node:fs';
import path from 'node:path';

// Données d'exemple livrées avec le dépôt (dossier defaults/).
const readJsonFile = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readLines = f => { try { return fs.readFileSync(f, 'utf8').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#')); } catch { return []; } };

export const SNCF_BASE = 'https://www.garesetconnexions.sncf/schedule-table/Departures/';

// Valeurs par défaut : l'exemple « Causse qui Roule ». Pour un autre territoire, tout se change dans /admin.
export const DEFAULTS = {
  site: {
    name: '*Causse* qui Roule',                       // *mot* = mis en couleur dans le titre
    tagline: 'Transport en *Quercy Rouergue*, et alentours',
    description: 'Covoiturage local et horaires des trains et bus en Quercy Rouergue : Caussade, Saint-Antonin, Caylus, Vaour, Penne…',
    url: '', contact: '', editor: 'Initiative citoyenne', hosting: 'Hébergement maison',
    skin: 'lavande', themeColor: '#5b3fd1',
  },
  admins: [],                                        // identifiants Telegram des admins (commande /monid)
  retention: { recurringDays: 60, archiveDays: 365 },
  phrase: { prefix: 'N’amasse pas', list: readLines('defaults/phrases.txt') },
  cities: readJsonFile('defaults/cities.json') || [],
  stations: [
    { name: 'Caussade', api: SNCF_BASE + '0087613356', link: 'https://www.ter.sncf.com/occitanie/se-deplacer/prochains-departs/caussade-87613356',
      groups: [{ label: 'Vers Toulouse', match: ['Toulouse', 'Montauban'] }, { label: 'Vers Paris', match: [] }] },
    { name: 'Lexos', api: SNCF_BASE + '0087613489', link: 'https://www.ter.sncf.com/occitanie/se-deplacer/prochains-departs/lexos-87613489',
      groups: [{ label: 'Vers Toulouse', match: ['Toulouse', 'Tessonnières', 'Gaillac', 'Lisle', 'Rabastens', 'Sulpice', 'Montauban'] }, { label: 'Vers Clermont-Fd', match: [] }] },
  ],
  about: `## Pourquoi
On est un territoire enclavé, sans aucun transport en commun, et ça n’a pas l’air de déranger nos élu·e·s. Ce site est une initiative citoyenne pour centraliser toutes les propositions de transport entre particuliers·ères pour faciliter la vie des locaux·ales.

## Pour qui
Toute personne qui veut se déplacer sur le territoire, ou qui veut se proposer pour aider celles et ceux qui en ont besoin.

## Comment
Les horaires des transports en commun au même endroit, et une plateforme pour mettre en relation chauffeur·se·s et passager·ère·s. On s’occupe pas de faire les trajets. Et on recommande de pas faire payer : c’est un service essentiel à la population.

## Déposer une annonce
Il faut un compte Telegram avec un numéro de mobile français. Je sais, c’est chiant. Mais à notre échelle on ne peut pas investir dans une infrastructure pour vérifier les numéros autrement. Voilà, c’est comme ça, déso… pas déso.`,
  aboutEnd: `## Autre
Si t’as d’autres idées, dis-le nous.`,
};

const SKINS = ['lavande', 'ardoise', 'journal'];
const str = (v, max, def = '') => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : def;
const isUrl = s => /^https?:\/\/[^\s]+$/i.test(s);

// Vérifie et nettoie une configuration complète. Lève une erreur lisible si quelque chose cloche.
export function validateConfig(c) {
  if (!c || typeof c !== 'object') throw new Error('Configuration illisible.');
  const s = c.site || {}, out = {};
  const name = str(s.name, 60);
  if (!name.replace(/\*/g, '').trim()) throw new Error('Le nom du site est obligatoire.');
  const url = str(s.url, 200).replace(/\/+$/, '');
  if (url && !isUrl(url)) throw new Error('L’adresse du site doit commencer par https:// (ou http://)');
  const contact = str(s.contact, 120);
  if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw new Error('Adresse e-mail de contact invalide.');
  out.site = { name, tagline: str(s.tagline, 120), description: str(s.description, 300), url, contact,
    editor: str(s.editor, 120), hosting: str(s.hosting, 200), skin: SKINS.includes(s.skin) ? s.skin : 'lavande',
    themeColor: /^#[0-9a-f]{6}$/i.test(s.themeColor || '') ? s.themeColor : '#5b3fd1' };
  out.admins = [...new Set((Array.isArray(c.admins) ? c.admins : String(c.admins || '').split(/[\s,;]+/)).map(x => String(x).trim()).filter(x => /^\d{3,20}$/.test(x)))].slice(0, 20);   // positifs seulement : un ID négatif est un groupe Telegram
  const r = c.retention || {};
  const days = (v, d, min, max) => Math.min(max, Math.max(min, parseInt(v) || d));
  out.retention = { recurringDays: days(r.recurringDays, 60, 7, 365), archiveDays: days(r.archiveDays, 365, 30, 3650) };
  const p = c.phrase || {};
  out.phrase = { prefix: str(p.prefix, 60), list: (Array.isArray(p.list) ? p.list : []).map(x => str(x, 80)).filter(Boolean).slice(0, 500) };
  out.cities = (Array.isArray(c.cities) ? c.cities : []).map(x => ({ n: str(x?.n, 40), d: str(String(x?.d ?? ''), 6) })).filter(x => x.n).slice(0, 500);
  if (new Set(out.cities.map(x => x.n.toLowerCase())).size !== out.cities.length) throw new Error('Une ville apparaît deux fois dans la liste.');
  out.stations = (Array.isArray(c.stations) ? c.stations : []).slice(0, 10).map((st, i) => {
    const name = str(st?.name, 40), api = str(st?.api, 300), link = str(st?.link, 300);
    if (!name) throw new Error(`Gare n°${i + 1} : nom manquant.`);
    if (!isUrl(api)) throw new Error(`Gare « ${name} » : l’URL de l’API doit commencer par https:// (ou http://)`);
    if (link && !isUrl(link)) throw new Error(`Gare « ${name} » : le lien « tous les trains » doit commencer par https:// (ou http://)`);
    const groups = (Array.isArray(st.groups) ? st.groups : []).slice(0, 6).map(g => ({ label: str(g?.label, 40),
      match: [...new Set((Array.isArray(g?.match) ? g.match : String(g?.match || '').split(/[\n,;]+/)).map(x => str(x, 60)).filter(Boolean))].slice(0, 100) }))
      .filter(g => g.label);
    if (!groups.length) throw new Error(`Gare « ${name} » : il faut au moins un panier de destinations.`);
    return { name, api, link, groups };
  });
  out.about = str(c.about, 20000);
  out.aboutEnd = str(c.aboutEnd, 20000);
  return out;
}

// Vérifie et nettoie les horaires de bus.
const DATE = /^\d{4}-\d\d-\d\d$/, HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const dayList = v => Array.isArray(v) ? [...new Set(v.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : undefined;
const perList = v => Array.isArray(v) ? [...new Set(v.filter(p => ['S', 'V', 'E'].includes(p)))].sort((a, b) => 'SVE'.indexOf(a) - 'SVE'.indexOf(b)) : undefined;
export function validateBus(b) {
  if (!b || typeof b !== 'object') throw new Error('Fichier d’horaires illisible.');
  const ranges = v => (Array.isArray(v) ? v : []).filter(r => Array.isArray(r) && DATE.test(r[0]) && DATE.test(r[1]) && r[0] <= r[1]).map(r => [r[0], r[1]]);
  const out = {
    sourceName: str(b.sourceName, 60), soonLink: isUrl(b.soonLink || '') ? b.soonLink : '', soonLabel: str(b.soonLabel, 60),
    periodes: { S: ranges(b.periodes?.S), V: ranges(b.periodes?.V), E: ranges(b.periodes?.E) },
    feries: [...new Set((Array.isArray(b.feries) ? b.feries : []).filter(d => DATE.test(d)))].sort(),
    arrets: [...new Set((Array.isArray(b.arrets) ? b.arrets : []).map(x => str(x, 60)).filter(Boolean))],
    bientot: [...new Set((Array.isArray(b.bientot) ? b.bientot : []).map(x => str(x, 60)).filter(Boolean))],
    sources: Object.fromEntries(Object.entries(b.sources && typeof b.sources === 'object' ? b.sources : {}).map(([k, v]) => [str(k, 60), str(v, 400)]).filter(([k, v]) => k && isUrl(v))),
  };
  if (b.valable && Array.isArray(b.valable) && DATE.test(b.valable[0]) && DATE.test(b.valable[1])) out.valable = [b.valable[0], b.valable[1]];
  const trips = Array.isArray(b.trips) ? b.trips : [];
  if (trips.length > 5000) throw new Error('Trop de cars (5000 maximum).');
  out.trips = trips.map((t, i) => {
    const where = `Car n°${i + 1}`;
    const stops = (Array.isArray(t?.stops) ? t.stops : []).map((s, j) => {
      if (!Array.isArray(s)) throw new Error(`${where}, arrêt n°${j + 1} illisible.`);
      const name = str(s[0], 80), time = String(s[1] || '');
      if (!name.includes(' · ')) throw new Error(`${where} : l’arrêt « ${name} » doit s’écrire « Commune · Arrêt ».`);
      if (!HM.test(time)) throw new Error(`${where} : heure invalide « ${time} » pour « ${name} ».`);
      const o = [name, time];
      if (s[2] && typeof s[2] === 'object') {
        const x = {}, d = dayList(s[2].days), p = perList(s[2].periods);
        if (d?.length) x.days = d; if (p?.length) x.periods = p;
        if (Object.keys(x).length) o.push(x);
      }
      return o;
    });
    if (stops.length < 2) throw new Error(`${where} : il faut au moins deux arrêts.`);
    const days = dayList(t.days) || [];
    if (!days.length && !t.ferie) throw new Error(`${where} : choisis au moins un jour de circulation.`);
    const o = { ligne: str(t.ligne, 20), direction: str(t.direction, 60) || stops[stops.length - 1][0].split(' · ')[0], days, periods: perList(t.periods)?.length ? perList(t.periods) : ['S', 'V', 'E'], stops };
    if (t.ferie) o.ferie = true;
    return o;
  });
  return out;
}

// Lecture / écriture atomique d'un fichier JSON.
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(f, v) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
  fs.renameSync(tmp, f);
}

// Charge la configuration ; au premier démarrage, la crée à partir des défauts, du .env et des anciens fichiers.
export function openConfig(dir, env = process.env) {
  const file = path.join(dir, 'config.json'), busFile = path.join(dir, 'bus.json');
  let cfg = readJson(file);
  if (!cfg) {
    cfg = structuredClone(DEFAULTS);
    // Reprise d'une installation existante (versions précédentes du site).
    if (env.CONTACT_EMAIL) cfg.site.contact = env.CONTACT_EMAIL;
    if (env.EDITOR_NAME) cfg.site.editor = env.EDITOR_NAME;
    if (env.SITE_URL) cfg.site.url = env.SITE_URL;
    if (env.ADMIN_CHAT_IDS) cfg.admins = env.ADMIN_CHAT_IDS.split(/[\s,;]+/).filter(Boolean);
    if (env.RECURRING_DAYS) cfg.retention.recurringDays = +env.RECURRING_DAYS;
    if (env.ARCHIVE_DAYS) cfg.retention.archiveDays = +env.ARCHIVE_DAYS;
    const oldCities = readJson('public/cities.json');
    if (Array.isArray(oldCities) && oldCities.length) cfg.cities = oldCities;
    const oldPhrases = readLines('public/mousse.txt');
    if (oldPhrases.length) cfg.phrase.list = oldPhrases;
    cfg = validateConfig(cfg);
    writeJson(file, cfg);
    console.log('[config] data/config.json créé');
  } else {
    // Fichier existant : on complète les champs ajoutés par une version plus récente.
    cfg = validateConfig({ ...structuredClone(DEFAULTS), ...cfg, site: { ...DEFAULTS.site, ...cfg.site }, retention: { ...DEFAULTS.retention, ...cfg.retention }, phrase: { ...DEFAULTS.phrase, ...cfg.phrase } });
  }
  let bus = readJson(busFile);
  if (!bus) {
    bus = readJson('public/bus.json') || readJson('defaults/bus.json') || {};
    if (!bus.sourceName) { const d = readJson('defaults/bus.json') || {}; Object.assign(bus, { sourceName: d.sourceName, soonLink: d.soonLink, soonLabel: d.soonLabel }); }
    bus = validateBus(bus);
    writeJson(busFile, bus);
    console.log('[config] data/bus.json créé');
  }
  const envAdmins = (env.ADMIN_CHAT_IDS || '').split(/[\s,;]+/).filter(Boolean);
  return {
    get: () => cfg,
    bus: () => bus,
    set(next) { cfg = validateConfig(next); writeJson(file, cfg); return cfg; },
    setBus(next) { bus = validateBus(next); writeJson(busFile, bus); return bus; },
    // Admins Telegram : ceux de la page admin + ceux du .env (gardés pour ne jamais s'enfermer dehors).
    admins: () => new Set([...cfg.admins, ...envAdmins]),
    plainName: () => cfg.site.name.replace(/\*/g, ''),
  };
}

// Petit Markdown sûr pour les textes de la page « À propos » : ## titres, paragraphes, listes « - », **gras**, *italique*, liens [texte](https://…).
export function markdown(src) {
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  for (const block of String(src || '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter(l => l.trim());
    if (!lines.length) continue;
    let para = [];
    const flush = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^#{1,3}\s/.test(l)) { flush(); out.push(`<h2>${inline(l.replace(/^#+\s*/, ''))}</h2>`); }
      else if (/^\s*[-•]\s/.test(l)) {
        flush(); const items = [];
        while (i < lines.length && /^\s*[-•]\s/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-•]\s*/, ''))}</li>`);
        i--; out.push(`<ul>${items.join('')}</ul>`);
      } else para.push(l);
    }
    flush();
  }
  return out.join('\n');
}
// « *Causse* qui Roule » → « <i>Causse</i> qui Roule » (titre) ; tagline → <b>.
export const accent = (s, tag) => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/\*(.+?)\*/g, `<${tag}>$1</${tag}>`);
