import crypto from 'node:crypto';

export const sha = s => crypto.createHash('sha256').update(s).digest('hex');
export const normCode = c => String(c || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
export const newCode = () => Array.from(crypto.randomBytes(8), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
// Mobile français (06/07) → "+336…" ; sinon null. Accepte aussi « +33 (0)6 12 34 56 78 » (0 optionnel après l'indicatif seulement).
export const frMobile = s => {
  const m = String(s || '').replace(/[\s.\-()]/g, '').match(/^(?:0|(?:\+33|0033|33)0?)([67]\d{8})$/);
  return m ? '+33' + m[1] : null;
};
export const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Texte saisi par un·e utilisateur·ice : on retire les caractères de contrôle, mais aussi les caractères invisibles
// et d'inversion du sens d'écriture (qui permettent de maquiller un prénom ou une ville). On garde \u200d (émojis composés).
// oneLine : pour les champs qui doivent tenir sur une ligne (prénom, villes).
export const str = (v, n, oneLine = false) => {
  let s = String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  if (oneLine) s = s.replace(/\s+/g, ' ');
  return s.trim().slice(0, n);
};

const validDate = s => {
  if (!/^\d{4}-\d\d-\d\d$/.test(s || '')) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};

// Valide et normalise le formulaire d'annonce. Renvoie { ad } ou { error }.
export function cleanAd(b) {
  if (!b || typeof b !== 'object') return { error: 'Formulaire incomplet.' };
  const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
  const date = validDate(b.date) ? b.date : null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '') ? b.time : null;
  const name = str(b.name, 40, true), from_city = str(b.from, 40, true), to_city = str(b.to, 40, true);
  const contact = ['tel', 'wa', 'tg'].filter(c => Array.isArray(b.contact) && b.contact.includes(c)).join(',');
  if (!name) return { error: 'Indique ton prénom.' };
  if (!from_city || !to_city) return { error: 'Indique les villes de départ et d’arrivée.' };
  if (!contact) return { error: 'Choisis au moins un moyen de contact.' };
  if (!time) return { error: 'Indique une heure valide.' };
  if (!days.length && !date) return { error: 'Choisis une date ou au moins un jour.' };
  if (!days.length) {
    const max = new Date(Date.now() + 366 * 864e5).toISOString().slice(0, 10);
    if (date > max) return { error: 'Date trop lointaine (un an maximum).' };
  }
  const seats = Math.min(8, Math.max(1, parseInt(b.seats) || 1));
  return { ad: { kind: b.kind === 'request' ? 'request' : 'offer', name, from_city, to_city, contact,
    date: days.length ? null : date, days: JSON.stringify(days), time, seats, description: str(b.description, 500) } };
}
