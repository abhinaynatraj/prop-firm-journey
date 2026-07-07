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

module.exports = { parseMoney, isBalanceHistory };
