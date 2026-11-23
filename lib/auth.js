// Connexion à /admin : identifiant + mot de passe définis dans .env (ADMIN_USER, ADMIN_PASSWORD).
import crypto from 'node:crypto';

const SESSION_MS = 12 * 3600e3;          // une session dure 12 h
const COOKIE = 'cqr_admin';

export function createAuth({ user, password }) {
  const enabled = !!password && password.length >= 10;
  const sessions = new Map();            // jeton → { exp }
  const fails = new Map();               // ip → [horodatages des échecs]
  const h = s => crypto.createHash('sha256').update(String(s)).digest();
  const same = (a, b) => crypto.timingSafeEqual(h(a), h(b));   // comparaison à temps constant

  setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) if (s.exp < now) sessions.delete(k);
    for (const [ip, a] of fails) if (!a.some(t => now - t < 3600e3)) fails.delete(ip);
  }, 10 * 60e3).unref();

  const cookieOf = req => {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
    return m ? m[1] : null;
  };
  const secure = req => String(req.headers['x-forwarded-proto'] || '').includes('https') || !!req.socket.encrypted;
  const setCookie = (req, res, value, maxAge) => res.setHeader('set-cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`);

  return {
    enabled,
    // Trop d'échecs depuis cette IP ? (10 par heure)
    blocked: ip => (fails.get(ip) || []).filter(t => Date.now() - t < 3600e3).length >= 10,
    login(req, res, ip, u, p) {
      if (!enabled) return false;
      const ok = same(u || '', user) & same(p || '', password);   // « & » : on compare toujours les deux
      if (!ok) { fails.set(ip, [...(fails.get(ip) || []), Date.now()]); return false; }
      fails.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { exp: Date.now() + SESSION_MS });
      setCookie(req, res, token, SESSION_MS / 1000);
      return true;
    },
    logout(req, res) { const t = cookieOf(req); if (t) sessions.delete(t); setCookie(req, res, '', 0); },
    check(req) {
      const t = cookieOf(req), s = t && sessions.get(t);
      return !!s && s.exp >= Date.now();
    },
  };
}
