'use strict';
/**
 * SNP Optimizer Insight — backend.
 *
 * 1. Отдаёт дашборд (index.html) — браузер не умеет открывать TCP к Postgres,
 *    поэтому нужен этот прокси.
 * 2. Проксирует запросы к PostgreSQL:
 *    POST /api/pg/schemas — схемы, в которых есть таблица optimizer_status
 *    POST /api/pg/runs    — список прогонов в выбранных схемах
 *    POST /api/pg/load    — строки optimizer_status выбранных прогонов
 *    GET  /api/health     — проверка, что backend жив
 *    GET  /api/pg/defaults — хост/порт/база по умолчанию для формы подключения
 *
 * Логин/пароль приходят в теле каждого запроса и нигде не сохраняются и не
 * логируются. Для тестов DB-слой инжектится: createApp({connect}).
 *
 * Запуск: npm start (PORT=3000, HOST=0.0.0.0 по умолчанию)
 */

const path = require('path');
const express = require('express');
const { Client } = require('pg');

const PG_DEFAULTS = {
  host: 'db-postgresql-app.k8s.b1gahmn2gdjf3lsm4jeh.in-plan.ru',
  port: 48235,
  database: 'pgs_app_data_db'
};
const TABLE_NAME = 'optimizer_status';
const MAX_ROWS = 300000; // жёсткий лимит строк в одном ответе /api/pg/load
const MAX_SCHEMAS = 64;
const MAX_RUNS = 2000;
const MAX_SELECTION = 2000;
const CHUNK = 500; // прогонов в одном SQL-запросе (по 3 параметра на прогон)
const SAMPLE_ROWS = 5; // строк-образцов для ручного мэппинга столбцов

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ── Идентификаторы: только квотирование, никаких конкатенаций «как есть» ── */
function qi(ident) {
  if (typeof ident !== 'string' || !ident) throw new HttpError(400, 'Пустое имя схемы/таблицы/столбца.');
  if (ident.length > 128) throw new HttpError(400, 'Слишком длинное имя схемы/таблицы/столбца.');
  return '"' + ident.replace(/"/g, '""') + '"';
}

/* ── Валидация входа ── */
function asStr(v, field) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  if (s.length > 512) throw new HttpError(400, `Поле «${field}» слишком длинное.`);
  return s;
}
function reqStr(v, field) {
  const s = asStr(v, field).trim();
  if (!s) throw new HttpError(400, `Заполните поле «${field}».`);
  return s;
}
function normalizeConn(body) {
  const b = body || {};
  const host = reqStr(b.host, 'Хост');
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, 'Порт должен быть целым числом от 1 до 65535.');
  }
  const database = reqStr(b.database, 'База данных');
  const user = reqStr(b.user, 'Логин');
  const password = b.password === undefined || b.password === null ? '' : String(b.password);
  const ssl = b.ssl === undefined || b.ssl === null || b.ssl === '' ? 'auto' : String(b.ssl);
  if (!['auto', 'off', 'insecure', 'strict'].includes(ssl)) {
    throw new HttpError(400, 'Некорректный режим SSL.');
  }
  return { host, port, database, user, password, ssl };
}
function normalizeSchemas(v) {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, 'Выберите хотя бы одну схему.');
  if (v.length > MAX_SCHEMAS) throw new HttpError(400, `Слишком много схем (максимум ${MAX_SCHEMAS}).`);
  return v.map((s, i) => {
    const o = typeof s === 'string' ? { schema: s } : (s || {});
    const schema = reqStr(o.schema, `Схема #${i + 1}`);
    const table = o.table === undefined || o.table === null || o.table === ''
      ? TABLE_NAME
      : reqStr(o.table, `Таблица #${i + 1}`);
    return { schema, table };
  });
}
function normalizeSelection(v) {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, 'Выберите хотя бы один прогон.');
  if (v.length > MAX_SELECTION) throw new HttpError(400, `Слишком много прогонов (максимум ${MAX_SELECTION}).`);
  return v.map((s, i) => {
    const o = s || {};
    return {
      schema: reqStr(o.schema, `Схема (прогон #${i + 1})`),
      table: o.table === undefined || o.table === null || o.table === ''
        ? TABLE_NAME
        : reqStr(o.table, `Таблица (прогон #${i + 1})`),
      runid: reqStr(o.runid, `runid (прогон #${i + 1})`),
      datasetid: asStr(o.datasetid, 'datasetid'),
      configid: asStr(o.configid, 'configid')
    };
  });
}

