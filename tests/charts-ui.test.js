/**
 * UI tests for §18 features (index.html) via jsdom.
 * Run: node tests/charts-ui.test.js
 *
 * Проверяются четыре доработки дашборда:
 * 1. разворот графика на весь экран (кнопка ⛶ → модалка → ✕/Escape обратно);
 * 2. кликабельная легенда в духе Superset/ECharts (серии скрываются,
 *    график перестраивается, скрытые пункты сереют, «Все» возвращает);
 * 3. сворачивание групп (+/−) в пикере «Прогоны для анализа»;
 * 4. доп. фильтр по статусу (OPTIMAL и др.) в «Истории прогонов» поверх
 *    выбора прогонов.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let passed = 0;
function ok(cond, msg) {
  assert(cond, msg);
  passed++;
  console.log('  ✓', msg);
}

function makeDom() {
  return new JSDOM(HTML, {
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async () => { throw new Error('no network in test'); };
      const any = () => new Proxy(function () {}, {
        get: (t, p) => {
          if (p === Symbol.toPrimitive) return () => 0;
          if (p === 'measureText') return () => ({ width: 40 });
          return any();
        },
        set: () => true,
        apply: () => any()
      });
      window.HTMLCanvasElement.prototype.getContext = function () { return any(); };
    }
  });
}
const q = (d, s) => d.querySelector(s);
const qa = (d, s) => [...d.querySelectorAll(s)];
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
async function waitFor(dom, fn, what, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = fn(dom.window.document); } catch (e) { /* retry */ }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout: ' + what);
    await new Promise(r => setTimeout(r, 20));
  }
}

function runRows(runid, cfg, ds, status, salePct, gap) {
  const R = [];
  const row = (p, v) => R.push({ runid, 'Параметр': p, 'Значение': v, datasetid: ds, configid: cfg });
  row('Solution', status);
  row('Start time', `2026-05-${10 + runid} 10:00:00`);
  if (gap != null) row('Result gap %', String(gap));
  row('Objective value', String(1e11 + runid * 1e9));
  row('Solve time', '0:00:05.000000');
  row('Calc time', '0:00:06.000000');
  row('Iterations', '100');
  row('Variables', '1000');
  row('Constraints', '500');
  row('Non-zero values of sale variables', '80 / 100');
  row('Non-zero values of sale variables %', String(salePct));
  row('Value of sale', '1000000');
  row('Non-zero values of movement variables', '10 / 1000');
  row('Non-zero values of movement variables %', '1');
  row('Value of movement', '-100');
  row('Non-zero values of production variables', '20 / 200');
  row('Non-zero values of production variables %', '10');
  row('Value of production', '-500');
  row('Lower bound reached sale:demand_cons (STRICT) %', '20');
  row('Upper bound reached sale:demand_cons (STRICT) %', '60');
  return R;
}
const ROWS = runRows(1, 300, 15, 'OPTIMAL', 80, 0.1)
  .concat(runRows(2, 300, 16, 'INFEASIBLE', 0, null))
  .concat(runRows(3, 301, 15, 'OPTIMAL', 90, 0.05));

