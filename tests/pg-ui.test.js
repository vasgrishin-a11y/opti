/**
 * UI tests for the PostgreSQL modal (index.html §16) via jsdom.
 * Run: node tests/pg-ui.test.js
 *
 * Проверяется полный сценарий без живого Postgres и браузера:
 * открытие модалки → подключение → мультивыбор схем → выбор прогонов →
 * загрузка в дашборд, плюс ветки ошибок (401, недоступный backend, 405 от
 * чужого статического сервера) и поле «адрес backend» (включая file://),
 * запасной автоподбор status/message и ручной мэппинг для экзотики.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { COL_CANDIDATES } = require('../server.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const COLS = ['runid', 'parameter', 'value', 'datasetid', 'configid'];

let passed = 0;
function ok(cond, msg) {
  assert(cond, msg);
  passed++;
  console.log('  ✓', msg);
}

function runRows(schema, runid) {
  // минимальный, но валидный набор строк optimizer_status одного прогона
  const R = String(runid);
  return [
    { runid: R, 'Параметр': 'Solution', 'Значение': 'OPTIMAL', datasetid: '14', configid: '300', __schema: schema },
    { runid: R, 'Параметр': 'Start time', 'Значение': '2026-05-14 10:00:00', datasetid: '14', configid: '300', __schema: schema },
    { runid: R, 'Параметр': 'Result gap %', 'Значение': '0.1', datasetid: '14', configid: '300', __schema: schema },
    { runid: R, 'Параметр': 'Non-zero values of sale variables', 'Значение': '5 / 10', datasetid: '14', configid: '300', __schema: schema },
    { runid: R, 'Параметр': 'Non-zero values of sale variables %', 'Значение': '50', datasetid: '14', configid: '300', __schema: schema }
  ];
}

/** Столбцы «неправильной» таблицы в боевой базе: status/message (реальный случай). */
const ODD_COLS = ['status', 'runid', 'datasetid', 'message', 'update_date_time', 'configid', 'change_author', 'sys_id'];
/** Ещё более экзотичная таблица: не угадывается даже запасной автоподбор. */
const EXOTIC_COLS = ['state', 'runid', 'datasetid', 'note', 'update_date_time', 'configid', 'change_author', 'sys_id'];

/** Автоподбор сервера (зеркало suggestColumns в server.js по COL_CANDIDATES). */
function suggestLike(cols) {
  const lower = new Map((cols || []).map(c => [String(c).toLowerCase(), String(c)]));
  const out = {};
  for (const k of Object.keys(COL_CANDIDATES)) {
    out[k] = COL_CANDIDATES[k].map(c => lower.get(c)).find(Boolean) || null;
  }
  return out;
}

