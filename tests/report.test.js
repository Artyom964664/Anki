/* Тесты выгрузки для модели: цифры, проблемные слова, самоописание файла. */
const test = require('node:test');
const assert = require('node:assert');
const SRS = require('../app/js/srs.js');
const Report = require('../app/js/report.js');

const NOW = Date.parse('2026-07-30T12:00:00Z');
const DAY = 86400000;

function makeState() {
  const state = {
    profile: { name: 'Артём', level: 'B1', goal: 'работа' },
    settings: { newPerDay: 15, reviewsPerDay: 120, mode: 'mixed', matureDays: 21 },
    cards: {},
    log: [],
    daily: { date: '2026-07-30', newDone: 0, reviewsDone: 0 }
  };

  const add = (id, front, back, tags, srs) => {
    state.cards[id] = { id, front, back, tags, examples: [], srs };
  };

  // выучено надёжно
  add('w:take-off', 'take off', 'взлетать', ['phrasal-verbs'],
    { state: 'review', reps: 10, lapses: 0, ef: 2.6, interval: 40, due: NOW + 40 * DAY });
  // проблемное слово
  add('w:receive', 'receive', 'получать', ['verbs'],
    { state: 'relearn', reps: 9, lapses: 5, ef: 1.9, interval: 1, due: NOW });
  // молодое
  add('w:issue', 'issue', 'проблема', ['nouns', 'work'],
    { state: 'review', reps: 3, lapses: 0, ef: 2.5, interval: 6, due: NOW - DAY });
  // не начатое
  add('w:budget', 'budget', 'бюджет', ['nouns', 'work'], SRS.newSrs());

  const log = [];
  // take off — всегда успешно
  for (let i = 0; i < 6; i++) log.push({ ts: NOW - (10 - i) * DAY, id: 'w:take-off', grade: 3, mode: 'recognition', ms: 2500, typed: '', verdict: '' });
  // receive — сыпется при письме, с опечаткой
  for (let i = 0; i < 5; i++) log.push({ ts: NOW - (5 - i) * DAY, id: 'w:receive', grade: 1, mode: 'typing', ms: 8000, typed: 'recieve', verdict: 'typo' });
  log.push({ ts: NOW - DAY, id: 'w:receive', grade: 3, mode: 'typing', ms: 6000, typed: 'receive', verdict: 'correct' });
  // issue — в основном успешно
  for (let i = 0; i < 4; i++) log.push({ ts: NOW - (4 - i) * DAY, id: 'w:issue', grade: i === 0 ? 1 : 3, mode: 'recognition', ms: 3000, typed: '', verdict: '' });

  state.log = log.sort((a, b) => a.ts - b.ts);
  return state;
}

test('в выгрузке первым полем идёт инструкция для модели', () => {
  const r = Report.buildReport(makeState(), { now: NOW });
  const keys = Object.keys(r);
  assert.equal(keys[0], 'ИНСТРУКЦИЯ_ДЛЯ_МОДЕЛИ');
  const ins = r.ИНСТРУКЦИЯ_ДЛЯ_МОДЕЛИ;
  assert.match(ins.что_это, /приложения-карточек/);
  assert.ok(ins.что_сделать.length >= 5, 'есть пошаговый план');
  assert.equal(ins.шаблон_колоды.format, 'anki-lite/deck', 'шаблон ответа приложен');
  assert.equal(ins.уровень_ученика, 'B1');
});

test('сводка считает точность, количество и распределение карточек', () => {
  const r = Report.buildReport(makeState(), { now: NOW });
  const s = r.summary;
  assert.equal(s.totalCards, 4);
  assert.deepEqual(s.buckets, { new: 1, learning: 0, relearn: 1, young: 1, mature: 1 });
  assert.equal(s.reviewsTotal, 16);
  assert.equal(s.accuracyAll, 0.625, '10 успешных из 16');
  assert.equal(s.dueNow, 2, 'receive и issue пора повторять');
  assert.ok(s.avgAnswerMs > 0);
});

