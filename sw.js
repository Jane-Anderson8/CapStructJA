/*
 * sw.js — the service worker. It lets the app install and work offline.
 *
 * Network first: every request goes to GitHub Pages first, so each merged
 * change shows up. The copy saved in the cache is used only when the device
 * is offline. All paths are relative, because the site lives at
 * https://<username>.github.io/<repository>/, not at the root of a domain.
 */
var CACHE = 'capstruct-v1';
var FILES = [
  './',
  'index.html',
  'styles.css',
  'capstruct.js',
  'app.js',
  'manifest.webmanifest',
  'data/cdss.csv',
  'data/assumptions.csv',
  'data/banker_schedule.csv',
  'data/example_firms.csv',
  'data/ebit_scenarios.csv',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(FILES); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  // Only this site's own files. The app never asks other websites for anything.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then(function (res) {
      if (res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        return (req.mode === 'navigate' ? caches.match('index.html') : Promise.resolve(undefined))
          .then(function (page) {
            return page || new Response('Offline, and this file is not saved yet.', { status: 503 });
          });
      });
    })
  );
});
