/**
 * Persistence tests: IndexedDB session round-trip (index.html §6).
 * Run: node tests/session.test.js
 *
 * Проверяется сценарий «закрыл вкладку — открыл снова»: прогоны, загруженные
 * из БД/файла, переживают перезагрузку страницы. IndexedDB подменяется
 * in-memory фейком с shared-хранилищем: два разных JSDOM (две «вкладки»)
 * видят одно хранилище, как два окна одного origin.
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

/* Минимальный фейк IndexedDB поверх shared Map (structured clone → JSON). */
function makeFakeIDB(shared) {
  return {
    open() {
      const req = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const tx = {};
            tx.objectStore = () => ({
              get(k) {
                const r = {};
                setTimeout(() => {
                  r.result = shared.has(k) ? shared.get(k) : undefined;
                  if (r.onsuccess) r.onsuccess();
                }, 0);
                return r;
              },
              put(v, k) {
                setTimeout(() => {
                  try {
                    shared.set(k, JSON.parse(JSON.stringify(v)));
                    if (tx.oncomplete) tx.oncomplete();
                  } catch (e) { tx.error = e; if (tx.onerror) tx.onerror(); }
                }, 0);
                return {};
              },
              delete(k) {
                setTimeout(() => {
                  shared.delete(k);
                  if (tx.oncomplete) tx.oncomplete();
                }, 0);
                return {};
              }
            });
            return tx;
          }
        };
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };
}

function makeDom(shared) {
  return new JSDOM(HTML, {
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    beforeParse(window) {
      if (shared) window.indexedDB = makeFakeIDB(shared);
      window.fetch = async () => { throw new Error('no backend in session test'); };
      // Заглушка canvas (как в pg-ui.test.js)
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

function seedRows() {
  // один прогон №77 + дублирующийся Alias (проверка dups при восстановлении)
  return [
    { runid: '77', 'Параметр': 'Solution', 'Значение': 'OPTIMAL', datasetid: '14', configid: '300', __schema: 'public_1' },
    { runid: '77', 'Параметр': 'Start time', 'Значение': '2026-06-01 09:00:00', datasetid: '14', configid: '300', __schema: 'public_1' },
    { runid: '77', 'Параметр': 'Alias', 'Значение': 'SNP_ОСНОВНОЙ_ПЛАН', datasetid: '14', configid: '300', __schema: 'public_1' },
    { runid: '77', 'Параметр': 'Alias', 'Значение': 'SNP_НОЧНОЙ_ПЕРЕСЧЁТ', datasetid: '14', configid: '300', __schema: 'public_1' },
    { runid: '77', 'Параметр': 'Non-zero values of sale variables', 'Значение': '5 / 10', datasetid: '14', configid: '300', __schema: 'public_1' },
    { runid: '77', 'Параметр': 'Non-zero values of sale variables %', 'Значение': '50', datasetid: '14', configid: '300', __schema: 'public_1' }
  ];
}

(async () => {
  console.log('1. Сохранение → закрытие вкладки → открытие: данные переживают перезагрузку');
  const shared = new Map();
  {
    const d1 = makeDom(shared);
    const doc1 = d1.window.document;
    await waitFor(d1, d => q(d, '#runSel'), 'boot tab 1');
    await new Promise(r => setTimeout(r, 50)); // таймеры boot-отрисовки — до нашей перерисовки
    ok(doc1.querySelector('#runbar').textContent.includes('Прогон 19'), 'первый старт: демо-набор');
    // «загрузка из БД»: прогон 77 вместо демо
    d1.window.eval(`initFromRows(${JSON.stringify(seedRows())},{source:'postgres',files:['PostgreSQL: public_1'],loadedAt:new Date().toISOString()});IS_DEMO=false;TAB='bnd';render();`);
    const saved1 = await d1.window.eval('persistSession()');
    ok(saved1 === true, 'persistSession записал сессию');
    ok(shared.has('current'), 'запись current появилась в IndexedDB');
    await new Promise(r => setTimeout(r, 100)); // дать таймерам отрисовки отработать до закрытия
    d1.window.close(); // «закрыли вкладку»
  }
  {
    const d2 = makeDom(shared); // «открыли вкладку снова» — то же хранилище
    const doc2 = d2.window.document;
    // boot() сначала ждёт restoreSession и только потом рисует runbar
    await waitFor(d2, d => q(d, '#runSel'), 'boot tab 2');
    ok(d2.window.eval('IS_DEMO') === false, 'восстановлена пользовательская сессия, а не демо');
    ok(doc2.querySelector('#runSel').title.includes('Прогон 77'), 'активный прогон 77 на месте');
    ok(doc2.querySelector('#runbar').textContent.includes('прогон 77'), 'контекст прогона 77 в runbar');
    ok(d2.window.eval('DS.runs.length') === 1, 'история: 1 прогон');
    ok(d2.window.eval('DS.runs[0].dups.length') === 1, 'конфликт Alias (dups) пережил перезагрузку');
    ok(d2.window.eval('DS.runs[0].schema') === 'public_1', 'схема прогона сохранена');
    ok(d2.window.eval('CUR_KEY') === d2.window.eval('runKey(DS.runs[0])'), 'активный прогон восстановлен');
    ok(doc2.querySelector('#pgTitle').textContent.includes('Ограничения'), 'восстановлена вкладка «Ограничения»');
    ok(/сохранённая сессия|PostgreSQL: public_1/.test(doc2.querySelector('#runbar').textContent), 'мета-источник виден в runbar');
    d2.window.close();
  }

  console.log('2. Пустое хранилище → демо-набор, без ошибок');
  {
    const d3 = makeDom(new Map());
    await waitFor(d3, d => q(d, '#runSel'), 'boot tab 3');
    ok(d3.window.eval('IS_DEMO') === true, 'без сохранённой сессии показывается демо');
    d3.window.close();
  }

  console.log('3. IndexedDB недоступен → честная ошибка вместо молчания');
  {
    const d4 = makeDom(null); // без indexedDB (как приватный режим)
    await waitFor(d4, d => q(d, '#runSel'), 'boot tab 4');
    await new Promise(r => setTimeout(r, 50)); // таймеры boot-отрисовки — до нашей перерисовки
    d4.window.eval(`initFromRows(${JSON.stringify(seedRows())},{source:'file',files:['a.xlsx'],loadedAt:new Date().toISOString()});IS_DEMO=false;render();`);
    const saved4 = await d4.window.eval('persistSession()');
    ok(saved4 === false, 'persistSession вернул false');
    ok(String(d4.window.eval('LOAD_META.persistError') || '').length > 0, 'причина записана в LOAD_META.persistError');
    ok(d4.window.eval(`loadMetaHtml().includes('не сохранено в браузере')`), 'в runbar видно «не сохранено в браузере»');
    d4.window.close();
  }

  console.log('\n' + '─'.repeat(40));
  console.log(`Result: ${passed} passed`);
})().catch(e => {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
});
