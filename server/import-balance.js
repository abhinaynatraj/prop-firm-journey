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