/** Подмена fetch: режимы {down, authFail, http405, odd, oddManual} переключаются на лету. */
function apiFetch(mode, log) {
  return async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    (log || []).push({ url: u, body });
    if (mode.down) throw new TypeError('fetch failed');
    if (mode.http405) {
      // так отвечает чужой статический сервер (Live Server и т.п.) на POST:
      // 405 + HTML-тело, не JSON
      return { ok: false, status: 405, json: async () => { throw new Error('HTML body, не JSON'); } };
    }
    if (mode.odd || mode.oddManual) {
      // Схема, где optimizer_status назвал столбцы по-своему.
      const colsUsed = mode.oddManual ? EXOTIC_COLS : ODD_COLS;
      const auto = suggestLike(colsUsed);
      const given = body.columns || {};
      // как mapColumns в server.js: пользовательский ключ важнее автоподбора
      const eff = {};
      Object.keys(auto).forEach(k => { eff[k] = (k in given) ? (given[k] || '') : (auto[k] || ''); });
      const okMap = !!(eff.param && eff.value);
      if (u.endsWith('/api/pg/schemas')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemas: [{
              schema: 'public_1841', table: 'optimizer_status', columns: colsUsed, rows: 500,
              ok: okMap, needsMapping: !okMap,
              error: okMap ? null : 'Схема «public_1841»: не удалось определить столбцы: Параметр/parameter, Значение/value.',
              mapped: { run: eff.run, param: eff.param || null, value: eff.value || null, ds: eff.ds, cfg: eff.cfg }
            }]
          })
        };
      }
      if (u.endsWith('/api/pg/columns')) {
        const sampleRow = mode.oddManual
          ? { state: 'Solution', runid: '7', datasetid: '14', note: 'OPTIMAL', update_date_time: '2026-06-01', configid: '300', change_author: 'etl', sys_id: '1' }
          : { status: 'Solution', runid: '7', datasetid: '14', message: 'OPTIMAL', update_date_time: '2026-06-01', configid: '300', change_author: 'etl', sys_id: '1' };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schema: 'public_1841', table: 'optimizer_status', columns: colsUsed,
            suggested: auto,
            missing: ['param', 'value'].filter(k => !auto[k]),
            sample: [sampleRow]
          })
        };
      }
      if (u.endsWith('/api/pg/runs')) {
        if (!okMap) return { ok: false, status: 400, json: async () => ({ error: 'нет мэппинга' }) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            runs: [{ schema: 'public_1841', table: 'optimizer_status', runid: '7', datasetid: '14', configid: '300', rows: 60, startTime: '2026-06-01 09:00:00' }],
            truncated: false
          })
        };
      }
      if (u.endsWith('/api/pg/load')) {
        if (!okMap) return { ok: false, status: 400, json: async () => ({ error: 'нет мэппинга' }) };
        const rows = [];
        for (const ssel of body.selection) rows.push(...runRows(ssel.schema, ssel.runid));
        return {
          ok: true,
          status: 200,
          json: async () => ({ rows, truncated: false, runs: body.selection.length, schemas: ['public_1841'] })
        };
      }
    }
    if (u.endsWith('/api/pg/schemas')) {
      if (mode.authFail) {
        return { ok: false, status: 401, json: async () => ({ error: 'Неверный логин или пароль — Postgres отклонил аутентификацию.' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemas: [
            { schema: 'public', table: 'optimizer_status', columns: COLS, rows: 120, ok: true, error: null },
            { schema: 'public_1', table: 'optimizer_status', columns: COLS, rows: 45, ok: true, error: null }
          ]
        })
      };
    }
    if (u.endsWith('/api/pg/runs')) {
      const runs = [];
      for (const s of body.schemas) {
        runs.push({ schema: s.schema, table: s.table, runid: '20', datasetid: '14', configid: '300', rows: 60, startTime: '2026-05-14 10:00:00' });
      }
      runs.push({ schema: body.schemas[0].schema, table: 'optimizer_status', runid: '19', datasetid: '14', configid: '300', rows: 60, startTime: '' });
      return { ok: true, status: 200, json: async () => ({ runs, truncated: false }) };
    }
    if (u.endsWith('/api/pg/load')) {
      const rows = [];
      for (const s of body.selection) rows.push(...runRows(s.schema, s.runid));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rows,
          truncated: false,
          runs: body.selection.length,
          schemas: [...new Set(body.selection.map(s => s.schema))]
        })
      };
    }
    throw new Error('unexpected url ' + u);
  };
}

function makeDom(fetchImpl, url = 'http://localhost:3000/') {
  return new JSDOM(HTML, {
    url,
    runScripts: 'dangerously',
    beforeParse(window) {
      window.fetch = fetchImpl;
      // Заглушка canvas: любой метод/проперти — no-op, чтобы графики молча «рисовались»
      const any = () =>
        new Proxy(function () {}, {
          get: (t, p) => (p === Symbol.toPrimitive ? () => 0 : any()),
          set: () => true,
          apply: () => any()
        });
      window.HTMLCanvasElement.prototype.getContext = function () {
        return any();
      };
    }
  });
}

