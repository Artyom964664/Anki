/* Тесты разбора колод и слияния с существующим прогрессом. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../app/js/srs.js');           // Deck.merge берёт SRS.newSrs из глобального объекта
const Deck = require('../app/js/deck.js');

const NOW = Date.parse('2026-07-30T12:00:00Z');
const starterPath = path.join(__dirname, '..', 'decks', 'starter-en-a2-b1.json');

test('стартовая колода разбирается целиком и заполнена как надо', () => {
  const parsed = Deck.parse(fs.readFileSync(starterPath, 'utf8'));
  assert.equal(parsed.cards.length, 60);
  for (const c of parsed.cards) {
    assert.ok(c.front, 'есть английская сторона');
    assert.ok(c.back, 'есть перевод: ' + c.front);
    assert.ok(c.examples.length >= 1, 'есть пример: ' + c.front);
    assert.ok(c.examples[0].en && c.examples[0].ru, 'пример с переводом: ' + c.front);
    assert.ok(c.tags.length >= 1, 'есть теги: ' + c.front);
    assert.ok(/^[\x00-\x7F\s'’-]+$/.test(c.front), 'front латиницей: ' + c.front);
    assert.ok(/[а-яё]/i.test(c.back), 'back по-русски: ' + c.front);
  }
});

test('в стартовой колоде нет повторяющихся id', () => {
  const parsed = Deck.parse(fs.readFileSync(starterPath, 'utf8'));
  const ids = new Set(parsed.cards.map((c) => c.id));
  assert.equal(ids.size, parsed.cards.length);
});

test('id считается из английской стороны и стабилен', () => {
  assert.equal(Deck.makeId({ front: 'take off' }), 'w:take-off');
  assert.equal(Deck.makeId({ front: 'Take Off!' }), 'w:take-off');
});

test('JSON в блоке кода (как присылает модель) тоже разбирается', () => {
  const text = 'Вот новая колода:\n```json\n{"format":"anki-lite/deck","name":"x","cards":[{"front":"look up","back":"искать в словаре"}]}\n```\nУдачи!';
  const parsed = Deck.parse(text);
  assert.equal(parsed.cards.length, 1);
  assert.equal(parsed.cards[0].front, 'look up');
});

test('короткий текстовый формат: тире, примеры и теги', () => {
  const text = [
    '#phrasal-verbs work',
    'bring up — поднять тему | She brought it up again. | Она снова подняла эту тему.',
    'follow up - вернуться к вопросу позже',
    '',
    '// это комментарий, его нет в колоде',
    'мусорная строка без разделителя'
  ].join('\n');
  const parsed = Deck.parse(text, 'быстро');
  assert.equal(parsed.cards.length, 2);
  assert.deepEqual(parsed.cards[0].tags, ['phrasal-verbs', 'work']);
  assert.equal(parsed.cards[0].examples[0].en, 'She brought it up again.');
  assert.equal(parsed.cards[0].examples[0].ru, 'Она снова подняла эту тему.');
  assert.equal(parsed.cards[1].front, 'follow up');
  assert.equal(parsed.cards[1].examples.length, 0);
});

test('CSV с заголовком разбирается', () => {
  const csv = 'front,back,example_en,example_ru,tags\nissue,проблема,We fixed the issue.,Мы исправили проблему.,work nouns';
  const parsed = Deck.parse(csv);
  assert.equal(parsed.cards.length, 1);
  assert.equal(parsed.cards[0].back, 'проблема');
  assert.deepEqual(parsed.cards[0].tags, ['work', 'nouns']);
});

test('синонимы полей (en/ru/translation) понимаются', () => {
  const parsed = Deck.parse('{"cards":[{"en":"insight","ru":"понимание","phonetics":"/ˈɪnsaɪt/","mnemonic":"in + sight"}]}');
  const c = parsed.cards[0];
  assert.equal(c.front, 'insight');
  assert.equal(c.back, 'понимание');
  assert.equal(c.ipa, '/ˈɪnsaɪt/');
  assert.equal(c.note, 'in + sight');
});

test('пустой ввод и мусор дают понятную ошибку', () => {
  assert.throws(() => Deck.parse(''), /Пусто/);
  assert.throws(() => Deck.parse('{"foo":1}'), /cards/);
});

test('повторный импорт обновляет текст, но не сбрасывает прогресс', () => {
  const cards = {};
  const first = Deck.parse('{"name":"d1","cards":[{"front":"bring up","back":"поднять тему"}]}');
  let m = Deck.merge(cards, first, NOW, 0);
  assert.equal(m.added, 1);

  // ученик поучил карточку
  cards['w:bring-up'].srs = { state: 'review', reps: 7, lapses: 2, ef: 2.2, interval: 12, due: NOW };

  const second = Deck.parse('{"name":"d2","cards":[{"front":"bring up","back":"поднять (тему), упомянуть","tags":["work"],"examples":[{"en":"He brought it up.","ru":"Он поднял это."}]}]}');
  m = Deck.merge(cards, second, NOW, m.nextPosition);
  assert.equal(m.added, 0);
  assert.equal(m.updated, 1);

  const c = cards['w:bring-up'];
  assert.equal(c.back, 'поднять (тему), упомянуть', 'текст обновился');
  assert.equal(c.examples.length, 1, 'пример добавился');
  assert.deepEqual(c.tags, ['work'], 'теги слились');
  assert.equal(c.srs.reps, 7, 'прогресс сохранён');
  assert.equal(c.srs.interval, 12);
});

test('новые карточки получают возрастающие позиции и чистый прогресс', () => {
  const cards = {};
  const parsed = Deck.parse('{"cards":[{"front":"a b","back":"а"},{"front":"c d","back":"ц"}]}');
  const m = Deck.merge(cards, parsed, NOW, 10);
  assert.equal(m.nextPosition, 12);
  assert.equal(cards['w:a-b'].position, 10);
  assert.equal(cards['w:c-d'].position, 11);
  assert.equal(cards['w:a-b'].srs.state, 'new');
  assert.equal(cards['w:a-b'].addedAt, NOW);
});
