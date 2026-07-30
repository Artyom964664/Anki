/* Тесты алгоритма повторений и проверки ввода: node --test tests/ */
const test = require('node:test');
const assert = require('node:assert');
const SRS = require('../app/js/srs.js');

const NOW = Date.parse('2026-07-30T12:00:00Z');
const MIN = 60000, DAY = 86400000;
const cfg = { fuzz: 0 }; // без случайного разброса, чтобы проверять точные числа

test('новая карточка: "помню" ведёт на второй этап обучения, а не сразу в повторения', () => {
  const c = SRS.schedule(SRS.newSrs(), 3, NOW, cfg);
  assert.equal(c.state, 'learning');
  assert.equal(c.step, 1);
  assert.equal(c.due - NOW, 10 * MIN);
  assert.equal(c.reps, 1);
});

test('новая карточка: "не помню" оставляет на первом этапе', () => {
  const c = SRS.schedule(SRS.newSrs(), 1, NOW, cfg);
  assert.equal(c.state, 'learning');
  assert.equal(c.step, 0);
  assert.equal(c.due - NOW, 1 * MIN);
});

test('новая карточка: "тяжело" даёт промежуточный интервал, а не тот же, что "не помню"', () => {
  const again = SRS.schedule(SRS.newSrs(), 1, NOW, cfg);
  const hard = SRS.schedule(SRS.newSrs(), 2, NOW, cfg);
  const good = SRS.schedule(SRS.newSrs(), 3, NOW, cfg);
  assert.ok(hard.due > again.due, 'тяжело позже, чем не помню');
  assert.ok(hard.due < good.due, 'тяжело раньше, чем помню');
  assert.equal(hard.due - NOW, 5.5 * MIN, 'середина между этапами 1 и 10 минут');
});

test('новая карточка: "легко" сразу отправляет в повторения на 4 дня', () => {
  const c = SRS.schedule(SRS.newSrs(), 4, NOW, cfg);
  assert.equal(c.state, 'review');
  assert.equal(c.interval, 4);
  assert.equal(c.due - NOW, 4 * DAY);
});

test('прохождение обучения: два "помню" выпускают карточку в повторения на 1 день', () => {
  let c = SRS.schedule(SRS.newSrs(), 3, NOW, cfg);
  c = SRS.schedule(c, 3, NOW + 10 * MIN, cfg);
  assert.equal(c.state, 'review');
  assert.equal(c.interval, 1);
  assert.equal(c.reps, 2);
});

test('в повторениях интервал растёт примерно на коэффициент лёгкости', () => {
  const base = { state: 'review', step: 0, ef: 2.5, interval: 10, due: NOW, reps: 5, lapses: 0 };
  const good = SRS.schedule(base, 3, NOW, cfg);
  assert.equal(good.interval, 25);
  assert.equal(good.ef, 2.5, 'на "помню" лёгкость не меняется');

  const easy = SRS.schedule(base, 4, NOW, cfg);
  assert.ok(easy.interval > good.interval, 'легко даёт больший интервал');
  assert.equal(easy.ef, 2.65);

  const hard = SRS.schedule(base, 2, NOW, cfg);
  assert.ok(hard.interval < good.interval, 'тяжело даёт меньший интервал');
  assert.equal(hard.ef, 2.35);
});

test('провал в повторениях: карточка уходит на переучивание, лёгкость падает, интервал урезается', () => {
  const base = { state: 'review', step: 0, ef: 2.5, interval: 20, due: NOW, reps: 8, lapses: 1 };
  const c = SRS.schedule(base, 1, NOW, cfg);
  assert.equal(c.state, 'relearn');
  assert.equal(c.lapses, 2);
  assert.equal(c.ef, 2.3);
  assert.equal(c.interval, 10);
  assert.equal(c.due - NOW, 10 * MIN, 'показать снова через 10 минут');
});

test('после переучивания карточка возвращается в повторения с урезанным интервалом', () => {
  let c = SRS.schedule({ state: 'review', ef: 2.5, interval: 20, reps: 8, lapses: 0 }, 1, NOW, cfg);
  c = SRS.schedule(c, 3, NOW + 10 * MIN, cfg);
  assert.equal(c.state, 'review');
  assert.equal(c.interval, 10);
});

test('лёгкость не падает ниже минимума даже после серии провалов', () => {
  let c = { state: 'review', ef: 2.5, interval: 5, reps: 3, lapses: 0 };
  for (let i = 0; i < 12; i++) {
    c = SRS.schedule(c, 1, NOW + i * DAY, cfg);
    c = SRS.schedule(c, 3, NOW + i * DAY + 10 * MIN, cfg);
  }
  assert.equal(c.ef, 1.3);
  assert.ok(c.leech, 'после 6+ провалов карточка помечена проблемной');
});

test('интервал не превышает максимум', () => {
  let c = { state: 'review', ef: 2.5, interval: 300, reps: 20, lapses: 0 };
  c = SRS.schedule(c, 4, NOW, cfg);
  assert.equal(c.interval, 365);
});

