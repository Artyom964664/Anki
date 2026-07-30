/* Service worker: приложение целиком кладётся в кэш, поэтому работает без интернета. */
var VERSION = 'anki-lite-v1';
var ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/srs.js',
  './js/deck.js',
  './js/store.js',
  './js/report.js',
  './js/tts.js',
  './js/starter.js',
  './js/ui.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      // addAll падает целиком, если хоть один файл недоступен — кладём по одному
      return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) {
        // обновляем кэш в фоне, но отдаём сохранённое — быстро и офлайн
        fetch(req).then(function (res) {
          if (res && res.ok) caches.open(VERSION).then(function (c) { c.put(req, res.clone()); });
        }).catch(function () {});
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match('./index.html');
      });
    })
  );
});
