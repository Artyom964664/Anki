/* Service worker: приложение целиком кладётся в кэш, поэтому работает без интернета. */
/* Строка ниже генерируется tools/build.mjs из содержимого сборки — руками не править:
   когда меняется хоть один файл, меняется и имя кэша, и браузер забирает новую версию. */
var VERSION = 'anki-lite-b24bd26696';
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
  './js/docs.js',
  './js/build.js',
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

/*
 * Сеть в приоритете, кэш — резерв.
 *
 * Раньше было наоборот (кэш сразу, обновление в фоне), и это давало неприятный эффект:
 * после выхода новой версии первая загрузка всё равно показывала старую, а иногда новая
 * разметка встречалась со старыми скриптами. Сейчас при наличии сети приложение всегда
 * получает свежие файлы одной версии, а кэш срабатывает только офлайн или когда сеть
 * не ответила. Приложение маленькое (около 140 КБ), так что на скорости это не сказывается.
 */
function fromCache(req) {
  return caches.match(req).then(function (hit) {
    return hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined);
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  if (!self.navigator.onLine) {   // офлайн — не тратим время на попытку запроса
    e.respondWith(fromCache(req).then(function (hit) {
      return hit || Response.error();
    }));
    return;
  }

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      return fromCache(req).then(function (hit) {
        return hit || Response.error();
      });
    })
  );
});
