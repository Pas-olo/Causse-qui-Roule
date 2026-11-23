// Covoiturage local + horaires de transports — serveur sans dépendance (Node ≥ 22.13).
import './lib/env.js'; // en premier : charge .env avant le reste
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, queries, maintenance, parisNow, stats } from './lib/db.js';
import { startBot } from './lib/bot.js';
import { trains, seenDestinations, groupOf } from './lib/trains.js';
import { pipeline } from 'node:stream';
import { sha, normCode, cleanAd, newCode, frMobile, escHtml as esc } from './lib/util.js';
import { openConfig, markdown, accent, validateConfig, validateBus } from './lib/config.js';
import { createAuth } from './lib/auth.js';

const env = process.env;
const PORT = +env.PORT || 3000;
// Secrets : uniquement dans .env
const BOT_TOKEN = env.BOT_TOKEN || '', BOT_USERNAME = (env.BOT_USERNAME || '').replace(/^@/, '');
const PENDING_TTL = 2 * 3600e3;                     // une vérification Telegram non terminée est effacée après 2 h
const DATA_DIR = env.DATA_DIR || 'data';
const PUBLIC = path.resolve('public'), ADMIN_PAGE = path.resolve('admin/index.html');

const db = openDb(DATA_DIR);
const Q = queries(db);
const CFG = openConfig(DATA_DIR);                   // tout le reste : modifiable depuis /admin
const auth = createAuth({ user: env.ADMIN_USER || 'admin', password: env.ADMIN_PASSWORD || '' });

// ——— Outils HTTP ———
const SEC = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
  // Aucune ressource externe autorisée : ni polices Google, ni scripts tiers.
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { ...SEC, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}
const fail = (res, status, error) => json(res, status, { error });

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!size) return resolve({});
      let v; try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(Object.assign(new Error('bad json'), { status: 400 })); }
      // Un JSON valide mais qui n'est pas un objet (null, tableau, nombre…) ferait planter les routes : refusé.
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(Object.assign(new Error('not an object'), { status: 400 }));
      resolve(v);
    });
    req.on('error', reject);
  });
}

// IP du visiteur (limites de requêtes, statistiques). Les en-têtes ajoutés par un proxy sont falsifiables par n'importe qui
// s'ils ne viennent pas vraiment du proxy : on ne les lit que si TRUST_PROXY le demande.
//   TRUST_PROXY=cloudflare → CF-Connecting-IP (Cloudflare Tunnel)
//   TRUST_PROXY=1          → dernière IP de X-Forwarded-For (Caddy, Nginx…)
//   sinon                  → l'adresse de la connexion seulement
const clientIp = req => {
  const hdr = env.TRUST_PROXY === 'cloudflare' ? String(req.headers['cf-connecting-ip'] || '').trim()
    : env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() : '';
  return hdr || req.socket.remoteAddress || '?';
};

const hits = new Map();
function limited(req, key, max) {
  const k = key + '|' + clientIp(req), now = Date.now();
  const a = (hits.get(k) || []).filter(t => now - t < 60e3);
  if (a.length >= max) return true;
  a.push(now); hits.set(k, a); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 60e3)) hits.delete(k); }, 5 * 60e3).unref();

// Visiteur anonyme : hash (IP + navigateur + sel du jour). Le sel change chaque jour et n'est jamais stocké.
let salt = { day: '', v: '' };
function visitor(req) {
  const day = parisNow().slice(0, 10);
  if (salt.day !== day) salt = { day, v: crypto.randomBytes(16).toString('hex') };
  return sha(salt.v + clientIp(req) + (req.headers['user-agent'] || '')).slice(0, 16);
}

// ——— Pages HTML : le nom, le thème, etc. viennent de la configuration ———
function renderHtml(file, req, res) {
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return fail(res, 404, 'Introuvable.');
    const s = CFG.get().site;
    const vars = { SITE_URL: esc(s.url), NAME: esc(CFG.plainName()), NAME_HTML: accent(s.name, 'i'), TAGLINE_HTML: accent(s.tagline, 'b'),
      TAGLINE: esc(s.tagline.replace(/\*/g, '')), DESCRIPTION: esc(s.description), SKIN: s.skin, THEME_COLOR: s.themeColor };
    const body = Buffer.from(html.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m));
    res.writeHead(200, { ...SEC, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

// ——— Fichiers statiques ———
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  let rel; try { rel = decodeURIComponent(pathname); } catch { return fail(res, 400, 'Chemin invalide.'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) return fail(res, 404, 'Introuvable.');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'Introuvable.');
    const ext = path.extname(file), mtime = st.mtime.toUTCString();
    if (ext === '.html') return renderHtml(file, req, res);
    const headers = { ...SEC, 'content-type': MIME[ext] || 'application/octet-stream', 'last-modified': mtime,
      'cache-control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache' };
    if (req.headers['if-modified-since'] === mtime) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

// ——— Routes ———
const routes = [];
// opts.admin : réservé à l'admin connecté
const route = (method, pattern, max, fn, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), max, fn, key: method + pattern, ...opts });

