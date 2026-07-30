/*
 * Живая проверка приложения в Chromium с эмуляцией телефона.
 * Запуск: node tools/serve-and-smoke.mjs   (или node tests/smoke.mjs http://localhost:8123/)
 *
 * Проходит весь путь пользователя: загрузка стартовой колоды -> тренировка (узнавание,
 * письмо с опечаткой, пропуск в предложении) -> статистика -> выгрузка -> перезапуск.
 */
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8123/';
const SHOTS = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const checks = [];
function check(name, ok, extra) {
  checks.push({ name, ok: !!ok, extra });
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (extra ? '  — ' + extra : ''));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ru-RU' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const shot = (name) => page.screenshot({ path: SHOTS + name + '.png' });

// ---------- 1. запуск ----------
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
check('приложение стартует', true);
check('колода пустая при первом запуске', (await page.textContent('#c-new')) === '0');
check('кнопка «Учить» заблокирована без карточек', await page.isDisabled('#btn-study'));
await shot('01-empty');

// ---------- 2. импорт стартовой колоды ----------
await page.click('.tab[data-screen="claude"]');
await page.click('#btn-starter');
await page.waitForFunction(() => document.getElementById('import-result').textContent.includes('Готово'));
const importMsg = await page.textContent('#import-result');
check('стартовая колода импортируется', /добавлено 60/.test(importMsg), importMsg.trim());
await shot('02-import');

await page.click('.tab[data-screen="home"]');
check('новые карточки появились на главном', (await page.textContent('#c-new')) === '60');
check('кнопка «Учить» активна', !(await page.isDisabled('#btn-study')));
const studyLabel = await page.textContent('#btn-study');
check('в очереди дневной лимит новых слов (15)', /15/.test(studyLabel), studyLabel);
await shot('03-home');

// ---------- 3. повторный импорт не плодит дубли ----------
await page.click('.tab[data-screen="claude"]');
await page.click('#btn-starter');
await page.waitForFunction(() => /обновлено 60/.test(document.getElementById('import-result').textContent));
check('повторный импорт обновляет, а не дублирует', true);

// ---------- 4. добавление словом-строкой ----------
await page.fill('#import-text', '#test-tag\nbring up — поднять тему | She brought it up. | Она это подняла.');
await page.click('#btn-import');
await page.waitForFunction(() => /добавлено 1/.test(document.getElementById('import-result').textContent));
check('короткий текстовый формат работает', true);

// ---------- 5. тренировка: узнавание ----------
await page.click('.tab[data-screen="home"]');
await page.click('#btn-study');
await page.waitForSelector('#screen-review:not(.hidden)');
check('экран тренировки открылся', await page.isVisible('#card-question'));
const q1 = await page.textContent('#card-question');
check('вопрос не пустой', q1.trim().length > 0, q1);
check('нижняя навигация спрятана в тренировке', !(await page.isVisible('#tabs')));
await shot('04-review-question');

await page.click('#btn-show');
await page.waitForSelector('#grades:not(.hidden)');
const answer = await page.textContent('#answer-main');
check('ответ показывается', answer.trim().length > 0, answer);
check('есть примеры употребления', (await page.locator('#examples li').count()) > 0);
const ivl3 = await page.textContent('#ivl-3');
check('на кнопках подписаны интервалы', /мин|ч|дн/.test(ivl3), 'помню → ' + ivl3);
await shot('05-review-answer');

await page.click('.grade[data-grade="3"]');
await page.waitForFunction(() => document.getElementById('card-answer').classList.contains('hidden'));
check('после оценки показывается следующая карточка', true);

// ---------- 6. прогоняем сессию до конца, встречая режимы ввода ----------
const seen = new Set();
let answered = 0;
for (let i = 0; i < 40; i++) {
  if (!(await page.isVisible('#screen-review'))) break;
  if (await page.locator('#screen-review').evaluate((el) => el.classList.contains('hidden'))) break;
  const mode = await page.textContent('#card-mode-label');
  seen.add(mode.trim());
  const typing = await page.isVisible('#btn-check');
  if (typing) {
    // отвечаем с одной опечаткой, чтобы проверить и «почти», и запись ошибки
    const expected = await page.evaluate(() => {
      const ui = window.__probe && window.__probe();
      return ui;
    }).catch(() => null);
    await page.fill('#answer-input', 'recieve');
    await page.click('#btn-check');
    await page.waitForSelector('#grades:not(.hidden)');
    const v = await page.textContent('#verdict');
    if (!seen.has('verdict-checked')) {
      check('ввод проверяется и даёт вердикт', /✓|≈|✗/.test(v), v.trim().slice(0, 60));
      seen.add('verdict-checked');
      await shot('06-review-typing');
    }
    void expected;
  } else {
    await page.click('#btn-show');
    await page.waitForSelector('#grades:not(.hidden)');
  }
  await page.click('.grade[data-grade="' + (i % 4 === 0 ? 1 : 3) + '"]');
  answered++;
  await page.waitForTimeout(30);
}
check('сессия проходится до конца', answered >= 15, 'ответов: ' + answered);
check('встречались разные режимы', seen.size >= 2, [...seen].filter((s) => s !== 'verdict-checked').join(', '));