/* ── Мэппинг столбцов ─────────────────────────────────────────────────────
   Таблица optimizer_status в разных базах называет столбцы по-разному
   (русские/английские имена, свой регистр, иногда совсем другие названия —
   например status/message вместо Параметр/Значение). Поэтому:
     1. пробуем угадать соответствие по списку кандидатов (suggestColumns);
     2. пользователь может задать своё соответствие в модалке — оно приходит
        в теле запроса как `columns` и имеет приоритет над догадкой.
   Обязательны только run/param/value; datasetid/configid необязательны
   (если их нет, прогон определяется одним runid).                        */
/* status (имя параметра) и message (его значение) — реальный вид таблицы
   optimizer_status в «боевой» базе (см. REVIEW.md). Они идут ПОСЛЕДНИМИ в
   списках: если есть нормальные названия (Параметр/parameter/Значение/value),
   они важнее — запасные срабатывают только когда больше нечего взять. */
const COL_CANDIDATES = {
  run: ['runid', 'run_id', 'run', 'id_run', 'прогон'],
  param: ['параметр', 'parameter', 'param', 'metric', 'показатель', 'attribute', 'атрибут', 'status'],
  value: ['значение', 'value', 'val', 'значения', 'message'],
  ds: ['datasetid', 'dataset_id', 'dataset', 'датасет'],
  cfg: ['configid', 'config_id', 'config', 'конфиг']
};
const COL_KEYS = Object.keys(COL_CANDIDATES);
const COL_REQUIRED = ['run', 'param', 'value'];
const COL_LABELS = {
  run: 'runid',
  param: 'Параметр/parameter',
  value: 'Значение/value',
  ds: 'datasetid',
  cfg: 'configid'
};
/** Карта «нижний регистр → исходное имя столбца». */
function colIndex(columnNames) {
  const lower = new Map();
  for (const c of columnNames || []) {
    const k = String(c).toLowerCase();
    if (!lower.has(k)) lower.set(k, c);
  }
  return lower;
}
/**
 * Догадка о соответствии столбцов — ничего не бросает.
 * @returns {{mapped:Object, missing:string[]}} missing — ключи (run/param/…),
 *   которые не удалось определить (только обязательные учитываются как проблема).
 */
function suggestColumns(columnNames) {
  const lower = colIndex(columnNames);
  const mapped = {};
  const missing = [];
  for (const key of COL_KEYS) {
    const hit = COL_CANDIDATES[key].map(c => lower.get(c)).find(Boolean);
    if (hit) mapped[key] = hit;
    else {
      mapped[key] = null;
      if (COL_REQUIRED.includes(key)) missing.push(key);
    }
  }
  return { mapped, missing };
}
/**
 * Пользовательский мэппинг из тела запроса: {run,param,value,ds,cfg}.
 * Ключ отсутствует → подбирается автоматически; ключ есть, но пустой →
 * столбца в таблице нет (осмысленно только для необязательных ds/cfg).
 */
function normalizeColumns(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new HttpError(400, `Поле «${field || 'columns'}» должно быть объектом соответствия столбцов.`);
  }
  const out = {};
  let any = false;
  for (const key of COL_KEYS) {
    if (!(key in v) || v[key] === undefined || v[key] === null) continue;
    out[key] = asStr(v[key], `columns.${key}`).trim();
    if (out[key]) any = true;
  }
  // объект без единого непустого значения = мэппинг не задан
  return any ? out : null;
}
/**
 * Итоговое соответствие столбцов для конкретной таблицы.
 * @param columnNames реальные столбцы таблицы
 * @param where       префикс для текста ошибки («Схема «public_1841»»)
 * @param override    пользовательский мэппинг (приоритетнее автоподбора)
 */
