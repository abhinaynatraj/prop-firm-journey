const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
process.env.PFJ_DB_PATH = path.join(os.tmpdir(), `pfj-test-${process.pid}-${process.hrtime.bigint()}.db`);

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
