/*
 * tts.js — озвучка через системный синтезатор речи Android (Web Speech API).
 * Интернет не нужен: используется голос, установленный в телефоне.
 */
(function (root) {
  'use strict';

  var voices = [];
  var ready = false;

  function refresh() {
    if (!root.speechSynthesis) return;
    voices = root.speechSynthesis.getVoices() || [];
    ready = voices.length > 0;
  }

  function available() { return !!root.speechSynthesis; }

  function englishVoices() {
    refresh();
    return voices.filter(function (v) { return /^en/i.test(v.lang || ''); });
  }

  function pick(preferredName) {
    var en = englishVoices();
    if (!en.length) return null;
    if (preferredName) {
      for (var i = 0; i < en.length; i++) if (en[i].name === preferredName) return en[i];
    }
    // предпочитаем en-US, затем en-GB, затем что есть
    var order = ['en-US', 'en_US', 'en-GB', 'en_GB'];
    for (var o = 0; o < order.length; o++) {
      for (var j = 0; j < en.length; j++) if ((en[j].lang || '').replace('_', '-') === order[o].replace('_', '-')) return en[j];
    }
    return en[0];
  }

  function speak(text, opts) {
    if (!available() || !text) return false;
    opts = opts || {};
    try {
      root.speechSynthesis.cancel();
      var u = new root.SpeechSynthesisUtterance(String(text));
      var v = pick(opts.voice);
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
      u.rate = opts.rate || 0.9;
      u.pitch = 1;
      root.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }

  function stop() { try { root.speechSynthesis.cancel(); } catch (e) {} }

  if (root.speechSynthesis) {
    refresh();
    root.speechSynthesis.onvoiceschanged = refresh;
  }

  root.TTS = { available: available, speak: speak, stop: stop, englishVoices: englishVoices, isReady: function () { return ready; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
