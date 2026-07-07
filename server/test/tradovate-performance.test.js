const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseMoney, detectFormat, normalizeTradovatePerformance, importCSV } = require('../csv-import');

test('parseMoney parses positive dollars', () => {
  assert.equal(parseMoney('$294.00'), 294);
});

test('parseMoney parses parenthesized negatives', () => {
  assert.equal(parseMoney('$(205.00)'), -205);
});

test('parseMoney strips thousands commas', () => {
  assert.equal(parseMoney('$(1,150.00)'), -1150);
});

test('parseMoney handles zero and empty', () => {
  assert.equal(parseMoney('$0.00'), 0);
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney(undefined), 0);
});

test('detectFormat recognizes Tradovate Performance headers', () => {
  const headers = ['Symbol','Qty','Buy Price','Buy Time','Duration','Sell Time','Sell Price','P&L'];
  assert.equal(detectFormat(headers), 'tradovate-performance');
});

test('detectFormat still recognizes generic entry/exit trades', () => {
  const headers = ['Symbol','Entry Price','Exit Price'];
  assert.equal(detectFormat(headers), 'generic-trades');
});

test('detectFormat prefers tradovate-performance over generic when both could match', () => {
  const headers = ['Symbol','Qty','Buy Price','Buy Time','Sell Time','Sell Price','P&L','Entry Price','Exit Price'];
  assert.equal(detectFormat(headers), 'tradovate-performance');
});

// Covered short: Sell Time (08:55:06) is BEFORE Buy Time (09:03:11), P&L negative.
// Long: Buy Time before Sell Time, P&L positive.
// Breakeven: equal price, $0.00.
const PERF_OBJS = [
  { Symbol:'MNQU6', Qty:'10', 'Buy Price':'30301.50', 'Buy Time':'07/01/2026 09:03:11',
    Duration:'8min 5sec', 'Sell Time':'07/01/2026 08:55:06', 'Sell Price':'30244.00', 'P&L':'$(1,150.00)' },
  { Symbol:'MNQU6', Qty:'5', 'Buy Price':'30196.75', 'Buy Time':'07/01/2026 21:58:42',
    Duration:'5min 55sec', 'Sell Time':'07/01/2026 22:04:37', 'Sell Price':'30211.25', 'P&L':'$145.00' },
  { Symbol:'MNQU6', Qty:'1', 'Buy Price':'29707.25', 'Buy Time':'07/02/2026 22:18:19',
    Duration:'', 'Sell Time':'07/02/2026 22:18:19', 'Sell Price':'29707.25', 'P&L':'$0.00' },
];

test('normalize produces one account under the connection', () => {
  const r = normalizeTradovatePerformance(PERF_OBJS, 'conn1');
  assert.equal(r.accounts.length, 1);
  assert.equal(r.accounts[0].id, 'conn1-perf');
  assert.equal(r.accounts[0].account_type, 'tradovate-performance');
  assert.equal(r.fills.length, 0);
  assert.equal(r.trades.length, 3);
});

test('normalize trusts file P&L verbatim, including covered-short sign', () => {
  const r = normalizeTradovatePerformance(PERF_OBJS, 'conn1');
  const short = r.trades[0];
  assert.equal(short.net_pnl, -1150);   // taken from file, NOT recomputed
  assert.equal(short.pnl, -1150);
  assert.equal(short.commission, 0);
  const long = r.trades[1];
  assert.equal(long.net_pnl, 145);
});

test('normalize infers entry/exit times and side from timestamp order', () => {
  const r = normalizeTradovatePerformance(PERF_OBJS, 'conn1');
  const short = r.trades[0];
  assert.ok(short.entry_time <= short.exit_time);           // min/max applied
  assert.equal(short.side, 'short');                        // sell before buy
  assert.equal(short.entry_price, 30244.00);                // sell leg is entry
  assert.equal(short.exit_price, 30301.50);
  const long = r.trades[1];
  assert.equal(long.side, 'long');                          // buy before sell
  assert.equal(long.entry_price, 30196.75);
});

test('normalize keeps breakeven rows with zero duration', () => {
  const r = normalizeTradovatePerformance(PERF_OBJS, 'conn1');
  const be = r.trades[2];
  assert.equal(be.net_pnl, 0);
  assert.equal(be.duration_sec, 0);
});

test('account realized_pnl sums the file net P&L', () => {
  const r = normalizeTradovatePerformance(PERF_OBJS, 'conn1');
  assert.equal(r.accounts[0].realized_pnl, -1150 + 145 + 0);
});

const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'tradovate-performance-sample.csv'), 'utf8');

test('importCSV routes Performance CSV to the right normalizer', () => {
  const r = importCSV(FIXTURE, 'connX');
  assert.equal(r.accounts[0].account_type, 'tradovate-performance');
  assert.equal(r.trades.length, 5);
});

test('same-second same-price micro rows get distinct IDs (no collapse)', () => {
  const r = importCSV(FIXTURE, 'connX');
  const ids = new Set(r.trades.map(t => t.id));
  assert.equal(ids.size, 5); // the two 18:25:25 rows differ by price+pnl
});

test('re-importing the same file is idempotent by trade ID', () => {
  const a = importCSV(FIXTURE, 'connX');
  const b = importCSV(FIXTURE, 'connX');
  const idsA = a.trades.map(t => t.id).sort();
  const idsB = b.trades.map(t => t.id).sort();
  assert.deepEqual(idsA, idsB); // identical IDs → DB upsert dedupes
});

test('trades split across the correct calendar days', () => {
  const r = importCSV(FIXTURE, 'connX');
  const dayOf = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const byDay = {};
  for (const t of r.trades) {
    const k = dayOf(t.entry_time);
    byDay[k] = (byDay[k] || 0) + 1;
  }
  const days = Object.keys(byDay).sort();
  assert.deepEqual(days, ['2026-07-01', '2026-07-02']);
  assert.equal(byDay['2026-07-01'], 2);
  assert.equal(byDay['2026-07-02'], 3);
});
