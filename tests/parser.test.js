/**
 * Parser unit tests for SNP Optimizer Insight
 * Run: node tests/parser.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) {
  console.error('No script in index.html');
  process.exit(1);
}

const noop = () => {};
const store = {};

const sandbox = {
  console,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  document: {
    documentElement: { setAttribute: noop, getAttribute: () => null },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({
      style: {},
      classList: { add: noop, remove: noop, toggle: noop },
      setAttribute: noop,
      getAttribute: () => null,
      removeAttribute: noop,
      appendChild: noop,
      remove: noop,
      focus: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      removeEventListener: noop
    }),
    body: { appendChild: noop, classList: { add: noop, remove: noop } },
    addEventListener: noop,
    removeEventListener: noop
  },
  innerWidth: 1200,
  innerHeight: 800,
  devicePixelRatio: 1,
  HTMLElement: function () {},
  Node: function () {},
  CSS: { escape: s => String(s).replace(/"/g, '\\"') },
  indexedDB: undefined,
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
  Blob: function () {},
  ResizeObserver: undefined,
  confirm: () => true,
  XLSX: undefined,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  setTimeout,
  clearTimeout,
  addEventListener: noop,
  removeEventListener: noop,
  Math,
  Date,
  JSON,
  Map,
  Set,
  Array,
  Object,
  String,
  Number,
  Boolean,
  parseFloat,
  parseInt,
  isFinite,
  Infinity,
  NaN,
  undefined,
  Promise,
  Error,
  TypeError,
  RegExp,
  encodeURIComponent,
  decodeURIComponent
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

// Keep pure logic; drop UI wiring that needs a real DOM
let src = m[1];
const cutAt = src.search(/\/\* ── Обработчики UI ── \*\//);
if (cutAt > 0) src = src.slice(0, cutAt);
src = src.replace(
  /\(async function boot\(\)\{[\s\S]*?\}\)\(\);/,
  '/* boot skipped in tests */'
);
// Also drop drag-and-drop / resize listeners that sit before handlers
const cutDrag = src.search(/\/\* ── Drag & drop ── \*\//);
if (cutDrag > 0) src = src.slice(0, cutDrag);
// Drop report/print boot block if still present after loadFiles
const cutReport = src.search(/\/\* ── HTML-отчёт и печать ── \*\//);
if (cutReport > 0) src = src.slice(0, cutReport);

// Expose pure symbols (const/let are not enumerable on the sandbox object)
src += `
;this.__TEST__ = {
  parseOptimizerRows,
  parseCalcTime,
  buildRun,
  SEED_ROWS,
  onFill,
  csvSep,
  setCsvSep,
  csvEscape,
  runKey,
  num,
  mkRow
};
`;

try {
  vm.runInNewContext(src, sandbox, { filename: 'index.html<script>', timeout: 5000 });
} catch (e) {
  console.error('Eval failed:', e.stack || e.message);
  process.exit(1);
}

const {
  parseOptimizerRows,
  parseCalcTime,
  SEED_ROWS,
  onFill,
  csvSep,
  setCsvSep,
  csvEscape,
  runKey,
  num
} = sandbox.__TEST__ || {};

if (typeof parseOptimizerRows !== 'function') {
  console.error('parseOptimizerRows not available via __TEST__ export.');
  process.exit(1);
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error('  ✗', msg);
  }
}
function assertEq(a, b, msg) {
  const ok =
    Object.is(a, b) ||
    (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);
  if (ok) passed++;
  else {
    failed++;
    console.error('  ✗', msg, '| got', a, 'expected', b);
  }
}

console.log('1. Demo seed parse');
{
  const runs = parseOptimizerRows(SEED_ROWS);
  assertEq(runs.length, 1, 'one run from seed');
  const r = runs[0];
  assertEq(r.runid, '19', 'runid');
  assertEq(r.datasetid, '14', 'datasetid');
  assertEq(r.configid, '300', 'configid');
  assertEq(r.entities.length, 5, 'entities=5');
  assertEq(r.bounds.length, 6, 'bounds=6');
  assert(r.penalties.length >= 1, 'penalties>=1');
  assertEq(r.solve.status, 'OPTIMAL', 'status OPTIMAL');
  assertEq(r.solve.gapPct, 0, 'gap 0');
  assert(Math.abs(r.solve.solveTimeSec - 1.120604) < 1e-6, 'solve time parse');
  assert(r.meta.cfgParsed, 'config JSON parsed');
  assertEq(r.meta.threads, 8, 'threads');
  assert(Math.abs(r.meta.gapLimit - 0.01) < 1e-9, 'gap_limit *100 = 0.01');

  const sale = r.entities.find(e => e.entity === 'sale');
  assert(sale, 'sale entity');
  assertEq(sale.nonzero, 167, 'sale nonzero');
  assertEq(sale.total, 210, 'sale total');
  assertEq(sale.pct, 79.52, 'sale pct');

  const stockB = r.bounds.find(
    b => b.entity === 'stock' && b.constraint === 'stock_capacity'
  );
  assert(stockB, 'stock_capacity bound');
  assertEq(stockB.lowerPct, 98.23, 'stock lower');
  assertEq(stockB.upperPct, 78.27, 'stock upper');
  assertEq(stockB.status, 'STRICT', 'stock STRICT');

  const pen = r.penalties.find(p => p.entity === 'production' && p.kind === 'min');
  assert(pen, 'softmin production');
  assertEq(pen.sum, 11866.14, 'penalty sum');
  assertEq(pen.nonzeroPct, 3.3, 'penalty nonzero pct');
}

console.log('2. English column names');
{
  const rows = [
    { RunId: 1, Parameter: 'Solution', Value: 'OPTIMAL', DatasetId: 2, ConfigId: 3 },
    { RunId: 1, Parameter: 'Result gap %', Value: '0.5', DatasetId: 2, ConfigId: 3 },
    {
      RunId: 1,
      Parameter: 'Non-zero values of sale variables',
      Value: '10 / 20',
      DatasetId: 2,
      ConfigId: 3
    },
    {
      RunId: 1,
      Parameter: 'Non-zero values of sale variables %',
      Value: '50',
      DatasetId: 2,
      ConfigId: 3
    },
    {
      RunId: 1,
      Parameter: 'Lower bound reached stock:wh_capacity (STRICT) %',
      Value: '12.5',
      DatasetId: 2,
      ConfigId: 3
    },
    {
      RunId: 1,
      Parameter: 'Upper bound reached stock:wh_capacity (STRICT) %',
      Value: '40',
      DatasetId: 2,
      ConfigId: 3
    },
    {
      RunId: 1,
      Parameter: 'Softmax penalties sum sale:demand_cons (SOFT)',
      Value: '100',
      DatasetId: 2,
      ConfigId: 3
    },
    {
      RunId: 1,
      Parameter: 'Softmax penalties non-zerosale:demand_cons (SOFT) %',
      Value: '5',
      DatasetId: 2,
      ConfigId: 3
    }
  ];
  const runs = parseOptimizerRows(rows);
  assertEq(runs.length, 1, 'en cols one run');
  assertEq(runs[0].solve.status, 'OPTIMAL', 'en status');
  assertEq(runs[0].solve.gapPct, 0.5, 'en gap');
  assertEq(runs[0].entities.length, 1, 'en entities');
  assertEq(runs[0].bounds.length, 1, 'en bounds');
  assertEq(runs[0].bounds[0].lowerPct, 12.5, 'en lower');
  assertEq(runs[0].bounds[0].upperPct, 40, 'en upper');
  assertEq(runs[0].penalties.length, 1, 'en pens');
  assertEq(runs[0].penalties[0].kind, 'max', 'softmax kind');
}

console.log('3. Multiple runs + grouping');
{
  const rows = [
    { runid: 1, Параметр: 'Solution', Значение: 'OPTIMAL', datasetid: 1, configid: 1 },
    { runid: 2, Параметр: 'Solution', Значение: 'FEASIBLE', datasetid: 1, configid: 1 },
    { runid: 1, Параметр: 'Result gap %', Значение: '0', datasetid: 1, configid: 1 },
    { runid: 2, Параметр: 'Result gap %', Значение: '1.2', datasetid: 1, configid: 1 }
  ];
  const runs = parseOptimizerRows(rows);
  assertEq(runs.length, 2, 'two runs');
  const byId = Object.fromEntries(runs.map(r => [r.runid, r]));
  assertEq(byId['1'].solve.status, 'OPTIMAL', 'run1');
  assertEq(byId['2'].solve.status, 'FEASIBLE', 'run2');
  assertEq(byId['2'].solve.gapPct, 1.2, 'run2 gap');
}

console.log('4. Entity with only % (no N/M) kept via pct>0');
{
  const rows = [
    { runid: 9, Параметр: 'Solution', Значение: 'OPTIMAL', datasetid: 1, configid: 1 },
    {
      runid: 9,
      Параметр: 'Non-zero values of movement variables %',
      Значение: '3.5',
      datasetid: 1,
      configid: 1
    }
  ];
  const runs = parseOptimizerRows(rows);
  assertEq(runs[0].entities.length, 1, 'pct-only entity kept');
  assertEq(runs[0].entities[0].pct, 3.5, 'pct value');
}

console.log('5. parseCalcTime');
{
  assertEq(parseCalcTime('0:00:01.5'), 1.5, 'hms');
  assertEq(parseCalcTime('1:02:03'), 3723, '1h2m3s');
  assertEq(parseCalcTime('12.5'), 12.5, 'plain float');
  assertEq(parseCalcTime(''), 0, 'empty');
}

console.log('6. Zero penalties filtered out');
{
  const rows = [
    { runid: 1, Параметр: 'Solution', Значение: 'OPTIMAL', datasetid: 1, configid: 1 },
    {
      runid: 1,
      Параметр: 'Softmin penalties sum production:aggregated_production (SOFT)',
      Значение: '0',
      datasetid: 1,
      configid: 1
    },
    {
      runid: 1,
      Параметр: 'Softmin penalties non-zeroproduction:aggregated_production (SOFT) %',
      Значение: '0',
      datasetid: 1,
      configid: 1
    }
  ];
  const runs = parseOptimizerRows(rows);
  assertEq(runs[0].penalties.length, 0, 'zero pens filtered');
}

console.log('7. Bounds regex — fixed vs broken');
{
  const key = 'Lower bound reached movement:movement_capacity (STRICT) %';
  const ok = /^Lower bound reached (\w+):(\w+) \(([A-Z]+)\) %$/.test(key);
  const broken = /^Lower bound reached (\w+):(\w+) $([A-Z]+)$ %$/.test(key);
  assert(ok, 'fixed regex matches');
  assert(!broken, 'broken regex does not match');
}

console.log('8. onFill blue channel');
{
  const hex = '#1ba84c';
  const b = parseInt(hex.slice(5, 7), 16);
  assertEq(b, 76, 'blue channel 76 not 132');
  const fill = onFill(hex);
  assert(fill === '#ffffff' || fill === '#15151c', 'onFill returns contrast color');
}

console.log('9. csvSep helpers');
{
  setCsvSep(';');
  assertEq(csvSep(), ';', 'sep ;');
  setCsvSep(',');
  assertEq(csvSep(), ',', 'sep ,');
  assertEq(csvEscape('a;b', ';'), '"a;b"', 'escape sep');
  assertEq(csvEscape('plain', ';'), 'plain', 'no escape');
}

console.log('10. runKey + num');
{
  assertEq(runKey({ runid: '1', datasetid: '2', configid: '3' }), '1|2|3', 'runKey');
  assertEq(num('1 234,5'), 1234.5, 'num with space and comma');
  assertEq(num(''), 0, 'num empty');
}

console.log('\n' + '─'.repeat(40));
console.log(`Result: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
