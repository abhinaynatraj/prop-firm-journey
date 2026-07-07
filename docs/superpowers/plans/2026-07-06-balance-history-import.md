# Account Balance History Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a Tradovate "Account Balance History" CSV (one row per account per day: end-of-day balance + daily realized P&L) into per-day account records, with cushion-to-limit drawdown tracking — no individual trades.

**Architecture:** A new `balance-import.js` parses the CSV and groups rows by Account ID; a new `daily_stats.balance` column stores each day's end-of-day balance; a new `cushion.js` computes distance-to-blow-up-limit from the daily balance series + the account's drawdown config; a new `POST /api/import-balance-history` endpoint ties it together. Rendering branches on `account_type === 'balance-history'`. Trade-based accounts and their views are untouched.

**Tech Stack:** Node.js (CommonJS), better-sqlite3 (existing), built-in `node:test`/`node:assert/strict` (no framework to install), single-file frontend (`index.html`).

## Global Constraints

- Language: CommonJS (`require`/`module.exports`), matching `server/*.js`.
- No new npm dependencies. Tests use built-in `node:test` and `node:assert/strict`, run via `npm test`.
- Only additive schema change: `daily_stats.balance` (nullable REAL), added via the existing idempotent `addColumnIfMissing` helper (db.js:137).
- Money/balance values parsed verbatim from the file (strip quotes/commas, leading `-` = negative); never recomputed.
- Account id = `${connectionId}-${accountId}`; `account_type` = `'balance-history'`.
- Daily rows upsert by the existing `daily_stats` primary key `(date, account_id)`.
- Drawdown: cushion-to-limit only; support **static** and **eod_trailing** DD types (NOT intraday_trailing — no tick data in this file).
- Trade-based accounts and their existing calendar/equity/card behavior must be unaffected — always branch on `account_type`.
- Run commands from `server/`.

---

### Task 1: `parseMoney` + CSV tokenizer reuse in `balance-import.js`

**Files:**
- Create: `server/balance-import.js`
- Test: `server/test/balance-import.test.js`

**Interfaces:**
- Consumes: `parseCSV`, `rowsToObjects` from `./csv-import` (already exported there).
- Produces: `parseMoney(str) -> number` exported from `balance-import.js`.

- [ ] **Step 1: Write the failing test**

Create `server/test/balance-import.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMoney } = require('../balance-import');

test('parseMoney parses quoted comma values', () => {
  assert.equal(parseMoney('51,126.40'), 51126.4);
});
test('parseMoney parses negative comma values', () => {
  assert.equal(parseMoney('-1,377.50'), -1377.5);
});
test('parseMoney parses zero and plain numbers', () => {
  assert.equal(parseMoney('0.00'), 0);
  assert.equal(parseMoney('881.60'), 881.6);
});
test('parseMoney handles empty/undefined', () => {
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney(undefined), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/balance-import.test.js`
Expected: FAIL — `Cannot find module '../balance-import'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/balance-import.js`:

```js
// balance-import.js — imports a Tradovate "Account Balance History" CSV
// (one row per account per day: end-of-day balance + daily realized P&L).
// Reuses the CSV tokenizer from csv-import.js.

const { parseCSV, rowsToObjects } = require('./csv-import');

// Parses money strings from the balance export:
//   "51,126.40" -> 51126.4 ; "-1,377.50" -> -1377.5 ; "0.00" -> 0 ; "" -> 0
function parseMoney(s) {
  if (s === null || s === undefined) return 0;
  const str = String(s).trim();
  if (!str) return 0;
  const negative = str.startsWith('-') || str.startsWith('(');
  const cleaned = str.replace(/[$,()]/g, '').replace(/-/g, '').trim();
  const n = parseFloat(cleaned);
  if (isNaN(n)) return 0;
  return negative ? -Math.abs(n) : n;
}

module.exports = { parseMoney };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/balance-import.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/balance-import.js server/test/balance-import.test.js
git commit -m "feat: add parseMoney for balance-history CSV"
```

---

### Task 2: Format detection

**Files:**
- Modify: `server/balance-import.js`
- Test: `server/test/balance-import.test.js` (append)

**Interfaces:**
- Produces: `isBalanceHistory(headers: string[]) -> boolean`.

- [ ] **Step 1: Write the failing test**

Append to `server/test/balance-import.test.js`:

```js
const { isBalanceHistory } = require('../balance-import');

test('isBalanceHistory accepts the balance export header', () => {
  const h = ['Account ID','Account Name','Trade Date','Total Amount','Total Realized PNL'];
  assert.equal(isBalanceHistory(h), true);
});
test('isBalanceHistory rejects a trades header', () => {
  const h = ['Symbol','Qty','Buy Price','Sell Price','P&L'];
  assert.equal(isBalanceHistory(h), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/balance-import.test.js`
