// equity.js — equity curve generator
// Builds per-trade and per-day equity curves, including peak, drawdown,
// and underwater curve data ready for charting.

function pnlOf(t) { return t.net_pnl ?? t.pnl ?? 0; }

function buildCurve(trades, startingBalance = 0) {
  const sorted = [...trades].sort((a, b) => a.entry_time - b.entry_time);
  let equity = startingBalance;
  let peak = startingBalance;
  const points = [];
  for (const t of sorted) {
    equity += pnlOf(t);
    if (equity > peak) peak = equity;
    points.push({
      time: t.exit_time || t.entry_time,
      equity,
      peak,
      drawdown: peak - equity,
      underwater: peak > 0 ? -((peak - equity) / peak) * 100 : 0,
      tradeId: t.id,
      symbol: t.symbol,
      pnl: pnlOf(t),
    });
  }
  return points;
}

function buildDailyCurve(trades, startingBalance = 0) {
  const byDate = {};
  for (const t of trades) {
    const d = new Date(t.entry_time);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDate[key] = (byDate[key] || 0) + pnlOf(t);
  }
  const dates = Object.keys(byDate).sort();
  let equity = startingBalance;
  let peak = startingBalance;
  return dates.map(date => {
    equity += byDate[date];
    if (equity > peak) peak = equity;
    return {
      date,
      equity,
      peak,
      drawdown: peak - equity,
      dailyPnl: byDate[date],
    };
  });
}

module.exports = { buildCurve, buildDailyCurve };
