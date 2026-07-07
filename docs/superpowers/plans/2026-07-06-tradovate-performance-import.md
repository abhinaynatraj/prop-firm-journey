# Tradovate Performance Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a Tradovate Performance CSV export (one row per closed trade) into a chosen connection, trusting the file's signed P&L, so trades appear in the Journal and split by day in the Calendar automatically.

**Architecture:** Add one new format (`tradovate-performance`) to the existing `server/csv-import.js` detect→normalize pipeline. A new `normalizeTradovatePerformance()` produces the standard `{accounts, fills, trades}` shape; the existing `/api/connections/:id/import-csv` endpoint, DB writes, and `rebuildDailyStats` are reused unchanged. No new dependency, no schema change, no frontend change.

**Tech Stack:** Node.js (CommonJS), built-in `node:test` + `node:assert` runner (no test framework to install), existing better-sqlite3/express stack untouched.

## Global Constraints

- Language: CommonJS (`require`/`module.exports`), matching `server/csv-import.js`.
- No new npm dependencies. Tests use built-in `node:test` and `node:assert/strict`.
- Trade objects MUST match the exact field set produced by the existing normalizers in `server/csv-import.js` (see Task 1 interface block) so downstream DB/stats code is identical.
- P&L is taken verbatim from the file's `P&L` column — NEVER recomputed from prices.
- `entry_time = min(buyTime, sellTime)`, `exit_time = max(buyTime, sellTime)`.
- Deterministic trade IDs for idempotent re-import.
- All work happens in `server/`. Run commands from `server/`.

---

### Task 1: `parseMoney()` helper + failing test

**Files:**
- Modify: `server/csv-import.js` (add `parseMoney` near the other helpers, ~line 62; export it)
- Test: `server/test/tradovate-performance.test.js` (create)

**Interfaces:**
- Produces: `parseMoney(str: string) -> number`. Strips `$` and thousands commas; parentheses mean negative. `""`/null/undefined → `0`.

- [ ] **Step 1: Write the failing test**

