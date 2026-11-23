// Base SQLite (module intégré à Node ≥ 22.13) : schéma, migrations, requêtes.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const H = 3600e3, D = 24 * H;

// Date/heure locale française, au format comparable "YYYY-MM-DD HH:MM".
export const parisNow = (t = Date.now()) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).slice(0, 16);

export function openDb(dir = 'data') {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  migrate(db);
  return db;
}

function addCol(db, table, def) {
  const name = def.split(' ')[0];
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
}

function migrate(db) {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v < 1) {
    // Schéma d'origine (compatible avec les bases déjà en production).
    db.exec(`CREATE TABLE IF NOT EXISTS ads(id INTEGER PRIMARY KEY, kind TEXT, name TEXT, date TEXT, days TEXT, time TEXT, seats INT, description TEXT, phone TEXT, tg TEXT, code_hash TEXT, created INT);
      CREATE TABLE IF NOT EXISTS pending(token TEXT PRIMARY KEY, data TEXT, chat INT, ad INT, created INT);`);
    for (const c of ['from_city TEXT', 'to_city TEXT', 'contact TEXT']) addCol(db, 'ads', c);
    db.exec('PRAGMA user_version=1');
  }
  if (v < 2) {
    db.exec('BEGIN');
    try {
      // status : online | expired (date passée) | deleted (par l'auteur·ice) | removed (par l'admin)
      addCol(db, 'ads', "status TEXT NOT NULL DEFAULT 'online'");
      addCol(db, 'ads', 'ended INT');
      addCol(db, 'ads', 'updated INT');
      addCol(db, 'ads', 'tg_id INT');
      db.exec(`UPDATE ads SET updated=created WHERE updated IS NULL;
        UPDATE ads SET tg_id=(SELECT chat FROM pending p WHERE p.ad=ads.id) WHERE tg_id IS NULL;
        CREATE INDEX IF NOT EXISTS ads_status ON ads(status, kind);
        CREATE INDEX IF NOT EXISTS ads_code ON ads(code_hash);
        CREATE INDEX IF NOT EXISTS ads_owner ON ads(tg_id);
        CREATE TABLE IF NOT EXISTS events(t INT NOT NULL, type TEXT NOT NULL, ad INT, v TEXT);
        CREATE INDEX IF NOT EXISTS events_type ON events(type, t);
        PRAGMA user_version=2;`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

// Colonnes publiques d'une annonce (jamais le téléphone ni le hash du code).
const PUB = 'id,kind,name,from_city,to_city,date,days,time,seats,description';

export function queries(db) {
  const q = sql => db.prepare(sql);
  const onlineWhere = `status='online' AND (days!='[]' OR date||' '||time >= ?)`;
  return {
    listOnline: (kind) => q(`SELECT ${PUB} FROM ads WHERE kind=? AND ${onlineWhere} ORDER BY date IS NULL, date, time`).all(kind, parisNow()),
    getOnline: id => q(`SELECT * FROM ads WHERE id=? AND ${onlineWhere}`).get(id, parisNow()),
    get: id => q('SELECT * FROM ads WHERE id=?').get(id),
    byCode: hash => q(`SELECT * FROM ads WHERE code_hash=? AND ${onlineWhere}`).get(hash, parisNow()),
    insert: a => Number(q(`INSERT INTO ads(kind,name,from_city,to_city,date,days,time,seats,description,phone,tg,tg_id,code_hash,contact,created,updated,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'online')`).run(a.kind, a.name, a.from_city, a.to_city, a.date, a.days, a.time, a.seats, a.description,
      a.phone, a.tg, a.tg_id, a.code_hash, a.contact, Date.now(), Date.now()).lastInsertRowid),
    update: (id, c) => q('UPDATE ads SET name=?,from_city=?,to_city=?,date=?,days=?,time=?,seats=?,description=?,contact=?,updated=? WHERE id=?')
      .run(c.name, c.from_city, c.to_city, c.date, c.days, c.time, c.seats, c.description, c.contact, Date.now(), id),
    // Les annonces ne sont jamais effacées : elles passent en archive.
    archive: (id, status) => q("UPDATE ads SET status=?, ended=? WHERE id=? AND status='online'").run(status, Date.now(), id).changes,
    // Remise en ligne : seulement une annonce expirée ou retirée par l'admin, et pas anonymisée (téléphone présent).
    // Une annonce supprimée par son auteur·ice ne revient jamais.
    revive: id => q("UPDATE ads SET status='online', ended=NULL, updated=? WHERE id=? AND status IN ('expired','removed') AND phone IS NOT NULL").run(Date.now(), id).changes,
    setCode: (id, hash) => q('UPDATE ads SET code_hash=? WHERE id=?').run(hash, id),
    byOwner: tgId => q(`SELECT * FROM ads WHERE tg_id=? AND ${onlineWhere} ORDER BY id`).all(tgId, parisNow()),
    listAll: (limit, offset) => q(`SELECT * FROM ads WHERE ${onlineWhere} ORDER BY kind, date IS NULL, date, time LIMIT ? OFFSET ?`).all(parisNow(), limit, offset),
    countAll: () => q(`SELECT COUNT(*) n FROM ads WHERE ${onlineWhere}`).get(parisNow()).n,
    search: (s, digits) => q(`SELECT * FROM ads WHERE name LIKE ? OR from_city LIKE ? OR to_city LIKE ? OR tg LIKE ? OR (? != '' AND phone LIKE ?) ORDER BY id DESC LIMIT 15`)
      .all(`%${s}%`, `%${s}%`, `%${s}%`, `%${s}%`, digits, `%${digits}%`),

    addPending: (token, data) => q('INSERT INTO pending(token,data,created) VALUES(?,?,?)').run(token, JSON.stringify(data), Date.now()),
    pending: token => q('SELECT * FROM pending WHERE token=?').get(token),
    pendingOpen: (token, ttl) => q('SELECT * FROM pending WHERE token=? AND ad IS NULL AND created>?').get(token, Date.now() - ttl),
    pendingForChat: (chat, ttl) => q('SELECT * FROM pending WHERE chat=? AND ad IS NULL AND created>? ORDER BY created DESC').get(chat, Date.now() - ttl),
    setPendingChat: (token, chat) => q('UPDATE pending SET chat=? WHERE token=?').run(chat, token),
    setPendingAd: (token, ad) => q('UPDATE pending SET ad=? WHERE token=?').run(ad, token),

    // ——— Administration (page /admin) ———
    adminList({ status = 'all', kind = '', q = '', limit = 50, offset = 0 }) {
      const where = [], args = [];
      if (status === 'online') where.push("status='online'");
      else if (['expired', 'deleted', 'removed'].includes(status)) { where.push('status=?'); args.push(status); }
      else if (status === 'archived') where.push("status!='online'");
      if (kind === 'offer' || kind === 'request') { where.push('kind=?'); args.push(kind); }
      if (q) {
        const digits = q.replace(/\D/g, '');
        where.push(`(name LIKE ? OR from_city LIKE ? OR to_city LIKE ? OR tg LIKE ? OR description LIKE ? OR CAST(id AS TEXT)=?${digits.length >= 4 ? ' OR phone LIKE ?' : ''})`);
        args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, q.replace(/^#/, ''));
        if (digits.length >= 4) args.push(`%${digits.replace(/^0/, '')}%`);
      }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = db.prepare(`SELECT COUNT(*) n FROM ads ${w}`).get(...args).n;
      const rows = db.prepare(`SELECT id,kind,name,from_city,to_city,date,days,time,seats,description,phone,tg,tg_id,contact,status,created,updated,ended FROM ads ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
      return { total, rows };
    },
    adminUpdate: (id, c) => q('UPDATE ads SET name=?,from_city=?,to_city=?,date=?,days=?,time=?,seats=?,description=?,contact=?,phone=?,updated=? WHERE id=?')
      .run(c.name, c.from_city, c.to_city, c.date, c.days, c.time, c.seats, c.description, c.contact, c.phone, Date.now(), id).changes,
    hardDelete: id => q('DELETE FROM ads WHERE id=?').run(id).changes,
    exportAll: () => q('SELECT id,kind,status,name,from_city,to_city,date,days,time,seats,description,phone,tg,contact,created,updated,ended FROM ads ORDER BY id').all(),

    event: (type, ad = null, v = null) => q('INSERT INTO events(t,type,ad,v) VALUES(?,?,?,?)').run(Date.now(), type, ad, v),
  };
}

// Statistiques pour l'admin. windows = liste de durées en ms (0 = depuis le début).
export function stats(db, windows) {
  const now = Date.now(), q = sql => db.prepare(sql);
  const online = Object.fromEntries(q(`SELECT kind, COUNT(*) n FROM ads WHERE status='online' AND (days!='[]' OR date||' '||time >= ?) GROUP BY kind`).all(parisNow()).map(r => [r.kind, r.n]));
  const archived = Object.fromEntries(q("SELECT status, COUNT(*) n FROM ads WHERE status!='online' GROUP BY status").all().map(r => [r.status, r.n]));
  const pending = q('SELECT COUNT(*) n FROM pending WHERE ad IS NULL').get().n;
  const cols = windows.map(w => {
    const since = w ? now - w : 0;
    const ev = Object.fromEntries(q('SELECT type, COUNT(*) n, COUNT(DISTINCT v) u FROM events WHERE t>? GROUP BY type').all(since).map(r => [r.type, r]));
    return {
      created: q('SELECT COUNT(*) n FROM ads WHERE created>?').get(since).n,
      offers: q("SELECT COUNT(*) n FROM ads WHERE created>? AND kind='offer'").get(since).n,
      visits: ev.visit?.n || 0, visitors: ev.visit?.u || 0,
      reveal: ev.reveal?.n || 0, tel: ev.tel?.n || 0, wa: ev.wa?.n || 0, tg: ev.tg?.n || 0, report: ev.report?.n || 0,
    };
  });
  return { online, archived, pending, cols };
}

// Tâches d'entretien : archivage, purge, anonymisation, sauvegarde.
export function maintenance(db, { recurringDays, archiveDays, pendingTtl, dir = 'data', keepBackups = 7 }) {
  const now = Date.now(), out = {};
  out.expiredOnce = db.prepare(`UPDATE ads SET status='expired', ended=? WHERE status='online' AND days='[]' AND date||' '||time < ?`).run(now, parisNow()).changes;
  // Annonces hebdomadaires : expirent si elles n'ont pas été mises à jour depuis recurringDays.
  out.expiredWeekly = db.prepare(`UPDATE ads SET status='expired', ended=? WHERE status='online' AND days!='[]' AND COALESCE(updated,created) < ?
    RETURNING id, tg_id, from_city, to_city`).all(now, now - recurringDays * D);
  out.pendingPurged = db.prepare('DELETE FROM pending WHERE created < ?').run(now - pendingTtl).changes;
  // Au-delà de archiveDays, les archives sont anonymisées (on garde trajet/date pour les stats).
  out.anonymized = db.prepare(`UPDATE ads SET name='(anonymisé)', phone=NULL, tg=NULL, tg_id=NULL, description='', code_hash=NULL
    WHERE status!='online' AND ended < ? AND phone IS NOT NULL`).run(now - archiveDays * D).changes;
  out.eventsPurged = db.prepare('DELETE FROM events WHERE t < ?').run(now - 400 * D).changes;
  // Sauvegarde quotidienne cohérente (VACUUM INTO), on garde les keepBackups dernières.
  const bdir = path.join(dir, 'backups'), file = path.join(bdir, `app-${parisNow().slice(0, 10)}.db`);
  fs.mkdirSync(bdir, { recursive: true });
  if (!fs.existsSync(file)) {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    out.backup = file;
    const old = fs.readdirSync(bdir).filter(f => /^app-\d{4}-\d\d-\d\d\.db$/.test(f)).sort().slice(0, -keepBackups);
    for (const f of old) fs.rmSync(path.join(bdir, f), { force: true });
  }
  return out;
}
