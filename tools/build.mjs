#!/usr/bin/env node
/*
 * Сборка. Делает две вещи:
 *   1) decks/starter-en-a2-b1.json  ->  app/js/starter.js   (чтобы колода была доступна офлайн,
 *      без fetch — иначе она не работала бы при открытии с file://);
 *   2) app/*  ->  dist/anki-lite.html  (всё одним файлом: можно открыть без хостинга).
 *
 * Запуск: node tools/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'app');

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

// ---------- 3. однофайловая сборка ----------
const html = readFileSync(join(app, 'index.html'), 'utf8');
const css = readFileSync(join(app, 'css', 'style.css'), 'utf8');
const scripts = ['srs.js', 'deck.js', 'store.js', 'report.js', 'tts.js', 'starter.js', 'docs.js', 'ui.js'];

// ВАЖНО: подставляем через функцию, иначе $& / $1 внутри кода будут съедены replace()
let out = html
  .replace('<link rel="stylesheet" href="css/style.css">', () => '<style>\n' + css + '\n</style>')
  .replace(/<link rel="manifest"[^>]*>\s*/, '')
  .replace(/<link rel="icon"[^>]*>\s*/, '')
  .replace(/<link rel="apple-touch-icon"[^>]*>\s*/, '');

for (const name of scripts) {
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
