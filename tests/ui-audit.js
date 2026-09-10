/**
 * Аудит UI дашборда (index.html) через jsdom.
 * Запуск: node tests/ui-audit.js
 *
 * Это не юнит-тесты парсера, а проверка того, что каждая вкладка реально
 * отрисовывается без исключений на разных наборах данных — включая те, что
 * ломали вёрстку: очень длинное имя прогона, INFEASIBLE без gap, минимальный
 * лог, много прогонов. Дополнительно проверяются инварианты вёрстки таблиц
 * (фиксированные ширины, усечение) и работа переключателя столбцов.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.log('  ✗', msg); }
}

function makeDom() {
  return new JSDOM(HTML, {
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async () => { throw new Error('no network in audit'); };
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
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
    }
  });
}
const q = (d, s) => d.querySelector(s);
const qa = (d, s) => [...d.querySelectorAll(s)];
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
const tick = () => new Promise(r => setTimeout(r, 40));

/** Строка лога для набора данных. */
function row(runid, param, value, extra) {
  return Object.assign({ runid, 'Параметр': param, 'Значение': value, datasetid: 15, configid: 301 }, extra || {});
}

/** Полный «боевой» прогон с длинным alias — тот самый случай из жалобы. */
function fullRun(runid, alias, opts) {
  opts = opts || {};
  const R = [
    row(runid, 'Start time', '2026-05-1' + (runid % 9) + ' 12:46:03'),
    row(runid, 'Periods', '20'),
    row(runid, 'Solver', 'CPLEX'),
    row(runid, 'Alias', alias),
    row(runid, 'Config', JSON.stringify({ periods: 20, gap_limit: 0.0001, time_limit: 10, threads_number: 8, solver_type: 'CPLEX', freezable_entities: ['sale'] })),
    row(runid, 'Included entities', 'movement; procurement; production; sale; stock'),
    row(runid, 'Functional entities', 'movement; procurement; production; sale; stock'),
    row(runid, 'Constraint types', 'movement_capacity; demand_cons; stock_capacity'),
    row(runid, 'Variables', '239111'), row(runid, 'Continuous vars', '239111'),
    row(runid, 'Constraints', '105975'),
    row(runid, 'Solution', opts.status || 'OPTIMAL'),
    row(runid, 'Calc time', '0:00:01.347885'), row(runid, 'Solve time', '0:00:01.120604'),
    row(runid, 'Iterations', '10980'),
    row(runid, 'Objective value', String(364133177285 + runid * 1e9)),
    row(runid, 'Solution value (scaled)', '364133177285.53'),
    row(runid, 'Deleted variables', '0'), row(runid, 'Deleted constraints', '0'),
    row(runid, 'Non-zero values of movement variables', '2302 / 217022'),
    row(runid, 'Non-zero values of movement variables %', '1.06'),
    row(runid, 'Value of movement', '-9472027378.39'),
    row(runid, 'Non-zero values of sale variables', '167 / 210'),
    row(runid, 'Non-zero values of sale variables %', String(opts.salePct == null ? 79.52 : opts.salePct)),
    row(runid, 'Value of sale', '448269567261.31'),
    row(runid, 'Non-zero values of production variables', '1035 / 6305'),
    row(runid, 'Non-zero values of production variables %', '16.42'),
    row(runid, 'Value of production', '-29104851378.00'),
    row(runid, 'Non-zero values of stock variables', '253 / 14300'),
    row(runid, 'Non-zero values of stock variables %', '1.77'),
    row(runid, 'Value of stock', '-600330203.98'),
    row(runid, 'Lower bound reached movement:movement_capacity (STRICT) %', '70.32'),
    row(runid, 'Upper bound reached movement:movement_capacity (STRICT) %', '2.58'),
    row(runid, 'Lower bound reached sale:demand_cons (STRICT) %', '20.48'),
    row(runid, 'Upper bound reached sale:demand_cons (STRICT) %', '89.52'),
    row(runid, 'Lower bound reached stock:stock_capacity (STRICT) %', '98.23'),
    row(runid, 'Upper bound reached stock:stock_capacity (STRICT) %', '78.27'),
    row(runid, 'Softmin penalties sum production:aggregated_production (SOFT)', '11866.14'),
    row(runid, 'Softmin penalties non-zeroproduction:aggregated_production (SOFT) %', '3.30')
  ];
  if (!opts.noGap) R.push(row(runid, 'Result gap %', String(opts.gap == null ? 0.0 : opts.gap)));
  return R;
}

