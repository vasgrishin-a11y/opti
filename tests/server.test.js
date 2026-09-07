/**
 * Backend tests for SNP Optimizer Insight (server.js).
 * Run: node tests/server.test.js
 *
 * DB-слой инжектится фейком (createApp({connect})), живой Postgres не нужен.
 * Плюс live-тест негативных путей на реальном HTTP (недоступный хост).
 */
'use strict';
const assert = require('assert');
const {
  createApp,
  qi,
  mapColumns,
  normalizeRow,
  normalizeConn,
  normalizeSchemas,
  normalizeSelection,
  friendlyPgError,
  HttpError,
  PG_DEFAULTS
} = require('../server.js');

let passed = 0;
function ok(cond, msg) {
  assert(cond, msg);
  passed++;
  console.log('  ✓', msg);
}
function eq(a, b, msg) {
  assert.deepStrictEqual(a, b, `${msg} | got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
  passed++;
  console.log('  ✓', msg);
}
async function throwsAsync(fn, status, msg) {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof HttpError, `${msg}: expected HttpError, got ${e && e.constructor && e.constructor.name}`);
    assert.strictEqual(e.status, status, `${msg}: status ${e.status} !== ${status} (${e.message})`);
    passed++;
    console.log('  ✓', msg);
    return e;
  }
  assert.fail(`${msg}: expected throw, got success`);
}
function throwsSync(fn, status, msg) {
  try {
    fn();
  } catch (e) {
    assert(e instanceof HttpError, `${msg}: expected HttpError`);
    assert.strictEqual(e.status, status, `${msg}: status ${e.status} !== ${status} (${e.message})`);
    passed++;
    console.log('  ✓', msg);
    return e;
  }
  assert.fail(`${msg}: expected throw, got success`);
}

/* ── Фейковый драйвер: canned-ответы по виду SQL, запись вызовов ── */
function makeFake(impl) {
  const calls = [];
  const api = {
    calls,
    mode: 'ok', // ok | auth | refused
    connect: async conn => {
      api.lastConn = conn;
      if (api.mode === 'auth') {
        const e = new Error('password authentication failed');
        e.code = '28P01';
        throw e;
      }
      if (api.mode === 'refused') {
        const e = new Error('connect ECONNREFUSED');
        e.code = 'ECONNREFUSED';
        throw e;
      }
      return {
        query: async (text, params) => {
          calls.push({ text, params });
          return impl(text, params || []);
        },
        close: async () => {}
      };
    }
  };
  return api;
}

const COLS_EN = ['runid', 'parameter', 'value', 'datasetid', 'configid'];
const COLS_RU = ['runid', 'Параметр', 'Значение', 'datasetid', 'configid'];

/** Стандартный фейк: 2 схемы (вторая с битыми столбцами), прогоны, строки. */
function standardFake() {
  return makeFake((text, params) => {
    if (text.includes('information_schema.tables')) {
      return { rows: [{ s: 'public', t: 'optimizer_status' }, { s: 'public_1', t: 'optimizer_status' }] };
    }
    if (text.includes('information_schema.columns')) {
      if (params[0] === 'public') return { rows: COLS_EN.map(c => ({ c })) };
      return { rows: [{ c: 'id' }, { c: 'data' }] }; // битая схема
    }
    if (text.includes('GROUP BY 1,2,3 ORDER BY')) {
      return { rows: [{ r: 20, d: 14, c: 300, n: 60 }, { r: 19, d: 14, c: 300, n: 60 }] };
    }
    if (text.includes('COUNT(*)::int AS n')) return { rows: [{ n: 120 }] };
    if (text.includes("MAX(") && text.includes("Start time")) {
      return { rows: [{ r: 20, d: 14, c: 300, s: '2026-05-14 10:00:00' }] };
    }
    if (text.includes(' AS _r,')) {
      // load: по одному набору строк на прогон из IN-списка
      const n = (params.length / 3) | 0;
      const rows = [];
      for (let i = 0; i < n; i++) {
        const [r, d, c] = [params[i * 3], params[i * 3 + 1], params[i * 3 + 2]];
        rows.push({ _r: r, _p: 'Solution', _v: 'OPTIMAL', _d: d, _c: c });
        rows.push({ _r: r, _p: 'Start time', _v: '2026-05-14 10:00:00', _d: d, _c: c });
      }
      return { rows };
    }
    throw new Error('Unexpected SQL in fake: ' + text.slice(0, 80));
  });
}

async function listen(app) {
  const srv = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = srv.address().port;
  return { srv, base: `http://127.0.0.1:${port}` };
}
async function post(base, p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) { /* ignore */ }
  return { status: res.status, data };
}