test('подписи на кнопках: интервалы растут от "не помню" к "легко"', () => {
  const p = SRS.previewIntervals({ state: 'review', ef: 2.5, interval: 10, reps: 5, lapses: 0 }, NOW, cfg);
  assert.ok(p[1] < p[2] && p[2] < p[3] && p[3] < p[4], JSON.stringify(p));
});

test('bucketOf раскладывает карточки по группам', () => {
  assert.equal(SRS.bucketOf(SRS.newSrs()), 'new');
  assert.equal(SRS.bucketOf({ state: 'learning', reps: 1 }), 'learning');
  assert.equal(SRS.bucketOf({ state: 'review', reps: 3, interval: 5 }), 'young');
  assert.equal(SRS.bucketOf({ state: 'review', reps: 9, interval: 30 }), 'mature');
});

test('очередь уважает дневные лимиты и не берёт то, что ещё не пора', () => {
  const cards = [];
  for (let i = 0; i < 30; i++) cards.push({ id: 'n' + i, position: i, srs: SRS.newSrs() });
  for (let i = 0; i < 10; i++) cards.push({ id: 'd' + i, srs: { state: 'review', reps: 3, ef: 2.5, interval: 5, due: NOW - DAY } });
  for (let i = 0; i < 5; i++) cards.push({ id: 'f' + i, srs: { state: 'review', reps: 3, ef: 2.5, interval: 5, due: NOW + 5 * DAY } });

  const q = SRS.buildQueue(cards, NOW, { newPerDay: 5, reviewsPerDay: 4, fuzz: 0 }, {});
  assert.equal(q.counts.new, 5, 'не больше лимита новых');
  assert.equal(q.counts.review, 4, 'не больше лимита повторений');
  assert.equal(q.queue.length, 9);
  assert.ok(!q.queue.some((c) => c.id.startsWith('f')), 'будущие карточки не попадают в очередь');
});

test('уже отвеченное сегодня вычитается из лимитов', () => {
  const cards = [];
  for (let i = 0; i < 10; i++) cards.push({ id: 'n' + i, position: i, srs: SRS.newSrs() });
  const q = SRS.buildQueue(cards, NOW, { newPerDay: 5, reviewsPerDay: 50, fuzz: 0 }, { newDone: 3 });
  assert.equal(q.counts.new, 2);
});

test('отложенные карточки в очередь не попадают', () => {
  const cards = [{ id: 'a', position: 0, srs: SRS.newSrs(), suspended: true },
                 { id: 'b', position: 1, srs: SRS.newSrs() }];
  const q = SRS.buildQueue(cards, NOW, { fuzz: 0 }, {});
  assert.equal(q.queue.length, 1);
  assert.equal(q.queue[0].id, 'b');
});

test('проверка ввода: точное совпадение', () => {
  const r = SRS.checkAnswer('receive', 'receive');
  assert.equal(r.verdict, 'correct');
  assert.equal(r.suggestedGrade, 3);
});

test('проверка ввода: регистр, пробелы и знаки не важны', () => {
  assert.equal(SRS.checkAnswer('  Take Off! ', 'take off').verdict, 'correct');
});

test('проверка ввода: опечатка в одну букву — это не ошибка, а "почти"', () => {
  const r = SRS.checkAnswer('recieve', 'receive');
  assert.equal(r.verdict, 'typo');
  assert.equal(r.suggestedGrade, 2);
});

test('проверка ввода: другое слово — ошибка', () => {
  const r = SRS.checkAnswer('borrow', 'lend');
  assert.equal(r.verdict, 'wrong');
  assert.equal(r.suggestedGrade, 1);
});

test('проверка ввода: короткое слово с опечаткой не прощается', () => {
  assert.equal(SRS.checkAnswer('bed', 'bad').verdict, 'wrong');
});

test('проверка ввода: артикль и to можно опустить', () => {
  assert.equal(SRS.checkAnswer('afford', 'to afford').verdict, 'correct');
  assert.equal(SRS.checkAnswer('the deadline', 'deadline').verdict, 'correct');
});

test('проверка ввода: любой из вариантов через слэш подходит', () => {
  assert.equal(SRS.checkAnswer('sort out', 'figure out / sort out').verdict, 'correct');
});

test('проверка ввода: пустой ответ — ошибка', () => {
  assert.equal(SRS.checkAnswer('   ', 'receive').verdict, 'wrong');
});

test('расстояние Левенштейна считается верно', () => {
  assert.equal(SRS.levenshtein('kitten', 'sitting'), 3);
  assert.equal(SRS.levenshtein('same', 'same'), 0);
  assert.equal(SRS.levenshtein('', 'abc'), 3);
});

test('schedule не мутирует переданный объект', () => {
  const before = SRS.newSrs();
  const copy = JSON.stringify(before);
  SRS.schedule(before, 4, NOW, cfg);
  assert.equal(JSON.stringify(before), copy);
});
