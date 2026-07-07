# Tradovate Performance Import — Design

**Date:** 2026-07-06
**Status:** Approved, ready for implementation plan

## Problem

Users can export a **Performance report** from Tradovate's Performance/Trades tab.
This report lists already-closed (paired) trades — one row per trade with a signed
P&L — which is a different shape from the raw-fill CSVs the app already imports
(`tradovate-orders`, `tradovate-export`). Today there is no way to import this file.
The user wants to import it and have the trades split by day.

The reference file is a Tradovate Performance PDF; the user will upload the **CSV**
equivalent (Tradovate's Performance tab offers a CSV/Excel export with the same
columns).

## Decisions (locked)

1. **Input format:** CSV only. No PDF parsing, no new dependency.
2. **Account mapping:** Upload into a user-chosen connection via the existing
   per-connection "Upload CSV" flow. The Performance export has no account column;
   all rows attach to a single account under the chosen connection.
3. **"Split by day":** No new grouping code. Once trades land with a correct
   `entry_time`, the existing `rebuildDailyStats`, `/api/daily-stats`, and Calendar
   heatmap already bucket per day.
4. **P&L / direction:** Trust the file's signed `P&L` column verbatim. Infer times
   (`entry = earlier`, `exit = later`) and side from timestamp order. **Never**
   recompute P&L from prices — that would flip the sign on covered shorts.
5. **Approach:** Add a `tradovate-performance` case to the existing `csv-import.js`
   pipeline (not a separate module, not by overloading `generic-trades`).

## Architecture & data flow

No new endpoint, no schema change, no new dependency. Reuses the whole existing
pipeline:

```
Frontend "Upload CSV" button (existing, accept=".csv")
  → POST /api/connections/:id/import-csv          (existing)
  → csvImport.importCSV(text, connectionId)        (existing entry point)
      → detectFormat(headers)                       (+1 branch: 'tradovate-performance')
      → normalizeTradovatePerformance(objs, connId) (NEW, ~60 lines)
  → db.saveAccount / db.saveTrades                  (existing)
  → sync.rebuildDailyStats(connId)                  (existing → this splits by day)
```

## Components

### 1. `detectFormat()` — new branch (`server/csv-import.js`)

Signature columns of the Performance export: `Buy Price` + `Sell Price` + `P&L`.
Distinct from `tradovate-orders` (`B/S`, `Avg Fill Price`) and `generic-trades`
(`Entry Price`/`Exit Price`).

```js
if (h.includes('buy price') && h.includes('sell price') && (h.includes('p&l') || h.includes('pnl')))
  return 'tradovate-performance';
```

Placed **before** the `generic-trades` check so a Tradovate file wins.

### 2. `normalizeTradovatePerformance(objs, connectionId)` — new function

Returns the standard `{ accounts, fills, trades }` shape. `fills` is empty (rows are
already paired trades).

Single account for the whole file:
- `id = ${connectionId}-perf`
- `external_id` / `name` = connection label (or `"Performance"` fallback)
- `account_type: 'tradovate-performance'`

Per row:

| Field | Source / rule |
|---|---|
| `symbol` | `Symbol` (e.g. `MNQU6`) |
| `quantity` | `Qty` |
| `buyTime`, `sellTime` | `parseTimestamp(Buy Time)`, `parseTimestamp(Sell Time)` |
| `entry_time` | `min(buyTime, sellTime)` |
| `exit_time` | `max(buyTime, sellTime)` |
| `side` | `buyTime <= sellTime` → `long`, else `short` |
| `entry_price` | price of whichever leg is the entry (buy price if long, sell price if short) |
| `exit_price` | the other leg's price |
| `pnl`, `net_pnl` | `parseMoney(P&L)` verbatim (already net at row level) |
| `commission` | `0` (per-row P&L is already net; fee breakdown only exists in aggregate) |
| `duration_sec` | `max(0, floor((exit_time - entry_time)/1000))`; if a timestamp is missing, fall back to parsing the `Duration` text |
| `hour_of_day` | `new Date(entry_time).getHours()` |
| `day_of_week` | `new Date(entry_time).getDay()` |

**Deterministic trade ID** (idempotent re-import, matching existing pattern):

```
${accountId}-TP-${entry_time}-${exit_time}-${symbol}-${quantity}-${pnl}
```

Including `pnl` disambiguates same-second, same-price rows (e.g. the eleven
`29581.75 @ 18:25:25` micro rows in the sample).

Account `realized_pnl` = sum of `net_pnl` across the file's trades (same as the other
normalizers).

### 3. `parseMoney(str)` — new helper

- `"$(205.00)"` → `-205`
- `"$294.00"` → `294`
- `"$(1,150.00)"` → `-1150`
- `"$0.00"` → `0`

Strips `$` and commas; parentheses denote negative.

Timestamps reuse the existing `parseTimestamp()` — Tradovate's
`07/01/2026 09:03:11` parses via `new Date`.

### 4. Frontend

**No change required.** The existing per-connection "Upload CSV" button already:
- accepts `.csv`
- posts to `/api/connections/:id/import-csv`
- shows a success toast with the trade count

Optional trivial polish (only if cheap): surface a "Tradovate Performance" label in
the success message.

## Edge cases

- **Covered shorts** (Sell Time < Buy Time, e.g. sample row 1: `$(205.00)`): handled
  by `min/max` on timestamps + side inference. P&L kept verbatim (correctly negative).
- **Sub-second scalps** with blank Duration and equal buy/sell time: `duration_sec = 0`,
  side defaults to `long`.
- **Breakeven `$0.00` rows:** `net_pnl = 0`, kept (they belong to the breakeven bucket).
- **Duplicate-looking rows:** distinct IDs via `pnl`+`qty` in the key. Two *genuinely*
  identical rows in one file collapse to one — acceptable and consistent with the
  existing importers' idempotency model.

## Testing

Fixture CSV derived from the sample PDF, including at least:
- a covered-short row (negative P&L, Sell Time before Buy Time),
- a breakeven `$0.00` row,
- a cluster of same-second micro rows.

Assertions:
1. P&L signs correct for both longs and covered shorts (from the file, not recomputed).
2. `entry_time <= exit_time` for every trade; side inferred correctly.
3. Trades bucket into the right days via `rebuildDailyStats` / `/api/daily-stats`.
4. Idempotent re-import: importing the same file twice yields the same trade count.

## Non-goals (YAGNI)

- PDF parsing.
- A dedicated per-day report UI (the Calendar/Journal already split by day).
- Multi-account performance files (the export is single-account).
- Reconstructing exchange/clearing/NFA fee breakdown (only exists in aggregate;
  the row P&L is already net).
