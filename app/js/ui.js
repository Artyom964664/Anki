/*
 * ui.js — экраны, тренировка, обмен файлами.
 */
(function () {
  'use strict';

  var S = window.Store, R = window.SRS, RP = window.Report, DK = window.Deck, T = window.TTS;
  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  var session = null;
  var shown = false;      // ответ уже открыт
  var startedAt = 0;
  var suggested = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, ms || 2200);
  }

  function fmtDelay(ms) {
    if (ms == null) return '';
    var m = ms / 60000;
    if (m < 1) return '<1 мин';
    if (m < 60) return Math.round(m) + ' мин';
    var h = m / 60;
    if (h < 24) return Math.round(h) + ' ч';
    var d = h / 24;
    if (d < 31) return Math.round(d) + ' дн';
    var mo = d / 30.4;
    if (mo < 12) return Math.round(mo) + ' мес';
    return (d / 365).toFixed(1) + ' г';
  }

  function applyTheme() {
    var th = state.settings.theme;
    if (th === 'auto') {
      var dark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', th);
    }
  }

  // ---------------- навигация ----------------
  var SCREENS = ['home', 'cards', 'stats', 'claude', 'settings'];

  function showScreen(name) {
    if (name === 'claude-export') { showScreen('claude'); $('block-export').scrollIntoView({ behavior: 'smooth' }); return; }
    SCREENS.forEach(function (n) {
      $('screen-' + n).classList.toggle('hidden', n !== name);
    });
    $('screen-review').classList.add('hidden');
    $('tabs').classList.remove('hidden');
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.dataset.screen === name);
    });
    window.scrollTo(0, 0);
    if (name === 'home') renderHome();
    if (name === 'cards') renderCards();
    if (name === 'stats') renderStats();
    if (name === 'claude') renderExportPreview();
    if (name === 'settings') fillSettings();
  }

  // ---------------- главный экран ----------------
  function streakDays() {
    var days = {};
    state.log.forEach(function (e) { days[RP.dayKey(e.ts)] = 1; });
    var n = 0, cur = Date.now();
    if (!days[RP.dayKey(cur)]) cur -= 86400000;
    while (days[RP.dayKey(cur)]) { n++; cur -= 86400000; }
    return n;
  }

  function renderHome() {
    S.rollDay();
    var cards = S.cardsArray();
    var done = { newDone: state.daily.newDone, reviewsDone: state.daily.reviewsDone };
    var c = R.counts(cards, Date.now(), state.settings, done);

    $('c-new').textContent = c.new;
    $('c-learn').textContent = c.learning + c.relearn;
    $('c-due').textContent = c.dueNow;
    $('c-mature').textContent = c.mature;
    $('streak').textContent = '🔥 ' + streakDays();

    var todayAnswers = state.daily.newDone + state.daily.reviewsDone;
    var goal = state.settings.dailyGoal || 40;
    $('goal-done').textContent = todayAnswers;
    $('goal-total').textContent = goal;
    $('goal-fill').style.width = Math.min(100, Math.round(todayAnswers / goal * 100)) + '%';

    Array.prototype.forEach.call(document.querySelectorAll('#mode-chips .chip'), function (b) {
      b.classList.toggle('active', b.dataset.mode === state.settings.mode);
    });

    var canStudy = c.toStudy > 0;
    $('btn-study').disabled = !canStudy;
    $('btn-study').textContent = canStudy ? 'Учить — ' + c.toStudy : 'На сегодня всё';
    var note = $('empty-note');
    if (!cards.length) {
      note.textContent = 'Колода пустая. Открой вкладку «Клод» и загрузи слова.';
      note.classList.remove('hidden');
    } else if (!canStudy) {
      note.textContent = c.dueNow ? 'Дневной лимит повторений исчерпан.' : 'Повторений нет — возвращайся позже. Хочешь больше? Поднимите лимит новых слов в настройках.';
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }
  }

  // ---------------- тренировка ----------------
  function pickMode(card) {
    var setting = state.settings.mode;
    var bucket = R.bucketOf(card.srs, state.settings);
    var hasExample = (card.examples || []).some(function (e) { return e.en; });
    if (bucket === 'new') return 'recognition';           // новое слово сначала показываем
    if (setting !== 'mixed') {
      if (setting === 'listening' && !T.available()) return 'typing';
      return setting;
    }
    var r = Math.random();
    if (r < 0.40) return 'recognition';
    if (r < 0.70) return 'typing';
    if (r < 0.85 && hasExample) return 'cloze';
    return T.available() ? 'listening' : 'typing';
  }

  function clozeFrom(card) {
    var ex = (card.examples || []).filter(function (e) { return e.en; })[0];
    if (!ex) return null;
    var word = (card.front || '').trim();
    if (!word) return null;
    var re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (!re.test(ex.en)) return null;
    return { text: ex.en.replace(re, '@@GAP@@'), ru: ex.ru || '' };
  }

  function startSession() {
    S.rollDay();
    var done = { newDone: state.daily.newDone, reviewsDone: state.daily.reviewsDone };
    var q = R.buildQueue(S.cardsArray(), Date.now(), state.settings, done);
    if (!q.queue.length) { toast('Сейчас нечего повторять'); return; }
    session = { ids: q.queue.map(function (c) { return c.id; }), idx: 0, done: 0 };
    $('tabs').classList.add('hidden');
    SCREENS.forEach(function (n) { $('screen-' + n).classList.add('hidden'); });
    $('screen-review').classList.remove('hidden');
    nextCard();
  }

  function endSession() {
    session = null;
    T.stop();
    showScreen('home');
  }

  function nextCard() {
    if (!session) return;
    if (session.idx >= session.ids.length) {
      var n = session.done;
      endSession();
      toast(n ? 'Готово! Ответов: ' + n : 'Сессия завершена');
      return;
    }
    var card = state.cards[session.ids[session.idx]];
    if (!card) { session.idx++; return nextCard(); }
    renderCard(card);
  }

  function renderCard(card) {
    shown = false;
    startedAt = Date.now();
    suggested = 0;
    var mode = pickMode(card);
    if (mode === 'cloze' && !clozeFrom(card)) mode = 'typing';
    session.mode = mode;

    var remaining = session.ids.length - session.idx;
    $('review-counter').textContent = session.done + '/' + (session.done + remaining);
    $('review-bar').style.width = Math.round(session.done / (session.done + remaining) * 100) + '%';

    var q = $('card-question'), ipa = $('card-ipa'), hint = $('card-hint');
    var ansBox = $('answer-box'), input = $('answer-input');
    var label = $('card-mode-label');
    var speak = $('speak-btn');

    $('card-answer').classList.add('hidden');
    $('verdict').textContent = '';
    $('verdict').className = 'verdict';
    $('grades').classList.add('hidden');
    input.value = '';
    input.disabled = false;
    ipa.textContent = '';
    hint.textContent = '';
    speak.classList.add('hidden');

    var ttsOn = state.settings.tts && T.available();

    if (mode === 'recognition') {
      label.textContent = 'узнай слово';
      q.textContent = card.front;
      if (state.settings.showIpa && card.ipa) ipa.textContent = card.ipa;
      ansBox.classList.add('hidden');
      if (ttsOn) speak.classList.remove('hidden');
      $('btn-show').classList.remove('hidden');
      $('btn-check').classList.add('hidden');
      if (ttsOn && state.settings.autoPlay) T.speak(card.front, { voice: state.settings.ttsVoice, rate: state.settings.ttsRate });
    } else if (mode === 'typing') {
      label.textContent = 'напиши по-английски';
      q.textContent = card.back || '(нет перевода)';
      if (card.pos) hint.textContent = card.pos;
      ansBox.classList.remove('hidden');
      $('btn-show').classList.add('hidden');
      $('btn-check').classList.remove('hidden');
      setTimeout(function () { input.focus(); }, 60);
    } else if (mode === 'listening') {
      label.textContent = 'на слух — запиши, что услышал';
      q.textContent = '🎧';
      hint.textContent = 'нажми кнопку, если не расслышал';
      speak.classList.remove('hidden');
      ansBox.classList.remove('hidden');
      $('btn-show').classList.add('hidden');
      $('btn-check').classList.remove('hidden');
      T.speak(card.front, { voice: state.settings.ttsVoice, rate: state.settings.ttsRate });
      setTimeout(function () { input.focus(); }, 60);
    } else { // cloze
      var cz = clozeFrom(card);
      label.textContent = 'вставь пропущенное слово';
      q.innerHTML = esc(cz.text).replace('@@GAP@@', '<span class="gap">&nbsp;</span>');
      if (cz.ru) hint.textContent = cz.ru;
      ansBox.classList.remove('hidden');
      $('btn-show').classList.add('hidden');
      $('btn-check').classList.remove('hidden');
      setTimeout(function () { input.focus(); }, 60);
    }
  }

  function revealAnswer(card, opts) {
    shown = true;
    opts = opts || {};
    var box = $('card-answer');
    var mode = session.mode;

    $('answer-main').textContent = mode === 'recognition' ? (card.back || '—') : card.front;
    var meta = [];
    if (mode !== 'recognition' && card.back) meta.push(card.back);
    if (card.ipa && state.settings.showIpa) meta.push(card.ipa);
    if (card.pos) meta.push(card.pos);
    if (card.level) meta.push(card.level);
    $('answer-pos').textContent = meta.join(' · ');

    var ul = $('examples');
    ul.innerHTML = '';
    (card.examples || []).slice(0, 3).forEach(function (e) {
      if (!e.en && !e.ru) return;
      var li = document.createElement('li');
      var en = esc(e.en);
      if (card.front) {
        var re = new RegExp('\\b(' + card.front.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\b', 'ig');
        en = en.replace(re, '<em>$1</em>');
      }
      li.innerHTML = '<span class="en">' + en + '</span>' + (e.ru ? '<span class="ru">' + esc(e.ru) + '</span>' : '');
      ul.appendChild(li);
    });

    $('card-note').textContent = card.note || '';
    var tg = $('card-tags');
    tg.innerHTML = '';
    (card.tags || []).forEach(function (t) {
      var s = document.createElement('span'); s.textContent = t; tg.appendChild(s);
    });

    box.classList.remove('hidden');
    $('btn-show').classList.add('hidden');
    $('btn-check').classList.add('hidden');
    $('grades').classList.remove('hidden');

    var prev = R.previewIntervals(card.srs, Date.now(), state.settings);
    for (var g = 1; g <= 4; g++) $('ivl-' + g).textContent = fmtDelay(prev[g]);

    if (state.settings.tts && T.available() && (mode !== 'recognition' || !state.settings.autoPlay) && !opts.silent) {
      T.speak(card.front, { voice: state.settings.ttsVoice, rate: state.settings.ttsRate });
    }
  }

  function checkTyped() {
    var card = state.cards[session.ids[session.idx]];
    var typed = $('answer-input').value;
    var res = R.checkAnswer(typed, card.front, state.settings);
    var v = $('verdict');
    session.typed = typed;
    session.verdict = res.verdict;
    suggested = res.suggestedGrade;
    if (res.verdict === 'correct') {
      v.className = 'verdict ok';
      v.textContent = '✓ верно';
    } else if (res.verdict === 'typo') {
      v.className = 'verdict typo';
      v.innerHTML = '≈ почти: опечатка — <b>' + esc(card.front) + '</b>';
    } else {
      v.className = 'verdict err';
      v.innerHTML = '✗ <s>' + esc(typed || '—') + '</s> → <b>' + esc(card.front) + '</b>';
    }
    $('answer-input').disabled = true;
    revealAnswer(card);
  }

  function grade(g) {
    if (!session) return;
    var id = session.ids[session.idx];
    var card = state.cards[id];
    if (!card) return;
    var ms = Date.now() - startedAt;
    S.recordReview(id, g, { mode: session.mode, ms: ms, typed: session.typed || '', verdict: session.verdict || '' });
    session.typed = ''; session.verdict = '';
    session.done++;
    session.idx++;

    // если карточка скоро снова нужна (learning / relearn) — вернём её в эту же сессию
    var srs = card.srs;
    if (srs.due - Date.now() < 11 * 60000 && srs.state !== 'review') {
      var insertAt = Math.min(session.ids.length, session.idx + 3);
      session.ids.splice(insertAt, 0, id);
    }
    nextCard();
  }

  // ---------------- слова ----------------
  var cardFilter = { q: '', tag: '' };

  function renderCards() {
    var all = S.cardsArray();
    $('cards-total').textContent = all.length + ' шт.';

    var tags = {};
    all.forEach(function (c) { (c.tags || []).forEach(function (t) { tags[t] = (tags[t] || 0) + 1; }); });
    var tf = $('tag-filter');
    tf.innerHTML = '';
    var mk = function (label, val) {
      var b = document.createElement('button');
      b.className = 'chip' + (cardFilter.tag === val ? ' active' : '');
      b.textContent = label;
      b.onclick = function () { cardFilter.tag = cardFilter.tag === val ? '' : val; renderCards(); };
      tf.appendChild(b);
    };
    Object.keys(tags).sort(function (a, b) { return tags[b] - tags[a]; }).slice(0, 12).forEach(function (t) { mk(t + ' ' + tags[t], t); });

    var q = cardFilter.q.toLowerCase();
    var list = all.filter(function (c) {
      if (cardFilter.tag && (c.tags || []).indexOf(cardFilter.tag) < 0) return false;
      if (!q) return true;
      return (c.front + ' ' + c.back + ' ' + (c.tags || []).join(' ')).toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (a, b) { return (b.srs.lapses || 0) - (a.srs.lapses || 0) || (a.position || 0) - (b.position || 0); });

    var box = $('cards-list');
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<p class="muted">Ничего не найдено.</p>'; return; }

    list.slice(0, 300).forEach(function (c) {
      var b = R.bucketOf(c.srs, state.settings);
      var div = document.createElement('div');
      div.className = 'item';
      var when = c.srs.due ? new Date(c.srs.due).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—';
      div.innerHTML =
        '<div class="item-head"><div><div class="item-front">' + esc(c.front) + '</div>' +
        '<div class="item-back">' + esc(c.back) + '</div></div>' +
        '<div class="item-meta"><span class="badge ' + b + '">' + b + '</span>' +
        (c.srs.lapses >= 3 ? ' <span class="badge leech">×' + c.srs.lapses + '</span>' : '') +
        '<br>' + (b === 'new' ? 'не начато' : when) + '</div></div>';
      var act = document.createElement('div');
      act.className = 'item-actions';
      var speak = document.createElement('button'); speak.className = 'btn'; speak.textContent = '🔊';
      speak.onclick = function () { T.speak(c.front, { voice: state.settings.ttsVoice, rate: state.settings.ttsRate }); };
      var sus = document.createElement('button'); sus.className = 'btn'; sus.textContent = c.suspended ? 'Вернуть' : 'Отложить';
      sus.onclick = function () { c.suspended = !c.suspended; S.save(); renderCards(); };
      var rst = document.createElement('button'); rst.className = 'btn'; rst.textContent = 'Сброс';
      rst.onclick = function () { c.srs = R.newSrs(state.settings); S.save(); renderCards(); toast('Прогресс карточки сброшен'); };
      var del = document.createElement('button'); del.className = 'btn'; del.textContent = '🗑';
      del.onclick = function () {
        if (!confirm('Удалить «' + c.front + '»?')) return;
        delete state.cards[c.id]; S.save(); renderCards();
      };
      [speak, sus, rst, del].forEach(function (x) { act.appendChild(x); });
      div.appendChild(act);
      box.appendChild(div);
    });
    if (list.length > 300) {
      var p = document.createElement('p'); p.className = 'muted small';
      p.textContent = 'Показаны первые 300 из ' + list.length + '.';
      box.appendChild(p);
    }
  }

  // ---------------- анализ ----------------
  function barRow(name, value, text) {
    var cls = value >= 0.8 ? 'good' : value >= 0.6 ? 'mid' : 'bad';
    return '<div class="bar-row ' + cls + '"><span class="name">' + esc(name) + '</span>' +
      '<span class="bar"><i style="width:' + Math.round(value * 100) + '%"></i></span>' +
      '<span class="val">' + esc(text) + '</span></div>';
  }

  function renderStats() {
    var r = RP.buildReport(state);
    var s = r.summary;
    var H = [];

    H.push('<div class="stat-grid">' +
      '<div class="stat"><b>' + s.totalCards + '</b><span>карточек</span></div>' +
      '<div class="stat"><b>' + (s.accuracy7d == null ? '—' : Math.round(s.accuracy7d * 100) + '%') + '</b><span>точность за 7 дней</span></div>' +
      '<div class="stat"><b>' + s.reviews7d + '</b><span>ответов за 7 дней</span></div>' +
      '<div class="stat"><b>' + s.streakDays + '</b><span>дней подряд</span></div>' +
      '</div>');

    H.push('<div class="block"><h2>Из чего состоит колода</h2>');
    var tot = Math.max(1, s.totalCards);
    [['выучено (21+ дн)', s.buckets.mature], ['молодые', s.buckets.young],
     ['в процессе', s.buckets.learning + s.buckets.relearn], ['не начато', s.buckets.new]].forEach(function (p) {
      H.push(barRow(p[0], p[1] / tot, String(p[1])));
    });
    H.push('</div>');

    if (r.weakTags.length) {
      H.push('<div class="block"><h2>Темы: где слабее всего</h2>');
      r.weakTags.slice(0, 10).forEach(function (t) {
        H.push(barRow(t.tag, t.accuracy, Math.round(t.accuracy * 100) + '%'));
      });
      H.push('<p class="muted small">Меньше 70% — просить у Клода мини-урок и дополнительные примеры по этой теме.</p></div>');
    }

    if (r.leeches.length) {
      H.push('<div class="block"><h2>Не идут (' + r.leeches.length + ')</h2>');
      r.leeches.slice(0, 15).forEach(function (c) {
        H.push('<div class="item"><div class="item-head"><div><div class="item-front">' + esc(c.front) + '</div>' +
          '<div class="item-back">' + esc(c.back) + '</div></div><div class="item-meta">провалов ' + c.lapses +
          '<br>' + (c.accuracy == null ? '' : Math.round(c.accuracy * 100) + '%') + '</div></div></div>');
      });
      H.push('<p class="muted small">Такие слова полезно пересобрать: попросить у Клода мнемонику, другой перевод или живой пример.</p></div>');
    }

    if (r.typingErrors.length) {
      H.push('<div class="block"><h2>Ошибки при вводе</h2>');
      r.typingErrors.slice(0, 20).forEach(function (e) {
        H.push('<div class="bar-row"><span class="name">' + esc(e.expected) + '</span>' +
          '<span class="bar" style="background:none;color:var(--muted);font-size:13px">написал: ' + esc(e.typed) + '</span>' +
          '<span class="val">' + (e.count > 1 ? '×' + e.count : '') + '</span></div>');
      });
      H.push('</div>');
    }

    if (!s.reviewsTotal) {
      H.push('<p class="muted center">Пока нет данных — позанимайся немного, и здесь появится разбор.</p>');
    }

    H.push('<div class="block"><h2>Последние 14 дней</h2>');
    var byDay = {};
    r.byDay.forEach(function (d) { byDay[d.date] = d.reviews; });
    var max = 1;
    r.byDay.forEach(function (d) { max = Math.max(max, d.reviews); });
    for (var i = 13; i >= 0; i--) {
      var d = new Date(Date.now() - i * 86400000);
      var key = RP.dayKey(d.getTime());
      var v = byDay[key] || 0;
      H.push(barRow(key.slice(5), v / max, String(v)));
    }
    H.push('</div>');

    $('stats-body').innerHTML = H.join('');
  }

  // ---------------- импорт / экспорт ----------------
  function doImport(text, name) {
    var res = $('import-result');
    try {
      var parsed = DK.parse(text, name);
      if (!parsed.cards.length) throw new Error('не нашёл ни одной карточки');
      var m = DK.merge(state.cards, parsed, Date.now(), state.nextPosition);
      state.nextPosition = m.nextPosition;
      state.decks[m.deck] = { importedAt: Date.now(), count: m.total };
      state.lastImportAt = Date.now();
      S.saveNow();
      res.className = 'result ok';
      res.textContent = 'Готово: добавлено ' + m.added + ', обновлено ' + m.updated + ' (колода «' + m.deck + '»).';
      $('import-text').value = '';
      toast('Добавлено слов: ' + m.added);
      renderHome();
    } catch (e) {
      res.className = 'result err';
      res.textContent = 'Не получилось: ' + e.message;
    }
  }

  function renderExportPreview() {
    if (!Object.keys(state.cards).length) {
      $('digest-preview').textContent = 'Пока нечего выгружать — сначала загрузи слова и позанимайся.';
      return;
    }
    $('digest-preview').textContent = RP.buildDigest(state);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  function exportName(prefix) {
    return prefix + '-' + S.todayKey() + '.json';
  }

  // ---------------- настройки ----------------
  function fillSettings() {
    var st = state.settings, p = state.profile;
    $('set-name').value = p.name || '';
    $('set-level').value = p.level || 'B1';
    $('set-goal').value = p.goal || '';
    $('set-new').value = st.newPerDay;
    $('set-rev').value = st.reviewsPerDay;
    $('set-goalnum').value = st.dailyGoal;
    $('set-tts').checked = !!st.tts;
    $('set-autoplay').checked = !!st.autoPlay;
    $('set-ipa').checked = !!st.showIpa;
    $('set-typo').value = st.typoTolerance;
    $('set-rate').value = st.ttsRate;
    $('set-theme').value = st.theme;

    var sel = $('set-voice');
    sel.innerHTML = '<option value="">по умолчанию</option>';
    T.englishVoices().forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.name; o.textContent = v.name + ' (' + v.lang + ')';
      sel.appendChild(o);
    });
    sel.value = st.ttsVoice || '';
  }

  function bindSettings() {
    var bind = function (id, fn) {
      $(id).addEventListener('change', function () { fn(this); S.saveNow(); toast('Сохранено', 900); });
    };
    bind('set-name', function (el) { state.profile.name = el.value.trim(); });
    bind('set-level', function (el) { state.profile.level = el.value; });
    bind('set-goal', function (el) { state.profile.goal = el.value.trim(); });
    bind('set-new', function (el) { state.settings.newPerDay = Math.max(0, +el.value || 0); });
    bind('set-rev', function (el) { state.settings.reviewsPerDay = Math.max(0, +el.value || 0); });
    bind('set-goalnum', function (el) { state.settings.dailyGoal = Math.max(5, +el.value || 40); });
    bind('set-tts', function (el) { state.settings.tts = el.checked; });
    bind('set-autoplay', function (el) { state.settings.autoPlay = el.checked; });
    bind('set-ipa', function (el) { state.settings.showIpa = el.checked; });
    bind('set-typo', function (el) { state.settings.typoTolerance = Math.max(0, Math.min(3, +el.value || 0)); });
    bind('set-rate', function (el) { state.settings.ttsRate = +el.value; T.speak('spaced repetition', { voice: state.settings.ttsVoice, rate: +el.value }); });
    bind('set-voice', function (el) { state.settings.ttsVoice = el.value; T.speak('this is my voice', { voice: el.value, rate: state.settings.ttsRate }); });
    bind('set-theme', function (el) { state.settings.theme = el.value; applyTheme(); });

    $('btn-reset').onclick = function () {
      if (!confirm('Стереть все карточки и историю? Это необратимо.')) return;
      if (!confirm('Точно? Сначала лучше сохранить резервную копию.')) return;
      S.reset().then(function () { state = S.get(); applyTheme(); showScreen('home'); toast('Данные стёрты'); });
    };
  }

  // ---------------- события ----------------
  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.onclick = function () { showScreen(b.dataset.screen); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (b) {
      b.onclick = function () { showScreen(b.dataset.goto); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('#mode-chips .chip'), function (b) {
      b.onclick = function () {
        state.settings.mode = b.dataset.mode;
        S.saveNow();
        renderHome();
      };
    });

    $('btn-study').onclick = startSession;
    $('review-exit').onclick = endSession;
    $('btn-show').onclick = function () { revealAnswer(state.cards[session.ids[session.idx]]); };
    $('btn-check').onclick = checkTyped;
    $('speak-btn').onclick = function () {
      var c = state.cards[session.ids[session.idx]];
      T.speak(c.front, { voice: state.settings.ttsVoice, rate: state.settings.ttsRate });
    };
    Array.prototype.forEach.call(document.querySelectorAll('.grade'), function (b) {
      b.onclick = function () { grade(+b.dataset.grade); };
    });
    $('answer-input').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!shown) checkTyped();
      else grade(suggested || 3);
    });

    $('btn-import').onclick = function () { doImport($('import-text').value, 'from-claude'); };
    $('btn-paste').onclick = function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) { toast('Браузер не даёт читать буфер — вставь вручную'); return; }
      navigator.clipboard.readText().then(function (t) {
        $('import-text').value = t;
        toast('Вставлено — проверь и нажми «Добавить»');
      }).catch(function () { toast('Не дали доступ к буферу'); });
    };
    $('import-file').onchange = function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { doImport(String(fr.result), f.name.replace(/\.[^.]+$/, '')); };
      fr.readAsText(f);
      this.value = '';
    };
    $('btn-starter').onclick = function () {
      if (!window.STARTER_DECK) { toast('Стартовая колода не найдена'); return; }
      doImport(JSON.stringify(window.STARTER_DECK), 'starter');
    };

    $('btn-copy-digest').onclick = function () {
      var text = RP.buildDigest(state);
      copyText(text).then(function (ok) {
        var r = $('export-result');
        r.className = 'result ' + (ok ? 'ok' : 'err');
        r.textContent = ok ? 'Сводка в буфере — вставляй в чат с Клодом.' : 'Не удалось скопировать. Выдели текст ниже вручную.';
        state.lastExportAt = Date.now(); S.save();
      });
    };
    $('btn-download').onclick = function () {
      var rep = RP.buildReport(state);
      download(exportName('progress'), JSON.stringify(rep, null, 1));
      state.lastExportAt = Date.now(); S.save();
      $('export-result').className = 'result ok';
      $('export-result').textContent = 'Файл сохранён в «Загрузки» — прикрепи его в чат.';
    };
    if (navigator.canShare) {
      $('btn-share').classList.remove('hidden');
      $('btn-share').onclick = function () {
        var rep = RP.buildReport(state);
        var file = new File([JSON.stringify(rep, null, 1)], exportName('progress'), { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: 'Мой прогресс' }).catch(function () {});
        } else {
          navigator.share({ text: RP.buildDigest(state) }).catch(function () {});
        }
      };
    }

    $('btn-backup').onclick = function () {
      download(exportName('backup'), JSON.stringify(state));
      $('backup-result').className = 'result ok';
      $('backup-result').textContent = 'Копия сохранена. Держи её на всякий случай.';
    };
    $('restore-file').onchange = function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var data = JSON.parse(String(fr.result));
          if (!data.cards) throw new Error('это не резервная копия');
          if (!confirm('Заменить текущие данные копией?')) return;
          S.replace(data).then(function () {
            state = S.get(); applyTheme(); showScreen('home'); toast('Данные восстановлены');
          });
        } catch (e) {
          $('backup-result').className = 'result err';
          $('backup-result').textContent = 'Не получилось: ' + e.message;
        }
      };
      fr.readAsText(f);
      this.value = '';
    };

    $('cards-search').addEventListener('input', function () {
      cardFilter.q = this.value;
      clearTimeout(bind._t);
      bind._t = setTimeout(renderCards, 150);
    });

    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (state.settings.theme === 'auto') applyTheme();
      });
    }
    window.addEventListener('beforeunload', function () { S.saveNow(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) S.saveNow(); });
  }

  // ---------------- старт ----------------
  S.load().then(function (s) {
    state = s;
    applyTheme();
    bind();
    bindSettings();
    S.rollDay();
    showScreen('home');
    document.body.dataset.ready = '1';
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }).catch(function (e) {
    document.body.innerHTML = '<p style="padding:24px">Не удалось запустить приложение: ' + esc(e.message) + '</p>';
  });
})();