function mapColumns(columnNames, where, override) {
  const lower = colIndex(columnNames);
  const auto = suggestColumns(columnNames).mapped;
  const prefix = where ? where + ': ' : '';
  const found = (columnNames && columnNames.length) ? columnNames.join(', ') : '—';
  const out = {};
  const missing = [];
  const unknown = [];
  for (const key of COL_KEYS) {
    const given = override && key in override;
    const want = given ? String(override[key] || '') : '';
    if (want) {
      const hit = lower.get(want.toLowerCase());
      if (hit) out[key] = hit;
      else unknown.push(`${COL_LABELS[key]} → «${want}»`);
      continue;
    }
    // Пустое значение при явно переданном ключе = столбца нет (только ds/cfg)
    if (given && !COL_REQUIRED.includes(key)) {
      out[key] = null;
      continue;
    }
    if (auto[key]) out[key] = auto[key];
    else {
      out[key] = null;
      if (COL_REQUIRED.includes(key)) missing.push(COL_LABELS[key]);
    }
  }
  if (unknown.length) {
    throw new HttpError(
      400,
      `${prefix}в таблице нет столбцов, указанных в мэппинге: ${unknown.join(', ')}. Есть: ${found}.`
    );
  }
  if (missing.length) {
    throw new HttpError(
      400,
      `${prefix}не удалось определить столбцы: ${missing.join(', ')}. Найдены: ${found}. ` +
      'Задайте соответствие вручную в блоке «Мэппинг столбцов».'
    );
  }
  return out;
}

/* ── Нормализация строк к виду, который понимает parseOptimizerRows ── */
function cell(v) {
  return v === null || v === undefined ? '' : String(v);
}
/** dbRow — строка с алиасами _r/_p/_v/_d/_c (см. SQL ниже). */
function normalizeRow(dbRow, schema) {
  return {
    runid: cell(dbRow._r),
    'Параметр': cell(dbRow._p),
    'Значение': cell(dbRow._v),
    datasetid: cell(dbRow._d),
    configid: cell(dbRow._c),
    __schema: schema
  };
}

/* ── Подключение через node-pg ── */
function sslConfig(mode) {
  if (mode === 'off') return false;
  if (mode === 'strict') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false }; // insecure
}
function isSslError(err) {
  if (!err) return false;
  if (['28P01', '28P04', '28000', '3D000'].includes(err.code)) return false;
  return /ssl/i.test(err.message || '');
}
async function defaultConnect(conn) {
  const base = {
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    connectionTimeoutMillis: 15000,
    statement_timeout: 180000,
    application_name: 'snp-optimizer-insight'
  };
  const open = async mode => {
    const client = new Client({ ...base, ssl: sslConfig(mode) });
    await client.connect();
    return client;
  };
  let client;
  if (conn.ssl && conn.ssl !== 'auto') {
    client = await open(conn.ssl);
  } else {
    try {
      client = await open('insecure');
    } catch (e) {
      if (isSslError(e)) client = await open('off');
      else throw e;
    }
  }
  return {
    query: (text, params) => client.query(text, params),
    close: () => client.end().catch(() => {})
  };
}

/* ── Дружелюбные тексты ошибок ── */
function friendlyPgError(err, conn) {
  if (err instanceof HttpError) return err;
  const code = err && err.code;
  const where = conn && conn.host ? ` (${conn.host}:${conn.port || ''})` : '';
  if (code === '28P01' || code === '28P04' || code === '28000') {
    // Называем логин: так сразу видно, если в поле подставились не те данные
    // (например, менеджер паролей браузера — у него для каждого сайта свои).
    const who = conn && conn.user ? ` пользователя «${conn.user}»` : '';
    return new HttpError(401, `Неверный логин или пароль — Postgres отклонил аутентификацию${who}.`);
  }
  if (code === '3D000') {
    return new HttpError(400, `База данных «${conn && conn.database}» не существует или недоступна.`);
  }
  if (code === '42P01') return new HttpError(400, 'Таблица optimizer_status не найдена (или нет прав на неё).');
  if (code === '42501' || code === '42000') {
    return new HttpError(403, 'Недостаточно прав: пользователь не видит нужные схемы/таблицы.');
  }
  if (code === 'ENOTFOUND') return new HttpError(502, `Хост «${conn && conn.host}» не найден (DNS).`);
  if (code === 'ECONNREFUSED') {
    return new HttpError(502, `Нет соединения с ${conn && conn.host}:${conn && conn.port} — проверьте хост и порт${where ? '' : ''}.`);
  }
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EAI_AGAIN') {
    return new HttpError(502, `Превышено время ожидания соединения${where}. Проверьте хост, порт и доступность сети.`);
  }
  if (isSslError(err)) {
    return new HttpError(502, 'Ошибка SSL при подключении. Попробуйте другой режим SSL в форме подключения.');
  }
  // Запасные эвристики по тексту (у части сетевых ошибок pg нет code)
  const raw = String((err && err.message) || '');
  if (/timeout expired|timed out/i.test(raw)) {
    return new HttpError(502, `Превышено время ожидания соединения${where}. Проверьте хост, порт и доступность сети.`);
  }
  if (/connection terminated|connection reset|econnreset/i.test(raw)) {
    return new HttpError(502, `Соединение с сервером${where} разорвано. Проверьте хост/порт и режим SSL.`);
  }
  if (/password authentication failed/i.test(raw)) {
    const who = conn && conn.user ? ` пользователя «${conn.user}»` : '';
    return new HttpError(401, `Неверный логин или пароль — Postgres отклонил аутентификацию${who}.`);
  }
  if (/database .* does not exist/i.test(raw)) {
    return new HttpError(400, `База данных «${conn && conn.database}» не существует или недоступна.`);
  }
  const msg = raw.slice(0, 400);
  return new HttpError(500, `Postgres: ${msg || 'неизвестная ошибка'}`);
}