(async () => {
  console.log('\n════════ ГРАФИКИ §18: ПОЛНЫЙ ЭКРАН, ЛЕГЕНДА, СВОРАЧИВАНИЕ, СТАТУС ════════\n');
  const dom = makeDom();
  const doc = dom.window.document;
  const w = dom.window;
  await waitFor(dom, d => q(d, '#runSel'), 'boot');
  w.eval(`initFromRows(${JSON.stringify(ROWS)}, {source:'file',files:['t.xlsx'],loadedAt:new Date().toISOString()});IS_DEMO=false;TAB='ov';render();`);
  await tick();

  /* ── 1. Полный экран ── */
  console.log('1. Разворот графика на весь экран');
  const o2card = q(doc, '#o2').closest('.card');
  const expBtn = o2card.querySelector('.chart-expand');
  ok(!!expBtn, 'у карточки с графиком есть кнопка разворота ⛶');
  ok(expBtn.getAttribute('aria-label').includes('Насколько задействован каждый блок'),
    'aria-label кнопки содержит заголовок графика');
  expBtn.click();
  await tick(30);
  ok(q(doc, '#chartModal').hidden === false, 'модалка открылась');
  ok(q(doc, '#chartModalTitle').textContent === 'Насколько задействован каждый блок',
    'заголовок модалки совпадает с заголовком карточки');
  ok(q(doc, '#mChart').width > 0, 'график перерисован в модалке на большом canvas');
  ok(qa(doc, '#mChart-lg .cl-item').length === 3, 'в модалке есть своя легенда (3 блока модели)');
  q(doc, '#chartModalX').click();
  await tick(30);
  ok(q(doc, '#chartModal').hidden === true, '✕ закрывает модалку');
  expBtn.click();
  await tick(30);
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(30);
  ok(q(doc, '#chartModal').hidden === true, 'Escape закрывает модалку');

  /* ── 2. Кликабельная легенда ── */
  console.log('\n2. Кликабельная легенда (Superset-подход)');
  const lg = o2card.querySelector('.chart-legend');
  ok(!!lg && qa(doc, '#o2 ~ .chart-legend .cl-item').length === 3,
    'под графиком o2 легенда из 3 пунктов (по числу блоков)');
  const first = lg.querySelector('.cl-item');
  const firstKey = first.dataset.k;
  first.click();
  await tick(30);
  const lg2 = o2card.querySelector('.chart-legend');
  const firstAfter = [...lg2.querySelectorAll('.cl-item')].find(b => b.dataset.k === firstKey);
  ok(firstAfter.classList.contains('off'), 'скрытый пункт легенды засерён (.off)');
  ok(w.eval(`LEGEND_HIDDEN['o2'].has(${JSON.stringify(firstKey)})`), 'состояние скрытия запомнено');
  ok(!!lg2.querySelector('.cl-reset'), 'появилась кнопка «Все» для сброса');
  ok(q(doc, '#o2').width > 0, 'график перестроен после клика по легенде');
  lg2.querySelector('.cl-reset').click();
  await tick(30);
  ok(qa(doc, '#o2 ~ .chart-legend .cl-item.off').length === 0, '«Все» вернуло все серии');
  // одиночная серия: скрыть единственный показатель
  w.eval("TAB='hist';SEL_HIST=new Set(DS.runs.map(runKey));render();");
  await tick();
  const h1lg = qa(doc, '#h1 ~ .chart-legend .cl-item');
  ok(h1lg.length === 1 && h1lg[0].textContent.includes('Gap'),
    'у однoсерийного графика один пункт легенды с именем показателя');
  h1lg[0].click();
  await tick(30);
  ok(w.eval(`LEGEND_HIDDEN['h1'].has('s0')`), 'одиночная серия скрыта кликом');
  qa(doc, '#h1 ~ .chart-legend .cl-reset')[0].click();
  await tick(30);
  ok(!w.eval(`LEGEND_HIDDEN['h1'].has('s0')`), 'одиночная серия возвращена кнопкой «Все»');
  // мультисерийный график h6
  const h6lg = qa(doc, '#h6 ~ .chart-legend .cl-item');
  ok(h6lg.length === 3, 'у графика «Использование блоков по прогонам» 3 серии в легенде');
  h6lg[0].click();
  await tick(30);
  ok(qa(doc, '#h6 ~ .chart-legend .cl-item.off').length === 1,
    'в мультисерийном графике скрыта ровно одна серия, остальные на месте');
  // легенда в модалке синхронизирована с карточкой
  const h6exp = q(doc, '#h6').closest('.card').querySelector('.chart-expand');
  h6exp.click();
  await tick(30);
  qa(doc, '#mChart-lg .cl-item:not(.off)')[0].click();
  await tick(30);
  ok(qa(doc, '#h6 ~ .chart-legend .cl-item.off').length === 2,
    'клик по легенде в модалке скрыл серию и в карточке');
  q(doc, '#chartModalX').click();
  await tick(30);

  /* ── 3. Сворачивание групп в пикере ── */
  console.log('\n3. Сворачивание групп конфиг/датасет (+/−)');
  w.eval(`HIST_STATUS.clear();render();`);
  await tick();
  q(doc, '#histSelBtn').click();
  await tick(30);
  ok(qa(doc, '#dtpop .rt-tw').length >= 4, `кнопки +/− есть на шапках (${qa(doc, '#dtpop .rt-tw').length} шт.)`);
  const leavesBefore = qa(doc, '#dtpop .rt-leaf').length;
  ok(leavesBefore === 3, 'до сворачивания видны все 3 прогона');
  const cfgTw = qa(doc, '#dtpop .rt-grp.cfg .rt-tw')[0];
  const selBefore = w.eval('SEL_HIST.size');
  cfgTw.click();
  await tick(30);
  ok(qa(doc, '#dtpop .rt-leaf').length < leavesBefore, 'сворачивание конфига спрятало его прогоны');
  ok(qa(doc, '#dtpop .rt-grp.cfg .rt-tw')[0].textContent === '+', 'на свёрнутой группе показан «+»');
  ok(w.eval('SEL_HIST.size') === selBefore, 'выбор прогонов сворачиванием не затронут');
  qa(doc, '#dtpop .rt-grp.cfg .rt-tw')[0].click();
  await tick(30);
  ok(qa(doc, '#dtpop .rt-leaf').length === leavesBefore, 'повторный клик развернул группу обратно');
  // датасет тоже сворачивается
  qa(doc, '#dtpop .rt-grp.ds .rt-tw')[0].click();
  await tick(30);
  ok(qa(doc, '#dtpop .rt-leaf').length < leavesBefore, 'сворачивание датасета спрятало его прогоны');
  // поиск разворачивает всё
  const fi = q(doc, '#dtpop .dtp-q');
  fi.value = 'Прогон';
  fi.dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick(30);
  ok(qa(doc, '#dtpop .rt-leaf').length === 3, 'при активном поиске дерево развёрнуто целиком');
  w.eval('dtpHide()');

  /* ── 4. Фильтр по статусу ── */
  console.log('\n4. Фильтр по статусу в «Истории прогонов»');
  const chips = qa(doc, '#histStatusChips .chip');
  ok(chips.length === 3, `чипы статуса: Все + 2 статуса (${chips.map(c => c.textContent.trim()).join(' / ')})`);
  ok(chips[0].classList.contains('on'), 'по умолчанию активен чип «Все»');
  const optChip = chips.find(c => c.textContent.includes('OPTIMAL'));
  optChip.click();
  await tick();
  const rowsOpt = qa(doc, '#h5 tbody tr');
  ok(rowsOpt.length === 2, 'таблица истории показывает только 2 прогона OPTIMAL');
  ok(q(doc, '#histSelInfo').textContent.includes('показано 2 из 3'),
    'подпись поясняет, что статус-фильтр сузил выбор: ' + q(doc, '#histSelInfo').textContent.trim());
  ok(!!q(doc, '#h6'), 'графики перестроены по отфильтрованным прогонам');
  const infChip = qa(doc, '#histStatusChips .chip').find(c => c.textContent.includes('INFEASIBLE'));
  infChip.click();
  await tick();
  ok(qa(doc, '#h5 tbody tr').length === 3, 'выбор всех статусов = фильтр снят, снова 3 прогона');
  qa(doc, '#histStatusChips .chip').find(c => c.textContent.includes('INFEASIBLE')).click();
  await tick();
  ok(qa(doc, '#h5 tbody tr').length === 1, 'остался только 1 прогон INFEASIBLE');
  ok(!q(doc, '#h4'), 'при одном прогоне графики динамики скрыты, как раньше');
  qa(doc, '#histStatusChips .chip')[0].click();
  await tick();
  ok(qa(doc, '#h5 tbody tr').length === 3, 'чип «Все» сбросил фильтр статуса');

  dom.window.close();
  console.log('\n────────────────────────────────────────');
  console.log(`Result: ${passed} passed`);
})().catch(e => { console.error('\nТЕСТ УПАЛ:', e); process.exit(1); });