Create `server/test/tradovate-performance.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMoney } = require('../csv-import');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tradovate-performance.test.js`
Expected: FAIL — `parseMoney is not a function` (it isn't exported/defined yet).

- [ ] **Step 3: Write minimal implementation**

In `server/csv-import.js`, add after the `parseTimestamp` function (~line 68):

```js
// Parses money strings from Tradovate exports:
//   "$294.00" -> 294 ; "$(205.00)" -> -205 ; "$(1,150.00)" -> -1150 ; "$0.00" -> 0
function parseMoney(s) {
  if (s === null || s === undefined) return 0;
  let str = String(s).trim();
  if (!str) return 0;
  const negative = /^\(.*\)$/.test(str) || str.includes('(');
  str = str.replace(/[$,()]/g, '').trim();
  const n = parseFloat(str);
  if (isNaN(n)) return 0;
  return negative ? -Math.abs(n) : n;
}
```

Add `parseMoney` to the `module.exports` object at the bottom of the file:

```js
module.exports = {
  importCSV,
  parseCSV,
  rowsToObjects,
  detectFormat,
  pairFillsIntoTrades,
  parseMoney,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tradovate-performance.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/csv-import.js server/test/tradovate-performance.test.js
git commit -m "feat: add parseMoney helper for Tradovate money strings"
```

---

### Task 2: Detect the `tradovate-performance` format

**Files:**
- Modify: `server/csv-import.js` — `detectFormat()` (~line 48-55)
- Test: `server/test/tradovate-performance.test.js` (append)

**Interfaces:**
- Consumes: `detectFormat(headers: string[]) -> string` (existing).
- Produces: `detectFormat` returns `'tradovate-performance'` for Performance headers.

- [ ] **Step 1: Write the failing test**

Append to `server/test/tradovate-performance.test.js`:

```js
const { detectFormat } = require('../csv-import');

test('detectFormat recognizes Tradovate Performance headers', () => {
  const headers = ['Symbol','Qty','Buy Price','Buy Time','Duration','Sell Time','Sell Price','P&L'];
  assert.equal(detectFormat(headers), 'tradovate-performance');
});

test('detectFormat still recognizes generic entry/exit trades', () => {
  const headers = ['Symbol','Entry Price','Exit Price'];
  assert.equal(detectFormat(headers), 'generic-trades');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tradovate-performance.test.js`
Expected: FAIL — first new test returns `'unknown'` instead of `'tradovate-performance'`.

- [ ] **Step 3: Write minimal implementation**

In `detectFormat()`, add the branch BEFORE the `generic-trades` line so Tradovate wins:

```js
function detectFormat(headers) {
  const h = headers.map(x => x.toLowerCase().trim());
  if (h.includes('contractname') && h.includes('pnl')) return 'topstepx-trades';
  if (h.includes('activity') && h.includes('message type') && h.includes('related id')) return 'tradovate-export';
  if (h.includes('orderid') && h.includes('b/s') && (h.includes('avgprice') || h.includes('avg fill price'))) return 'tradovate-orders';
  if (h.includes('buy price') && h.includes('sell price') && (h.includes('p&l') || h.includes('pnl'))) return 'tradovate-performance';
  if (h.includes('symbol') && h.includes('entry price') && h.includes('exit price')) return 'generic-trades';
  return 'unknown';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tradovate-performance.test.js`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add server/csv-import.js server/test/tradovate-performance.test.js
git commit -m "feat: detect Tradovate Performance CSV format"
```

---

### Task 3: `normalizeTradovatePerformance()` — core parsing

**Files:**
- Modify: `server/csv-import.js` — add function after `normalizeTradovateOrders` (~line 246); add case in `importCSV` switch (~line 336)
- Test: `server/test/tradovate-performance.test.js` (append)

**Interfaces:**
- Consumes: `parseMoney` (Task 1), `parseTimestamp` (existing).
- Produces: `normalizeTradovatePerformance(objs: object[], connectionId: string) -> { accounts, fills: [], trades }`.
  Each trade object has exactly these fields (matching existing normalizers):
  `id, account_id, symbol, side, quantity, entry_price, exit_price, entry_time, exit_time, duration_sec, pnl, commission, net_pnl, hour_of_day, day_of_week`.
  Account id is `${connectionId}-perf`.

- [ ] **Step 1: Write the failing test**

Append to `server/test/tradovate-performance.test.js`. These cases come straight from the sample export (a long, a covered short, a breakeven):

```js
const { normalizeTradovatePerformance } = require('../csv-import');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tradovate-performance.test.js`
Expected: FAIL — `normalizeTradovatePerformance is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/csv-import.js`, add after `normalizeTradovateOrders` (before the FIFO section, ~line 246):

```js
function normalizeTradovatePerformance(objs, connectionId) {
  // Tradovate "Performance" export: one row per already-closed trade with a
  // signed P&L column. No account column, so all rows attach to one account.
  const localAcct = `${connectionId}-perf`;
  const trades = [];
  for (const o of objs) {
    const symbol = (o.Symbol || o.symbol || 'UNKNOWN').trim();
    const qty = Math.abs(parseFloat(o.Qty || o.Quantity || 0) || 0);
    const buyPrice = parseFloat(o['Buy Price'] || o.BuyPrice || 0) || 0;
    const sellPrice = parseFloat(o['Sell Price'] || o.SellPrice || 0) || 0;
    const buyTime = parseTimestamp(o['Buy Time'] || o.BuyTime);
    const sellTime = parseTimestamp(o['Sell Time'] || o.SellTime);
    const netPnl = parseMoney(o['P&L'] || o.PnL || o['P&l'] || o.pnl);

    // Direction: a long is bought then sold; a covered short is sold (earlier)
    // then bought back. Tie (equal times) defaults to long.
    const isLong = buyTime <= sellTime;
    const entry_time = Math.min(buyTime, sellTime);
    const exit_time = Math.max(buyTime, sellTime);
    const entry_price = isLong ? buyPrice : sellPrice;
    const exit_price = isLong ? sellPrice : buyPrice;
    const duration_sec = Math.max(0, Math.floor((exit_time - entry_time) / 1000));

    trades.push({
      // Deterministic ID (idempotent re-import). pnl+qty disambiguate
      // same-second, same-price micro rows.
      id: `${localAcct}-TP-${entry_time}-${exit_time}-${symbol}-${qty}-${netPnl}`,
      account_id: localAcct,
      symbol,
      side: isLong ? 'long' : 'short',
      quantity: qty,
      entry_price,
      exit_price,
      entry_time,
      exit_time,
      duration_sec,
      pnl: netPnl,
      commission: 0,
      net_pnl: netPnl,
      hour_of_day: new Date(entry_time).getHours(),
      day_of_week: new Date(entry_time).getDay(),
    });
  }
  const realized = trades.reduce((s, t) => s + t.net_pnl, 0);
  return {
    accounts: [{
      id: localAcct,
      external_id: 'performance',
      name: 'Performance',
      connection_id: connectionId,
      account_type: 'tradovate-performance',
      balance: null,
      realized_pnl: realized,
      unrealized_pnl: null,
      equity: null,
      trailing_drawdown: null,
      drawdown_lock: null,
      status: 'active',
      last_updated: Date.now(),
    }],
    fills: [],
    trades,
  };
}
```

Wire it into the `importCSV` switch (~line 336):

```js
    case 'tradovate-performance': return normalizeTradovatePerformance(objs, connectionId);
```

Add `normalizeTradovatePerformance` to `module.exports`:

```js
module.exports = {
  importCSV,
  parseCSV,
  rowsToObjects,
  detectFormat,
  pairFillsIntoTrades,
  parseMoney,
  normalizeTradovatePerformance,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tradovate-performance.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add server/csv-import.js server/test/tradovate-performance.test.js
git commit -m "feat: normalize Tradovate Performance CSV into trades"
```

---

### Task 4: End-to-end `importCSV` + idempotency + day-split

**Files:**
- Test: `server/test/tradovate-performance.test.js` (append)
- Fixture: `server/test/fixtures/tradovate-performance-sample.csv` (create)

**Interfaces:**
- Consumes: `importCSV(text: string, connectionId: string)` (existing entry point).

- [ ] **Step 1: Create the fixture CSV**

Create `server/test/fixtures/tradovate-performance-sample.csv` (covered short, long, breakeven, plus two same-second micro rows to prove distinct IDs — spans two days for the split check):

```
Symbol,Qty,Buy Price,Buy Time,Duration,Sell Time,Sell Price,P&L
MNQU6,10,30301.50,07/01/2026 09:03:11,8min 5sec,07/01/2026 08:55:06,30244.00,"$(1,150.00)"
MNQU6,5,30196.75,07/01/2026 21:58:42,5min 55sec,07/01/2026 22:04:37,30211.25,$145.00
MNQU6,1,29581.75,07/02/2026 18:25:25,5min,07/02/2026 18:20:25,29587.25,$11.00
MNQU6,1,29581.75,07/02/2026 18:25:25,5min,07/02/2026 18:20:25,29590.50,$17.50
MNQU6,1,29707.25,07/02/2026 22:18:19,,07/02/2026 22:18:19,29707.25,$0.00
```

- [ ] **Step 2: Write the failing test**

Append to `server/test/tradovate-performance.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const { importCSV } = require('../csv-import');

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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/tradovate-performance.test.js`
Expected: FAIL only if fixture/route missing. If Task 3 is done, the route works; run to confirm all pass. If any fail, fix before continuing.

Note: the day-split test uses the same `getFullYear/getMonth/getDate` local-time bucketing that `server.js` `/api/daily-stats` and `sync.rebuildDailyStats` use, so it verifies the real downstream behavior.

- [ ] **Step 4: Run the full test file to verify PASS**

Run: `node --test test/tradovate-performance.test.js`
Expected: PASS (all tests across all tasks).

- [ ] **Step 5: Commit**

```bash
git add server/test/fixtures/tradovate-performance-sample.csv server/test/tradovate-performance.test.js
git commit -m "test: end-to-end Tradovate Performance import, idempotency, day-split"
```

---

### Task 5: Add a test script + manual smoke test

**Files:**
- Modify: `server/package.json` — add `test` script

**Interfaces:** none new.

- [ ] **Step 1: Add the test script**

In `server/package.json`, change the `scripts` block to:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  },
```

- [ ] **Step 2: Run the whole suite via npm**

Run: `npm test`
Expected: PASS — all tests in `server/test/` run and pass.

- [ ] **Step 3: Manual smoke test against the running server**

Start the server (`node server.js`), then in the UI: create a connection, click its **Upload CSV** button, and upload `server/test/fixtures/tradovate-performance-sample.csv`.
Expected: success toast reporting **5 trades, 1 account**; the Calendar shows entries on Jul 1 and Jul 2; the Journal lists 5 trades with correct signs (the `$(1,150.00)` row is red/negative and marked `short`).

- [ ] **Step 4: Commit**

```bash
git add server/package.json
git commit -m "chore: add npm test script for csv-import tests"
```

---

## Self-Review

**Spec coverage:**
- CSV-only, no PDF dep → Tasks 1-5 use CSV text via `importCSV`; no PDF code. ✔
- Detect on `Buy Price`+`Sell Price`+`P&L` before generic → Task 2. ✔
- Single account per file under chosen connection → Task 3 (`${connectionId}-perf`). ✔
- Trust P&L verbatim, parse `$(...)` → Task 1 (`parseMoney`) + Task 3 (used verbatim). ✔
- entry=min / exit=max time, side inference, covered shorts → Task 3 + tests. ✔
- Deterministic idempotent IDs incl. pnl+qty → Task 3 + Task 4 idempotency test. ✔
- Breakeven rows kept, zero duration → Task 3 + test. ✔
- Split by day is free downstream → Task 4 day-split test mirrors `/api/daily-stats` bucketing. ✔
- No frontend change → confirmed; Task 5 smoke test exercises the existing Upload CSV button. ✔
- No new dependency → `node:test`/`node:assert` only. ✔

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✔

**Type consistency:** `parseMoney`, `detectFormat`, `normalizeTradovatePerformance`, `importCSV` names and the 15 trade fields are identical across Tasks 1-4 and match the existing normalizers in `csv-import.js`. Account id `${connectionId}-perf` used consistently. ✔
