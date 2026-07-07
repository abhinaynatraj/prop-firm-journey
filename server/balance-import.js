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

function isBalanceHistory(headers) {
  const h = headers.map(x => String(x).toLowerCase().trim());
  return h.includes('account id') && h.includes('trade date') &&
         h.includes('total amount') && h.includes('total realized pnl');
}

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

module.exports = { parseMoney, isBalanceHistory, parse };
