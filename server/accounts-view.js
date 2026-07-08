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
