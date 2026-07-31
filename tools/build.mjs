#!/usr/bin/env node
/*
 * Сборка. Делает две вещи:
 *   1) decks/starter-en-a2-b1.json  ->  app/js/starter.js   (чтобы колода была доступна офлайн,
 *      без fetch — иначе она не работала бы при открытии с file://);
 *   2) app/*  ->  dist/anki-lite.html  (всё одним файлом: можно открыть без хостинга).
 *
 * Запуск: node tools/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'app');

// порядок важен: ровно в этом виде скрипты подключены в index.html
const scriptNames = ['srs.js', 'deck.js', 'store.js', 'report.js', 'tts.js', 'starter.js', 'docs.js', 'build.js', 'ui.js'];

// ---------- 1. стартовая колода в js ----------
const deckPath = join(root, 'decks', 'starter-en-a2-b1.json');
const deck = JSON.parse(readFileSync(deckPath, 'utf8'));
if (!Array.isArray(deck.cards) || !deck.cards.length) throw new Error('стартовая колода пустая');
const missing = deck.cards.filter((c) => !c.front || !c.back || !(c.examples || []).length);
if (missing.length) throw new Error('в колоде есть карточки без front/back/examples: ' + missing.length);

writeFileSync(join(app, 'js', 'starter.js'),
  '/* Сгенерировано tools/build.mjs из decks/starter-en-a2-b1.json — руками не править. */\n' +
  'window.STARTER_DECK = ' + JSON.stringify(deck) + ';\n');
console.log('ok  app/js/starter.js —', deck.cards.length, 'карточек');

// ---------- 2. инструкции для модели внутрь приложения ----------
// Чтобы их можно было скопировать или отправить прямо из приложения, без интернета.
const docs = {
  tutor: readFileSync(join(root, 'CLAUDE_INSTRUCTIONS.md'), 'utf8'),
  short: readFileSync(join(root, 'ДЛЯ-НЕЙРОНКИ.md'), 'utf8'),
  formats: readFileSync(join(root, 'FORMATS.md'), 'utf8'),
  profile: readFileSync(join(root, 'PROFILE.md'), 'utf8')
};
for (const [name, text] of Object.entries(docs)) {
  if (text.length < 500) throw new Error('документ ' + name + ' подозрительно короткий');
}
writeFileSync(join(app, 'js', 'docs.js'),
  '/* Сгенерировано tools/build.mjs из md-файлов в корне — руками не править. */\n' +
  'window.DOCS = ' + JSON.stringify(docs) + ';\n');
console.log('ok  app/js/docs.js —', Math.round(JSON.stringify(docs).length / 1024), 'КБ');

// ---------- 3. штамп сборки в service worker ----------
// Без этого браузер продолжает отдавать старую закешированную версию: имя кэша
// не меняется, обновление не устанавливается. Считаем хеш от всего, что публикуем.
const html = readFileSync(join(app, 'index.html'), 'utf8');
const css = readFileSync(join(app, 'css', 'style.css'), 'utf8');
const swPath = join(app, 'sw.js');
const swSrc = readFileSync(swPath, 'utf8');

// build.js в хеш не входит: он сам содержит штамп, иначе хеш зависел бы от себя.
// sw.js входит, но без строки VERSION — по той же причине.
const stampSource = [html, css, swSrc.replace(/var VERSION = '[^']*';/, '')]
  .concat(scriptNames.filter((n) => n !== 'build.js').map((n) => readFileSync(join(app, 'js', n), 'utf8')))
  .join(' ');
const stamp = createHash('sha256').update(stampSource).digest('hex').slice(0, 10);

const swOut = swSrc.replace(/var VERSION = '[^']*';/, () => "var VERSION = 'anki-lite-" + stamp + "';");
if (!swOut.includes(stamp)) throw new Error('не удалось записать штамп сборки в sw.js');
if (swOut !== swSrc) writeFileSync(swPath, swOut);
console.log('ok  app/sw.js — версия кэша anki-lite-' + stamp);

writeFileSync(join(app, 'js', 'build.js'),
  '/* Сгенерировано tools/build.mjs — руками не править. */\n' +
  'window.BUILD = ' + JSON.stringify({ stamp: stamp, date: new Date().toISOString().slice(0, 10) }) + ';\n');

// ---------- 4. однофайловая сборка ----------
// ВАЖНО: подставляем через функцию, иначе $& / $1 внутри кода будут съедены replace()
let out = html
  .replace('<link rel="stylesheet" href="css/style.css">', () => '<style>\n' + css + '\n</style>')
  .replace(/<link rel="manifest"[^>]*>\s*/, '')
  .replace(/<link rel="icon"[^>]*>\s*/, '')
  .replace(/<link rel="apple-touch-icon"[^>]*>\s*/, '');

for (const name of scriptNames) {
  const code = readFileSync(join(app, 'js', name), 'utf8');
  const tag = '<script src="js/' + name + '"></script>';
  if (!out.includes(tag)) throw new Error('в index.html нет тега для ' + name);
  out = out.replace(tag, () => '<script>\n' + code + '\n</script>');
}

if (/<script src=/.test(out)) throw new Error('не все скрипты встроены');
if (/<link rel="stylesheet"/.test(out)) throw new Error('стили не встроены');

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'anki-lite.html'), out);
console.log('ok  dist/anki-lite.html —', Math.round(out.length / 1024), 'КБ');

// ---------- 5. копия приложения по адресу /v2/ ----------
// Обход застрявшего кэша: старый service worker живёт в области /Anki/ и про этот путь
// ничего не знает, поэтому первая же загрузка приходит из сети. Данные не теряются —
// они привязаны к домену, а не к пути. Заодно это полноценный PWA-адрес со своим scope.
const v2 = join(app, 'v2');
rmSync(v2, { recursive: true, force: true });
mkdirSync(v2, { recursive: true });
for (const rel of ['index.html', 'manifest.webmanifest', 'sw.js']) {
  cpSync(join(app, rel), join(v2, rel));
}
for (const dir of ['css', 'js', 'icons']) {
  cpSync(join(app, dir), join(v2, dir), { recursive: true });
}
console.log('ok  app/v2/ — копия приложения для установки на телефон');