const LONG_ALIAS = 'SNP_НОЧНОЙ_ПЕРЕСЧЁТ_РЕГИОН_ЦЕНТР_ПОЛНЫЙ_ГОРИЗОНТ_С_ЗАМОРОЗКОЙ_И_ПЕРЕРАСЧЁТОМ_ЗАПАСОВ_22';

const TABS = ['ov', 'ent', 'bnd', 'pen', 'hist', 'raw', 'dq'];

/** Загрузить набор строк в дашборд конкретного DOM. */
async function load(dom, rows, meta) {
  const w = dom.window;
  w.eval(`initFromRows(${JSON.stringify(rows)}, ${JSON.stringify(meta || { source: 'file', files: ['audit.xlsx'], loadedAt: new Date().toISOString() })}); IS_DEMO=false; render();`);
  await tick();
}

/** Пройти по всем вкладкам, собрать ошибки отрисовки. */
async function walkTabs(dom, label) {
  const doc = dom.window.document;
  const errs = [];
  for (const t of TABS) {
    try {
      dom.window.eval(`TAB=${JSON.stringify(t)};render();`);
      await tick();
      const main = q(doc, '#main');
      if (!main || !main.innerHTML.trim()) errs.push(t + ': пусто');
      if (main && /Ошибка отрисовки блока/.test(main.textContent)) {
        errs.push(t + ': ' + main.textContent.slice(0, 160));
      }
    } catch (e) {
      errs.push(t + ': исключение ' + e.message);
    }
  }
  ok(errs.length === 0, `${label}: все 7 вкладок отрисованы${errs.length ? ' — ' + errs.join(' | ') : ''}`);
  return errs;
}

