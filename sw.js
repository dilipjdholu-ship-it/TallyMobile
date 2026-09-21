// TallyMobile service worker.
//
// Three jobs:
//  1. Makes the app's own shell (this HTML file + its static assets --
//     manifest, icons) load instantly on reopen instead of re-fetching
//     several hundred KB of HTML/CSS/JS over the network every single
//     time, on top of whatever Firebase data has to load. This used to
//     not actually exist as a file at all -- index.html registered
//     'sw.js' but nothing in this codebase ever delivered one, so that
//     registration was silently failing (caught, logged, ignored) and
//     doing nothing.
//  2. Caches the two Google Fonts (Inter, IBM Plex Mono) index.html
//     loads from fonts.googleapis.com/fonts.gstatic.com -- added Sept
//     2026. Those are a different origin from the app itself, so job #1
//     above never touched them; every open was still a live round trip
//     to Google for the font CSS and files before text could render in
//     the right typeface, on top of everything else. Fonts essentially
//     never change once fetched for a given browser, so this is a
//     simple cache-first policy (see FONT_HOSTS below), not stale-while-
//     revalidate -- there's no real staleness risk worth paying a
//     repeat network fetch for.
//  3. Still required for Chrome's real "Install" prompt (a service
//     worker with a fetch handler is one of the PWA installability
//     requirements) -- this used to be the ONLY reason this registration
//     existed, hence it was never built out to actually cache anything.
//
// Strategy for the shell (job #1): stale-while-revalidate -- always
// answer instantly from cache if a cached copy exists, AND always kick
// off a network fetch in the background to refresh the cache for next
// time. This means DJ never has to remember to bump a cache-busting
// version number every time he ships a new index.html by hand (there's
// no build/deploy pipeline generating hashed filenames here) -- the very
// next app open after he updates the file already has the fresh network
// response cached and ready, it just doesn't block THAT particular open
// on waiting for it. If he ever needs to force everyone onto a change to
// THIS file's own caching logic (not just index.html's content), bump
// CACHE_NAME (or FONT_CACHE_NAME) below -- activate() below deletes any
// cache under an old name for either one.
//
// Firebase Realtime Database/Auth traffic is a completely different
// origin (*.firebaseio.com / *.firebasedatabase.app / Google's auth
// endpoints) and is never touched by this file at all -- only same-
// origin GET requests and the two specific font hosts below are ever
// intercepted. Firebase's own SDK handles its own connection/retry/
// offline behavior independently of this.

const CACHE_NAME = 'tallymobile-shell-v1';
const FONT_CACHE_NAME = 'tallymobile-fonts-v1';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const KNOWN_CACHES = [CACHE_NAME, FONT_CACHE_NAME];

// Precached eagerly on install so the very first offline-ish open (e.g.
// a weak signal right as the app is opened) still has at least the shell
// itself. Kept short and certain-to-exist on purpose -- manifest.json
// and the icon files get picked up automatically by the fetch handler
// below the first time they're actually requested (stale-while-
// revalidate applies to every same-origin GET, not just this list), so
// a wrong guess at their exact path here can't break installation.
const SHELL_ASSETS = ['index.html'];

self.addEventListener('install', event => {
  self.skipWaiting(); // take over on the very next load, don't wait for old tabs to close
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).catch(() => {
      // Best-effort -- if even this small precache fails (e.g. offline
      // during install), the service worker still installs; the fetch
      // handler below will populate the cache from the first real
      // request instead.
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => !KNOWN_CACHES.includes(n)).map(n => caches.delete(n))))
      .then(() => self.clients.claim()) // take control of already-open tabs immediately, no reload needed
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Google Fonts: cache-first, no revalidation. Once a font (or its CSS)
  // is cached, it's served from cache forever -- no background refetch
  // like the shell below, because there's nothing to keep fresh here.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.status === 200) {
          cache.put(req, res.clone());
        }
        return res;
      } catch (e) {
        // Offline on the very first-ever fetch of this font, nothing
        // cached yet -- nothing we can do, let the request fail
        // naturally (the browser's own fallback font stack handles it).
        throw e;
      }
    })());
    return;
  }

  // Everything else: only same-origin GET requests get the shell's
  // stale-while-revalidate treatment. Firebase and anything else cross-
  // origin passes straight through untouched, exactly as if this
  // service worker didn't exist.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);

    const networkFetch = fetch(req).then(res => {
      // Only cache successful, same-origin (non-opaque) responses --
      // an error page or a redirected/opaque response is never worth
      // caching as if it were the real asset.
      if (res && res.status === 200 && res.type === 'basic') {
        cache.put(req, res.clone());
      }
      return res;
    }).catch(() => cached); // offline and nothing fresh -- fall back to whatever's cached, if anything

    // Explicitly keep the service worker alive for the background
    // refresh even though we're about to answer from cache below without
    // waiting on it -- respondWith() settling on `cached` doesn't by
    // itself guarantee the worker stays alive long enough for
    // networkFetch's cache.put() to finish otherwise.
    event.waitUntil(networkFetch);

    // Stale-while-revalidate: answer from cache immediately if we have
    // it (this is what makes reopening feel instant), otherwise wait for
    // the network -- true only on the very first ever load, or right
    // after the cache was cleared.
    return cached || networkFetch;
  })());
});
