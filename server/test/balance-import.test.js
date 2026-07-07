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

const { isBalanceHistory } = require('../balance-import');

test('isBalanceHistory accepts the balance export header', () => {
  const h = ['Account ID','Account Name','Trade Date','Total Amount','Total Realized PNL'];
  assert.equal(isBalanceHistory(h), true);
});
test('isBalanceHistory rejects a trades header', () => {
  const h = ['Symbol','Qty','Buy Price','Sell Price','P&L'];
  assert.equal(isBalanceHistory(h), false);
});

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
  assert.equal(a.balance, 58000.00);   // latest date 2026-07-08 (below the 60,311.70 max, so latest != max)
  assert.equal(Math.round(a.realized_pnl * 100) / 100, Math.round((1332.30 + 881.60 - 2230.50 + 2390.00 + 1626.00 - 2311.70) * 100) / 100);
});

test('daily rows carry balance and net_pnl, keyed by date+account', () => {
  const r = parse(FIX, 'connA');
  const rows = r.dailyRows.filter(x => x.account_id === 'connA-54823063');
  assert.equal(rows.length, 6);
  const dip = rows.find(x => x.date === '2026-06-29');
  assert.equal(dip.net_pnl, -2230.5);
  assert.equal(dip.balance, 51170.00);
  assert.equal(dip.trade_count, 0);
  // latest-day balance must NOT be the max: 2026-07-07 ($60,311.70) is higher than the latest day
  const a = r.accounts.find(x => x.external_id === '54823063');
  const earlier = rows.find(x => x.date === '2026-07-07');
  assert.ok(a.balance < earlier.balance);   // 58000 < 60311.70 — a Math.max() impl would fail this
});

test('second account grouped independently', () => {
  const r = parse(FIX, 'connA');
  const b = r.accounts.find(x => x.external_id === '99999999');
  assert.equal(b.balance, 25100.00);   // latest 2026-07-07
});