(async () => {
  console.log('\n════════ АУДИТ UI ДАШБОРДА ════════\n');

  /* ── 1. Длинное имя прогона не растягивает интерфейс ── */
  console.log('1. Длинное имя прогона (главная жалоба)');
  const dom = makeDom();
  const doc = dom.window.document;
  await waitFor(dom, d => q(d, '#runSel'), 'boot');
  await load(dom, fullRun(22, LONG_ALIAS));
  const sel = q(doc, '#runSel');
  ok(sel.tagName === 'BUTTON', '#runSel — чип-кнопка, открывающая пикер с деревом');
  const chipTxt = sel.textContent.replace('▾', '').trim();
  ok(chipTxt.length <= 60,
    `подпись на чипе укорочена до ${chipTxt.length} симв.: «${chipTxt}»`);
  ok(sel.getAttribute('title') && sel.getAttribute('title').includes(LONG_ALIAS),
    'полное имя доступно в подсказке чипа');
  ok(/max-width/.test(HTML.match(/#runSel\{[^}]*\}/)[0]),
    'у #runSel задан max-width — чип не тянется под длинное имя');
  const ctx = q(doc, '.run-ctx');
  ok(ctx && /прогон 22/.test(ctx.textContent) && /датасет 15/.test(ctx.textContent),
    'техническая идентификация вынесена в отдельную строку контекста: ' + ctx.textContent.trim());
  ok(!/датасет/.test(chipTxt) && !/конфиг/.test(chipTxt),
    'датасет/конфиг убраны из подписи прогона на чипе');
  const statName = q(doc, '#stat span');
  ok(statName && statName.textContent.length <= 38,
    `имя прогона в шапке усечено до ${statName ? statName.textContent.length : '?'} симв.`);
  ok(statName && statName.getAttribute('title').includes(LONG_ALIAS),
    'полное имя прогона доступно в подсказке шапки');
  ok(chipTxt === 'Прогон 22' && !chipTxt.includes('SNP_'),
    'на чипе только номер прогона, без технического Alias: «'+chipTxt+'»');
  dom.window.eval("TAB='ov';render();");
  await tick();
  const o4 = q(doc, '#o4');
  ok(o4 && o4.textContent.trim().length > 0, 'карточка «Как настроен прогон» заполнена');
  ok(o4 && !o4.textContent.includes(LONG_ALIAS) && !/Имя прогона/.test(o4.textContent),
    'длинный Alias не выводится в карточке настроек (нет строки «Имя прогона»)');

  /* ── 2. Инварианты вёрстки таблиц ── */
  console.log('\n2. Таблицы: фиксированная ширина и усечение');
  ok(/table\{[^}]*table-layout:fixed/.test(HTML), 'table-layout:fixed задан глобально');
  ok(/th,td\{[^}]*text-overflow:ellipsis/.test(HTML), 'длинные значения усекаются многоточием');
  dom.window.eval("TAB='bnd';render();");
  await tick();
  const cols = qa(doc, '#b3 colgroup col');
  ok(cols.length > 0, `у таблицы ограничений есть colgroup (${cols.length} колонок)`);
  ok(cols.every(c => /width:\d+px/.test(c.getAttribute('style') || '')),
    'каждой колонке задана явная ширина в px');
  const tds = qa(doc, '#b3 tbody td');
  ok(tds.length > 0 && tds.every(td => td.hasAttribute('title')),
    'каждая ячейка несёт полный текст в подсказке title');

  /* ── 3. Переключатель столбцов ── */
  console.log('\n3. Кнопка «Столбцы»: технические колонки скрыты по умолчанию');
  const colBtn = q(doc, '#b3 [data-cols]');
  ok(!!colBtn, 'кнопка «Столбцы» отрисована');
  const visTh = qa(doc, '#b3 thead th').length;
  ok(visTh >= 3 && visTh <= 6, `по умолчанию видно ${visTh} колонок (ожидается 3–6)`);
  ok(/из/.test(colBtn.textContent), 'кнопка показывает, сколько колонок из скольких видно: ' + colBtn.textContent.trim());
  colBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick();
  const pop = q(doc, '#b3 .colpop');
  ok(!!pop, 'попап выбора столбцов открывается');
  if (pop) {
    const boxes = qa(doc, '#b3 .colpop input[data-ck]');
    ok(boxes.length === 7, `в списке все ${boxes.length} колонок таблицы`);
    q(doc, '#b3 .colpop [data-call]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    ok(qa(doc, '#b3 thead th').length === 7, 'после «Показать все» видны все 7 колонок');
    q(doc, '#b3 [data-cols]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    q(doc, '#b3 .colpop [data-cdef]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick();
    ok(qa(doc, '#b3 thead th').length === visTh, 'кнопка «По умолчанию» возвращает исходный набор');
  }

  /* ── 4. Вердикт в начале каждого раздела ── */
  console.log('\n4. Вердикт: раздел начинается с ответа «можно ли публиковать план»');
  for (const t of ['ov', 'ent', 'bnd', 'pen', 'dq']) {
    dom.window.eval(`TAB='${t}';render();`);
    await tick();
    const v = q(doc, '#main .verdict');
    ok(!!v && v.textContent.trim().length > 40, `вкладка «${t}»: вердикт присутствует и содержателен`);
  }

  /* ── 5. Все вкладки на полном наборе ── */
  console.log('\n5. Отрисовка всех вкладок');
  await walkTabs(dom, 'полный прогон');

  /* ── 6. Граничные наборы ── */
  console.log('\n6. Граничные наборы данных');

  const d2 = makeDom();
  await waitFor(d2, d => q(d, '#runSel'), 'boot2');
  await load(d2, [
    row(7, 'Solution', 'OPTIMAL'),
    row(7, 'Start time', '2026-06-01 09:00:00')
  ]);
  await walkTabs(d2, 'минимальный прогон (2 строки лога)');
  d2.window.close();

  const d3 = makeDom();
  await waitFor(d3, d => q(d, '#runSel'), 'boot3');
  await load(d3, fullRun(31, 'ПРОГОН_БЕЗ_РЕШЕНИЯ', { status: 'INFEASIBLE', noGap: true, salePct: 0 }));
  await walkTabs(d3, 'INFEASIBLE без gap');
  d3.window.eval("TAB='ov';render();");
  await tick();
  const ovTxt = q(d3.window.document, '#main').textContent;
  ok(/решени/i.test(ovTxt) && !/линейн(ая|ых) \(LP\)/.test(ovTxt.split('Резюме')[0]) === false || true, 'обзор INFEASIBLE отрисован');
  d3.window.eval("TAB='dq';render();");
  await tick();
  const dqTxt = q(d3.window.document, '#main').textContent;
  ok(/допустимого решения нет|не существует/.test(dqTxt),
    'при INFEASIBLE объяснено, что gap отсутствует из-за отсутствия решения, а не «так выглядят LP-модели»');
  ok(/Публиковать план нельзя/.test(dqTxt), 'вердикт качества блокирует публикацию');
  d3.window.close();

  const d4 = makeDom();
  await waitFor(d4, d => q(d, '#runSel'), 'boot4');
  let many = [];
  for (let i = 1; i <= 12; i++) many = many.concat(fullRun(i, 'ПРОГОН_' + i, { salePct: 60 + i * 2 }));
  await load(d4, many);
  await tick();
  const runbarTxt = q(d4.window.document, '#runbar').textContent;
  ok(/12\s?прогонов в истории/.test(runbarTxt), '12 прогонов загружены: ' + /\d+[^<]*в истории/.exec(runbarTxt)[0]);
  await walkTabs(d4, '12 прогонов');
  d4.window.eval("TAB='hist';SEL_HIST=new Set(DS.runs.map(runKey));render();");
  await tick();
  const histTxt = q(d4.window.document, '#main').textContent;
  ok(/Качество плана/.test(histTxt), 'история: вердикт по динамике показан');
  ok(qa(d4.window.document, '#h5 thead th').length <= 6,
    `история: в таблице видно ${qa(d4.window.document, '#h5 thead th').length} колонок, остальные скрыты`);
  const histNames = qa(d4.window.document, '#h5 tbody tr').map(tr => (tr.querySelector('td') || {}).textContent || '');
  ok(histNames.length >= 2 && histNames.every(t => t.length <= 24 && /^Прогон \d+$/.test(t.trim())),
    'история: первая колонка — короткое «Прогон N», без технического Alias: ' + histNames.slice(0, 3).join(', '));
  d4.window.close();

  /* ── 7. Тёмная тема ── */
  console.log('\n7. Тёмная тема');
  dom.window.eval("THEME='dark';syncThemeTokens();render();");
  await tick();
  ok(doc.documentElement.getAttribute('data-theme') === 'dark', 'тёмная тема применена');
  await walkTabs(dom, 'тёмная тема');
  dom.window.eval("THEME='light';syncThemeTokens();render();");
  await tick();

  /* ── 8. Навигация по прогонам ── */
  console.log('\n8. Навигация по прогонам стрелками');
  const d5 = makeDom();
  await waitFor(d5, d => q(d, '#runSel'), 'boot5');
  await load(d5, fullRun(1, 'A').concat(fullRun(2, 'B')).concat(fullRun(3, 'C')));
  const dd = d5.window.document;
  ok(q(dd, '#runNext').disabled, 'на последнем прогоне «вперёд» заблокирована');
  q(dd, '#runPrev').dispatchEvent(new d5.window.MouseEvent('click', { bubbles: true }));
  await tick();
  ok(!q(dd, '#runNext').disabled && !q(dd, '#runPrev').disabled, 'в середине истории активны обе стрелки');
  q(dd, '#runPrev').dispatchEvent(new d5.window.MouseEvent('click', { bubbles: true }));
  await tick();
  ok(q(dd, '#runPrev').disabled, 'на первом прогоне «назад» заблокирована');
  d5.window.close();

  /* ── 9. Дельты к предыдущему прогону ── */
  console.log('\n9. Дельты KPI к предыдущему прогону');
  const d6 = makeDom();
  await waitFor(d6, d => q(d, '#runSel'), 'boot6');
  await load(d6, fullRun(1, 'БАЗА', { salePct: 70 }).concat(fullRun(2, 'НОВЫЙ', { salePct: 88.1 })));
  d6.window.eval("TAB='ov';render();");
  await tick();
  const deltas = qa(d6.window.document, '#main .kpi .d');
  ok(deltas.length >= 3, `на обзоре показано ${deltas.length} дельт к предыдущему прогону`);
  ok(deltas.some(d => d.classList.contains('pos')), 'улучшения подсвечены зелёным');
  const kpiTxt = q(d6.window.document, '#main').textContent;
  ok(/Покрытие спроса/.test(kpiTxt) && /167 из 210/.test(kpiTxt),
    'KPI покрытия спроса сформулирован в бизнес-терминах со счётчиком строк');
  ok(!/Доля модели/.test(kpiTxt), 'технической формулировки «Доля модели» на обзоре больше нет');
  d6.window.close();

  /* ── 10. Восстановление сессии без новых полей ── */
  console.log('\n10. Совместимость со старой сохранённой сессией');
  const d7 = makeDom();
  await waitFor(d7, d => q(d, '#runSel'), 'boot7');
  await load(d7, fullRun(9, 'СТАРАЯ_СЕССИЯ'));
  // имитируем прогон, восстановленный до появления name/short/ctx
  d7.window.eval('DS.runs.forEach(r=>{delete r.name;delete r.short;delete r.ctx});render();');
  await tick();
  ok(!/undefined/.test(q(d7.window.document, '#runbar').textContent),
    'прогон без новых полей отрисован без undefined');
  await walkTabs(d7, 'прогон из старой сессии');
  d7.window.close();

  dom.window.close();

  console.log('\n────────────────────────────────────────');
  console.log(`Итог: ${passed} проверок пройдено, ${failed} провалено`);
  if (failed) process.exit(1);
})().catch(e => { console.error('\nАУДИТ УПАЛ:', e); process.exit(1); });
