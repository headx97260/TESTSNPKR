// Service Worker minimal — met en cache l'app shell pour un accès hors-ligne
// aux dernières données déjà calculées. Les appels à /api/prices ne sont PAS
// mis en cache : ils nécessitent une connexion pour récupérer des données à jour.

const CACHE_NAME = 'regime-marche-shell-v1';
const SHELL_FILES = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ne jamais mettre en cache les appels API — toujours aller chercher des données fraîches
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
