// metrics.js — risk-adjusted performance metrics
// Computes Sharpe, Sortino, Calmar, Recovery Factor, K-ratio, Win/Loss streaks,
// max drawdown, R-multiple stats, expectancy, and trade-level streak detection.

// All inputs are arrays of trades (objects with at least net_pnl/pnl and entry_time).

function pnlOf(t) { return t.net_pnl ?? t.pnl ?? 0; }

// ─── Returns helpers ─────────────────────────────────────────────────────────

function dailyPnls(trades) {
  // Group trades by date (YYYY-MM-DD using local time of entry)
  const byDate = {};
  for (const t of trades) {
    const d = new Date(t.entry_time);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDate[key] = (byDate[key] || 0) + pnlOf(t);
  }
  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, pnl]) => ({ date, pnl }));
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stdev(arr, m = null) {
  if (arr.length < 2) return 0;
  if (m === null) m = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function downsideDeviation(arr, target = 0) {
  if (arr.length === 0) return 0;
  const downside = arr.map(x => Math.min(0, x - target) ** 2);
  return Math.sqrt(downside.reduce((s, x) => s + x, 0) / arr.length);
}

// ─── Sharpe Ratio ──────────────────────────────────────────────────────────
// Annualized using sqrt(252) trading days.
// Risk-free rate assumed 0 for short-duration day trading.

function sharpeRatio(daily) {
  if (daily.length < 2) return 0;
  const pnls = daily.map(d => d.pnl);
  const m = mean(pnls);
  const sd = stdev(pnls, m);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(252);
}

// ─── Sortino Ratio ─────────────────────────────────────────────────────────
// Like Sharpe but only penalizes downside volatility.

function sortinoRatio(daily) {
  if (daily.length < 2) return 0;
  const pnls = daily.map(d => d.pnl);
  const m = mean(pnls);
  const dd = downsideDeviation(pnls, 0);
  if (dd === 0) return 0;
  return (m / dd) * Math.sqrt(252);
}

// ─── Max Drawdown (from cumulative equity curve) ───────────────────────────

function maxDrawdown(daily) {
  if (daily.length === 0) return { maxDD: 0, maxDDDate: null, maxRunup: 0 };
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  let maxDDDate = null;
  let maxRunup = 0;
  for (const d of daily) {
    cum += d.pnl;
    if (cum > peak) peak = cum;
    if (cum > maxRunup) maxRunup = cum;
    const dd = peak - cum;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDDate = d.date;
    }
  }
  return { maxDD, maxDDDate, maxRunup, finalEquity: cum };
}

// ─── Calmar Ratio ──────────────────────────────────────────────────────────
// Annualized return / max drawdown. Higher is better.

function calmarRatio(daily) {
  if (daily.length < 2) return 0;
  const totalReturn = daily.reduce((s, d) => s + d.pnl, 0);
  const tradingDays = daily.length;
  const annualized = (totalReturn / tradingDays) * 252;
  const { maxDD } = maxDrawdown(daily);
  if (maxDD === 0) return totalReturn > 0 ? Infinity : 0;
  return annualized / maxDD;
}

// ─── Recovery Factor ───────────────────────────────────────────────────────
// Net profit / max drawdown. >2 is healthy, >5 is excellent.

function recoveryFactor(trades) {
  const totalProfit = trades.reduce((s, t) => s + pnlOf(t), 0);
  const { maxDD } = maxDrawdown(dailyPnls(trades));
  if (maxDD === 0) return totalProfit > 0 ? Infinity : 0;
  return totalProfit / maxDD;
}

// ─── Profit Factor ─────────────────────────────────────────────────────────
// Gross profit / gross loss. >1.5 is healthy.

function profitFactor(trades) {
  let gross_w = 0, gross_l = 0;
  for (const t of trades) {
    const p = pnlOf(t);
    if (p > 0) gross_w += p;
    else if (p < 0) gross_l += Math.abs(p);
  }
  if (gross_l === 0) return gross_w > 0 ? Infinity : 0;
  return gross_w / gross_l;
}

// ─── Expectancy ────────────────────────────────────────────────────────────
// Average $ profit per trade.

function expectancy(trades) {
  if (trades.length === 0) return 0;
  return trades.reduce((s, t) => s + pnlOf(t), 0) / trades.length;
}

// ─── Win Rate ──────────────────────────────────────────────────────────────

function winRate(trades) {
  if (trades.length === 0) return 0;
  return trades.filter(t => pnlOf(t) > 0).length / trades.length;
}

// ─── Streaks ───────────────────────────────────────────────────────────────