Expected: FAIL — `isBalanceHistory is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/balance-import.js`, add before `module.exports`:

```js
function isBalanceHistory(headers) {
  const h = headers.map(x => String(x).toLowerCase().trim());
  return h.includes('account id') && h.includes('trade date') &&
         h.includes('total amount') && h.includes('total realized pnl');
}
```

Update exports: `module.exports = { parseMoney, isBalanceHistory };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/balance-import.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/balance-import.js server/test/balance-import.test.js
git commit -m "feat: detect balance-history CSV format"
```

---

### Task 3: `parse()` — group rows into accounts + daily rows

**Files:**
- Modify: `server/balance-import.js`
- Test: `server/test/balance-import.test.js` (append)
- Fixture: `server/test/fixtures/balance-history-sample.csv` (create)

**Interfaces:**
- Consumes: `parseCSV`, `rowsToObjects`, `parseMoney`, `isBalanceHistory`.
- Produces: `parse(text: string, connectionId: string) -> { accounts, dailyRows }`.
  - `accounts[i]`: `{ id: '<conn>-<acctId>', connection_id, external_id: acctId, name, account_type:'balance-history', balance:<latest day Total Amount>, realized_pnl:<sum daily pnl>, unrealized_pnl:null, equity:<latest balance>, trailing_drawdown:null, drawdown_lock:null, status:'active', last_updated:<number> }`
  - `dailyRows[i]`: `{ date:'YYYY-MM-DD', account_id, trade_count:0, win_count:0, loss_count:0, gross_pnl:<pnl>, net_pnl:<pnl>, balance:<Total Amount> }`

- [ ] **Step 1: Create the fixture**

Create `server/test/fixtures/balance-history-sample.csv` (real account 54823063 rows + a second synthetic account 99999999 to prove multi-account grouping; note the Jun 26→29 dip that drives drawdown):

```
Account ID,Account Name,Trade Date,Total Amount,Total Realized PNL
54823063,FTDFYG50573537347,2026-06-25,"54,018.90","1,332.30"
54823063,FTDFYG50573537347,2026-06-26,"54,900.50",881.60
54823063,FTDFYG50573537347,2026-06-29,"51,170.00","-2,230.50"
54823063,FTDFYG50573537347,2026-06-30,"53,560.00","2,390.00"
54823063,FTDFYG50573537347,2026-07-07,"60,311.70","1,626.00"
99999999,ABCXYZ00011122233,2026-07-06,"25,500.00",500.00
99999999,ABCXYZ00011122233,2026-07-07,"25,100.00",-400.00
```

- [ ] **Step 2: Write the failing test**

Append to `server/test/balance-import.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('../balance-import');

const FIX = fs.readFileSync(path.join(__dirname,'fixtures','balance-history-sample.csv'),'utf8');

test('parse groups rows into one account per Account ID', () => {
  const r = parse(FIX, 'connA');
  assert.equal(r.accounts.length, 2);
  const a = r.accounts.find(x => x.external_id === '54823063');
  assert.equal(a.id, 'connA-54823063');
  assert.equal(a.account_type, 'balance-history');
  assert.equal(a.name, 'FTDFYG50573537347');
});

test('account balance is the latest day, realized_pnl is the sum', () => {
  const r = parse(FIX, 'connA');
  const a = r.accounts.find(x => x.external_id === '54823063');
  assert.equal(a.balance, 60311.70);   // latest date 2026-07-07
  assert.equal(Math.round(a.realized_pnl * 100) / 100, 1332.30 + 881.60 - 2230.50 + 2390.00 + 1626.00);
});

test('daily rows carry balance and net_pnl, keyed by date+account', () => {
  const r = parse(FIX, 'connA');
  const rows = r.dailyRows.filter(x => x.account_id === 'connA-54823063');
  assert.equal(rows.length, 5);
  const dip = rows.find(x => x.date === '2026-06-29');
  assert.equal(dip.net_pnl, -2230.5);
  assert.equal(dip.balance, 51170.00);
  assert.equal(dip.trade_count, 0);
});

test('second account grouped independently', () => {
  const r = parse(FIX, 'connA');
  const b = r.accounts.find(x => x.external_id === '99999999');
  assert.equal(b.balance, 25100.00);   // latest 2026-07-07
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/balance-import.test.js`
Expected: FAIL — `parse is not a function`.

- [ ] **Step 4: Write minimal implementation**

In `server/balance-import.js`, add before `module.exports`:

```js
function parse(text, connectionId) {
  const rows = parseCSV(text);
  if (rows.length === 0) throw new Error('Empty CSV');
  if (!isBalanceHistory(rows[0])) {
    throw new Error('Not an Account Balance History CSV. Expected columns: Account ID, Trade Date, Total Amount, Total Realized PNL.');
  }
  const objs = rowsToObjects(rows);
  const byAcct = {};   // acctId -> { name, days: [{date, balance, pnl}] }
  for (const o of objs) {
    const acctId = String(o['Account ID'] || '').trim();
    if (!acctId) continue;
    const date = String(o['Trade Date'] || '').trim();
    if (!date) continue;
    const balance = parseMoney(o['Total Amount']);
    const pnl = parseMoney(o['Total Realized PNL']);
    if (!byAcct[acctId]) byAcct[acctId] = { name: String(o['Account Name'] || acctId).trim(), days: [] };
    byAcct[acctId].days.push({ date, balance, pnl });
  }
  const accounts = [];
  const dailyRows = [];
  const now = Date.now();
  for (const [acctId, info] of Object.entries(byAcct)) {
    const localId = `${connectionId}-${acctId}`;
    const sorted = info.days.slice().sort((a, b) => a.date.localeCompare(b.date));
    const latest = sorted[sorted.length - 1];
    const realized = sorted.reduce((s, d) => s + d.pnl, 0);
    accounts.push({
      id: localId, connection_id: connectionId, external_id: acctId, name: info.name,
      account_type: 'balance-history', balance: latest.balance, realized_pnl: realized,
      unrealized_pnl: null, equity: latest.balance, trailing_drawdown: null,
      drawdown_lock: null, status: 'active', last_updated: now,
    });
    for (const d of sorted) {
      dailyRows.push({
        date: d.date, account_id: localId, trade_count: 0, win_count: 0, loss_count: 0,
        gross_pnl: d.pnl, net_pnl: d.pnl, balance: d.balance,
      });
    }
  }
  return { accounts, dailyRows };
}
```

Update exports: `module.exports = { parseMoney, isBalanceHistory, parse };`

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/balance-import.test.js`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add server/balance-import.js server/test/balance-import.test.js server/test/fixtures/balance-history-sample.csv
git commit -m "feat: parse balance-history CSV into accounts + daily rows"
```

---

### Task 4: `daily_stats.balance` column + `saveDailyStat` extension

**Files:**
- Modify: `server/db.js` — add column (near db.js:143), `upsertDailyStat` (db.js:227), `listDailyStatsByAccountStmt` (db.js:240), `saveDailyStat` (db.js:441)
- Test: `server/test/db-balance.test.js` (create)

**Interfaces:**
- Consumes: `db.saveDailyStat`, `db.listDailyStatsByAccount`, `db.saveConnection`, `db.saveAccount` (existing).
- Produces: `saveDailyStat` accepts an optional `balance` field; `listDailyStatsByAccount(id)` rows include `balance`.

- [ ] **Step 1: Write the failing test**

Create `server/test/db-balance.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

test('daily_stats round-trips a balance value', () => {
  db.saveConnection({ id:'tconn', firm:'test', owner:'me', label:'t', platform:'csv', created_at: 1, status:'new' });
  db.saveAccount({ id:'tconn-1', connection_id:'tconn', external_id:'1', name:'A', account_type:'balance-history',
    balance:100, realized_pnl:0, unrealized_pnl:null, equity:100, trailing_drawdown:null, drawdown_lock:null,
    status:'active', last_updated:1 });
  db.saveDailyStat({ date:'2026-07-07', account_id:'tconn-1', trade_count:0, win_count:0, loss_count:0,
    gross_pnl:5, net_pnl:5, balance:12345.67 });
  const rows = db.listDailyStatsByAccount('tconn-1');
  const row = rows.find(r => r.date === '2026-07-07');
  assert.equal(row.balance, 12345.67);
  assert.equal(row.net_pnl, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db-balance.test.js`
Expected: FAIL — `row.balance` is `undefined` (column/select missing).

- [ ] **Step 3: Write minimal implementation**

In `server/db.js`, after the existing `addColumnIfMissing('account_configs', ...)` call (db.js:143), add:

```js
addColumnIfMissing('daily_stats', 'balance', 'REAL');
```

Change `upsertDailyStat` (db.js:227) to include `balance`:

```js
const upsertDailyStat = db.prepare(`
  INSERT OR REPLACE INTO daily_stats (date, account_id, trade_count, win_count, loss_count, gross_pnl, net_pnl, max_drawdown, balance)
  VALUES (@date, @account_id, @trade_count, @win_count, @loss_count, @gross_pnl, @net_pnl, @max_drawdown, @balance)
`);
```

Change `listDailyStatsByAccountStmt` (db.js:240) to select `balance`:

```js
const listDailyStatsByAccountStmt = db.prepare(`
  SELECT date, account_id, trade_count, win_count, loss_count, gross_pnl, net_pnl, balance
  FROM daily_stats
  WHERE account_id = ?
  ORDER BY date ASC
