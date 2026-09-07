/**
 * UI tests for the PostgreSQL modal (index.html §16) via jsdom.
 * Run: node tests/pg-ui.test.js
 *
 * Проверяется полный сценарий без живого Postgres и браузера:
 * открытие модалки → подключение → мультивыбор схем → выбор прогонов →
 * загрузка в дашборд, плюс ветки ошибок (401, недоступный backend).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

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

/** Подмена fetch: режимы {down, authFail} переключаются на лету. */
function apiFetch(mode, log) {
  return async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    (log || []).push({ url: u, body });
    if (mode.down) throw new TypeError('fetch failed');
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

function makeDom(fetchImpl) {
  return new JSDOM(HTML, {
    url: 'http://localhost:3000/',
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

  console.log('7. Ошибка 401 — текст в модалке, остаёмся на шаге 1');
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
    ok(q(doc2, '#pgErr1').textContent.includes('логин или пароль'), 'friendly 401 text');
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

  console.log('\n' + '─'.repeat(40));
  console.log(`Result: ${passed} passed`);
})().catch(e => {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
});