function streaks(trades) {
  let curStreak = 0;
  let curType = null;
  let maxWinStreak = 0, maxLossStreak = 0;
  let curWinStreakValue = 0, curLossStreakValue = 0;
  let maxWinStreakValue = 0, maxLossStreakValue = 0;
  const sorted = [...trades].sort((a, b) => a.entry_time - b.entry_time);
  for (const t of sorted) {
    const p = pnlOf(t);
    if (p > 0) {
      if (curType === 'win') { curStreak++; curWinStreakValue += p; }
      else { curStreak = 1; curType = 'win'; curWinStreakValue = p; }
      if (curStreak > maxWinStreak) maxWinStreak = curStreak;
      if (curWinStreakValue > maxWinStreakValue) maxWinStreakValue = curWinStreakValue;
    } else if (p < 0) {
      if (curType === 'loss') { curStreak++; curLossStreakValue += p; }
      else { curStreak = 1; curType = 'loss'; curLossStreakValue = p; }
      if (curStreak > maxLossStreak) maxLossStreak = curStreak;
      if (curLossStreakValue < maxLossStreakValue) maxLossStreakValue = curLossStreakValue;
    } else {
      curStreak = 0; curType = null;
    }
  }
  return {
    currentStreak: curStreak,
    currentStreakType: curType,
    maxWinStreak,
    maxLossStreak,
    maxWinStreakValue,
    maxLossStreakValue,
  };
}

// ─── Trade-level metrics ───────────────────────────────────────────────────

function tradeStats(trades) {
  const wins = trades.filter(t => pnlOf(t) > 0);
  const losses = trades.filter(t => pnlOf(t) < 0);
  const grossWins = wins.reduce((s, t) => s + pnlOf(t), 0);
  const grossLosses = losses.reduce((s, t) => s + pnlOf(t), 0);
  const avgWin = wins.length ? grossWins / wins.length : 0;
  const avgLoss = losses.length ? grossLosses / losses.length : 0;
  const winRatePct = trades.length ? wins.length / trades.length : 0;
  const expectancyVal = winRatePct * avgWin + (1 - winRatePct) * avgLoss;
  const largestWin = wins.length ? Math.max(...wins.map(pnlOf)) : 0;
  const largestLoss = losses.length ? Math.min(...losses.map(pnlOf)) : 0;
  const avgWinLossRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
  return {
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: winRatePct,
    grossWins,
    grossLosses,
    avgWin,
    avgLoss,
    largestWin,
    largestLoss,
    avgWinLossRatio,
    expectancy: expectancyVal,
    netPnl: trades.reduce((s, t) => s + pnlOf(t), 0),
  };
}

// ─── R-Multiple analysis (using avg loss as 1R) ────────────────────────────

function rMultiples(trades) {
  const losses = trades.filter(t => pnlOf(t) < 0);
  if (losses.length === 0) return { avgR: 0, expectancyR: 0, perTrade: [] };
  const oneR = Math.abs(losses.reduce((s, t) => s + pnlOf(t), 0) / losses.length);
  if (oneR === 0) return { avgR: 0, expectancyR: 0, perTrade: [] };
  const perTrade = trades.map(t => ({ id: t.id, r: pnlOf(t) / oneR }));
  return {
    oneR,
    avgR: perTrade.reduce((s, t) => s + t.r, 0) / perTrade.length,
    expectancyR: perTrade.reduce((s, t) => s + t.r, 0) / perTrade.length,
    perTrade,
  };
}

// ─── Combined snapshot ─────────────────────────────────────────────────────

function computeAll(trades) {
  if (trades.length === 0) return { empty: true };
  const daily = dailyPnls(trades);
  const t = tradeStats(trades);
  const dd = maxDrawdown(daily);
  const r = rMultiples(trades);
  const s = streaks(trades);
  return {
    ...t,
    sharpe: sharpeRatio(daily),
    sortino: sortinoRatio(daily),
    calmar: calmarRatio(daily),
    profitFactor: profitFactor(trades),
    recoveryFactor: recoveryFactor(trades),
    maxDrawdown: dd.maxDD,
    maxDrawdownDate: dd.maxDDDate,
    maxRunup: dd.maxRunup,
    avgR: r.avgR,
    oneR: r.oneR,
    ...s,
    tradingDays: daily.length,
    daily,
  };
}

module.exports = {
  computeAll,
  dailyPnls,
  sharpeRatio,
  sortinoRatio,
  calmarRatio,
  maxDrawdown,
  profitFactor,
  recoveryFactor,
  expectancy,
  winRate,
  streaks,
  tradeStats,
  rMultiples,
};