const CONN = { host: 'h', port: 5432, database: 'd', user: 'u', password: 'p', ssl: 'off' };

(async () => {
  console.log('1. qi — квотирование идентификаторов');
  eq(qi('public'), '"public"', 'simple');
  eq(qi('we"ird'), '"we""ird"', 'double quote escaped');
  throwsSync(() => qi(''), 400, 'empty throws');
  throwsSync(() => qi('x'.repeat(200)), 400, 'too long throws');

  console.log('2. mapColumns — EN/RU/регистр/ошибки');
  eq(
    mapColumns(['RUNID', 'Parameter', 'Value', 'DatasetID', 'ConfigID']),
    { run: 'RUNID', param: 'Parameter', value: 'Value', ds: 'DatasetID', cfg: 'ConfigID' },
    'case-insensitive EN'
  );
  eq(
    mapColumns(COLS_RU),
    { run: 'runid', param: 'Параметр', value: 'Значение', ds: 'datasetid', cfg: 'configid' },
    'RU columns'
  );
  const missErr = throwsSync(() => mapColumns(['id', 'data'], 'Схема «s»'), 400, 'missing columns throws');
  ok(missErr.message.includes('Схема «s»') && missErr.message.includes('runid'), 'error mentions schema + columns');

  console.log('3. normalizeRow/cell');
  eq(
    normalizeRow({ _r: 19, _p: 'Solution', _v: null, _d: 14, _c: 300 }, 'public_1'),
    { runid: '19', 'Параметр': 'Solution', 'Значение': '', datasetid: '14', configid: '300', __schema: 'public_1' },
    'types stringified, NULL→empty, schema tagged'
  );

  console.log('4. normalizeConn/Schemas/Selection — валидация');
  eq(normalizeConn({ host: 'h', port: '5432', database: 'd', user: 'u' }).ssl, 'auto', 'ssl defaults to auto');
  throwsSync(() => normalizeConn({ host: '', port: 1, database: 'd', user: 'u' }), 400, 'empty host');
  throwsSync(() => normalizeConn({ host: 'h', port: 99999, database: 'd', user: 'u' }), 400, 'bad port');
  throwsSync(() => normalizeConn({ host: 'h', port: 1, database: 'd', user: '' }), 400, 'empty user');
  throwsSync(() => normalizeConn({ host: 'h', port: 1, database: 'd', user: 'u', ssl: 'x' }), 400, 'bad ssl mode');
  eq(normalizeSchemas(['public']), [{ schema: 'public', table: 'optimizer_status' }], 'string schema → default table');
  throwsSync(() => normalizeSchemas([]), 400, 'empty schemas');
  throwsSync(() => normalizeSelection([]), 400, 'empty selection');
  throwsSync(() => normalizeSelection([{ schema: 's' }]), 400, 'selection w/o runid');
  const sel1 = normalizeSelection([{ schema: 's', runid: 5, datasetid: null, configid: undefined }]);
  eq(sel1, [{ schema: 's', table: 'optimizer_status', runid: '5', datasetid: '', configid: '' }], 'selection coerced');

  console.log('5. friendlyPgError — коды → статусы');
  eq(friendlyPgError(Object.assign(new Error('x'), { code: '28P01' }), CONN).status, 401, '28P01→401');
  eq(friendlyPgError(Object.assign(new Error('x'), { code: '3D000' }), CONN).status, 400, '3D000→400');
  eq(friendlyPgError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), CONN).status, 502, 'refused→502');
  eq(friendlyPgError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }), CONN).status, 502, 'dns→502');
  ok(
    friendlyPgError(Object.assign(new Error('The server does not support SSL connections')), CONN).status === 502,
    'ssl hint→502'
  );
  const tmo = friendlyPgError(new Error('timeout expired'), CONN);
  eq(tmo.status, 502, 'timeout text→502');
  ok(/время ожидания/.test(tmo.message), 'friendly timeout message');
  eq(friendlyPgError(new Error('password authentication failed'), CONN).status, 401, 'auth text→401');

  console.log('6. POST /api/pg/schemas (fake DB)');
  {
    const fake = standardFake();
    const { srv, base } = await listen(createApp({ connect: fake.connect }));
    try {
      const { status, data } = await post(base, '/api/pg/schemas', CONN);
      eq(status, 200, 'schemas 200');
      eq(data.schemas.length, 2, 'two schemas');
      eq(data.schemas[0].schema, 'public', 'first = public');
      ok(data.schemas[0].ok && data.schemas[0].rows === 120, 'public ok with row count');
      ok(!data.schemas[1].ok && /столбцы/.test(data.schemas[1].error), 'public_1 flagged with column error');
      eq(fake.lastConn, { ...CONN }, 'conn passed through');
      ok(fake.calls.some(c => c.text.includes('information_schema.tables')), 'discovery SQL issued');
      ok(
        fake.calls.some(c => c.text.includes('"public"."optimizer_status"')),
        'count uses quoted identifiers'
      );
      const bad = await post(base, '/api/pg/schemas', { host: '', port: 1, database: 'd', user: 'u' });
      eq(bad.status, 400, 'validation → 400 JSON');
      ok(bad.data && typeof bad.data.error === 'string', 'error payload');
    } finally {
      srv.close();
    }
  }

  console.log('7. POST /api/pg/schemas — ошибка авторизации → 401');
  {
    const fake = standardFake();
    fake.mode = 'auth';
    const { srv, base } = await listen(createApp({ connect: fake.connect }));
    try {
      const { status, data } = await post(base, '/api/pg/schemas', CONN);
      eq(status, 401, 'auth → 401');
      ok(/логин или пароль/.test(data.error), 'friendly auth message');
    } finally {
      srv.close();
    }
  }

  console.log('8. POST /api/pg/runs — прогоны + Start time');
  {
    const fake = standardFake();
    const { srv, base } = await listen(createApp({ connect: fake.connect }));
    try {
      const { status, data } = await post(base, '/api/pg/runs', { ...CONN, schemas: ['public'] });
      eq(status, 200, 'runs 200');
      eq(data.runs.length, 2, 'two runs');
      eq(data.runs[0].runid, '20', 'runids stringified');
      eq(data.runs[0].startTime, '2026-05-14 10:00:00', 'startTime joined');
      eq(data.runs[1].startTime, '', 'missing startTime → empty');
      eq(data.truncated, false, 'not truncated');
      const bad = await post(base, '/api/pg/runs', { ...CONN, schemas: [{ schema: 'public_1' }] });
      eq(bad.status, 400, 'broken columns → 400');
      ok(/public_1/.test(bad.data.error), 'schema in message');
    } finally {
      srv.close();
    }
  }

  console.log('9. POST /api/pg/load — нормализация + группировка по схемам');
  {
    const fake = standardFake();
    const { srv, base } = await listen(createApp({ connect: fake.connect }));
    try {
      const selection = [
        { schema: 'public', runid: '19', datasetid: '14', configid: '300' },
        { schema: 'public', runid: '20', datasetid: '14', configid: '300' }
      ];
      const { status, data } = await post(base, '/api/pg/load', { ...CONN, selection });
      eq(status, 200, 'load 200');
      eq(data.rows.length, 4, '2 rows per run');
      eq(data.runs, 2, 'runs echoed');
      eq(data.schemas, ['public'], 'schemas echoed');
      eq(data.truncated, false, 'not truncated');
      ok(
        data.rows.every(r => r.__schema === 'public' && 'Параметр' in r && 'Значение' in r),
        'rows normalized with __schema'
      );
      const loadCalls = fake.calls.filter(c => c.text.includes(' AS _r,'));
      eq(loadCalls.length, 1, 'one SQL per schema+table');
      ok(loadCalls[0].text.includes('($1,$2,$3),($4,$5,$6)'), 'tuple IN placeholders');
      eq(loadCalls[0].params, ['19', '14', '300', '20', '14', '300'], 'params in order');
      ok(/LIMIT \d+/.test(loadCalls[0].text), 'LIMIT present');
    } finally {
      srv.close();
    }
  }

  console.log('10. Лимит строк + health/defaults/404');
  {
    const fake = makeFake(() => ({ rows: [] }));
    // подменяем impl для load: возвращаем больше лимита
    const big = makeFake((text, params) => {
      if (text.includes('information_schema.columns')) return { rows: COLS_EN.map(c => ({ c })) };
      const rows = [];
      for (let i = 0; i < 10; i++) rows.push({ _r: '1', _p: 'p' + i, _v: 'v', _d: '1', _c: '1' });
      return { rows };
    });
    const { MAX_ROWS } = require('../server.js');
    ok(Number.isInteger(MAX_ROWS) && MAX_ROWS > 1000, 'MAX_ROWS sane (' + MAX_ROWS + ')');
    const { srv, base } = await listen(createApp({ connect: big.connect }));
    try {
      const h = await (await fetch(base + '/api/health')).json();
      ok(h.ok === true, 'health ok');
      const d = await (await fetch(base + '/api/pg/defaults')).json();
      eq(d, PG_DEFAULTS, 'defaults match server constants');
      const idx = await fetch(base + '/');
      eq(idx.status, 200, '/ serves dashboard');
      const html = await idx.text();
      ok(html.includes('SNP Optimizer Insight') && html.includes('id="bPg"'), 'index.html has PG button');
      const nf = await fetch(base + '/nope');
      eq(nf.status, 404, 'unknown path → 404');
    } finally {
      srv.close();
    }
    void fake;
  }

  console.log('11. Live: реальный коннект к закрытому порту → 502 JSON');
  {
    const { srv, base } = await listen(createApp());
    try {
      const t0 = Date.now();
      const { status, data } = await post(base, '/api/pg/schemas', {
        host: '127.0.0.1', port: 1, database: 'd', user: 'u', password: 'p', ssl: 'off'
      });
      eq(status, 502, 'refused → 502');
      ok(/соединения/.test(data.error), 'friendly refused message: ' + data.error);
      ok(Date.now() - t0 < 20000, 'fails fast');
    } finally {
      srv.close();
    }
  }

  console.log('12. CORS — preflight 204 и заголовки на ответах');
  {
    const { srv, base } = await listen(createApp({ connect: makeFake(() => ({ rows: [] })).connect }));
    try {
      const pre = await fetch(base + '/api/pg/schemas', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5500',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type'
        }
      });
      eq(pre.status, 204, 'preflight OPTIONS → 204');
      eq(pre.headers.get('access-control-allow-origin'), '*', 'Access-Control-Allow-Origin: *');
      ok(/POST/i.test(pre.headers.get('access-control-allow-methods') || ''), 'allow-methods включает POST');
      ok(/content-type/i.test(pre.headers.get('access-control-allow-headers') || ''), 'allow-headers включает Content-Type');
      const h = await fetch(base + '/api/health', { headers: { Origin: 'http://localhost:5500' } });
      eq(h.headers.get('access-control-allow-origin'), '*', 'GET /api/health — CORS-заголовок');
      const d = await fetch(base + '/api/pg/defaults', { headers: { Origin: 'null' } });
      eq(d.headers.get('access-control-allow-origin'), '*', 'GET /api/pg/defaults — CORS-заголовок (Origin: null, т.е. file://)');
    } finally {
      srv.close();
    }
  }

  console.log('\n' + '─'.repeat(40));
  console.log(`Result: ${passed} passed`);
})().catch(e => {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
});
