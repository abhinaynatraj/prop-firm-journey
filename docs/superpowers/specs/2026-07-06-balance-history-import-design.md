# Account Balance History Import — Design

**Date:** 2026-07-06
**Status:** Approved (design), pending spec review → plan → build

## Problem

Prop firms (e.g. Tradovate/Apex-style) export an **Account Balance History** CSV: one
row per account per day with the end-of-day balance and that day's realized P&L. The
user wants to import this and track accounts at **day/balance granularity** — including
**drawdown** — instead of importing individual trades.

Sample file (`Account Balance History.csv`):

```
Account ID,Account Name,Trade Date,Total Amount,Total Realized PNL
54823063,FTDFYG50573537347,2026-06-19,"51,126.40","1,126.40"
54823063,FTDFYG50573537347,2026-06-20,"51,126.40",0.00
...
54823063,FTDFYG50573537347,2026-07-07,"60,311.70","1,626.00"
```

The app today derives calendar/equity/metrics entirely from the `trades` table. This
data has **no trades** — only daily balances + daily P&L.

## Decisions (locked)

1. **Data model:** write CSV rows directly into the existing `daily_stats` table
   (`date`, `account_id`, `net_pnl` = Total Realized PNL) and add a new per-day
   `balance` column (= Total Amount). No synthetic trades.
2. **Firm:** typed once in the import modal (dropdown like Add Connection). The file
   has no firm column. All accounts in the file attach to that one firm connection.
3. **Multi-account:** group rows by `Account ID`; create/update one account per
   distinct ID under the firm connection. Account id = `${connectionId}-${accountId}`.
4. **Re-import:** upsert by `(account, date)` — the `daily_stats` primary key. Updates a
   restated day, adds new days, no duplicates. Idempotent.
5. **Account card:** stat tiles — Balance / Net P&L / Best day / Worst day / Days
   (+ a cushion line).
6. **Calendar cell:** daily P&L big + colored, end-of-day balance small grey underneath.
7. **Drawdown:** track **cushion to the blow-up limit** (distance from current balance
   to the trailing/static DD threshold), using a per-account DD rule.
8. **DD config:** entered in the import modal per import (start balance, DD type, DD
   amount, lock-at); applied to accounts on create; not overwritten on re-import.
9. **Approach:** balance-history is a first-class daily data source. Views read
   `daily_stats` and branch on `account_type = 'balance-history'`; trade-based accounts
   are untouched.

## Architecture & data flow

```
Frontend "Import Balances" button (Connections tab header)
  → POST /api/import-balance-history  (multipart: file, firm, DD config)  [NEW]
      → balanceImport.parse(text)      [NEW module balance-import.js]
          → detect header; group by Account ID; parse money
          → { accounts:[...], dailyRows:[{date,account_id,net_pnl,balance,...}] }
      → find-or-create firm connection  (reuse db.saveConnection)
      → per account: db.saveAccount (upsert) + db.saveAccountConfig (if none)
      → per dailyRow: db.saveDailyStat (extended with balance) — upsert by (date,account_id)
  → response {connectionId, accounts, daysImported, daysUpdated}

Rendering (branch on account_type === 'balance-history'):
  - account card  → stat tiles + cushion (cushion.js)
  - calendar cell → daily P&L (from daily_stats.net_pnl) + balance (daily_stats.balance)
  - equity view   → daily curve from daily_stats.balance (real balances, not trade sums)
```

## Components

### 1. `server/balance-import.js` (NEW)

Keeps `csv-import.js` focused; this is a separate parser for a distinct format.

- Reuses the CSV tokenizer from `csv-import.js` (export `parseCSV`/`rowsToObjects` or
  duplicate the small tokenizer — decide in plan; prefer importing to stay DRY).
- **Detection:** header contains `account id`, `trade date`, `total amount`,
  `total realized pnl` (case-insensitive).
- **`parseMoney(str)`:** `"51,126.40"` → `51126.4`, `"-1,377.50"` → `-1377.5`,
  `0.00` → `0`, `""` → `0`. Strips quotes/commas; leading `-` = negative.
- **`parse(text, connectionId)`** returns:
  - `accounts`: one per distinct `Account ID` —
    `{ id: ${connectionId}-${accountId}, connection_id, external_id: accountId,
       name: AccountName, account_type: 'balance-history',
       balance: <latest day Total Amount>, realized_pnl: <sum daily PNL>,
       status: 'active', last_updated: Date.now(), ...nulls for trade fields }`
  - `dailyRows`: one per CSV row —
    `{ date: TradeDate (YYYY-MM-DD), account_id, net_pnl: TotalRealizedPNL,
       gross_pnl: TotalRealizedPNL, balance: TotalAmount,
       trade_count: 0, win_count: 0, loss_count: 0 }`
  - "latest day" = max `Trade Date` per account.

### 2. `daily_stats.balance` column (schema)

Idempotent `ALTER TABLE daily_stats ADD COLUMN balance REAL` via the existing helper
pattern (db.js:135-140). `saveDailyStat` extended to write `balance`
(`INSERT OR REPLACE`, so upsert by the existing PK `(date, account_id)` is automatic).
`listDailyStats` / `listDailyStatsByAccount` select `balance` too.

### 3. `server/cushion.js` (NEW) — drawdown / cushion

Pure functions over an account's ordered daily balance series + DD config.

