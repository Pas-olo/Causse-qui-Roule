// Charge le fichier .env s'il existe (utile quand on lance « node server.js » sans Docker).
// Les variables déjà définies (par Docker, par exemple) ne sont pas écrasées.
try { process.loadEnvFile('.env'); console.log('Réglages chargés depuis .env'); } catch (e) { if (e.code !== 'ENOENT') console.warn('.env illisible :', e.message); }
