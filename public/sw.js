// Self-unregistering service worker.
//
// Earlier versions cached aggressively (cache-first) and served stale pages and
// API data, which masked deploys. This version removes the service worker
// entirely: on activation it deletes ALL caches, unregisters itself, and reloads
// open tabs so the app always loads fresh from the network. It does not
// intercept any requests.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch {
        // ignore cache errors
      }
      try {
        await self.registration.unregister();
      } catch {
        // ignore
      }
      try {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
          try { client.navigate(client.url); } catch { /* ignore */ }
        }
      } catch {
        // ignore
      }
    })(),
  );
});

// No fetch handler — every request goes straight to the network.
