// Bot Telegram (long polling) : vérification des annonces, gestion par l'auteur·ice, administration.
import { sha, newCode, frMobile, escHtml as e } from './util.js';
import { stats, parisNow } from './db.js';

const DJ = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const KIND = { offer: '🚗', request: '🙋' };
const STATUS = { online: '🟢 en ligne', expired: '⌛ expirée', deleted: '🗑 supprimée par son auteur·ice', removed: '⛔ retirée par l’admin' };
const MAX_ADS = 5;   // annonces en ligne maximum par compte Telegram
const SHARE_KB = { keyboard: [[{ text: '📱 Partager mon numéro', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };

export const when = a => {
  const d = JSON.parse(a.days || '[]');
  const t = (a.time || '').replace(':', 'h');
  if (d.length) return `${d.map(i => DJ[i]).join(' ')} · ${t}`;
  return `${new Date(a.date + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })} · ${t}`;
};
const line = a => `${KIND[a.kind] || ''} <b>${e(a.name)}</b> · ${e(a.from_city)} → ${e(a.to_city)} · ${e(when(a))}`;

// Durée "48h", "14j", "2s" (semaines) → ms
const parseWindow = s => {
  const m = String(s || '').match(/^(\d{1,4})\s*([hjds])/i);
  if (!m) return null;
  return +m[1] * { h: 3600e3, j: 864e5, d: 864e5, s: 7 * 864e5 }[m[2].toLowerCase()];
};
const wLabel = ms => !ms ? 'total' : ms <= 72 * 3600e3 || ms % 864e5 ? `${Math.round(ms / 3600e3)} h` : `${ms / 864e5} j`;

// admins, siteName et recurringDays sont des fonctions : la configuration peut changer depuis /admin sans redémarrer.
export function startBot({ db, Q, token, username, admins, siteName, pendingTtl, recurringDays }) {
  const API = `${process.env.TG_API || 'https://api.telegram.org'}/bot${token}/`;
  let running = true;
  const state = { ok: 0, error: null };   // pour le tableau de bord admin
  const stopCtrl = new AbortController();

  async function call(method, params = {}, timeout = 15000) {
    const signal = AbortSignal.any([stopCtrl.signal, AbortSignal.timeout(timeout)]);
    const r = await fetch(API + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal });
    const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!j.ok) { const err = new Error(`${method}: ${j.description}`); err.code = j.error_code; err.retry = j.parameters?.retry_after; throw err; }
    return j.result;
  }
  // Envoi qui ne fait jamais planter le bot (utilisateur·ice qui a bloqué le bot, etc.).
  const send = (chat, text, extra = {}) => call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra })
    .catch(err => console.warn('[bot] envoi impossible', chat, err.message));
  const isAdmin = chat => admins().has(String(chat));

  // ——— Messages ———
  async function onMessage(m) {
    const chat = m.chat?.id, from = m.from;
    // Discussions privées uniquement : dans un groupe, tous les membres hériteraient des droits liés à l'ID du groupe.
    if (!chat || !from || m.chat.type !== 'private') return;
    if (m.contact) return onContact(m);
    const text = (m.text || '').trim();
    const [cmd0, ...args] = text.split(/\s+/), cmd = cmd0.toLowerCase().replace(/@\w+$/, '');

    if (cmd === '/start' && args[0] && args[0] !== 'aide') {
      const row = Q.pendingOpen(args[0], pendingTtl);
      if (!row) return send(chat, 'Ce lien a expiré ou a déjà servi. Remplis à nouveau le formulaire sur le site.');
      Q.setPendingChat(row.token, chat);
      return send(chat, 'Pour publier ton annonce, partage ton numéro avec le bouton ci-dessous.\n\nIl ne sera montré qu’aux personnes qui cliquent sur « Contacter » sous ton annonce.'
        + (isAdmin(chat) ? '\n\n<b>Admin</b> : pour publier au nom de quelqu’un sans Telegram, envoie plutôt son numéro (ex. 06 12 34 56 78).' : ''), { reply_markup: SHARE_KB });
    }
    // Admin : publication au nom d'une personne sans Telegram (numéro tapé à la place du partage de contact).
    if (isAdmin(chat) && !text.startsWith('/') && frMobile(text)) return publishFor(chat, frMobile(text));
    if (isAdmin(chat) && cmd === '/ajouter') return send(chat, '➕ <b>Publier pour quelqu’un sans Telegram</b>\n\n1. Remplis le formulaire sur le site avec ses infos (prénom, trajet…).\n2. À l’étape Telegram, ouvre le lien puis, au lieu de partager ton numéro, <b>envoie ici son numéro</b> (06 ou 07).\n3. Je te donne le code secret à lui transmettre.\n\nSeul l’appel et WhatsApp seront proposés comme moyens de contact.');
    if (cmd === '/mesannonces') return myAds(chat, from.id);
    if (cmd === '/monid') return send(chat, `Ton identifiant Telegram : <code>${chat}</code>`);

    if (isAdmin(chat)) {
      if (cmd === '/admin' || cmd === '/stats') return sendStats(chat, args[0]);
      if (cmd === '/annonces') return listAds(chat, Math.max(1, parseInt(args[0]) || 1));
      const a = cmd.match(/^\/a(\d+)$/); if (a) return adDetail(chat, +a[1]);
      if (cmd === '/cherche') return search(chat, args.join(' '));
    }
    return send(chat, help(chat));
  }

  const help = chat => `👋 Bot de <b>${e(siteName())}</b>.\n\nPour publier un trajet, remplis le formulaire sur le site : il t’enverra ici.\n\n/mesannonces — voir, supprimer tes annonces ou recevoir un nouveau code secret`
    + (isAdmin(chat) ? `\n\n<b>Admin</b>\n/admin [48h|14j] — statistiques\n/annonces [page] — annonces en ligne\n/a12 — détail de l’annonce n°12 (téléphone, suppression)\n/cherche texte — par prénom, ville, @pseudo ou numéro (archives comprises)\n/ajouter — publier pour quelqu’un sans Telegram\n/monid — ton identifiant Telegram` : '');

  async function onContact(m) {
    const chat = m.chat.id;
    if (m.contact.user_id !== m.from.id) return send(chat, 'Partage <b>ton propre</b> numéro avec le bouton.', { reply_markup: SHARE_KB });
    const row = Q.pendingForChat(chat, pendingTtl);
    if (!row) return send(chat, 'Aucune annonce en attente : repasse par le site.', { reply_markup: { remove_keyboard: true } });
    const phone = frMobile(m.contact.phone_number);
    if (!phone) return send(chat, 'Désolé, il faut un compte Telegram avec un numéro de mobile français (06 ou 07).', { reply_markup: { remove_keyboard: true } });
    let d; try { d = JSON.parse(row.data); } catch { return send(chat, 'Annonce illisible, recommence sur le site.'); }
    // Anti-abus : un même compte ne peut pas avoir plus de MAX_ADS annonces en ligne.
    if (Q.byOwner(m.from.id).length >= MAX_ADS)
      return send(chat, `Tu as déjà ${MAX_ADS} annonces en ligne, c’est le maximum. Supprime-en une avec /mesannonces, puis renvoie ton numéro (ta demande reste valable 2 h).`, { reply_markup: SHARE_KB });
    // « Telegram seul » sans @pseudo : le seul moyen de te joindre serait ton numéro, que tu n'as pas choisi d'afficher.
    if (d.contact === 'tg' && !m.from.username)
      return send(chat, 'Tu as choisi d’être contacté·e <b>uniquement par Telegram</b>, mais ton compte n’a pas de nom d’utilisateur (@pseudo). Sans pseudo, les gens ne pourraient te joindre qu’avec ton numéro de téléphone, qui serait donc affiché.\n\nDeux solutions :\n• crée un pseudo dans Telegram (Paramètres → Nom d’utilisateur), puis renvoie ton numéro ici avec le bouton (ta demande reste valable 2 h) ;\n• ou recommence sur le site en ajoutant l’appel ou WhatsApp.', { reply_markup: SHARE_KB });
    const code = newCode();
    const id = Q.insert({ ...d, phone, tg: m.from.username || null, tg_id: m.from.id, code_hash: sha(code) });
    Q.setPendingAd(row.token, id);
    return send(chat, `✅ Annonce publiée !\n\n${line(d)}\n\nTon code secret pour la modifier sur le site :\n<code>${code}</code>\n\nCode perdu ? Tape /mesannonces ici pour en recevoir un nouveau ou supprimer l’annonce.`, { reply_markup: { remove_keyboard: true } });
  }

  function publishFor(chat, phone) {
    const row = Q.pendingForChat(chat, pendingTtl);
    if (!row) return send(chat, 'Aucune annonce en attente. Remplis d’abord le formulaire sur le site et ouvre le lien Telegram (voir /ajouter).');
    let d; try { d = JSON.parse(row.data); } catch { return send(chat, 'Annonce illisible, recommence sur le site.'); }
    const contact = d.contact.split(',').filter(c => c !== 'tg').join(',') || 'tel';
    const code = newCode();
    const id = Q.insert({ ...d, contact, phone, tg: null, tg_id: null, code_hash: sha(code) });
    Q.setPendingAd(row.token, id);
    return send(chat, `✅ Annonce n°${id} publiée pour <code>${e(phone)}</code> :\n${line(d)}\n\nCode secret à lui transmettre :\n<code>${code}</code>\n\nTu peux la gérer avec /a${id}.`, { reply_markup: { remove_keyboard: true } });
  }

  async function myAds(chat, uid) {
    const list = Q.byOwner(uid);
    if (!list.length) return send(chat, 'Tu n’as aucune annonce en ligne.');
    return send(chat, `Tes annonces en ligne :\n\n${list.map(a => `n°${a.id} ${line(a)}`).join('\n')}`, {
      reply_markup: { inline_keyboard: list.map(a => [{ text: `🗑 Supprimer n°${a.id}`, callback_data: `o:del:${a.id}` }, { text: `🔑 Nouveau code n°${a.id}`, callback_data: `o:code:${a.id}` }]) },
    });
  }

  // ——— Admin ———
  function sendStats(chat, arg) {
    const custom = parseWindow(arg);
    const windows = [864e5, 7 * 864e5, 30 * 864e5, ...(custom ? [custom] : []), 0];
    const s = stats(db, windows);
    const rows = [['Annonces créées', 'created'], ['  dont offres', 'offers'], ['Pages vues', 'visits'], ['Visiteurs*', 'visitors'],
      ['« Contacter »', 'reveal'], ['  Appels', 'tel'], ['  WhatsApp', 'wa'], ['  Telegram', 'tg'], ['Signalements', 'report']];
    const W = 6, L = 15, pad = (x, n) => String(x).padStart(n);
    const table = [''.padEnd(L) + windows.map(w => pad(wLabel(w), W)).join(''),
      ...rows.map(([l, k]) => l.padEnd(L).slice(0, L) + s.cols.map(c => pad(c[k], W)).join(''))].join('\n');
    const ar = s.archived;
    return send(chat, `📊 <b>${e(siteName())}</b> — ${e(parisNow())}\n\n`
      + `<b>En ligne</b> : ${s.online.offer || 0} trajets dispo · ${s.online.request || 0} demandes\n`
      + `En attente de vérification Telegram : ${s.pending}\n\n<pre>${e(table)}</pre>\n`
      + `<b>Archives</b> : ${ar.expired || 0} expirées · ${ar.deleted || 0} supprimées par leurs auteur·ices · ${ar.removed || 0} retirées par l’admin\n\n`
      + `<i>* visiteurs uniques par jour, additionnés (comptage anonyme sans cookie).</i>\n/annonces pour la liste · /admin 48h pour une autre période`);
  }

  function listAds(chat, page) {
    const per = 25, total = Q.countAll(), pages = Math.max(1, Math.ceil(total / per));
    page = Math.min(page, pages);
    const list = Q.listAll(per, (page - 1) * per);
    if (!list.length) return send(chat, 'Aucune annonce en ligne.');
    return send(chat, `<b>${total} annonce(s) en ligne</b> — page ${page}/${pages}\n\n${list.map(a => `/a${a.id} ${line(a)}`).join('\n')}`
      + (page < pages ? `\n\nSuite : /annonces ${page + 1}` : ''));
  }

  function adText(a) {
    return `<b>Annonce n°${a.id}</b> — ${STATUS[a.status] || e(a.status)}\n${line(a)}\n`
      + `${a.kind === 'offer' ? 'Places dispo' : 'Places demandées'} : ${a.seats}\n`
      + `Tél. : ${a.phone ? `<code>${e(a.phone)}</code>` : '—'} · Telegram : ${a.tg ? '@' + e(a.tg) : a.tg_id ? `id ${a.tg_id}` : '—'}\n`
      + `Contact affiché : ${e(a.contact || 'tel,wa,tg')}\n`
      + `Créée le ${new Date(a.created).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`
      + (a.ended ? `\nArchivée le ${new Date(a.ended).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}` : '')
      + (a.description ? `\n\n${e(a.description)}` : '');
  }
  function adDetail(chat, id) {
    const a = Q.get(id);
    if (!a) return send(chat, `Pas d’annonce n°${id}.`);
    const kb = a.status === 'online' ? [[{ text: '🗑 Retirer cette annonce', callback_data: `a:del:${id}` }]]
      : a.phone && ['expired', 'removed'].includes(a.status) ? [[{ text: '♻️ Remettre en ligne', callback_data: `a:renew:${id}` }]] : [];
    return send(chat, adText(a), kb.length ? { reply_markup: { inline_keyboard: kb } } : {});
  }
  function search(chat, s) {
    s = s.trim().replace(/^@/, '');
    if (s.length < 2) return send(chat, 'Exemple : /cherche Yolande, /cherche 0612345678, /cherche Caussade');
    const digits = s.replace(/\D/g, '').length >= 6 ? (frMobile(s)?.slice(3) || s.replace(/\D/g, '')) : '';
    const list = Q.search(s, digits);
    if (!list.length) return send(chat, 'Aucun résultat.');
    return send(chat, list.map(a => `/a${a.id} ${a.status === 'online' ? '' : '(' + a.status + ') '}${line(a)}`).join('\n'));
  }

  // ——— Boutons ———
  async function onCallback(cb) {
    const chat = cb.message?.chat?.id, mid = cb.message?.message_id;
    const [scope, act, idS] = String(cb.data || '').split(':'), id = +idS;
    const answer = text => call('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});
    const edit = (text, kb) => call('editMessageText', { chat_id: chat, message_id: mid, text, parse_mode: 'HTML', reply_markup: kb ? { inline_keyboard: kb } : undefined })
      .catch(err => console.warn('[bot] edit', err.message));
    const confirm = (prefix, label) => [[{ text: label, callback_data: `${prefix}:ok:${id}` }, { text: 'Annuler', callback_data: 'x' }]];
    if (cb.message?.chat?.type !== 'private') return answer();   // boutons de groupe ignorés

    if (scope === 'x') { await answer(); return edit('Annulé.'); }
    const a = Q.get(id);
    if (!a) return answer('Annonce introuvable.');

    if (scope === 'o' || scope === 'od') { // auteur·ice
      if (a.tg_id !== cb.from.id) return answer('Ce n’est pas ton annonce.');
      if (scope === 'o' && act === 'del') { await answer(); return edit(`Supprimer cette annonce ?\n\n${line(a)}`, confirm('od', '🗑 Oui, supprimer')); }
      if (scope === 'od' && act === 'ok') {
        await answer(Q.archive(id, 'deleted') ? 'Supprimée' : 'Déjà retirée');
        return edit(`🗑 Annonce supprimée :\n${line(a)}`);
      }
      if (act === 'code') {
        if (a.status !== 'online') return answer('Annonce plus en ligne.');
        const code = newCode(); Q.setCode(id, sha(code)); await answer('Nouveau code envoyé');
        return send(chat, `🔑 Nouveau code secret pour l’annonce n°${id} :\n<code>${code}</code>\n\nL’ancien ne fonctionne plus.`);
      }
      if (act === 'renew') {
        // Seulement une annonce expirée : une annonce retirée par l'admin ne peut pas être remise en ligne par son auteur·ice.
        if (a.status !== 'expired' || a.days === '[]' || !Q.revive(id)) return answer('Impossible de la remettre en ligne.');
        await answer('Remise en ligne');
        return edit(`♻️ Annonce remise en ligne pour ${recurringDays()} jours :\n${line(a)}`);
      }
    }
    if (scope === 'a' || scope === 'ad') { // admin
      if (!isAdmin(cb.from.id)) return answer('Réservé à l’admin.');   // la personne qui clique, pas la discussion
      if (scope === 'a' && act === 'del') { await answer(); return edit(`${adText(a)}\n\n<b>Retirer cette annonce ?</b>`, confirm('ad', '🗑 Oui, retirer')); }
      if (scope === 'ad' && act === 'ok') {
        const ok = Q.archive(id, 'removed'); await answer(ok ? 'Retirée' : 'Déjà retirée');
        if (ok && a.tg_id) send(a.tg_id, `ℹ️ Ton annonce a été retirée par l’équipe de ${e(siteName())} :\n${line(a)}`);
        return edit(adText(Q.get(id)));
      }
      if (act === 'renew') {
        if (a.days === '[]' && `${a.date} ${a.time}` < parisNow()) return answer('La date est passée.');
        if (!Q.revive(id)) return answer('Impossible : annonce anonymisée ou supprimée par son auteur·ice.');
        await answer('Remise en ligne');
        return edit(adText(Q.get(id)), [[{ text: '🗑 Retirer cette annonce', callback_data: `a:del:${id}` }]]);
      }
    }
    return answer();
  }

  // ——— Boucle ———
  async function poll() {
    try { await call('deleteWebhook'); } catch (err) { console.warn('[bot]', err.message); }
    call('setMyCommands', { commands: [{ command: 'mesannonces', description: 'Mes annonces : supprimer, nouveau code' }] }).catch(() => {});
    let offset = 0, fails = 0;
    while (running) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65000);
        fails = 0; state.ok = Date.now(); state.error = null;
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            if (u.message) await onMessage(u.message);
            else if (u.callback_query) await onCallback(u.callback_query);
          } catch (err) { console.error('[bot] update', u.update_id, err); }
        }
      } catch (err) {
        if (!running) break;
        fails++; state.error = err.message;
        if (err.code === 401) { console.error('[bot] BOT_TOKEN invalide : bot arrêté.'); state.error = 'BOT_TOKEN invalide'; return; }
        if (err.code === 409) console.warn('[bot] une autre instance utilise ce bot.');
        else console.warn('[bot]', err.message);
        await new Promise(r => setTimeout(r, err.retry ? err.retry * 1000 : Math.min(60e3, 2000 * 2 ** Math.min(fails, 5))));
      }
    }
  }
  poll();

  return {
    // Prévient l'auteur·ice qu'une annonce hebdomadaire a expiré, avec un bouton pour la prolonger.
    notifyExpired: a => a.tg_id && send(a.tg_id, `⌛ Ton annonce hebdomadaire n°${a.id} (${e(a.from_city)} → ${e(a.to_city)}) a expiré après ${recurringDays()} jours.\nToujours d’actualité ?`,
      { reply_markup: { inline_keyboard: [[{ text: '♻️ Remettre en ligne', callback_data: `o:renew:${a.id}` }]] } }),
    stop: () => { running = false; stopCtrl.abort(); },
    state: () => ({ ...state }),
    send,
    notifyAdmins: text => Promise.all([...admins()].map(id => send(id, text))),
  };
}