`computeCushion(dailyBalances, config)` where `config = {starting_balance,
drawdown_type, drawdown_amount, drawdown_locks_at}`:

- **static:** `limit = starting_balance - drawdown_amount` (fixed).
- **eod_trailing:** `peak = max end-of-day balance so far`;
  `limit = peak - drawdown_amount`, capped at `drawdown_locks_at` once `peak`
  clears the lock (limit freezes at `drawdown_locks_at`).
- Returns `{ currentBalance, peakBalance, limit, cushion: currentBalance - limit,
  cushionPct, locked }`.
- **intraday_trailing is NOT supported** for balance-history accounts (needs
  tick/trade data absent from this file). The import modal offers only **static** and
  **eod_trailing**.

Exposed on the accounts payload (extend `/api/accounts`, or add
`/api/accounts/:id/cushion`) so the card renders a ready number. Applies only to
`balance-history` accounts.

### 4. Server endpoint `POST /api/import-balance-history` (NEW)

Multipart fields: `file`, `firm`, `startingBalance`, `drawdownType`,
`drawdownAmount`, `drawdownLocksAt`.

1. Parse CSV; if header not balance-history → `400 {error: "Not an Account Balance
   History CSV. Expected columns: Account ID, Trade Date, Total Amount, Total
   Realized PNL."}` — before creating anything.
2. Find-or-create firm connection (reuse existing firm+owner `csv` connection, else
   `db.saveConnection`; owner `'me'`, platform `'csv'`).
3. Per distinct account: `db.saveAccount` (upsert); `db.saveAccountConfig` **only if
   `db.getAccountConfig(id)` is empty** (don't clobber a config you edited via ⚙).
4. Per daily row: check if `(date, account_id)` already exists (count → `daysUpdated`
   vs `daysImported`), then `db.saveDailyStat` (upsert incl. balance).
5. Return `{ok:true, connectionId, accounts:[{id,external_id,name,balance}], daysImported, daysUpdated}`.

### 5. Frontend

- **"Import Balances" button** in the Connections tab header (index.html:1289 area),
  next to Bulk Import / Add Connection.
- **Modal `modal-import-balances`:** file (`.csv`), Firm dropdown (+ custom), and DD
  rule fields — Starting balance, Drawdown type (**Static** / **EOD trailing** only),
  Drawdown amount, Lock-at (optional). Continue → `submitImportBalances()` posts the
  multipart form. Success toast: `Imported N days across M accounts under <firm>`
  (append `, K updated` when `daysUpdated > 0`). Format/validation errors show inline
  in the modal without closing.
- **Render branch (`account_type === 'balance-history'`):**
  - **Card:** stat tiles (Balance / Net P&L / Best / Worst / Days) + cushion line,
    colored by cushion health.
  - **Calendar cell:** daily P&L (from `net_pnl`) big+colored, `balance` small grey
    underneath.
  - **Equity view:** build the daily curve from `daily_stats.balance` for these
    accounts instead of accumulating trade P&L (branch in the equity endpoint at
    server.js:518-523).

## Edge cases

- **$0 / no-trade days** (e.g. Jul 4, weekend): balance carries forward, `net_pnl = 0`,
  neutral cell color. Kept.
- **Restated past day** on re-import: upsert overwrites that `(date, account_id)` with
  the file's latest values. ✔
- **Multiple accounts, same firm:** grouped under one connection; distinct account ids. ✔
- **Balance dips then recovers:** cushion uses the *running peak* for eod_trailing, so
  the limit doesn't fall back when balance recovers. ✔
- **Missing DD config on an existing account** at re-import: keep existing; don't
  overwrite. New accounts get the modal's config. ✔
- **Money parse:** quoted comma values and negatives handled by `parseMoney`.

## Testing

- **`balance-import.js`:** header detection (accept balance-history, reject a trades
  header); `parseMoney` on `"51,126.40"`, `"-1,377.50"`, `0.00`, `""`; multi-account
  grouping into distinct accounts; daily rows carry balance + net_pnl; account
  `balance` = latest day; `realized_pnl` = sum of daily PNL.
- **`cushion.js`:** static limit; eod_trailing limit tracks the running peak; lock
  freezes the limit; cushion sign at/below limit; the real 54823063 series →
  expected peak ($60,311.70 latest, running peak) and a positive cushion vs a
  $50k/$2,500 config.
- **End-to-end (`import-balance-history` logic):** fixture (the sample file, plus a
  second synthetic account) → correct accounts + daily rows written; re-import
  idempotent (second run reports days updated, not duplicated; row count unchanged).
- Tests use Node's built-in `node:test`/`node:assert/strict` (no framework), run via
  `npm test`.

## Non-goals (YAGNI)

- Importing individual trades from this file (it has none).
- Intraday-trailing drawdown for balance-history accounts (no tick data).
- Realized peak-to-trough drawdown display (chose cushion-to-limit; can add later).
- PDF import.
- Inferring firm from the Account Name token.

## Global constraints

- CommonJS; no new npm dependencies; tests use `node:test`/`node:assert/strict`.
- Reuse existing tables/helpers where possible; only additive schema change is
  `daily_stats.balance` (nullable, idempotent ALTER).
- Trade-based accounts and their existing views must be unaffected (branch on
  `account_type`).
- Balance/money values parsed from the file verbatim (comma/quote/sign handling);
  never recomputed.
