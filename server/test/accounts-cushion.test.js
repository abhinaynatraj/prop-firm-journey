const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
process.env.PFJ_DB_PATH = path.join(os.tmpdir(), `pfj-test-${process.pid}-${process.hrtime.bigint()}.db`);

const db = require('../db');
const { importBalanceHistory } = require('../import-balance');
const { attachCushion } = require('../accounts-view');

const FIX = fs.readFileSync(path.join(__dirname,'fixtures','balance-history-sample.csv'),'utf8');

// Unique firm name per run to avoid connection reuse from stale test runs
const uniqFirm = 'apex-cushion-' + process.pid + '-' + Number(process.hrtime.bigint() % 100000n);

test('attachCushion adds a cushion object to balance-history accounts', () => {
  const r = importBalanceHistory(FIX, { firm: uniqFirm, startingBalance:50000, drawdownType:'eod_trailing', drawdownAmount:2500 });
  const accounts = db.listAccounts().filter(a => a.connection_id === r.connectionId);
  const withCushion = attachCushion(accounts, db);
  const a = withCushion.find(x => x.external_id === '54823063');
  assert.ok(a.cushion);
  assert.equal(a.cushion.currentBalance, 58000);        // latest day 2026-07-08
  assert.equal(a.cushion.peakBalance, 60311.70);        // running peak (earlier high)
  // eod_trailing: limit = peak 60311.70 - 2500 = 57811.70
  assert.equal(a.cushion.limit, 57811.70);
  // cushion = 58000 - 57811.70 = 188.30 (still positive but thinner than at peak)
  assert.equal(Math.round(a.cushion.cushion * 100) / 100, 188.30);
});