async function listColumns(db, spec) {
  let res;
  try {
    res = await db.query(
      'SELECT column_name AS c FROM information_schema.columns ' +
      'WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',
      [spec.schema, spec.table]
    );
  } catch (e) {
    throw friendlyPgError(e, null);
  }
  const names = (res.rows || []).map(r => String(r.c));
  if (!names.length) {
    throw new HttpError(
      400,
      `Схема «${spec.schema}»: таблица «${spec.table}» не найдена или нет доступа.`
    );
  }
  return names;
}
/** Столбцы таблицы + итоговый мэппинг (с учётом пользовательского override). */
async function discoverColumns(db, spec, override) {
  const names = await listColumns(db, spec);
  return { names, mapped: mapColumns(names, `Схема «${spec.schema}»`, override) };
}

/* ── Приложение ── */
function createApp(deps) {
  const connect = (deps && deps.connect) || defaultConnect;
  const app = express();
  /* CORS: дашборд может обращаться к backend с чужого origins (file://, Live
     Server, другой хостинг), поэтому разрешаем произвольный Origin. Куки/
     auth не используются (пароль — в теле запроса), так что «*» безопасно.
     Без этого статический сервер отдаёт 405 на POST, а браузер блокирует
     чужой ответ — пользователь видит «Ошибка сервера: 405». */
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.get('/api/pg/defaults', (req, res) => res.json({ ...PG_DEFAULTS }));

  /** Схемы, в которых есть таблица optimizer_status. */
  app.post('/api/pg/schemas', async (req, res, next) => {
    try {
      const conn = normalizeConn(req.body || {});
      let db;
      try {
        db = await connect(conn);
      } catch (e) {
        throw friendlyPgError(e, conn);
      }
      try {
        let found;
        try {
          const t = await db.query(
            'SELECT table_schema AS s, table_name AS t FROM information_schema.tables ' +
            `WHERE LOWER(table_name)='${TABLE_NAME}' ` +
            `AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1`
          );
          found = (t.rows || []).map(r => ({ schema: String(r.s), table: String(r.t) }));
        } catch (e) {
          throw friendlyPgError(e, conn);
        }
        if (!found.length) {
          throw new HttpError(
            400,
            'Таблица optimizer_status не найдена ни в одной схеме. Проверьте базу данных и права пользователя.'
          );
        }
        /* Пользовательский мэппинг (если уже задан в модалке) применяется и
           здесь — схема считается доступной, если он к ней подходит. */
        const override = normalizeColumns((req.body || {}).columns, 'columns');
        const schemas = [];
        for (const f of found.slice(0, MAX_SCHEMAS)) {
          let columns = [];
          let rows = null;
          let error = null;
          let mapped = null;
          let needsMapping = false;
          try {
            columns = await listColumns(db, f);
            try {
              mapped = mapColumns(columns, `Схема «${f.schema}»`, override);
            } catch (e) {
              // Столбцы прочитаны, но соответствие не найдено — это чинится
              // мэппингом в UI, поэтому не считаем схему «сломанной наглухо».
              needsMapping = true;
              error = e instanceof HttpError ? e.message : friendlyPgError(e, conn).message;
              mapped = suggestColumns(columns).mapped;
            }
            const c = await db.query(`SELECT COUNT(*)::int AS n FROM ${qi(f.schema)}.${qi(f.table)}`);
            rows = c.rows && c.rows[0] ? c.rows[0].n : null;
          } catch (e) {
            error = e instanceof HttpError ? e.message : friendlyPgError(e, conn).message;
          }
          schemas.push({
            schema: f.schema,
            table: f.table,
            columns,
            rows,
            ok: !error,
            error,
            needsMapping,
            mapped
          });
        }
        res.json({ schemas, columnKeys: COL_KEYS, requiredColumnKeys: COL_REQUIRED, columnLabels: COL_LABELS });
      } finally {
        await db.close();
      }
    } catch (e) {
      next(e);
    }
  });

  /** Прогоны (runid/datasetid/configid) в выбранных схемах. */
  app.post('/api/pg/runs', async (req, res, next) => {
    try {
      const conn = normalizeConn(req.body || {});
      const specs = normalizeSchemas((req.body || {}).schemas);
      const override = normalizeColumns((req.body || {}).columns, 'columns');
      let db;
      try {
        db = await connect(conn);
      } catch (e) {
        throw friendlyPgError(e, conn);
      }
      try {
        const runs = [];
        let truncated = false;
        for (const spec of specs) {
          const { mapped } = await discoverColumns(db, spec, override);
          const from = `${qi(spec.schema)}.${qi(spec.table)}`;
          const R = qi(mapped.run);
          // datasetid/configid необязательны: если столбца нет — подставляем ''
          const D = mapped.ds ? qi(mapped.ds) : "''::text";
          const C = mapped.cfg ? qi(mapped.cfg) : "''::text";
          // группируем только по реальным столбцам (константы в GROUP BY нельзя)
          const grp = ['1'].concat(mapped.ds ? ['2'] : [], mapped.cfg ? ['3'] : []).join(',');
          let groups, starts;
          try {
            groups = await db.query(
              `SELECT ${R} AS r, ${D} AS d, ${C} AS c, COUNT(*)::int AS n FROM ${from} ` +
              `WHERE ${R} IS NOT NULL GROUP BY ${grp} ORDER BY 1 DESC LIMIT 1001`
            );
            starts = await db.query(
              `SELECT ${R} AS r, ${D} AS d, ${C} AS c, MAX(${qi(mapped.value)}) AS s FROM ${from} ` +
              `WHERE ${qi(mapped.param)}='Start time' GROUP BY ${grp}`
            );
          } catch (e) {
            throw friendlyPgError(e, conn);
          }
          const stMap = new Map(
            (starts.rows || []).map(x => [`${cell(x.r)}|${cell(x.d)}|${cell(x.c)}`, cell(x.s)])
          );
          for (const g of (groups.rows || []).slice(0, 1000)) {
            if (runs.length >= MAX_RUNS) {
              truncated = true;
              break;
            }
            const runid = cell(g.r), ds = cell(g.d), cfg = cell(g.c);
            runs.push({
              schema: spec.schema,
              table: spec.table,
              runid,
              datasetid: ds,
              configid: cfg,
              rows: g.n,
              startTime: stMap.get(`${runid}|${ds}|${cfg}`) || ''
            });
          }
          if ((groups.rows || []).length > 1000) truncated = true;
          if (runs.length >= MAX_RUNS) {
            truncated = true;
            break;
          }
        }
        res.json({ runs, truncated });
      } finally {
        await db.close();
      }
    } catch (e) {
      next(e);
    }
  });

  /** Строки optimizer_status выбранных прогонов, нормализованные для дашборда. */
  app.post('/api/pg/load', async (req, res, next) => {
    try {
      const conn = normalizeConn(req.body || {});
      const selection = normalizeSelection((req.body || {}).selection);
      const override = normalizeColumns((req.body || {}).columns, 'columns');
      let db;
      try {
        db = await connect(conn);
      } catch (e) {
        throw friendlyPgError(e, conn);
      }
      try {
        const byTable = new Map();
        for (const it of selection) {
          const k = `${it.schema}||${it.table}`;
          if (!byTable.has(k)) byTable.set(k, { spec: { schema: it.schema, table: it.table }, items: [] });
          byTable.get(k).items.push(it);
        }
        const rows = [];
        let truncated = false;
        for (const { spec, items } of byTable.values()) {
          const { mapped } = await discoverColumns(db, spec, override);
          const from = `${qi(spec.schema)}.${qi(spec.table)}`;
          const R = qi(mapped.run);
          const D = mapped.ds ? qi(mapped.ds) : "''::text";
          const C = mapped.cfg ? qi(mapped.cfg) : "''::text";
          // ключ прогона = только те столбцы, что реально есть в таблице
          const keyCols = [R].concat(mapped.ds ? [qi(mapped.ds)] : [], mapped.cfg ? [qi(mapped.cfg)] : []);
          const arity = keyCols.length;
          for (let i = 0; i < items.length && !truncated; i += CHUNK) {
            const chunk = items.slice(i, i + CHUNK);
            const vals = [];
            const conds = chunk.map((it, j) => {
              const parts = [it.runid].concat(mapped.ds ? [it.datasetid] : [], mapped.cfg ? [it.configid] : []);
              vals.push(...parts);
              const o = j * arity;
              return '(' + parts.map((_, k) => `$${o + k + 1}`).join(',') + ')';
            }).join(',');
            const remaining = MAX_ROWS + 1 - rows.length;
            let q;
            try {
              q = await db.query(
                `SELECT ${R} AS _r, ${qi(mapped.param)} AS _p, ${qi(mapped.value)} AS _v, ` +
                `${D} AS _d, ${C} AS _c FROM ${from} ` +
                `WHERE (${keyCols.join(',')}) IN (${conds}) LIMIT ${remaining}`,
                vals
              );
            } catch (e) {
              throw friendlyPgError(e, conn);
            }
            for (const r of (q.rows || [])) {
              if (rows.length > MAX_ROWS) {
                truncated = true;
                break;
              }
              rows.push(normalizeRow(r, spec.schema));
            }
            if (rows.length > MAX_ROWS) truncated = true;
          }
          if (truncated) break;
        }
        res.json({
          rows: rows.slice(0, MAX_ROWS),
          truncated,
          runs: selection.length,
          schemas: [...new Set(selection.map(s => s.schema))]
        });
      } finally {
        await db.close();
      }
    } catch (e) {
      next(e);
    }
  });

  /** Столбцы схемы + образцы значений — для ручного мэппинга в модалке. */
  app.post('/api/pg/columns', async (req, res, next) => {
    try {
      const conn = normalizeConn(req.body || {});
      const specs = normalizeSchemas((req.body || {}).schemas);
      const spec = specs[0];
      let db;
      try {
        db = await connect(conn);
      } catch (e) {
        throw friendlyPgError(e, conn);
      }
      try {
        const names = await listColumns(db, spec);
        const { mapped, missing } = suggestColumns(names);
        let sample = [];
        try {
          const s = await db.query(
            `SELECT * FROM ${qi(spec.schema)}.${qi(spec.table)} LIMIT ${SAMPLE_ROWS}`
          );
          sample = (s.rows || []).map(r => {
            const o = {};
            for (const n of names) o[n] = cell(r[n]).slice(0, 200);
            return o;
          });
        } catch (e) { /* образцы необязательны (например, нет прав на SELECT) */ }
        res.json({
          schema: spec.schema,
          table: spec.table,
          columns: names,
          suggested: mapped,
          missing,
          sample,
          columnKeys: COL_KEYS,
          requiredColumnKeys: COL_REQUIRED,
          columnLabels: COL_LABELS
        });
      } finally {
        await db.close();
      }
    } catch (e) {
      next(e);
    }
  });

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = (err && err.status) || 500;
    res.status(status).json({ error: (err && err.message) || 'Internal error' });
  });

  return app;
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  createApp().listen(PORT, HOST, () => {
    console.log(`SNP Optimizer Insight → http://${HOST}:${PORT}`);
    console.log(`Postgres по умолчанию: ${PG_DEFAULTS.host}:${PG_DEFAULTS.port} / ${PG_DEFAULTS.database}`);
  });
}

module.exports = {
  createApp,
  defaultConnect,
  normalizeConn,
  normalizeSchemas,
  normalizeSelection,
  normalizeColumns,
  suggestColumns,
  mapColumns,
  COL_CANDIDATES,
  COL_KEYS,
  COL_REQUIRED,
  COL_LABELS,
  normalizeRow,
  cell,
  qi,
  friendlyPgError,
  HttpError,
  PG_DEFAULTS,
  TABLE_NAME,
  MAX_ROWS
};
