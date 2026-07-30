/*
 * srs.js — интервальное повторение (алгоритм в духе SM-2 / Anki).
 *
 * Чистые функции без DOM: этот же файл подключается и в браузере (глобальный SRS),
 * и в node-тестах (module.exports).
 *
 * Оценки: 1 = again (не помню), 2 = hard (тяжело), 3 = good (помню), 4 = easy (легко).
 * Состояния карточки: new -> learning -> review, а при провале review -> relearn -> review.
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var MIN = 60000;

  var DEFAULTS = {
    learningSteps: [1, 10],      // минуты: этапы первого изучения
    relearnSteps: [10],          // минуты: этапы после забывания
    graduatingInterval: 1,       // дни: интервал после прохождения learning на "good"
    easyInterval: 4,             // дни: интервал, если сразу нажали "легко"
    startEase: 2.5,
    minEase: 1.3,
    maxEase: 3.2,
    lapseIntervalFactor: 0.5,    // во сколько раз урезать интервал при провале
    minLapseInterval: 1,         // дни
    leechThreshold: 6,           // столько провалов — и карточка помечается как проблемная
    maxInterval: 365,            // дни
    fuzz: 0.05,                  // случайный разброс интервала, чтобы карточки не слипались
    newPerDay: 20,
    reviewsPerDay: 150,
    matureDays: 21,              // с какого интервала карточка считается выученной
    rng: null                    // можно подменить в тестах
  };

  function cfgOf(opts) {
    var cfg = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) cfg[k] = DEFAULTS[k];
    if (opts) for (var j in opts) if (Object.prototype.hasOwnProperty.call(opts, j) && opts[j] != null) cfg[j] = opts[j];
    return cfg;
  }

  function newSrs(cfg) {
    var c = cfgOf(cfg);
    return {
      state: 'new',
      step: 0,
      ef: c.startEase,
      interval: 0,
      due: 0,
      reps: 0,
      lapses: 0,
      leech: false,
      lastGrade: 0,
      lastReview: 0,
      introducedAt: 0
    };
  }

  function clampEase(ef, cfg) {
    if (!(ef > 0)) ef = cfg.startEase;
    return Math.min(cfg.maxEase, Math.max(cfg.minEase, Math.round(ef * 100) / 100));
  }

  function applyFuzz(days, cfg) {
    if (!cfg.fuzz || days < 3) return days;
    var rnd = (cfg.rng || Math.random)();
    var spread = days * cfg.fuzz;
    var out = Math.round(days + (rnd * 2 - 1) * spread);
    return Math.max(1, out);
  }

  function graduate(c, days, now, cfg) {
    c.state = 'review';
    c.step = 0;
    c.interval = Math.min(cfg.maxInterval, applyFuzz(days, cfg));
    c.due = now + c.interval * DAY;
    return c;
  }

  function stepDelay(steps, idx) {
    var i = Math.min(Math.max(idx, 0), steps.length - 1);
    return steps[i] * MIN;
  }

  /* "Тяжело" на этапе обучения не повторяет тот же интервал, что и "не помню":
     берём середину между текущим и следующим этапом, иначе кнопки неотличимы. */
  function hardDelay(steps, idx) {
    var i = Math.min(Math.max(idx, 0), steps.length - 1);
    var mins = (i + 1 < steps.length) ? (steps[i] + steps[i + 1]) / 2 : steps[i] * 1.5;
    return Math.max(steps[i], mins) * MIN;
  }

  /**
   * Планирует следующий показ карточки. Возвращает НОВЫЙ объект, вход не меняется.
   */
  function schedule(srs, grade, now, opts) {
    var cfg = cfgOf(opts);
    now = now || Date.now();
    grade = Math.min(4, Math.max(1, grade | 0));

    var c = {};
    var base = srs || newSrs(cfg);
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) c[k] = base[k];
    if (!c.state) c.state = 'new';
    if (!(c.ef > 0)) c.ef = cfg.startEase;

    c.reps = (c.reps || 0) + 1;
    c.lastGrade = grade;
    c.lastReview = now;
    if (!c.introducedAt) c.introducedAt = now;

    var st = c.state;

    if (st === 'new' || st === 'learning') {
      if (grade === 1) {
        c.state = 'learning';
        c.step = 0;
        c.due = now + stepDelay(cfg.learningSteps, 0);
      } else if (grade === 2) {
        c.state = 'learning';
        c.due = now + hardDelay(cfg.learningSteps, c.step || 0);
      } else if (grade === 3) {
        var next = (st === 'new' ? 0 : (c.step || 0) + 1);
        if (st === 'new') next = 1;
        if (next >= cfg.learningSteps.length) {
          graduate(c, cfg.graduatingInterval, now, cfg);
        } else {
          c.state = 'learning';
          c.step = next;
          c.due = now + stepDelay(cfg.learningSteps, next);
        }
      } else {
        graduate(c, cfg.easyInterval, now, cfg);
      }
      return c;
    }

    if (st === 'relearn') {
      if (grade === 1) {
        c.step = 0;
        c.due = now + stepDelay(cfg.relearnSteps, 0);
        return c;
      }
      if (grade === 2) {
        c.due = now + hardDelay(cfg.relearnSteps, c.step || 0);
        return c;
      }
      var nx = (c.step || 0) + 1;
      if (nx >= cfg.relearnSteps.length || grade === 4) {
        var back = Math.max(cfg.minLapseInterval, c.interval || cfg.minLapseInterval);
        return graduate(c, back, now, cfg);
      }
      c.step = nx;
      c.due = now + stepDelay(cfg.relearnSteps, nx);
      return c;
    }

    // st === 'review'
    if (grade === 1) {
      c.lapses = (c.lapses || 0) + 1;
      c.ef = clampEase(c.ef - 0.2, cfg);
      c.interval = Math.max(cfg.minLapseInterval, Math.round((c.interval || 1) * cfg.lapseIntervalFactor));
      c.state = 'relearn';
      c.step = 0;
      c.due = now + stepDelay(cfg.relearnSteps, 0);
      if (c.lapses >= cfg.leechThreshold) c.leech = true;
      return c;
    }

    var prev = Math.max(1, c.interval || 1);
    var ivl;
    if (grade === 2) {
      c.ef = clampEase(c.ef - 0.15, cfg);
      ivl = Math.max(prev, Math.round(prev * 1.2));
    } else if (grade === 3) {
      ivl = Math.max(prev + 1, Math.round(prev * c.ef));
    } else {
      c.ef = clampEase(c.ef + 0.15, cfg);
      ivl = Math.max(prev + 2, Math.round(prev * c.ef * 1.3));
    }
    c.state = 'review';
    c.step = 0;
    c.interval = Math.min(cfg.maxInterval, applyFuzz(ivl, cfg));
    c.due = now + c.interval * DAY;
    return c;
  }

  /** Через сколько покажем карточку при каждой оценке — для подписей на кнопках. */
  function previewIntervals(srs, now, opts) {
    var out = {};
    for (var g = 1; g <= 4; g++) {
      var next = schedule(srs, g, now, Object.assign({}, opts || {}, { fuzz: 0 }));
      out[g] = next.due - (now || Date.now());
    }
    return out;
  }

  function bucketOf(srs, cfg) {
    var c = cfgOf(cfg);
    if (!srs || srs.state === 'new' || !srs.reps) return 'new';
    if (srs.state === 'learning') return 'learning';
    if (srs.state === 'relearn') return 'relearn';
    return (srs.interval || 0) >= c.matureDays ? 'mature' : 'young';
  }

  function isDue(srs, now) {
    if (!srs || srs.state === 'new' || !srs.reps) return false;
    return (srs.due || 0) <= (now || Date.now());
  }

  /**
   * Собирает очередь на сессию.
   * cards — массив объектов {id, srs}. done — {newDone, reviewsDone} за сегодня.
   */
  function buildQueue(cards, now, opts, done) {
    var cfg = cfgOf(opts);
    now = now || Date.now();
    done = done || {};
    var rng = cfg.rng || Math.random;

    var learn = [], review = [], fresh = [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.suspended) continue;
      var s = card.srs;
      var b = bucketOf(s, cfg);
      if (b === 'new') { fresh.push(card); continue; }
      if (!isDue(s, now)) continue;
      if (b === 'learning' || b === 'relearn') learn.push(card);
      else review.push(card);
    }

    function shuffle(arr) {
      for (var j = arr.length - 1; j > 0; j--) {
        var k = Math.floor(rng() * (j + 1));
        var t = arr[j]; arr[j] = arr[k]; arr[k] = t;
      }
      return arr;
    }

    learn.sort(function (a, b2) { return (a.srs.due || 0) - (b2.srs.due || 0); });
    shuffle(review);
    // новые — в порядке добавления (position), чтобы колода изучалась предсказуемо
    fresh.sort(function (a, b2) { return (a.position || 0) - (b2.position || 0); });

    var revLimit = Math.max(0, cfg.reviewsPerDay - (done.reviewsDone || 0));
    var newLimit = Math.max(0, cfg.newPerDay - (done.newDone || 0));
    review = review.slice(0, revLimit);
    fresh = fresh.slice(0, newLimit);

    // перемешиваем повторения с новыми, чтобы новые не шли пачкой в конце
    var mixed = [];
    var ri = 0, fi = 0;
    var everyN = fresh.length ? Math.max(1, Math.round(review.length / fresh.length)) : 0;
    while (ri < review.length || fi < fresh.length) {
      for (var n = 0; n < everyN && ri < review.length; n++) mixed.push(review[ri++]);
      if (fi < fresh.length) mixed.push(fresh[fi++]);
      if (!everyN) { while (ri < review.length) mixed.push(review[ri++]); }
    }

    return { learning: learn, queue: learn.concat(mixed), counts: { learning: learn.length, review: review.length, new: fresh.length } };
  }

  function counts(cards, now, opts, done) {
    var cfg = cfgOf(opts);
    now = now || Date.now();
    var out = { new: 0, learning: 0, relearn: 0, young: 0, mature: 0, dueNow: 0, total: 0, suspended: 0 };
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      out.total++;
      if (c.suspended) { out.suspended++; continue; }
      var b = bucketOf(c.srs, cfg);
      out[b]++;
      if (b !== 'new' && isDue(c.srs, now)) out.dueNow++;
    }
    var q = buildQueue(cards, now, cfg, done);
    out.toStudy = q.queue.length;
    return out;
  }

  // ---- сравнение ответа при вводе с клавиатуры ----

  function normalize(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[’`]/g, "'")
      .replace(/[.,!?;:"()\[\]«»…]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function levenshtein(a, b) {
    a = a || ''; b = b || '';
    if (a === b) return 0;
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = new Array(n + 1), cur = new Array(n + 1), i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      for (j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
  }

  /**
   * Проверяет ввод. Допустимые ответы берутся из expected: строка или массив,
   * варианты можно разделять "/" или ";".
   * Возвращает {verdict: 'correct'|'typo'|'wrong', match, distance, suggestedGrade}
   */
  function checkAnswer(typed, expected, opts) {
    var tol = (opts && opts.typoTolerance != null) ? opts.typoTolerance : 1;
    var strip = !(opts && opts.strictArticles);
    var list = [];
    (Array.isArray(expected) ? expected : [expected]).forEach(function (e) {
      String(e == null ? '' : e).split(/[\/;]|\bили\b/).forEach(function (part) {
        var n = normalize(part);
        if (n) list.push(n);
      });
    });
    var t = normalize(typed);
    if (strip) {
      t = t.replace(/^(to|a|an|the)\s+/, '');
      list = list.map(function (x) { return x.replace(/^(to|a|an|the)\s+/, ''); });
    }
    if (!t) return { verdict: 'wrong', match: list[0] || '', distance: 99, suggestedGrade: 1 };

    var best = null, bestD = 1e9;
    for (var i = 0; i < list.length; i++) {
      var d = levenshtein(t, list[i]);
      if (d < bestD) { bestD = d; best = list[i]; }
    }
    if (bestD === 0) return { verdict: 'correct', match: best, distance: 0, suggestedGrade: 3 };
    var limit = (best && best.length >= 6) ? tol + 1 : tol;
    if (bestD <= limit && best && best.length >= 4) {
      return { verdict: 'typo', match: best, distance: bestD, suggestedGrade: 2 };
    }
    return { verdict: 'wrong', match: best, distance: bestD, suggestedGrade: 1 };
  }

  var api = {
    DAY: DAY,
    DEFAULTS: DEFAULTS,
    newSrs: newSrs,
    schedule: schedule,
    previewIntervals: previewIntervals,
    bucketOf: bucketOf,
    isDue: isDue,
    buildQueue: buildQueue,
    counts: counts,
    normalize: normalize,
    levenshtein: levenshtein,
    checkAnswer: checkAnswer
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SRS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
