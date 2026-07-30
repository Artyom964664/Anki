/*
 * store.js — состояние приложения и его сохранение.
 *
 * Всё живёт на устройстве: IndexedDB (основное) или localStorage (если IDB недоступен).
 * Никаких сетевых запросов приложение не делает вообще.
 */
(function (root) {
  'use strict';

  var DB_NAME = 'anki-lite';
  var STORE = 'kv';
  var KEY = 'state';
  var LOG_CAP = 8000;

  function defaultState() {
    return {
      version: 1,
      profile: { name: '', level: 'B1', goal: '', native: 'ru' },
      settings: {
        newPerDay: 15,
        reviewsPerDay: 120,
        mode: 'mixed',          // mixed | recognition | typing | listening
        tts: true,
        ttsVoice: '',
        ttsRate: 0.9,
        theme: 'auto',
        typoTolerance: 1,
        showIpa: true,
        autoPlay: true,
        dailyGoal: 40
      },
      cards: {},
      decks: {},
      log: [],
      daily: { date: '', newDone: 0, reviewsDone: 0 },
      nextPosition: 0,
      lastExportAt: 0,
      lastImportAt: 0
    };
  }

  // ---- IndexedDB ----
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(new Error('no idb'));
      var req = root.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var r = tx.objectStore(STORE).get(key);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function idbSet(key, val) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // ---- localStorage fallback ----
  function lsGet() {
    try {
      var raw = root.localStorage.getItem(DB_NAME + ':' + KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function lsSet(val) {
    try { root.localStorage.setItem(DB_NAME + ':' + KEY, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  var state = defaultState();
  var saveTimer = null;
  var useIdb = true;

  function migrate(s) {
    var d = defaultState();
    if (!s || typeof s !== 'object') return d;
    // мягкая миграция: добиваем недостающие поля значениями по умолчанию
    Object.keys(d).forEach(function (k) {
      if (s[k] == null) s[k] = d[k];
    });
    Object.keys(d.settings).forEach(function (k) {
      if (s.settings[k] == null) s.settings[k] = d.settings[k];
    });
    Object.keys(d.profile).forEach(function (k) {
      if (s.profile[k] == null) s.profile[k] = d.profile[k];
    });
    Object.keys(s.cards).forEach(function (id) {
      var c = s.cards[id];
      if (!c.srs) c.srs = root.SRS.newSrs(s.settings);
      if (!c.tags) c.tags = [];
      if (!c.examples) c.examples = [];
      if (c.position == null) c.position = 0;
    });
    return s;
  }

  function load() {
    return idbGet(KEY).then(function (v) {
      state = migrate(v || lsGet());
      return state;
    }).catch(function () {
      useIdb = false;
      state = migrate(lsGet());
      return state;
    });
  }

  function saveNow() {
    var snapshot = state;
    if (useIdb) {
      return idbSet(KEY, snapshot).catch(function () { useIdb = false; lsSet(snapshot); });
    }
    lsSet(snapshot);
    return Promise.resolve(true);
  }

  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; saveNow(); }, 250);
  }

  function get() { return state; }

  function replace(s) { state = migrate(s); return saveNow(); }

  function reset() { state = defaultState(); return saveNow(); }

  function todayKey(now) {
    var d = new Date(now || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /** Сбрасывает дневные счётчики при смене даты. */
  function rollDay(now) {
    var key = todayKey(now);
    if (state.daily.date !== key) {
      state.daily = { date: key, newDone: 0, reviewsDone: 0 };
      save();
    }
    return state.daily;
  }

  function cardsArray() {
    return Object.keys(state.cards).map(function (id) { return state.cards[id]; });
  }

  /** Записывает результат повторения: обновляет srs, лог и дневные счётчики. */
  function recordReview(cardId, grade, meta) {
    var now = (meta && meta.now) || Date.now();
    var card = state.cards[cardId];
    if (!card) return null;
    rollDay(now);
    var wasNew = root.SRS.bucketOf(card.srs, state.settings) === 'new';
    card.srs = root.SRS.schedule(card.srs, grade, now, state.settings);
    state.log.push({
      ts: now,
      id: cardId,
      grade: grade,
      mode: (meta && meta.mode) || 'recognition',
      ms: (meta && meta.ms) || 0,
      typed: (meta && meta.typed) || '',
      verdict: (meta && meta.verdict) || ''
    });
    if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
    if (wasNew) state.daily.newDone++; else state.daily.reviewsDone++;
    save();
    return card;
  }

  var api = {
    defaultState: defaultState,
    load: load,
    save: save,
    saveNow: saveNow,
    get: get,
    replace: replace,
    reset: reset,
    rollDay: rollDay,
    todayKey: todayKey,
    cardsArray: cardsArray,
    recordReview: recordReview,
    migrate: migrate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Store = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