async function waitFor(dom, fn, what, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try {
      v = fn(dom.window.document);
    } catch (e) { /* retry */ }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for: ' + what);
    await new Promise(r => setTimeout(r, 25));
  }
}
const q = (doc, s) => doc.querySelector(s);
const qa = (doc, s) => [...doc.querySelectorAll(s)];
function setCheck(dom, el, checked) {
  el.checked = checked;
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

(async () => {
  console.log('1. Boot с демо-набором');
  const mode = {};
  const log = [];
  const dom = makeDom(apiFetch(mode, log));
  const doc = dom.window.document;
  await waitFor(dom, d => q(d, '#runSel'), 'runSel after boot');
  ok(q(doc, '#runbar').textContent.includes('Прогон 19'), 'demo run shown');
  ok(q(doc, '#bPg') !== null, 'PG button exists');

  console.log('2. Модалка: defaults, только логин+пароль');
  q(doc, '#bPg').click();
  ok(q(doc, '#pgModal').hidden === false, 'modal opened');
  ok(q(doc, '#pgStep1').hidden === false, 'step 1 visible');
  ok(q(doc, '#pgHost').value === 'db-postgresql-app.k8s.b1gahmn2gdjf3lsm4jeh.in-plan.ru', 'host prefilled');
  ok(q(doc, '#pgPort').value === '48235', 'port prefilled');
  ok(q(doc, '#pgDb').value === 'pgs_app_data_db', 'database prefilled');
  ok(q(doc, '#pgPass').value === '', 'password empty');
  ok(q(doc, '#pgBackend').value === '', 'backend field empty (same origin)');

  console.log('3. Подключение → мультивыбор схем');
  q(doc, '#pgUser').value = 'analyst';
  q(doc, '#pgPass').value = 'secret';
  q(doc, '#pgConnect').click();
  await waitFor(dom, d => q(d, '#pgStep2').hidden === false, 'step 2');
  const schemaItems = qa(doc, '#pgSchemasList .pg-item');
  ok(schemaItems.length === 2, 'two schemas listed');
  ok(q(doc, '#pgSchemasList').textContent.includes('public_1'), 'public_1 listed');
  ok(q(doc, '#pgToRuns').textContent.includes('(2)'), 'both preselected: ' + q(doc, '#pgToRuns').textContent);
  q(doc, '#pgSchemasNone').click();
  ok(q(doc, '#pgToRuns').textContent.includes('(0)'), 'deselect all');
  q(doc, '#pgSchemasAll').click();
  ok(q(doc, '#pgToRuns').textContent.includes('(2)'), 'select all');
  // фильтр схем
  q(doc, '#pgSchemaQ').value = 'public_1';
  q(doc, '#pgSchemaQ').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  ok(qa(doc, '#pgSchemasList .pg-item').length === 1, 'schema filter works');
  q(doc, '#pgSchemaQ').value = '';
  q(doc, '#pgSchemaQ').dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  console.log('4. Прогоны по схемам');
  q(doc, '#pgToRuns').click();
  await waitFor(dom, d => q(d, '#pgStep3').hidden === false, 'step 3');
  ok(qa(doc, '#pgRunsList .pg-grp').length === 2, 'runs grouped by schema');
  ok(qa(doc, '#pgRunsList .pg-item').length === 3, 'three runs listed');
  ok(q(doc, '#pgDoLoad').textContent.includes('(3)'), 'default selection = all (<=25)');
  ok(log.some(e => e.url.endsWith('/api/pg/runs')), 'runs API called');

  console.log('5. Загрузка в дашборд (2 из 3 прогонов)');
  setCheck(dom, q(doc, '#pgRunsList .pg-item input'), false);
  ok(q(doc, '#pgDoLoad').textContent.includes('(2)'), 'one run unchecked');
  q(doc, '#pgDoLoad').click();
  await waitFor(dom, d => q(d, '#pgModal').hidden === true, 'modal closed after load');
  const opts = qa(doc, '#runSel option');
  ok(opts.length === 2, 'two runs in history, got ' + opts.length);
  ok(opts.some(o => o.textContent.includes('public_1 · Прогон 20')), 'schema in run label: ' + opts.map(o => o.textContent).join(' / '));
  ok(q(doc, '#stat').textContent.includes('Загружено из Postgres'), 'stat updated');
  ok(q(doc, '#bPg').classList.contains('on'), 'PG button marked active');
  ok(q(doc, '#runbar').textContent.includes('PostgreSQL: public'), 'source meta shows schemas');
  // пароль не сохраняется
  const saved = JSON.parse(dom.window.localStorage.getItem('snp_opt_pg') || '{}');
  ok(saved.user === 'analyst' && !('password' in saved) && !('pass' in saved), 'no password in localStorage');
  ok(!JSON.stringify(saved).includes('secret'), 'password value not persisted');

  console.log('6. Повторное открытие — сразу к схемам; закрытие по Escape/клику');
  q(doc, '#bPg').click();
  ok(q(doc, '#pgStep2').hidden === false, 'reopen lands on schemas (session kept)');
  q(doc, '#pgModal').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(q(doc, '#pgModal').hidden === true, 'Escape closes');
  q(doc, '#bPg').click();
  q(doc, '#pgModal').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  ok(q(doc, '#pgModal').hidden === true, 'overlay click closes');
  dom.window.close();

  console.log('7. Ошибка 401 — текст в модалке c подсказками про подстановку/пробелы, остаёмся на шаге 1');
  {
    const m2 = { authFail: true };
    const d2 = makeDom(apiFetch(m2, []));
    const doc2 = d2.window.document;
    await waitFor(d2, d => q(d, '#runSel'), 'boot 2');
    q(doc2, '#bPg').click();
    q(doc2, '#pgUser').value = 'analyst';
    q(doc2, '#pgPass').value = 'wrong';
    q(doc2, '#pgConnect').click();
    await waitFor(d2, d => q(d, '#pgErr1').classList.contains('show'), 'auth error shown');
    const err7 = q(doc2, '#pgErr1').textContent;
    ok(err7.includes('логин или пароль'), 'friendly 401 text');
    ok(/сохранённые данные|менеджер/i.test(err7), '401: подсказка про автоподстановку браузера');
    ok(err7.includes('пробел'), '401: подсказка про пробелы при копировании');
    ok(err7.includes('глаз'), '401: подсказка про кнопку просмотра пароля');
    ok(q(doc2, '#pgStep1').hidden === false, 'still on step 1');
    d2.window.close();
  }

  console.log('8. Backend недоступен — подсказка про npm start');
  {
    const m3 = { down: true };
    const d3 = makeDom(apiFetch(m3, []));
    const doc3 = d3.window.document;
    await waitFor(d3, d => q(d, '#runSel'), 'boot 3');
    q(doc3, '#bPg').click();
    q(doc3, '#pgUser').value = 'analyst';
    q(doc3, '#pgPass').value = 'x';
    q(doc3, '#pgConnect').click();
    await waitFor(d3, d => q(d, '#pgErr1').classList.contains('show'), 'down error shown');
    ok(q(doc3, '#pgErr1').textContent.includes('npm start'), 'hint about backend start');
    d3.window.close();
  }

  console.log('9. HTTP 405 от чужого статического сервера — понятная ошибка вместо «Ошибка сервера: 405»');
  {
    const m4 = { http405: true };
    const d4 = makeDom(apiFetch(m4, []));
    const doc4 = d4.window.document;
    await waitFor(d4, d => q(d, '#runSel'), 'boot 4');
    q(doc4, '#bPg').click();
    q(doc4, '#pgUser').value = 'analyst';
    q(doc4, '#pgPass').value = 'x';
    q(doc4, '#pgConnect').click();
    await waitFor(d4, d => q(d, '#pgErr1').classList.contains('show'), '405 error shown');
    const msg4 = q(doc4, '#pgErr1').textContent;
    ok(msg4.includes('405') && !msg4.startsWith('Ошибка сервера: 405'), 'friendly 405 text: ' + msg4.slice(0, 50) + '…');
    ok(msg4.includes('npm start') && msg4.includes('адрес backend'), '405 hint: npm start + backend field');
    ok(q(doc4, '#pgStep1').hidden === false, 'still on step 1');
    d4.window.close();
  }

  console.log('10. Поле «адрес backend» — запросы уходят туда, значение запоминается');
  {
    const m5 = {};
    const log5 = [];
    const d5 = makeDom(apiFetch(m5, log5));
    const doc5 = d5.window.document;
    await waitFor(d5, d => q(d, '#runSel'), 'boot 5');
    q(doc5, '#bPg').click();
    q(doc5, '#pgUser').value = 'analyst';
    q(doc5, '#pgPass').value = 'x';
    q(doc5, '#pgBackend').value = 'http://pg-host:8123/';
    q(doc5, '#pgConnect').click();
    await waitFor(d5, d => q(d, '#pgStep2').hidden === false, 'step 2 via external backend');
    ok(log5.some(e => e.url === 'http://pg-host:8123/api/pg/schemas'), 'request went to the custom backend base');
    const saved5 = JSON.parse(d5.window.localStorage.getItem('snp_opt_pg') || '{}');
    ok(saved5.backend === 'http://pg-host:8123', 'backend base persisted (trailing slash stripped)');
    d5.window.close();
  }

  console.log('11. file:// — поле backend автоматически заполнено http://localhost:3000');
  {
    const m6 = {};
    const d6 = makeDom(apiFetch(m6, []), 'file:///C:/work/index.html');
    const doc6 = d6.window.document;
    await waitFor(d6, d => q(d, '#runSel'), 'boot 6');
    q(doc6, '#bPg').click();
    ok(q(doc6, '#pgBackend').value === 'http://localhost:3000', 'file:// prefills http://localhost:3000');
    d6.window.close();
  }

  console.log('12. Таблица status/message: мэппинг подбирается сам, схема сразу доступна');
  {
    const m7 = { odd: true };
    const log7 = [];
    const d7 = makeDom(apiFetch(m7, log7));
    const doc7 = d7.window.document;
    await waitFor(d7, d => q(d, '#runSel'), 'boot 7');
    q(doc7, '#bPg').click();
    q(doc7, '#pgUser').value = 'analyst';
    q(doc7, '#pgPass').value = 'x';
    q(doc7, '#pgConnect').click();
    await waitFor(d7, d => q(d, '#pgStep2').hidden === false, 'step 2 (status/message schema)');

    ok(q(doc7, '#pgSchemasList .pg-item.bad') === null, 'схема не помечена недоступной');
    ok(/доступно: 1/.test(q(doc7, '#pgSchemasInfo').textContent), 'в сводке «доступно: 1»: ' + q(doc7, '#pgSchemasInfo').textContent);
    ok(/автоматически/.test(q(doc7, '#pgMapState').textContent), 'мэппинг подобран автоматически');
    ok(q(doc7, '#pgMap').open === false, 'блок мэппинга не раскрывается — вмешательство не нужно');
    ok(q(doc7, '#pgMap_param').value === 'status', 'Параметр → status');
    ok(q(doc7, '#pgMap_value').value === 'message', 'Значение → message');
    ok(q(doc7, '#pgToRuns').textContent.includes('(1)'), 'схема предвыбрана без действий пользователя');

    q(doc7, '#pgToRuns').click();
    await waitFor(d7, d => q(d, '#pgStep3').hidden === false, 'step 3 with auto mapping');
    const runsReq = log7.filter(e => e.url.endsWith('/api/pg/runs')).pop();
    ok(!runsReq.body.columns, 'при автоподборе columns в запрос не добавляется');

    q(doc7, '#pgDoLoad').click();
    await waitFor(d7, d => q(d, '#pgModal').hidden === true, 'loaded with auto mapping');
    const loadReq = log7.filter(e => e.url.endsWith('/api/pg/load')).pop();
    ok(!loadReq.body.columns, 'и в /api/pg/load columns не уходит');
    ok(qa(doc7, '#runSel option').some(o => o.textContent.includes('public_1841')), 'прогон из схемы со status/message попал в дашборд');
    d7.window.close();
  }

  console.log('13. Мэппинг столбцов вручную: экзотические имена (state/note)');
  {
    const m7 = { oddManual: true };
    const log7 = [];
    const d7 = makeDom(apiFetch(m7, log7));
    const doc7 = d7.window.document;
    await waitFor(d7, d => q(d, '#runSel'), 'boot 7m');
    q(doc7, '#bPg').click();
    q(doc7, '#pgUser').value = 'analyst';
    q(doc7, '#pgPass').value = 'x';
    q(doc7, '#pgConnect').click();
    await waitFor(d7, d => q(d, '#pgStep2').hidden === false, 'step 2 (exotic schema)');

    ok(q(doc7, '#pgMap') !== null, 'блок «Мэппинг столбцов» есть на шаге 2');
    ok(q(doc7, '#pgMap').open === true, 'блок раскрыт автоматически, раз мэппинг неполный');
    ok(/нужно указать/.test(q(doc7, '#pgMapState').textContent), 'статус мэппинга предупреждает: ' + q(doc7, '#pgMapState').textContent);
    ok(q(doc7, '#pgSchemasList .pg-item.bad') !== null, 'схема помечена недоступной до мэппинга');
    ok(/Мэппинг столбцов/.test(q(doc7, '#pgSchemasList').textContent), 'подсказка про мэппинг в описании схемы');
    ok(/Ничего отметить нельзя/.test(q(doc7, '#pgSchemasInfo').textContent), 'при «доступно: 0» сводка объясняет причину и решение');

    // селекты заполнены реальными столбцами таблицы
    const selParam = q(doc7, '#pgMap_param');
    ok(selParam !== null, 'селект для «Параметр» отрисован');
    const optVals = [...selParam.options].map(o => o.value);
    ok(EXOTIC_COLS.every(c => optVals.includes(c)), 'в списке все столбцы таблицы: ' + optVals.join(','));
    ok(q(doc7, '#pgMap_run').value === 'runid', 'runid подобран автоматически');
    ok(q(doc7, '#pgMap_ds').value === 'datasetid', 'datasetid подобран автоматически');
    ok(selParam.value === '', '«Параметр» не угадан — пусто');

    // попытка идти дальше без мэппинга — понятная ошибка
    q(doc7, '#pgToRuns').click();
    await waitFor(d7, d => q(d, '#pgErr2').classList.contains('show'), 'mapping error');
    ok(/Мэппинг столбцов/.test(q(doc7, '#pgErr2').textContent), 'ошибка объясняет, что нужен мэппинг');
    ok(q(doc7, '#pgStep2').hidden === false, 'остаёмся на шаге 2');

    // образцы строк помогают понять, какой столбец за что отвечает
    q(doc7, '#pgMapSample').click();
    await waitFor(d7, d => q(d, '#pgMapSampleBox').hidden === false && q(d, '#pgMapSampleBox').textContent.includes('Solution'), 'sample rows');
    ok(/note/.test(q(doc7, '#pgMapSampleBox').textContent), 'в образцах видны имена столбцов');
    ok(log7.some(e => e.url.endsWith('/api/pg/columns')), 'образцы запрошены через /api/pg/columns');

    // задаём мэппинг вручную
    const setSel = (id, v) => { const el = q(doc7, id); el.value = v; el.dispatchEvent(new d7.window.Event('change', { bubbles: true })); };
    setSel('#pgMap_param', 'state');
    setSel('#pgMap_value', 'note');
    ok(/задан вручную/.test(q(doc7, '#pgMapState').textContent), 'статус: мэппинг задан вручную');
    ok(q(doc7, '#pgSchemasList .pg-item.bad') === null, 'схема стала доступной после мэппинга');
    ok(q(doc7, '#pgToRuns').textContent.includes('(1)'), 'единственная ставшая доступной схема отметилась сама');

    // «Выбрать все» работает и для схем, починенных ручным мэппингом (не по s.ok)
    q(doc7, '#pgSchemasNone').click();
    ok(q(doc7, '#pgToRuns').textContent.includes('(0)'), 'Снять все');
    q(doc7, '#pgSchemasAll').click();
    ok(q(doc7, '#pgToRuns').textContent.includes('(1)'), 'Выбрать все отмечает схему с ручным мэппингом');

    // теперь шаги проходят, и мэппинг уходит в каждый запрос
    q(doc7, '#pgToRuns').click();
    await waitFor(d7, d => q(d, '#pgStep3').hidden === false, 'step 3 with mapping');
    const runsReq = log7.filter(e => e.url.endsWith('/api/pg/runs')).pop();
    ok(runsReq.body.columns && runsReq.body.columns.param === 'state' && runsReq.body.columns.value === 'note',
      'мэппинг ушёл в /api/pg/runs: ' + JSON.stringify(runsReq.body.columns));

    q(doc7, '#pgDoLoad').click();
    await waitFor(d7, d => q(d, '#pgModal').hidden === true, 'loaded with mapping');
    const loadReq = log7.filter(e => e.url.endsWith('/api/pg/load')).pop();
    ok(loadReq.body.columns.param === 'state', 'мэппинг ушёл и в /api/pg/load');
    ok(qa(doc7, '#runSel option').some(o => o.textContent.includes('public_1841')), 'прогон из «неправильной» схемы попал в дашборд');

    // мэппинг запоминается между сессиями
    const saved7 = JSON.parse(d7.window.localStorage.getItem('snp_opt_pg') || '{}');
    ok(saved7.cols && saved7.cols.param === 'state' && saved7.cols.value === 'note', 'мэппинг сохранён в localStorage');
    ok(!JSON.stringify(saved7).includes('"password"'), 'пароль по-прежнему не сохраняется');
    d7.window.close();
  }

  console.log('14. Кнопка «Сбросить на авто» возвращает автоподбор');
  {
    const d8 = makeDom(apiFetch({}, []));
    const doc8 = d8.window.document;
    await waitFor(d8, d => q(d, '#runSel'), 'boot 8');
    q(doc8, '#bPg').click();
    q(doc8, '#pgUser').value = 'analyst';
    q(doc8, '#pgPass').value = 'x';
    q(doc8, '#pgConnect').click();
    await waitFor(d8, d => q(d, '#pgStep2').hidden === false, 'step 2 (normal schema)');
    ok(/автоматически/.test(q(doc8, '#pgMapState').textContent), 'обычная таблица: мэппинг авто');
    ok(q(doc8, '#pgMap').open === false, 'блок мэппинга свёрнут, когда всё определилось');
    ok(q(doc8, '#pgMap_param').value === 'parameter', 'parameter подобран: ' + q(doc8, '#pgMap_param').value);
    const sel = q(doc8, '#pgMap_value');
    sel.value = 'runid';
    sel.dispatchEvent(new d8.window.Event('change', { bubbles: true }));
    ok(/вручную/.test(q(doc8, '#pgMapState').textContent), 'после правки — «задан вручную»');
    q(doc8, '#pgMapAuto').click();
    ok(/автоматически/.test(q(doc8, '#pgMapState').textContent), 'сброс вернул авто');
    ok(q(doc8, '#pgMap_value').value === 'value', 'значение вернулось к автоподбору');
    d8.window.close();
  }

  console.log('15. Поле «адрес backend» — нормализация вставленного значения');
  async function connectWithBackend(backendValue) {
    const log15 = [];
    const d15 = makeDom(apiFetch({}, log15));
    const doc15 = d15.window.document;
    await waitFor(d15, d => q(d, '#runSel'), 'boot backend');
    q(doc15, '#bPg').click();
    q(doc15, '#pgUser').value = 'analyst';
    q(doc15, '#pgPass').value = 'x';
    q(doc15, '#pgBackend').value = backendValue;
    q(doc15, '#pgConnect').click();
    await waitFor(
      d15,
      d => q(d, '#pgStep2').hidden === false || q(d, '#pgErr1').classList.contains('show'),
      'step 2 or step-1 error'
    );
    return { d15, doc15, log15 };
  }
  {
    // markdown-ссылка из мессенджера/заметок: берём сам URL
    const { d15, doc15, log15 } = await connectWithBackend('[http://localhost:3000](http://localhost:3000)');
    ok(q(doc15, '#pgStep2').hidden === false, 'markdown-вставка принята');
    ok(log15.some(e => e.url === 'http://localhost:3000/api/pg/schemas'),
      'из markdown извлечён чистый URL: ' + JSON.stringify(log15.map(e => e.url)));
    d15.window.close();
  }
  {
    // адрес без схемы: подставляем http://
    const { d15, doc15, log15 } = await connectWithBackend('localhost:3000');
    ok(log15.some(e => e.url === 'http://localhost:3000/api/pg/schemas'), 'без схемы дописан http://');
    d15.window.close();
  }
  {
    // заведомый мусор: понятная ошибка на шаге 1, запрос не уходит
    const { d15, doc15, log15 } = await connectWithBackend('куда-то не туда');
    ok(q(doc15, '#pgErr1').classList.contains('show'), 'показана ошибка про адрес backend');
    ok(/http:\/\//.test(q(doc15, '#pgErr1').textContent), 'в ошибке сказано, какого формата ждём');
    ok(!log15.length, 'при кривом адресе запросы не уходят');
    ok(q(doc15, '#pgStep1').hidden === false, 'остаёмся на шаге 1');
    d15.window.close();
  }

  console.log('16. Кнопка «глаз» показывает/скрывает пароль');
  {
    const d16 = makeDom(apiFetch({}, []));
    const doc16 = d16.window.document;
    await waitFor(d16, d => q(d, '#runSel'), 'boot eye');
    q(doc16, '#bPg').click();
    const pass = q(doc16, '#pgPass');
    const eye = q(doc16, '#pgPassEye');
    ok(eye !== null, 'кнопка «глаз» отрисована');
    ok(pass.type === 'password', 'пароль скрыт по умолчанию');
    pass.value = 's e c';
    eye.click();
    ok(pass.type === 'text', 'по клику пароль виден — сразу видны пробелы/раскладка');
    ok(eye.getAttribute('aria-label') === 'Скрыть пароль', 'aria-label переключён');
    eye.click();
    ok(pass.type === 'password', 'повторный клик снова скрывает');
    d16.window.close();
  }

  console.log('\n' + '─'.repeat(40));
  console.log(`Result: ${passed} passed`);
})().catch(e => {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
});
