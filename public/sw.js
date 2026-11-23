// Service worker minimal : permet l'installation sur l'écran d'accueil.
// Aucune mise en cache : le site reste toujours à jour.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