test('проблемные слова попадают в leeches и отсортированы по числу провалов', () => {
  const r = Report.buildReport(makeState(), { now: NOW });
  assert.equal(r.leeches.length, 1);
  assert.equal(r.leeches[0].front, 'receive');
  assert.equal(r.leeches[0].lapses, 5);
  assert.ok(r.leeches[0].accuracy < 0.5);
  assert.ok(!r.leeches.some((c) => c.front === 'take off'), 'выученное сюда не попадает');
});

test('слабые темы считаются по тегам и отсортированы от худшей', () => {
  const r = Report.buildReport(makeState(), { now: NOW });
  const verbs = r.weakTags.find((t) => t.tag === 'verbs');
  const pv = r.weakTags.find((t) => t.tag === 'phrasal-verbs');
  assert.ok(verbs, 'тема verbs присутствует');
  assert.ok(verbs.accuracy < 0.3, 'verbs провальные: ' + verbs.accuracy);
  assert.equal(pv.accuracy, 1, 'phrasal-verbs идеальные');
  assert.equal(r.weakTags[0].tag, 'verbs', 'худшая тема первая');
});

test('ошибки при вводе собираются с подсчётом повторов', () => {
  const r = Report.buildReport(makeState(), { now: NOW });
  assert.equal(r.typingErrors.length, 1);
  assert.equal(r.typingErrors[0].expected, 'receive');
  assert.equal(r.typingErrors[0].typed, 'recieve');
  assert.equal(r.typingErrors[0].count, 5);
});

test('надёжно выученное отдаётся отдельным списком', () => {
  const r = Report.buildReport(makeState(), { now: NOW });
  assert.deepEqual(r.knownWell, ['take off']);
});

test('история ответов обрезается, чтобы файл не разрастался', () => {
  const state = makeState();
  for (let i = 0; i < 40; i++) state.log.push({ ts: NOW - i * 3600000, id: 'w:issue', grade: 3, mode: 'recognition', ms: 1000, typed: '', verdict: '' });
  const r = Report.buildReport(state, { now: NOW, historyPerCard: 8 });
  const issue = r.cards.find((c) => c.id === 'w:issue');
  assert.equal(issue.history.length, 8);
});

test('короткая сводка объясняет себя и содержит главные цифры', () => {
  const d = Report.buildDigest(makeState(), { now: NOW });
  assert.match(d, /Это сводка из моего приложения/);
  assert.match(d, /anki-lite\/deck/, 'указан формат ответа');
  assert.match(d, /front всегда по-английски/, 'указано направление карточек');
  assert.match(d, /Уровень: B1/);
  assert.match(d, /receive = получать/, 'проблемное слово в сводке');
  assert.match(d, /recieve/, 'ошибка написания в сводке');
  assert.match(d, /Уже знаю надёжно.*take off/s);
  assert.ok(d.length < 4000, 'сводка влезает в сообщение чата: ' + d.length);
});

test('пустое состояние не ломает выгрузку', () => {
  const empty = { profile: {}, settings: { matureDays: 21 }, cards: {}, log: [] };
  const r = Report.buildReport(empty, { now: NOW });
  assert.equal(r.summary.totalCards, 0);
  assert.equal(r.summary.accuracyAll, null);
  assert.equal(r.summary.streakDays, 0);
  assert.deepEqual(r.leeches, []);
  assert.doesNotThrow(() => Report.buildDigest(empty, { now: NOW }));
});

test('серия дней считается по календарным дням подряд', () => {
  const state = makeState();
  state.log = [
    { ts: NOW, id: 'w:issue', grade: 3, ms: 1000 },
    { ts: NOW - DAY, id: 'w:issue', grade: 3, ms: 1000 },
    { ts: NOW - 2 * DAY, id: 'w:issue', grade: 3, ms: 1000 },
    { ts: NOW - 5 * DAY, id: 'w:issue', grade: 3, ms: 1000 }
  ];
  const r = Report.buildReport(state, { now: NOW });
  assert.equal(r.summary.streakDays, 3);
});