// ---------- 7. статистика ----------
await page.click('.tab[data-screen="stats"]');
await page.waitForSelector('#stats-body .stat');
const statsText = await page.textContent('#stats-body');
check('в анализе есть точность', /точность за 7 дней/.test(statsText));
check('в анализе есть разбор по темам или проблемным словам', /Темы|Не идут|Ошибки при вводе/.test(statsText));
await shot('07-stats');

// ---------- 8. выгрузка для модели ----------
await page.click('.tab[data-screen="claude"]');
const digest = await page.textContent('#digest-preview');
check('сводка сформирована', /Это сводка из моего приложения/.test(digest));
check('в сводке есть инструкция про формат колоды', /anki-lite\/deck/.test(digest));
const report = await page.evaluate(() => JSON.stringify(window.Report.buildReport(window.Store.get())));
const parsedReport = JSON.parse(report);
check('файл выгрузки самоописан', !!parsedReport['ИНСТРУКЦИЯ_ДЛЯ_МОДЕЛИ']);
check('в выгрузке есть история ответов', parsedReport.cards.some((c) => c.history.length > 0));
check('в выгрузке учтены ошибки ввода', parsedReport.typingErrors.length > 0,
  JSON.stringify(parsedReport.typingErrors[0] || {}));
await shot('08-claude');

// ---------- 8б. инструкция для модели прямо в приложении ----------
const tutorLen = await page.evaluate(() => (window.DOCS && window.DOCS.tutor || '').length);
check('инструкция вшита в приложение', tutorLen > 5000, tutorLen + ' символов');
check('в инструкции есть памятка и формат колоды', await page.evaluate(() =>
  /Памятка ученику/.test(window.DOCS.tutor) && /anki-lite\/deck/.test(window.DOCS.tutor)));
check('видны кнопки «первое сообщение» и «скачать»',
  (await page.isVisible('#btn-copy-first')) && (await page.isVisible('#btn-download-tutor')));

await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
await page.click('#btn-copy-first');
await page.waitForFunction(() => document.getElementById('tutor-result').textContent.length > 0);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
check('первое сообщение копируется в буфер', /репетитор английского/.test(clip) && clip.length > 5000,
  clip.length + ' символов');
check('в скопированном есть и просьба, и сама инструкция',
  /поищи в наших прошлых чатах/i.test(clip) && /ИНСТРУКЦИЯ/.test(clip) && /Слабые темы|weakTags/.test(clip));

const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await page.click('#btn-download-tutor');
const file = await dl;
check('инструкция скачивается файлом', !!file && file.suggestedFilename() === 'CLAUDE_INSTRUCTIONS.md',
  file ? file.suggestedFilename() : 'загрузка не началась');
await shot('12-tutor');

// ---------- 9. данные выживают перезагрузку ----------
const before = await page.evaluate(() => Object.keys(window.Store.get().cards).length);
const logBefore = await page.evaluate(() => window.Store.get().log.length);
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('body[data-ready="1"]');
const after = await page.evaluate(() => Object.keys(window.Store.get().cards).length);
const logAfter = await page.evaluate(() => window.Store.get().log.length);
check('карточки сохранились после перезагрузки', before === after && after === 61, before + ' → ' + after);
check('история ответов сохранилась', logBefore === logAfter && logAfter > 0, logBefore + ' → ' + logAfter);

// ---------- 10. настройки ----------
await page.click('.tab[data-screen="settings"]');
await page.fill('#set-new', '30');
await page.dispatchEvent('#set-new', 'change');
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('body[data-ready="1"]');
const newPerDay = await page.evaluate(() => window.Store.get().settings.newPerDay);
check('настройки сохраняются', newPerDay === 30, 'newPerDay=' + newPerDay);
await page.click('.tab[data-screen="settings"]');
await shot('09-settings');

// ---------- 11. манифест и офлайн ----------
const manifest = await page.evaluate(async () => {
  const r = await fetch('manifest.webmanifest');
  return r.ok ? await r.json() : null;
});
check('манифест PWA доступен', manifest && manifest.display === 'standalone', manifest && manifest.name);
const swOk = await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length > 0));
check('service worker зарегистрирован (офлайн-режим)', swOk);

await ctx.setOffline(true);
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
const offlineCards = await page.evaluate(() => Object.keys(window.Store.get().cards).length);
check('приложение открывается без интернета', offlineCards === 61, 'карточек: ' + offlineCards);
await shot('10-offline');
await ctx.setOffline(false);

// ---------- итог ----------
check('в консоли нет ошибок', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' проверок пройдено');
if (failed.length) {
  console.log('Провалено:\n' + failed.map((f) => ' - ' + f.name + (f.extra ? ' (' + f.extra + ')' : '')).join('\n'));
  process.exit(1);
}
