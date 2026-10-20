/* Fasti service worker: makes the app open with no connection.

   It sits beside index.html and must stay there. Never rename or move it: on
   iOS 26.0 to 26.5 an installed app whose sw.js went missing could be left
   permanently broken.

   BUILD must match the one in index.html (tests/tests.js checks). Changing it
   is what tells a device that a new version exists. */
const BUILD = '2026.10.20.1';
const CACHE = 'fasti-' + BUILD;
// The whole app. Everything else on this address is left to the network.
const SHELL = ['index.html', 'core.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 'no-cache': GitHub Pages lets a file be reused for ten minutes, and
    // without this the new worker could store the old page.
    await Promise.all(SHELL.map(async path => {
      const res = await fetch(new Request(path, { cache: 'no-cache' }));
      if (!res.ok) throw new Error(path + ': ' + res.status);
      await cache.put(path, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Only Fasti's own old stores. His other apps share this web address.
    for (const name of await caches.keys()) if (name.startsWith('fasti-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  // Never the sync server, and never anything that is not a plain read of this app's own files.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;
  const rel = url.pathname.slice(scope.length);
  // The app may be opened as ".../fasti/" or ".../fasti/index.html", with or without a query string.
  const path = rel === '' ? 'index.html' : rel;
  if (SHELL.indexOf(path) < 0) return;
  event.respondWith((async () => {
    const hit = await (await caches.open(CACHE)).match(path);
    return hit || fetch(req);
  })());
});