`);
```

Change `saveDailyStat` (db.js:441) to default the new fields so existing callers (sync.js, which passes no `balance`/`max_drawdown`) still work:

```js
  saveDailyStat(stat) {
    upsertDailyStat.run({
      max_drawdown: null,
      balance: null,
      ...stat,
    });
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db-balance.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `node --test test/`
Expected: PASS — balance-import + db-balance tests all green. (sync.js callers still work because `balance`/`max_drawdown` default to null.)

- [ ] **Step 6: Commit**

```bash
git add server/db.js server/test/db-balance.test.js
git commit -m "feat: add balance column to daily_stats"
```

---

### Task 5: `cushion.js` — cushion-to-limit computation

**Files:**
- Create: `server/cushion.js`
- Test: `server/test/cushion.test.js` (create)

**Interfaces:**
- Produces: `computeCushion(dailyBalances: number[], config) -> { currentBalance, peakBalance, limit, cushion, cushionPct, locked }`.
  `config = { starting_balance, drawdown_type, drawdown_amount, drawdown_locks_at }`.
  `dailyBalances` is the account's end-of-day balances in date order.

- [ ] **Step 1: Write the failing test**

Create `server/test/cushion.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCushion } = require('../cushion');

test('static DD: fixed limit = start - amount', () => {
  const r = computeCushion([50000, 51000, 52000], { starting_balance:50000, drawdown_type:'static', drawdown_amount:2000, drawdown_locks_at:null });
  assert.equal(r.limit, 48000);
  assert.equal(r.currentBalance, 52000);
  assert.equal(r.cushion, 4000);
});

test('eod_trailing: limit trails the running peak', () => {
  // peak 54900 -> limit 52400; current 53560 -> cushion 1160
  const r = computeCushion([54018.9, 54900.5, 51170, 53560], { starting_balance:50000, drawdown_type:'eod_trailing', drawdown_amount:2500, drawdown_locks_at:null });
  assert.equal(r.peakBalance, 54900.5);
  assert.equal(r.limit, 52400.5);
  assert.equal(Math.round(r.cushion * 100) / 100, 1159.5);
});

test('eod_trailing: limit freezes at lock threshold', () => {
  // locks_at 52000: once peak-amount would exceed 52000, limit caps at 52000
  const r = computeCushion([50000, 55000, 60000], { starting_balance:50000, drawdown_type:'eod_trailing', drawdown_amount:2500, drawdown_locks_at:52000 });
  assert.equal(r.limit, 52000);
  assert.equal(r.locked, true);
  assert.equal(r.cushion, 8000);
});

test('cushion is negative below the limit', () => {
  const r = computeCushion([50000, 47000], { starting_balance:50000, drawdown_type:'static', drawdown_amount:2000, drawdown_locks_at:null });
  assert.equal(r.limit, 48000);
  assert.equal(r.cushion, -1000);
});

