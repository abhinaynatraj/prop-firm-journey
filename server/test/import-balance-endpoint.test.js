const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
process.env.PFJ_DB_PATH = path.join(os.tmpdir(), `pfj-test-${process.pid}-${process.hrtime.bigint()}.db`);

const db = require('../db');
const { importBalanceHistory } = require('../import-balance');

const FIX = fs.readFileSync(path.join(__dirname,'fixtures','balance-history-sample.csv'),'utf8');

// Unique firm names per test run to ensure re-runnable tests
let testCounter = 0;
const uniq = () => 'apex-' + process.pid + '-' + (testCounter++);

test('rejects a non-balance CSV', () => {
  assert.throws(() => importBalanceHistory('Symbol,Qty\nMNQ,1', { firm:'apex' }),
    /Account Balance History/);
});

test('imports accounts + daily rows and reports counts', () => {
  const r = importBalanceHistory(FIX, { firm:uniq(), startingBalance:50000, drawdownType:'eod_trailing', drawdownAmount:2500 });
  assert.equal(r.accounts.length, 2);
  assert.equal(r.daysImported, 8);   // 6 rows for 54823063 + 2 for 99999999
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
  const firm = uniq();
  const opts = { firm, startingBalance:50000, drawdownType:'static', drawdownAmount:2000 };
  const first = importBalanceHistory(FIX, opts);
  const second = importBalanceHistory(FIX, opts);
  assert.equal(second.connectionId, first.connectionId); // reused firm connection
  assert.equal(second.daysImported, 0);
  assert.equal(second.daysUpdated, 8);   // all 8 rows already present
  // daily rows not duplicated
  const rows = db.listDailyStatsByAccount(first.connectionId + '-54823063');
  assert.equal(rows.length, 6);   // hardened fixture has 6 rows for this account
});

test('re-import does not overwrite an edited account config', () => {
  const firm = uniq();
  const opts = { firm, startingBalance:50000, drawdownType:'static', drawdownAmount:2000 };
  const first = importBalanceHistory(FIX, opts);
  const acctId = first.connectionId + '-54823063';
  // user edits config via the gear panel
  db.saveAccountConfig({ account_id:acctId, starting_balance:50000, drawdown_type:'eod_trailing', drawdown_amount:3000, drawdown_locks_at:null, profit_target:null, daily_loss_limit:null, manual_status:null, notes:null });
  // re-import with different modal values
  importBalanceHistory(FIX, { firm, startingBalance:50000, drawdownType:'static', drawdownAmount:2000 });
  const cfg = db.getAccountConfig(acctId);
  assert.equal(cfg.drawdown_amount, 3000); // preserved, not clobbered
});
