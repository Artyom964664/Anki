/*
 * deck.js — разбор и слияние колод.
 *
 * Принимает три вида ввода:
 *   1) JSON формата anki-lite/deck (то, что присылает Клод) — основной путь;
 *   2) простой текст построчно: "take off — снимать; взлетать" (быстрое добавление с телефона);
 *   3) CSV/TSV: front,back,example_en,example_ru,tags.
 *
 * Слияние идёт по id: повторный импорт той же колоды обновляет текст карточки,
 * но НЕ сбрасывает прогресс повторений.
 */
(function (root) {
  'use strict';

  var SEP_RE = /\s+[—–]\s+|\t| \| | -- | - | = |\s+:\s+/;

  function slug(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9а-яё]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  function makeId(card) {
    var base = slug(card.front || card.cloze || card.back);
    if (!base) base = 'card';
    var t = card.type && card.type !== 'word' ? card.type.charAt(0) : 'w';
    return t + ':' + base;
  }

  function cleanCard(raw, deckName) {
    if (!raw) return null;
    var front = (raw.front != null ? raw.front : raw.en != null ? raw.en : raw.term) || '';
    var back = (raw.back != null ? raw.back : raw.ru != null ? raw.ru : raw.translation) || '';
    front = String(front).trim();
    back = String(back).trim();
    var type = raw.type || (raw.cloze ? 'cloze' : 'word');
    if (!front && !raw.cloze) return null;

    var examples = [];
    var src = raw.examples || raw.example || [];
    if (!Array.isArray(src)) src = [src];
    src.forEach(function (e) {
      if (!e) return;
      if (typeof e === 'string') { examples.push({ en: e.trim(), ru: '' }); return; }
      var en = String(e.en || e.english || '').trim();
      var ru = String(e.ru || e.russian || '').trim();
      if (en || ru) examples.push({ en: en, ru: ru });
    });

    var tags = raw.tags || [];
    if (typeof tags === 'string') tags = tags.split(/[,\s]+/);
    tags = tags.filter(Boolean).map(function (t) { return String(t).replace(/^#/, '').trim().toLowerCase(); });

    var card = {
      id: String(raw.id || '').trim() || null,
      front: front,
      back: back,
      ipa: String(raw.ipa || raw.phonetics || '').trim(),
      pos: String(raw.pos || '').trim(),
      level: String(raw.level || '').trim().toUpperCase(),
      type: type,
      cloze: String(raw.cloze || '').trim(),
      hint: String(raw.hint || '').trim(),
      note: String(raw.note || raw.mnemonic || '').trim(),
      examples: examples,
      tags: tags,
      deck: String(raw.deck || deckName || 'default')
    };
    if (!card.id) card.id = makeId(card);
    return card;
  }

  function parseJson(text) {
    var data = JSON.parse(text);
    var name = data.name || data.deck || 'imported';
    var cards = data.cards || data.notes || (Array.isArray(data) ? data : null);
    if (!cards) throw new Error('В JSON нет массива cards');
    var out = [];
    for (var i = 0; i < cards.length; i++) {
      var c = cleanCard(cards[i], name);
      if (c) out.push(c);
    }
    return { name: name, cards: out, meta: { source: data.source || '', created: data.created || '', level: data.level || '' } };
  }

  function parseText(text, deckName) {
    var lines = String(text).split(/\r?\n/);
    var tags = [];
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '/' && line.charAt(1) === '/') continue;
      // строка-директива с тегами: "#phrasal-verbs travel"
      if (line.charAt(0) === '#') {
        tags = line.slice(1).split(/[\s,]+/).filter(Boolean).map(function (t) { return t.toLowerCase(); });
        continue;
      }
      var parts = line.split(SEP_RE).map(function (p) { return p.trim(); }).filter(function (p, idx) { return idx < 4; });
      if (parts.length < 2) continue;
      var card = cleanCard({
        front: parts[0],
        back: parts[1],
        examples: parts[2] ? [{ en: parts[2], ru: parts[3] || '' }] : [],
        tags: tags.slice()
      }, deckName);
      if (card) out.push(card);
    }
    return { name: deckName || 'quick-add', cards: out, meta: { source: 'text' } };
  }

  function splitCsvLine(line) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (q) {
        if (ch === '"' && line.charAt(i + 1) === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',' || ch === '\t') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  function parseCsv(text, deckName) {
    var lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim(); });
    var out = [];
    var start = 0;
    var head = lines.length ? splitCsvLine(lines[0]).map(function (h) { return h.toLowerCase(); }) : [];
    var isHeader = head.indexOf('front') >= 0 || head.indexOf('en') >= 0;
    if (isHeader) start = 1;
    for (var i = start; i < lines.length; i++) {
      var f = splitCsvLine(lines[i]);
      if (f.length < 2) continue;
      var card = cleanCard({
        front: f[0], back: f[1],
        examples: f[2] ? [{ en: f[2], ru: f[3] || '' }] : [],
        tags: f[4] || ''
      }, deckName);
      if (card) out.push(card);
    }
    return { name: deckName || 'csv', cards: out, meta: { source: 'csv' } };
  }

  /** Угадывает формат и разбирает. */
  function parse(text, deckName) {
    var t = String(text || '').trim();
    if (!t) throw new Error('Пусто — нечего импортировать');
    // JSON может прийти обёрнутым в ```json ... ```
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    if (t.charAt(0) === '{' || t.charAt(0) === '[') return parseJson(t);
    var firstLine = t.split(/\r?\n/)[0] || '';
    if (/(^|,)\s*(front|en)\s*(,|$)/i.test(firstLine) || (firstLine.split(',').length >= 3 && !SEP_RE.test(firstLine))) {
      return parseCsv(t, deckName);
    }
    return parseText(t, deckName);
  }

  /**
   * Вливает разобранную колоду в состояние. Возвращает статистику.
   * cardsMap — объект state.cards, мутируется на месте.
   */
  function merge(cardsMap, parsed, now, nextPosition) {
    var added = 0, updated = 0, pos = nextPosition || 0;
    var ids = [];
    parsed.cards.forEach(function (c) {
      var exist = cardsMap[c.id];
      ids.push(c.id);
      if (exist) {
        // прогресс не трогаем, обновляем только содержимое
        ['front', 'back', 'ipa', 'pos', 'level', 'type', 'cloze', 'hint', 'note', 'examples'].forEach(function (k) {
          if (c[k] !== '' && c[k] != null && !(Array.isArray(c[k]) && !c[k].length)) exist[k] = c[k];
        });
        var tagSet = {};
        (exist.tags || []).concat(c.tags || []).forEach(function (t) { tagSet[t] = 1; });
        exist.tags = Object.keys(tagSet);
        updated++;
      } else {
        c.srs = root.SRS.newSrs();
        c.addedAt = now || Date.now();
        c.position = pos++;
        cardsMap[c.id] = c;
        added++;
      }
    });
    return { added: added, updated: updated, total: parsed.cards.length, ids: ids, deck: parsed.name, nextPosition: pos };
  }

  var api = { parse: parse, parseJson: parseJson, parseText: parseText, parseCsv: parseCsv, merge: merge, cleanCard: cleanCard, makeId: makeId, slug: slug };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Deck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
