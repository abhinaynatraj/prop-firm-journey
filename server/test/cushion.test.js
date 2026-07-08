const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCushion } = require('../cushion');

test('static DD: fixed limit = start - amount', () => {
  const r = computeCushion([50000, 51000, 52000], { starting_balance:50000, drawdown_type:'static', drawdown_amount:2000, drawdown_locks_at:null });
  assert.equal(r.limit, 48000);
  assert.equal(r.currentBalance, 52000);
  assert.equal(r.cushion, 4000);
});

test('eod_trailing: limit trails the running peak', () => {
  // peak 54900 -> limit 52400; current 53560 -> cushion 1160
  const r = computeCushion([54018.9, 54900.5, 51170, 53560], { starting_balance:50000, drawdown_type:'eod_trailing', drawdown_amount:2500, drawdown_locks_at:null });
  assert.equal(r.peakBalance, 54900.5);
  assert.equal(r.limit, 52400.5);
  assert.equal(Math.round(r.cushion * 100) / 100, 1159.5);
});

test('eod_trailing: limit freezes at lock threshold', () => {
  // locks_at 52000: once peak-amount would exceed 52000, limit caps at 52000
  const r = computeCushion([50000, 55000, 60000], { starting_balance:50000, drawdown_type:'eod_trailing', drawdown_amount:2500, drawdown_locks_at:52000 });
  assert.equal(r.limit, 52000);
  assert.equal(r.locked, true);
  assert.equal(r.cushion, 8000);
});

test('cushion is negative below the limit', () => {
  const r = computeCushion([50000, 47000], { starting_balance:50000, drawdown_type:'static', drawdown_amount:2000, drawdown_locks_at:null });
  assert.equal(r.limit, 48000);
  assert.equal(r.cushion, -1000);
});

test('empty series yields null-safe zeros', () => {
  const r = computeCushion([], { starting_balance:50000, drawdown_type:'static', drawdown_amount:2000, drawdown_locks_at:null });
  assert.equal(r.currentBalance, 0);
  assert.equal(r.cushion, 0);
});
