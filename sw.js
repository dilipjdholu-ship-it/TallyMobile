// Minimal service worker — its only job right now is to satisfy Chrome's
// PWA installability requirement (a registered service worker with a
// fetch handler). It doesn't cache anything or change behavior — every
// request just passes straight through to the network, same as without
// it. This can be extended later for real offline support if wanted.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
