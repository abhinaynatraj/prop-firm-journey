const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDailyCurveFromBalances } = require('../equity');

test('buildDailyCurveFromBalances maps balances to equity, sorted by date', () => {
  const rows = [
    { date: '2026-07-08', balance: 58000, net_pnl: -2311.7 },
    { date: '2026-06-25', balance: 54018.9, net_pnl: 1332.3 },
    { date: '2026-07-07', balance: 60311.7, net_pnl: 1626 },
  ];
  const curve = buildDailyCurveFromBalances(rows);
  assert.equal(curve.length, 3);
  // sorted ascending by date
  assert.deepEqual(curve.map(c => c.date), ['2026-06-25', '2026-07-07', '2026-07-08']);
  // equity IS the stored balance
  assert.equal(curve[0].equity, 54018.9);
  assert.equal(curve[2].equity, 58000);
  // dailyPnl carried from net_pnl
  assert.equal(curve[2].dailyPnl, -2311.7);
});

test('peak is the running max and drawdown = peak - equity', () => {
  const rows = [
    { date: '2026-07-07', balance: 60311.7, net_pnl: 1626 },   // new high
    { date: '2026-07-08', balance: 58000, net_pnl: -2311.7 },  // dip below peak
  ];
  const curve = buildDailyCurveFromBalances(rows);
  assert.equal(curve[0].peak, 60311.7);
  assert.equal(curve[0].drawdown, 0);
  assert.equal(curve[1].peak, 60311.7);                        // peak holds (running max)
  assert.equal(Math.round(curve[1].drawdown * 100) / 100, 2311.7);
});

test('skips null-balance rows and handles empty input', () => {
  assert.deepEqual(buildDailyCurveFromBalances([]), []);
  const curve = buildDailyCurveFromBalances([
    { date: '2026-07-01', balance: null, net_pnl: 0 },
    { date: '2026-07-02', balance: 100, net_pnl: 5 },
  ]);
  assert.equal(curve.length, 1);
  assert.equal(curve[0].equity, 100);
});
