/*
 * report.js — выгрузка прогресса для модели-репетитора.
 *
 * Две формы одного и того же:
 *   buildReport(state)  -> объект формата anki-lite/progress (полный, файлом)
 *   buildDigest(state)  -> короткий markdown, который удобно вставить в чат с телефона
 *
 * Формат подробно описан в FORMATS.md — модель читает именно его.
 */
(function (root) {
  'use strict';

  var DAY = 86400000;

  /* Файл выгрузки должен объяснять сам себя: модель может получить его вообще без
     контекста, поэтому инструкция едет внутри JSON первым полем. */
  function selfDescription(state) {
    return {
      что_это: 'Выгрузка прогресса из приложения-карточек «Английский» (anki-lite). Ученик учит английский по карточкам с интервальным повторением и прислал этот файл, чтобы ты разобрал его ошибки.',
      язык_общения: 'русский; примеры и разбор — на английском с переводом',
      уровень_ученика: (state.profile && state.profile.level) || 'не указан',
      цель_ученика: (state.profile && state.profile.goal) || 'не указана',
      что_сделать: [
        '1. Прочитай summary — общая точность и нагрузка. Если accuracy7d < 0.75, новых слов давай меньше обычного; если > 0.9 — больше.',
        '2. Разбери leeches (слова, которые не идут) — для каждого объясни, почему путается, и предложи мнемонику, уточнённый перевод или живой пример. Это самое важное.',
        '3. Посмотри weakTags — темы с точностью ниже 70%. По самой слабой дай короткий мини-урок (5–10 строк, без теории ради теории).',
        '4. Разбери typingErrors — это ошибки при письме. Найди закономерность (ei/ie, двойные согласные, окончания) и дай правило.',
        '5. Пришли новую колоду в формате anki-lite/deck (шаблон ниже) — 15–25 карточек, с учётом knownWell (эти слова не повторяй).',
        '6. Закончи 2–3 конкретными задачами на следующие дни.'
      ],
      формат_ответа: 'Сначала короткий разбор текстом, потом ОДИН блок кода с JSON колоды — ученик копирует его в приложение целиком (вкладка «Клод» → «Новые слова»).',
      шаблон_колоды: {
        format: 'anki-lite/deck',
        version: 1,
        name: 'короткое имя набора',
        cards: [{
          front: 'английское слово или фраза',
          back: 'перевод; можно несколько через ;',
          ipa: '/transcription/',
          pos: 'noun | verb | adj | phrasal verb | idiom',
          level: 'A2 | B1 | B2',
          tags: ['тема', 'подтема'],
          examples: [{ en: 'Живое предложение со словом.', ru: 'Перевод предложения.' }],
          note: 'мнемоника или подсказка, необязательно'
        }]
      },
      правила_карточек: [
        'front — всегда английский, back — всегда русский, иначе приложение перепутает направление.',
        'У каждой карточки минимум один пример с переводом: без контекста слово не запоминается.',
        'Не кладите в один набор похожие слова-паронимы — ученик начнёт их путать.',
        'Абстрактные слова переводите фразой, а не одним словом.',
        'Не присылай снова то, что уже есть в knownWell.'
      ],
      подробная_инструкция: 'CLAUDE_INSTRUCTIONS.md в репозитории приложения (Artyom964664/Anki)',
      поля_ниже: {
        summary: 'общая статистика: buckets — распределение карточек, accuracy* — доля ответов «помню/легко»',
        leeches: 'проблемные карточки: lapses — сколько раз забыл, accuracy — доля успешных ответов',
        weakTags: 'точность по темам (тегам)',
        typingErrors: 'что ученик написал вместо правильного слова',
        knownWell: 'слова, выученные надёжно — их не нужно давать заново',
        cards: 'полный список карточек с историей ответов (g: 1=не помню, 2=тяжело, 3=помню, 4=легко; ms — время ответа)'
      }
    };
  }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function round(x, n) {
    var p = Math.pow(10, n || 2);
    return Math.round((x || 0) * p) / p;
  }

  function cardList(state) {
    return Object.keys(state.cards || {}).map(function (id) { return state.cards[id]; });
  }

  function accuracy(entries) {
    if (!entries.length) return null;
    var ok = 0;
    entries.forEach(function (e) { if (e.grade >= 3) ok++; });
    return round(ok / entries.length, 3);
  }

  function streakOf(log, now) {
    var days = {};
    log.forEach(function (e) { days[dayKey(e.ts)] = 1; });
    var streak = 0;
    var cur = now || Date.now();
    // если сегодня не занимались — считаем от вчера, серия ещё не прервана
    if (!days[dayKey(cur)]) cur -= DAY;
    while (days[dayKey(cur)]) { streak++; cur -= DAY; }
    return streak;
  }

  function buildReport(state, opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    var historyPerCard = opts.historyPerCard || 8;
    var cards = cardList(state);
    var log = (state.log || []).slice();

    var byCard = {};
    log.forEach(function (e) {
      (byCard[e.id] = byCard[e.id] || []).push(e);
    });

    var last7 = log.filter(function (e) { return e.ts >= now - 7 * DAY; });
    var last30 = log.filter(function (e) { return e.ts >= now - 30 * DAY; });

    var buckets = { new: 0, learning: 0, relearn: 0, young: 0, mature: 0 };
    cards.forEach(function (c) { buckets[root.SRS.bucketOf(c.srs, state.settings)]++; });

    var times = last30.map(function (e) { return e.ms; }).filter(function (m) { return m > 0 && m < 60000; });
    var avgMs = times.length ? Math.round(times.reduce(function (a, b) { return a + b; }, 0) / times.length) : null;

    // --- проблемные карточки ---
    var leeches = [];
    cards.forEach(function (c) {
      var h = byCard[c.id] || [];
      if (!h.length) return;
      var acc = accuracy(h);
      var lapses = (c.srs && c.srs.lapses) || 0;
      var hard = lapses >= 3 || (h.length >= 3 && acc != null && acc < 0.6);
      if (!hard) return;
      leeches.push({
        id: c.id, front: c.front, back: c.back,
        tags: c.tags || [],
        reps: h.length, lapses: lapses, accuracy: acc,
        state: c.srs ? c.srs.state : 'new',
        interval: c.srs ? c.srs.interval : 0,
        note: c.note || ''
      });
    });
    leeches.sort(function (a, b) { return (b.lapses - a.lapses) || (a.accuracy - b.accuracy); });

    // --- слабые темы ---
    var tagStat = {};
    log.forEach(function (e) {
      var c = state.cards[e.id];
      if (!c) return;
      (c.tags && c.tags.length ? c.tags : ['без-тега']).forEach(function (t) {
        var s = tagStat[t] = tagStat[t] || { tag: t, reviews: 0, ok: 0, cards: {} };
        s.reviews++;
        if (e.grade >= 3) s.ok++;
        s.cards[e.id] = 1;
      });
    });
    var weakTags = Object.keys(tagStat).map(function (t) {
      var s = tagStat[t];
      return { tag: t, reviews: s.reviews, cards: Object.keys(s.cards).length, accuracy: round(s.ok / s.reviews, 3) };
    }).filter(function (s) { return s.reviews >= 4; })
      .sort(function (a, b) { return a.accuracy - b.accuracy; });

    // --- ошибки при вводе (орфография / не то слово) ---
    var typedErr = {};
    log.forEach(function (e) {
      if (!e.typed || e.verdict === 'correct') return;
      var c = state.cards[e.id];
      var key = e.id + '|' + e.typed.toLowerCase();
      var s = typedErr[key] = typedErr[key] || {
        id: e.id, expected: c ? c.front : '', typed: e.typed, verdict: e.verdict || 'wrong', count: 0
      };
      s.count++;
    });
    var typingErrors = Object.keys(typedErr).map(function (k) { return typedErr[k]; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 60);

    // --- уверенно выученное: чтобы модель не присылала это снова ---
    var known = cards.filter(function (c) {
      return c.srs && c.srs.state === 'review' && c.srs.interval >= (state.settings && state.settings.matureDays || 21) && (c.srs.lapses || 0) <= 1;
    }).map(function (c) { return c.front; });

    var perCard = cards.map(function (c) {
      var h = (byCard[c.id] || []).slice(-historyPerCard).map(function (e) {
        return { ts: new Date(e.ts).toISOString().slice(0, 16) + 'Z', g: e.grade, mode: e.mode, ms: e.ms, typed: e.typed || undefined };
      });
      return {
        id: c.id, front: c.front, back: c.back, tags: c.tags || [],
        state: c.srs ? c.srs.state : 'new',
        reps: c.srs ? c.srs.reps : 0,
        lapses: c.srs ? c.srs.lapses : 0,
        ef: c.srs ? c.srs.ef : null,
        interval: c.srs ? c.srs.interval : 0,
        due: c.srs && c.srs.due ? new Date(c.srs.due).toISOString().slice(0, 10) : null,
        accuracy: accuracy(byCard[c.id] || []),
        history: h
      };
    });

    var studyDays = {};
    log.forEach(function (e) { studyDays[dayKey(e.ts)] = (studyDays[dayKey(e.ts)] || 0) + 1; });

    return {
      ИНСТРУКЦИЯ_ДЛЯ_МОДЕЛИ: selfDescription(state),
      format: 'anki-lite/progress',
      version: 1,
      exportedAt: new Date(now).toISOString(),
      learner: state.profile || {},
      settings: {
        newPerDay: state.settings.newPerDay,
        reviewsPerDay: state.settings.reviewsPerDay,
        mode: state.settings.mode
      },
      summary: {
        totalCards: cards.length,
        buckets: buckets,
        reviewsTotal: log.length,
        reviews7d: last7.length,
        reviews30d: last30.length,
        accuracyAll: accuracy(log),
        accuracy7d: accuracy(last7),
        accuracy30d: accuracy(last30),
        avgAnswerMs: avgMs,
        streakDays: streakOf(log, now),
        studyDays: Object.keys(studyDays).length,
        dueNow: cards.filter(function (c) { return root.SRS.isDue(c.srs, now); }).length
      },
      byDay: Object.keys(studyDays).sort().slice(-30).map(function (d) { return { date: d, reviews: studyDays[d] }; }),
      leeches: leeches.slice(0, 40),
      weakTags: weakTags.slice(0, 20),
      typingErrors: typingErrors,
      knownWell: known.slice(0, 400),
      cards: perCard
    };
  }

  /** Короткая сводка для вставки прямо в чат (когда лень возиться с файлом). */
  function buildDigest(state, opts) {
    var r = buildReport(state, opts);
    var s = r.summary;
    var L = [];
    L.push('Это сводка из моего приложения-карточек для английского (anki-lite).');
    L.push('Ты — мой репетитор. Разбери ошибки ниже и пришли новую порцию слов одним блоком JSON формата anki-lite/deck');
    L.push('(поля: format, name, cards[{front, back, ipa, pos, level, tags[], examples[{en, ru}], note}] — front всегда по-английски, back по-русски, пример обязателен).');
    L.push('');
    L.push('СВОДКА ИЗ ПРИЛОЖЕНИЯ, ' + r.exportedAt.slice(0, 10));
    L.push('Уровень: ' + ((state.profile && state.profile.level) || '—') + ', цель: ' + ((state.profile && state.profile.goal) || '—'));
    L.push('Карточек: ' + s.totalCards + ' (новых ' + s.buckets.new + ', учу ' + (s.buckets.learning + s.buckets.relearn) + ', молодых ' + s.buckets.young + ', выучено ' + s.buckets.mature + ')');
    L.push('Повторений за 7 дней: ' + s.reviews7d + ', точность 7д: ' + (s.accuracy7d == null ? '—' : Math.round(s.accuracy7d * 100) + '%') + ', всего: ' + (s.accuracyAll == null ? '—' : Math.round(s.accuracyAll * 100) + '%'));
    L.push('Серия дней: ' + s.streakDays + ', среднее время ответа: ' + (s.avgAnswerMs ? (s.avgAnswerMs / 1000).toFixed(1) + ' с' : '—'));
    if (r.weakTags.length) {
      L.push('');
      L.push('Слабые темы:');
      r.weakTags.slice(0, 6).forEach(function (t) {
        L.push('- ' + t.tag + ': ' + Math.round(t.accuracy * 100) + '% (' + t.reviews + ' повторений)');
      });
    }
    if (r.leeches.length) {
      L.push('');
      L.push('Не идут (' + r.leeches.length + '):');
      r.leeches.slice(0, 15).forEach(function (c) {
        L.push('- ' + c.front + ' = ' + c.back + ' — провалов ' + c.lapses + ', точность ' + (c.accuracy == null ? '—' : Math.round(c.accuracy * 100) + '%'));
      });
    }
    if (r.typingErrors.length) {
      L.push('');
      L.push('Ошибки при вводе:');
      r.typingErrors.slice(0, 15).forEach(function (e) {
        L.push('- ждал "' + e.expected + '", написал "' + e.typed + '"' + (e.count > 1 ? ' (x' + e.count + ')' : ''));
      });
    }
    if (r.knownWell.length) {
      L.push('');
      L.push('Уже знаю надёжно (не присылай заново): ' + r.knownWell.slice(0, 60).join(', '));
    }
    L.push('');
    L.push('Что нужно от тебя: 1) разбор слов из списка «не идут» с мнемониками, 2) мини-урок по самой слабой теме, 3) правило по ошибкам в написании, 4) новая колода 15–25 карточек, 5) две-три задачи на неделю.');
    return L.join('\n');
  }

  var api = { buildReport: buildReport, buildDigest: buildDigest, dayKey: dayKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Report = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
