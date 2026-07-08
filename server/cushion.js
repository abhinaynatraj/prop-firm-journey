// cushion.js — distance from current balance to the drawdown blow-up limit,
// from a daily end-of-day balance series + the account's DD config.
// Supports 'static' and 'eod_trailing'. (intraday needs tick data we don't have.)

function computeCushion(dailyBalances, config) {
  const cfg = config || {};
  const amount = Number(cfg.drawdown_amount) || 0;
  const start = Number(cfg.starting_balance) || 0;
  const locksAt = cfg.drawdown_locks_at == null ? null : Number(cfg.drawdown_locks_at);

  if (!dailyBalances || dailyBalances.length === 0) {
    return { currentBalance: 0, peakBalance: 0, limit: start - amount, cushion: 0, cushionPct: 0, locked: false };
  }

  const currentBalance = dailyBalances[dailyBalances.length - 1];
  const peakBalance = Math.max(...dailyBalances, start);

  let limit;
  let locked = false;
  if (cfg.drawdown_type === 'eod_trailing') {
    let trailed = peakBalance - amount;
    if (locksAt != null && trailed >= locksAt) { trailed = locksAt; locked = true; }
    limit = trailed;
  } else {
    // static (default)
    limit = start - amount;
  }

  const cushion = currentBalance - limit;
  const cushionPct = currentBalance !== 0 ? (cushion / currentBalance) * 100 : 0;
  return { currentBalance, peakBalance, limit, cushion, cushionPct, locked };
}

module.exports = { computeCushion };