test('empty series yields null-safe zeros', () => {
  const r = computeCushion([], { starting_balance:50000, drawdown_type:'static', drawdown_amount:2000, drawdown_locks_at:null });
  assert.equal(r.currentBalance, 0);
  assert.equal(r.cushion, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cushion.test.js`
Expected: FAIL — `Cannot find module '../cushion'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/cushion.js`:

```js
// cushion.js — distance from current balance to the drawdown blow-up limit,
// from a daily end-of-day balance series + the account's DD config.
// Supports 'static' and 'eod_trailing'. (intraday needs tick data we don't have.)

function computeCushion(dailyBalances, config) {
  const cfg = config || {};
  const amount = Number(cfg.drawdown_amount) || 0;
  const start = Number(cfg.starting_balance) || 0;
  const locksAt = cfg.drawdown_locks_at == null ? null : Number(cfg.drawdown_locks_at);

  if (!dailyBalances || dailyBalances.length === 0) {
    return { currentBalance: 0, peakBalance: 0, limit: start - amount, cushion: 0, cushionPct: 0, locked: false };
  }

  const currentBalance = dailyBalances[dailyBalances.length - 1];
  const peakBalance = Math.max(...dailyBalances, start);

  let limit;
  let locked = false;
  if (cfg.drawdown_type === 'eod_trailing') {
    let trailed = peakBalance - amount;
    if (locksAt != null && trailed >= locksAt) { trailed = locksAt; locked = true; }
    limit = trailed;
  } else {
    // static (default)
    limit = start - amount;
  }

  const cushion = currentBalance - limit;
  const cushionPct = currentBalance !== 0 ? (cushion / currentBalance) * 100 : 0;
  return { currentBalance, peakBalance, limit, cushion, cushionPct, locked };
}

module.exports = { computeCushion };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cushion.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/cushion.js server/test/cushion.test.js
git commit -m "feat: cushion-to-limit drawdown computation"
```

---

### Task 6: Server endpoint `POST /api/import-balance-history`

**Files:**
- Modify: `server/server.js` — add endpoint near the existing import-csv handler (server.js:285-311); add `require` for balance-import at the top (near the other requires, server.js:1-15)
- Test: `server/test/import-balance-endpoint.test.js` (create — tests the handler's core logic through db, not HTTP)

**Interfaces:**
- Consumes: `balanceImport.parse`, `balanceImport.isBalanceHistory`, `db.saveConnection`, `db.saveAccount`, `db.saveDailyStat`, `db.getAccountConfig`, `db.saveAccountConfig`, `db.listConnections`.
- Produces: HTTP `POST /api/import-balance-history` (multipart) returning `{ ok, connectionId, accounts, daysImported, daysUpdated }`.

Because the app has no HTTP test harness, this task extracts the handler's core into a testable pure-ish function `importBalanceHistory(text, opts, deps)` and the route is a thin wrapper. This keeps the logic unit-testable.

- [ ] **Step 1: Write the failing test**

Create `server/test/import-balance-endpoint.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { importBalanceHistory } = require('../import-balance');

const FIX = fs.readFileSync(path.join(__dirname,'fixtures','balance-history-sample.csv'),'utf8');

test('rejects a non-balance CSV', () => {
  assert.throws(() => importBalanceHistory('Symbol,Qty\nMNQ,1', { firm:'apex' }),
    /Account Balance History/);
});

test('imports accounts + daily rows and reports counts', () => {
  const r = importBalanceHistory(FIX, { firm:'apex-test-'+Math.floor(1), startingBalance:50000, drawdownType:'eod_trailing', drawdownAmount:2500 });
  assert.equal(r.accounts.length, 2);
  assert.equal(r.daysImported, 7);
  assert.equal(r.daysUpdated, 0);
  // account persisted
  const acct = db.listAccounts().find(a => a.external_id === '54823063' && a.connection_id === r.connectionId);
  assert.ok(acct);
  assert.equal(acct.account_type, 'balance-history');
  // config applied
  const cfg = db.getAccountConfig(acct.id);
  assert.equal(cfg.drawdown_type, 'eod_trailing');
  assert.equal(cfg.starting_balance, 50000);
});

test('re-import is idempotent by (date, account) and reports updates', () => {
  const opts = { firm:'apex-reimport', startingBalance:50000, drawdownType:'static', drawdownAmount:2000 };
  const first = importBalanceHistory(FIX, opts);
  const second = importBalanceHistory(FIX, opts);
  assert.equal(second.connectionId, first.connectionId); // reused firm connection
  assert.equal(second.daysImported, 0);
  assert.equal(second.daysUpdated, 7);
  // daily rows not duplicated
  const rows = db.listDailyStatsByAccount(first.connectionId + '-54823063');
  assert.equal(rows.length, 5);
});

test('re-import does not overwrite an edited account config', () => {
  const opts = { firm:'apex-cfg', startingBalance:50000, drawdownType:'static', drawdownAmount:2000 };
  const first = importBalanceHistory(FIX, opts);
  const acctId = first.connectionId + '-54823063';
  // user edits config via the gear panel
  db.saveAccountConfig({ account_id:acctId, starting_balance:50000, drawdown_type:'eod_trailing', drawdown_amount:3000, drawdown_locks_at:null, profit_target:null, daily_loss_limit:null, manual_status:null, notes:null });
  // re-import with different modal values
  importBalanceHistory(FIX, { firm:'apex-cfg', startingBalance:50000, drawdownType:'static', drawdownAmount:2000 });
  const cfg = db.getAccountConfig(acctId);
  assert.equal(cfg.drawdown_amount, 3000); // preserved, not clobbered
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/import-balance-endpoint.test.js`
Expected: FAIL — `Cannot find module '../import-balance'`.

- [ ] **Step 3: Write the core logic module**

Create `server/import-balance.js`:

```js
// import-balance.js — orchestrates a balance-history import:
// find-or-create firm connection, upsert accounts + configs + daily rows.

const crypto = require('crypto');
const db = require('./db');
const balanceImport = require('./balance-import');

function findOrCreateConnection(firm) {
  const owner = 'me';
  const existing = db.listConnections().find(c => c.firm === firm && c.owner === owner && c.platform === 'csv');
  if (existing) return existing.id;
  const id = `${String(firm).toLowerCase()}-${owner}-${crypto.randomBytes(3).toString('hex')}`;
  db.saveConnection({ id, firm, owner, label: firm, platform: 'csv', created_at: Date.now(), status: 'new' });
  return id;
}

function importBalanceHistory(text, opts) {
  const { firm } = opts || {};
  if (!firm) throw new Error('firm is required');

  // Validate format BEFORE creating anything.
  const { parseCSV, isBalanceHistory } = balanceImport.__csvHelpers();
  const rows = parseCSV(text);
  if (rows.length === 0 || !isBalanceHistory(rows[0])) {
    throw new Error('Not an Account Balance History CSV. Expected columns: Account ID, Trade Date, Total Amount, Total Realized PNL.');
  }

  const connectionId = findOrCreateConnection(firm);
  const { accounts, dailyRows } = balanceImport.parse(text, connectionId);

  for (const a of accounts) {
    db.saveAccount(a);
    // Apply DD config only if the account has none yet (don't clobber edits).
    if (!db.getAccountConfig(a.id)) {
      db.saveAccountConfig({
        account_id: a.id,
        starting_balance: Number(opts.startingBalance) || 50000,
        drawdown_type: opts.drawdownType || 'eod_trailing',
        drawdown_amount: Number(opts.drawdownAmount) || 2000,
        drawdown_locks_at: opts.drawdownLocksAt != null && opts.drawdownLocksAt !== '' ? Number(opts.drawdownLocksAt) : null,
        profit_target: null, daily_loss_limit: null, manual_status: null, notes: null,
      });
    }
  }

  // Count new vs updated by checking existing (date, account) keys.
  const existingKeys = new Set();
  for (const a of accounts) {
    for (const row of db.listDailyStatsByAccount(a.id)) existingKeys.add(`${row.date}::${a.id}`);
  }
  let daysImported = 0, daysUpdated = 0;
  for (const row of dailyRows) {
    if (existingKeys.has(`${row.date}::${row.account_id}`)) daysUpdated++; else daysImported++;
    db.saveDailyStat(row);
  }

  return {
    connectionId,
    accounts: accounts.map(a => ({ id: a.id, external_id: a.external_id, name: a.name, balance: a.balance })),
    daysImported, daysUpdated,
  };
}

module.exports = { importBalanceHistory, findOrCreateConnection };
```

Add a tiny helper to `balance-import.js` so the endpoint can reuse the tokenizer + detector without re-requiring csv-import (keeps the format guard DRY). Add before its `module.exports`:

```js
function __csvHelpers() { return { parseCSV, isBalanceHistory }; }
```

And update its exports: `module.exports = { parseMoney, isBalanceHistory, parse, __csvHelpers };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/import-balance-endpoint.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the HTTP route**

In `server/server.js`, add near the other requires (top of file):

```js
const balanceImportLogic = require('./import-balance');
```

Add the route after the existing import-csv handler (after server.js:311):

```js
// ─── Balance history import ─────────────────────────────────────────────────
app.post('/api/import-balance-history', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
    const text = req.file.buffer.toString('utf8');
    const result = balanceImportLogic.importBalanceHistory(text, {
      firm: req.body.firm,
      startingBalance: req.body.startingBalance,
      drawdownType: req.body.drawdownType,
      drawdownAmount: req.body.drawdownAmount,
      drawdownLocksAt: req.body.drawdownLocksAt,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
```

- [ ] **Step 6: Run the full suite**

Run: `node --test test/`
Expected: PASS — all tests across all files. (The route is a thin wrapper over the tested `importBalanceHistory`.)

- [ ] **Step 7: Commit**

```bash
git add server/import-balance.js server/balance-import.js server/server.js server/test/import-balance-endpoint.test.js
git commit -m "feat: balance-history import endpoint + orchestration"
```

---

### Task 7: Expose cushion on the accounts payload

**Files:**
- Modify: `server/server.js` — the `GET /api/accounts` handler (server.js:315-317)
- Test: `server/test/accounts-cushion.test.js` (create)

**Interfaces:**
- Consumes: `db.listAccounts`, `db.getAccountConfig`, `db.listDailyStatsByAccount`, `cushion.computeCushion`.
- Produces: each `balance-history` account in `GET /api/accounts` carries a `cushion` object `{ currentBalance, peakBalance, limit, cushion, cushionPct, locked }`.

- [ ] **Step 1: Write the failing test**

Create `server/test/accounts-cushion.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { importBalanceHistory } = require('../import-balance');
const { attachCushion } = require('../accounts-view');

const FIX = fs.readFileSync(path.join(__dirname,'fixtures','balance-history-sample.csv'),'utf8');

test('attachCushion adds a cushion object to balance-history accounts', () => {
  const r = importBalanceHistory(FIX, { firm:'apex-cushion', startingBalance:50000, drawdownType:'eod_trailing', drawdownAmount:2500 });
  const accounts = db.listAccounts().filter(a => a.connection_id === r.connectionId);
  const withCushion = attachCushion(accounts, db);
  const a = withCushion.find(x => x.external_id === '54823063');
  assert.ok(a.cushion);
  assert.equal(a.cushion.currentBalance, 60311.70);
  // peak is 60311.70 (latest is the high), limit = 60311.70 - 2500
  assert.equal(a.cushion.limit, 57811.70);
  assert.ok(a.cushion.cushion > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/accounts-cushion.test.js`
Expected: FAIL — `Cannot find module '../accounts-view'`.

- [ ] **Step 3: Write the helper module**

Create `server/accounts-view.js`:

```js
// accounts-view.js — decorates account records for the API with a cushion
// object (balance-history accounts only).

const { computeCushion } = require('./cushion');

function attachCushion(accounts, db) {
  return accounts.map(a => {
    if (a.account_type !== 'balance-history') return a;
    const cfg = db.getAccountConfig(a.id) || {};
    const balances = db.listDailyStatsByAccount(a.id)
      .filter(r => r.balance != null)
      .map(r => r.balance);
    const cushion = computeCushion(balances, cfg);
    return { ...a, cushion };
  });
}

module.exports = { attachCushion };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/accounts-cushion.test.js`
Expected: PASS.

- [ ] **Step 5: Wire it into the accounts endpoint**

In `server/server.js`, add near the requires: `const accountsView = require('./accounts-view');`
Change `GET /api/accounts` (server.js:315-317) to:

```js
app.get('/api/accounts', (req, res) => {
  res.json({ accounts: accountsView.attachCushion(db.listAccounts(), db) });
});
```

- [ ] **Step 6: Run the full suite**

Run: `node --test test/`
Expected: PASS — all files.

- [ ] **Step 7: Commit**

```bash
git add server/accounts-view.js server/server.js server/test/accounts-cushion.test.js
git commit -m "feat: expose cushion on balance-history accounts"
```

---

### Task 8: Frontend — Import Balances button, modal, and rendering

**Files:**
- Modify: `index.html` — header buttons (index.html:1289), a new modal (near modal-add-connection at index.html:1560s), submit handler + render branches (in the `<script>` block)

**Interfaces:**
- Consumes: `POST /api/import-balance-history`; `GET /api/accounts` now returns `cushion` on balance-history accounts; `daily_stats` rows carry `balance`.

This task is UI wiring with no unit test harness (single-file frontend). It ends with a **manual smoke test** the controller performs by driving the real endpoint + browser.

- [ ] **Step 1: Add the header button**

In `index.html` near the existing import buttons (index.html:1289), add before "+ Add Connection":

```html
<button class="btn" style="padding:6px 14px;font-size:12px;background:rgba(210,153,34,0.15);color:#d29922;border:1px solid rgba(210,153,34,0.3);" onclick="openImportBalancesModal()">📈 Import Balances</button>
```

- [ ] **Step 2: Add the modal**

After the `modal-add-connection` block (search `id="modal-add-connection"`), add a sibling modal `modal-import-balances` with: a `.csv` file input (`id="bal-file"`), a Firm `<select id="bal-firm">` mirroring the add-connection firm options (+ a custom text input `id="bal-firm-custom"` shown on `__custom__`), Starting balance (`id="bal-start"`, default 50000), Drawdown type `<select id="bal-dd-type">` with ONLY `static` and `eod_trailing` options, Drawdown amount (`id="bal-dd-amount"`, default 2500), Lock-at (`id="bal-dd-lock"`, optional), a `Continue` button calling `submitImportBalances()`, a Cancel calling `closeModal('modal-import-balances')`, and an inline error `<div id="bal-error">`. Match the existing modal markup/styling conventions used by `modal-add-connection`.

- [ ] **Step 3: Add the JS handlers**

In the `<script>` block near `submitAddConnection`, add:

```js
function openImportBalancesModal() {
  if (!serverOnline) { alert('Server is offline. Start it first.'); return; }
  document.getElementById('bal-file').value = '';
  document.getElementById('bal-error').textContent = '';
  openModal('modal-import-balances');
}

async function submitImportBalances() {
  const err = document.getElementById('bal-error'); err.textContent = '';
  const fileEl = document.getElementById('bal-file');
  if (!fileEl.files.length) { err.textContent = 'Choose a CSV file.'; return; }
  let firm = document.getElementById('bal-firm').value;
  if (firm === '__custom__') {
    const c = document.getElementById('bal-firm-custom').value.trim();
    if (!c) { err.textContent = 'Enter a custom firm name.'; return; }
    firm = firmNameToSlug(c);
  }
  const fd = new FormData();
  fd.append('file', fileEl.files[0]);
  fd.append('firm', firm);
  fd.append('startingBalance', document.getElementById('bal-start').value || '50000');
  fd.append('drawdownType', document.getElementById('bal-dd-type').value);
  fd.append('drawdownAmount', document.getElementById('bal-dd-amount').value || '2500');
  fd.append('drawdownLocksAt', document.getElementById('bal-dd-lock').value || '');
  try {
    const res = await fetch(`${API}/import-balance-history`, { method:'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error || 'Import failed.'; return; }
    closeModal('modal-import-balances');
    let msg = `Imported ${data.daysImported} days across ${data.accounts.length} account(s) under ${firm}`;
    if (data.daysUpdated) msg += `, ${data.daysUpdated} updated`;
    toast(msg);
    loadConnections(); await refreshLiveFirms(); loadCalendar(); loadPatterns(); loadAccounts && loadAccounts();
  } catch (e) { err.textContent = 'Import failed: ' + e.message; }
}
```

(If `toast` / `loadAccounts` names differ in the file, use the file's existing equivalents — grep for `function toast` / how account cards refresh.)

- [ ] **Step 4: Add render branches for balance-history accounts**

Find where account cards render (grep `account_type` / `openCSVUpload('${c.id}')` / the account card template) and add a branch: when `a.account_type === 'balance-history'`, render the **stat-tile card** (Balance / Net P&L / Best day / Worst day / Days) plus a cushion line using `a.cushion.cushion` (green if > 0, red if ≤ 0). Find where calendar day cells render (grep `daily-stats` / the cell template) and, for the selected balance-history account, show `net_pnl` big+colored with `balance` small underneath. Use the existing helpers for currency formatting.

- [ ] **Step 5: Manual smoke test (controller performs)**

Start the server (`node server.js` from `server/`). In the browser: click **📈 Import Balances**, pick firm "Apex", upload `server/test/fixtures/balance-history-sample.csv`, set start 50000 / eod_trailing / 2500, Continue.
Expected: toast "Imported 7 days across 2 account(s) under apex"; Accounts view shows two stat-tile cards (54823063 balance $60,311.70, a positive cushion; 99999999 balance $25,100.00); Calendar shows the days with P&L + balance; re-uploading the same file toasts "0 days … 7 updated" and does not duplicate. Delete the smoke connections afterward.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: Import Balances button, modal, and balance-history rendering"
```

---

### Task 9: Add `npm test` script

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Add the script**

In `server/package.json` `scripts`, add alongside `start`:

```json
    "test": "node --test \"test/**/*.test.js\""
```

- [ ] **Step 2: Run the whole suite**

Run: `npm test`
Expected: PASS — all test files (balance-import, db-balance, cushion, import-balance-endpoint, accounts-cushion).

- [ ] **Step 3: Commit**

```bash
git add server/package.json
git commit -m "chore: add npm test script"
```

---

## Self-Review

**Spec coverage:**
- Parse balance CSV, group by Account ID → Task 3. ✔
- daily_stats + balance column, no synthetic trades → Task 4. ✔
- Firm typed at import; find-or-create connection → Task 6. ✔
- account id = conn-acctId; multi-account → Task 3 + Task 6. ✔
- Upsert by (date, account); new-vs-updated counts → Task 6. ✔
- Cushion-to-limit, static + eod_trailing, lock; no intraday → Task 5. ✔
- DD config from modal, not clobbered on re-import → Task 6. ✔
- Cushion exposed for the card → Task 7. ✔
- Import Balances button + modal (static/eod only) → Task 8. ✔
- Stat-tile card + P&L/balance calendar cell → Task 8. ✔
- Money parsed verbatim (comma/quote/sign) → Task 1. ✔
- Format guard before creating anything → Task 6 (guard runs before findOrCreateConnection). ✔
- npm test / node:test, no deps → Tasks 1-9. ✔

**Placeholder scan:** No TBD/TODO; every code step shows full code. Task 8 steps 2 & 4 describe DOM wiring in prose (single-file frontend, no unit harness) but name exact element ids and the exact branch condition — acceptable for UI glue; the manual smoke test in step 5 is the gate.

**Type consistency:** `parseMoney`, `isBalanceHistory`, `parse`, `computeCushion`, `importBalanceHistory`, `attachCushion`, `findOrCreateConnection` names and shapes are consistent across tasks. Account object has the same field set as existing normalizers. `computeCushion` return shape `{currentBalance, peakBalance, limit, cushion, cushionPct, locked}` is identical in Tasks 5 and 7. daily row shape `{date, account_id, trade_count, win_count, loss_count, gross_pnl, net_pnl, balance}` matches `saveDailyStat`'s columns from Task 4.

**Known consideration (not a gap):** the global `listDailyStats` (calendar all-accounts view) SUMs across accounts and does not select `balance` — correct, since summing balances across accounts is meaningless. Per-account balance shows via `listDailyStatsByAccount` (Task 4), which the single-account calendar/equity path uses. No change needed to the global sum.