route('GET', '/healthz', 0, (req, res) => { db.prepare('SELECT 1').get(); json(res, 200, { ok: true, bot: !!BOT_TOKEN }); });

route('GET', '/manifest.webmanifest', 0, (req, res) => {
  const s = CFG.get().site, body = JSON.stringify({
    name: CFG.plainName(), short_name: CFG.plainName(), description: s.description, lang: 'fr', start_url: '/', scope: '/', display: 'standalone',
    background_color: '#f5f2fb', theme_color: s.themeColor,
    icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] });
  res.writeHead(200, { ...SEC, 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' }); res.end(body);
});

// Tout ce dont la page publique a besoin (aucune donnée personnelle).
route('GET', '/api/config', 0, (req, res) => {
  const c = CFG.get();
  json(res, 200, { name: CFG.plainName(), contact: c.site.contact || null, editor: c.site.editor || '', hosting: c.site.hosting || '',
    publish: !!(BOT_TOKEN && BOT_USERNAME), bot: BOT_USERNAME || null, recurring: c.retention.recurringDays, archive: c.retention.archiveDays,
    cities: c.cities, phrase: c.phrase, stations: c.stations.map(s => s.name), about: markdown(c.about), aboutEnd: markdown(c.aboutEnd) });
});
route('GET', '/api/bus', 0, (req, res) => json(res, 200, CFG.bus()));

route('GET', '/api/ads', 0, (req, res, { query }) => json(res, 200, Q.listOnline(query.get('kind') === 'request' ? 'request' : 'offer')));

route('POST', '/api/ads', 10, async (req, res) => {
  if (!BOT_TOKEN || !BOT_USERNAME) return fail(res, 503, 'La publication est momentanément indisponible.');
  const { ad, error } = cleanAd(await readBody(req));
  if (error) return fail(res, 400, error);
  if (ad.date && `${ad.date} ${ad.time}` < parisNow()) return fail(res, 400, 'Cette date est déjà passée.');
  const token = crypto.randomBytes(12).toString('base64url');
  Q.addPending(token, ad);
  json(res, 200, { token, link: `https://t.me/${BOT_USERNAME}?start=${token}` });
});

route('GET', '/api/pending/:t', 60, (req, res, { p }) => {
  const row = Q.pending(p.t);
  json(res, 200, { done: !!row?.ad, expired: !row || Date.now() - row.created > PENDING_TTL });
});

route('GET', '/api/ads/:id/contact', 20, (req, res, { p }) => {
  const a = Q.getOnline(+p.id || 0);
  if (!a) return fail(res, 404, 'Cette annonce n’est plus en ligne.');
  Q.event('reveal', a.id, visitor(req));
  const c = (a.contact || 'tel,wa,tg').split(',');
  json(res, 200, { contact: c.join(','), phone: c.includes('tel') || c.includes('wa') || (c.includes('tg') && !a.tg) ? a.phone : null, tg: c.includes('tg') ? a.tg : null });
});

// Statistiques anonymes envoyées par la page (visite, clic sur Appeler / WhatsApp / Telegram, signalement).
const EVENTS = new Set(['visit', 'tel', 'wa', 'tg', 'report']);
route('POST', '/api/ev', 60, async (req, res) => {
  const b = await readBody(req, 1000);
  if (EVENTS.has(b.type)) Q.event(b.type, Number.isInteger(b.ad) ? b.ad : null, visitor(req));
  res.writeHead(204, SEC); res.end();
});

route('POST', '/api/edit/lookup', 10, async (req, res) => {
  const a = Q.byCode(sha(normCode((await readBody(req)).code)));
  if (!a) return fail(res, 404, 'Code inconnu, ou annonce plus en ligne.');
  const { phone, tg, tg_id, code_hash, ...pub } = a;
  json(res, 200, pub);
});
route('PUT', '/api/edit', 10, async (req, res) => {
  const b = await readBody(req), a = Q.byCode(sha(normCode(b.code)));
  if (!a) return fail(res, 404, 'Code inconnu, ou annonce plus en ligne.');
  const { ad, error } = cleanAd({ ...b, kind: a.kind });
  if (error) return fail(res, 400, error);
  if (ad.date && `${ad.date} ${ad.time}` < parisNow()) return fail(res, 400, 'Cette date est déjà passée.');
  Q.update(a.id, ad);
  json(res, 200, { ok: true });
});
route('DELETE', '/api/edit', 10, async (req, res) => {
  const a = Q.byCode(sha(normCode((await readBody(req)).code)));
  if (!a) return fail(res, 404, 'Code inconnu, ou annonce plus en ligne.');
  Q.archive(a.id, 'deleted');
  json(res, 200, { ok: true });
});

route('GET', '/api/trains', 0, async (req, res) => {
  // Même si la SNCF est en panne, on renvoie les gares (avec leur lien) : la page affiche « indisponible » pour chacune.
  json(res, 200, await trains(CFG.get().stations));
});

// ——— Administration ———
route('GET', '/admin', 0, (req, res) => renderHtml(ADMIN_PAGE, req, res));

route('POST', '/api/admin/login', 5, async (req, res) => {
  if (!auth.enabled) return fail(res, 503, 'Admin désactivé : définis ADMIN_PASSWORD (10 caractères minimum) dans le fichier .env, puis redémarre.');
  const ip = clientIp(req);
  if (auth.blocked(ip)) return fail(res, 429, 'Trop d’essais ratés. Réessaie dans une heure.');
  const { user, password } = await readBody(req);
  if (!auth.login(req, res, ip, user, password)) {
    console.warn('[admin] échec de connexion depuis', ip);
    return fail(res, 401, 'Identifiant ou mot de passe incorrect.');
  }
  console.log('[admin] connexion depuis', ip);
  bot?.notifyAdmins(`🔐 Connexion à la page admin de ${esc(CFG.plainName())} (IP ${esc(ip)}).\nSi ce n’est pas toi, change ADMIN_PASSWORD dans le .env et redémarre.`);
  json(res, 200, { ok: true });
});
route('POST', '/api/admin/logout', 0, (req, res) => { auth.logout(req, res); json(res, 200, { ok: true }); });
route('GET', '/api/admin/me', 0, (req, res) => json(res, 200, { logged: auth.check(req), enabled: auth.enabled }));

route('GET', '/api/admin/overview', 0, async (req, res) => {
  const W = [864e5, 7 * 864e5, 30 * 864e5, 0];
  const t = await trains(CFG.get().stations).catch(() => ({ stations: [] }));
  let backups = [];
  try { backups = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter(f => f.endsWith('.db')).sort().reverse(); } catch {}
  json(res, 200, { stats: stats(db, W), windows: ['24 h', '7 j', '30 j', 'total'],
    bot: { configured: !!BOT_TOKEN, username: BOT_USERNAME, ...(bot?.state() || {}) },
    stations: t.stations.map(s => ({ name: s.name, error: !!s.error, stale: !!s.stale })), backups,
    secrets: { adminPassword: auth.enabled, siteUrl: !!CFG.get().site.url, tunnel: !!env.TUNNEL_TOKEN } });
}, { admin: true });

route('GET', '/api/admin/ads', 0, (req, res, { query }) => {
  const page = Math.max(1, parseInt(query.get('page')) || 1), per = 50;
  const r = Q.adminList({ status: query.get('status') || 'all', kind: query.get('kind') || '', q: (query.get('q') || '').trim().slice(0, 60), limit: per, offset: (page - 1) * per });
  json(res, 200, { ...r, page, pages: Math.max(1, Math.ceil(r.total / per)) });
}, { admin: true });

// Création par l'admin, pour quelqu'un qui n'a pas Telegram. Renvoie le code secret à lui transmettre.
route('POST', '/api/admin/ads', 0, async (req, res) => {
  const b = await readBody(req), phone = frMobile(b.phone);
  if (!phone) return fail(res, 400, 'Numéro de mobile français (06 ou 07) obligatoire.');
  const { ad, error } = cleanAd({ ...b, contact: (Array.isArray(b.contact) ? b.contact : []).filter(c => c !== 'tg') });
  if (error) return fail(res, 400, error);
  if (ad.date && `${ad.date} ${ad.time}` < parisNow()) return fail(res, 400, 'Cette date est déjà passée.');
  const code = newCode();
  const id = Q.insert({ ...ad, phone, tg: null, tg_id: null, code_hash: sha(code) });
  json(res, 200, { id, code });
}, { admin: true });

route('PUT', '/api/admin/ads/:id', 0, async (req, res, { p }) => {
  const a = Q.get(+p.id);
  if (!a) return fail(res, 404, 'Annonce introuvable.');
  const b = await readBody(req), phone = frMobile(b.phone);
  if (!phone) return fail(res, 400, 'Numéro de mobile français (06 ou 07) obligatoire.');
  const { ad, error } = cleanAd({ ...b, kind: a.kind });
  if (error) return fail(res, 400, error);
  Q.adminUpdate(a.id, { ...ad, phone });
  json(res, 200, { ok: true });
}, { admin: true });

route('POST', '/api/admin/ads/:id/status', 0, async (req, res, { p }) => {
  const a = Q.get(+p.id), { status } = await readBody(req);
  if (!a) return fail(res, 404, 'Annonce introuvable.');
  if (status === 'removed') {
    if (Q.archive(a.id, 'removed') && a.tg_id) bot?.send(a.tg_id, `ℹ️ Ton annonce a été retirée par l’équipe de ${esc(CFG.plainName())} : ${esc(a.from_city)} → ${esc(a.to_city)}.`);
  } else if (status === 'online') {
    if (!Q.revive(a.id)) return fail(res, 400, 'Impossible : annonce anonymisée ou supprimée par son auteur·ice.');
  } else return fail(res, 400, 'Statut inconnu.');
  json(res, 200, { ok: true });
}, { admin: true });

// Effacement définitif (demande d'effacement RGPD, par exemple).
route('DELETE', '/api/admin/ads/:id', 0, (req, res, { p }) => json(res, Q.hardDelete(+p.id) ? 200 : 404, { ok: true }), { admin: true });

route('GET', '/api/admin/ads.csv', 0, (req, res) => {
  const cols = ['id', 'kind', 'status', 'name', 'from_city', 'to_city', 'date', 'days', 'time', 'seats', 'description', 'phone', 'tg', 'contact', 'created', 'updated', 'ended'];
  const cell = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // évite qu'Excel / LibreOffice interprète la cellule comme une formule
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const iso = t => t ? new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }) : '';
  const lines = [cols.join(';'), ...Q.exportAll().map(r => cols.map(c => cell(['created', 'updated', 'ended'].includes(c) ? iso(r[c]) : r[c])).join(';'))];
  res.writeHead(200, { ...SEC, 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="annonces-${parisNow().slice(0, 10)}.csv"` });
  res.end('﻿' + lines.join('\n'));
}, { admin: true });

route('GET', '/api/admin/config', 0, (req, res) => json(res, 200, CFG.get()), { admin: true });
route('PUT', '/api/admin/config', 0, async (req, res) => {
  try { json(res, 200, CFG.set(await readBody(req, 200_000))); } catch (e) { if (e.status) throw e; fail(res, 400, e.message); }
}, { admin: true });

route('GET', '/api/admin/bus', 0, (req, res) => json(res, 200, CFG.bus()), { admin: true });
route('PUT', '/api/admin/bus', 0, async (req, res) => {
  try { const b = CFG.setBus(await readBody(req, 8_000_000)); json(res, 200, { ok: true, trips: b.trips.length }); } catch (e) { if (e.status) throw e; fail(res, 400, e.message); }
}, { admin: true });

route('GET', '/api/admin/destinations', 0, (req, res) => {
  const seen = seenDestinations();
  json(res, 200, CFG.get().stations.map(st => ({ name: st.name, list: (seen[st.name] || []).map(d => ({ ...d, group: groupOf(st, d.dest), matched: st.groups.some(g => g.match.some(m => d.dest.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(m.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')))) })) })));
}, { admin: true });

// Sauvegarde téléchargeable : copie cohérente de la base au moment de la demande.
route('GET', '/api/admin/backup', 0, (req, res) => {
  const tmp = path.join(DATA_DIR, `.export-${crypto.randomBytes(6).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const st = fs.statSync(tmp);
  res.writeHead(200, { ...SEC, 'content-type': 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store', 'content-disposition': `attachment; filename="sauvegarde-${parisNow().slice(0, 10)}.db"` });
  // pipeline : le fichier temporaire est supprimé même si le téléchargement est interrompu.
  pipeline(fs.createReadStream(tmp), res, () => fs.rm(tmp, { force: true }, () => {}));
}, { admin: true });

// Modèle : export / import de toute la configuration (réglages + horaires de bus).
// Ni secret, ni ce qui est propre à cette instance : admins Telegram, adresse du site, e-mail de contact.
route('GET', '/api/admin/export', 0, (req, res) => {
  const { admins, ...config } = CFG.get(), { url, contact, ...site } = config.site;
  const body = JSON.stringify({ format: 'covoit-config', version: 1, config: { ...config, site }, bus: CFG.bus() }, null, 1);
  res.writeHead(200, { ...SEC, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="configuration-${parisNow().slice(0, 10)}.json"` });
  res.end(body);
}, { admin: true });
route('POST', '/api/admin/import', 0, async (req, res) => {
  const b = await readBody(req, 10_000_000);
  if (b.format !== 'covoit-config' || !b.config || typeof b.config !== 'object') return fail(res, 400, 'Ce fichier n’est pas un export de configuration.');
  // On garde les admins, l'adresse et le contact de cette instance, quoi que contienne le fichier.
  const cur = CFG.get();
  const next = { ...b.config, admins: cur.admins, site: { ...(b.config.site || {}), url: cur.site.url, contact: cur.site.contact } };
  // Tout est vérifié AVANT d'écrire : pas d'import à moitié appliqué.
  try { validateConfig(next); if (b.bus) validateBus(b.bus); } catch (e) { return fail(res, 400, e.message); }
  CFG.set(next); if (b.bus) CFG.setBus(b.bus);
  json(res, 200, { ok: true });
}, { admin: true });

const server = http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, 'http://x'); } catch { return fail(res, 400, 'URL invalide.'); }
  try {
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      if (r.max && limited(req, r.key, r.max)) return fail(res, 429, 'Trop de requêtes, réessaie dans une minute.');
      if (r.admin) {
        if (!auth.check(req)) return fail(res, 401, 'Session expirée : reconnecte-toi.');
        // Protection CSRF : une autre page ne peut pas ajouter cet en-tête sans y être autorisée.
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-admin'] !== '1') return fail(res, 403, 'Requête refusée.');
      }
      return await r.fn(req, res, { p: m.groups || {}, query: url.searchParams });
    }
    if (url.pathname.startsWith('/api/')) return fail(res, 404, 'Introuvable.');
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Méthode non autorisée.');
    serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err.status) return res.headersSent ? res.end() : fail(res, err.status, err.status === 413 ? 'Requête trop grosse.' : 'Requête invalide.');
    console.error('[http]', req.method, url.pathname, err);
    if (!res.headersSent) fail(res, 500, 'Erreur interne, réessaie plus tard.'); else res.end();
  }
});
server.headersTimeout = 15e3; server.requestTimeout = 60e3; server.keepAliveTimeout = 65e3;

// ——— Bot + entretien ———
const bot = BOT_TOKEN ? startBot({ db, Q, token: BOT_TOKEN, username: BOT_USERNAME, admins: CFG.admins, siteName: CFG.plainName,
  pendingTtl: PENDING_TTL, recurringDays: () => CFG.get().retention.recurringDays }) : null;
if (!BOT_TOKEN) console.warn('BOT_TOKEN manquant : bot désactivé, publication impossible.');
if (BOT_TOKEN && !BOT_USERNAME) console.warn('BOT_USERNAME manquant : publication impossible.');
if (BOT_TOKEN && !CFG.admins().size) console.warn('Aucun admin Telegram : envoie /monid au bot puis ajoute ton identifiant dans /admin (ou ADMIN_CHAT_IDS).');
if (!auth.enabled) console.warn('ADMIN_PASSWORD absent ou trop court (10 caractères minimum) : page /admin désactivée.');

function runMaintenance() {
  try {
    const { recurringDays, archiveDays } = CFG.get().retention;
    const r = maintenance(db, { recurringDays, archiveDays, pendingTtl: PENDING_TTL, dir: DATA_DIR });
    for (const a of r.expiredWeekly) bot?.notifyExpired(a);
    const n = r.expiredOnce + r.expiredWeekly.length + r.pendingPurged + r.anonymized;
    if (n || r.backup) console.log('[entretien]', { expirées: r.expiredOnce + r.expiredWeekly.length, pending: r.pendingPurged, anonymisées: r.anonymized, sauvegarde: r.backup });
  } catch (err) { console.error('[entretien]', err); }
}
runMaintenance();
const maintTimer = setInterval(runMaintenance, 5 * 60e3);

server.listen(PORT, () => console.log(`${CFG.plainName()} : http://localhost:${PORT}  (admin : /admin)`));

function shutdown(sig) {
  console.log(sig, ': arrêt…');
  clearInterval(maintTimer); bot?.stop();
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
