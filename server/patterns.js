// patterns.js — pattern analysis over the unified trades table
// Computes hour-of-day, day-of-week, symbol, duration bucket stats,
// consistency score, drawdown events, over-trading warnings, revenge flags.
// Also wraps metrics.js for risk-adjusted ratios.

const db = require('./db');
const metrics = require('./metrics');

function analyze(filters = {}) {
  const trades = db.listTradesFiltered(filters);
  if (trades.length === 0) {
    return { empty: true, tradeCount: 0 };
  }

  // ─── Aggregations ────────────────────────────────────────────────────────

  const byHour = Array.from({ length: 24 }, () => ({ count: 0, wins: 0, pnl: 0, losses: 0 }));
  const byDay = Array.from({ length: 7 }, () => ({ count: 0, wins: 0, pnl: 0, losses: 0 }));
  const bySymbol = {};
  const byDuration = { scalp: {count:0,pnl:0,wins:0}, short: {count:0,pnl:0,wins:0}, medium: {count:0,pnl:0,wins:0}, long: {count:0,pnl:0,wins:0} };
  const byAccount = {};
  const byDate = {};

  let wins = 0, losses = 0, totalPnl = 0, totalCommission = 0;
  let grossWins = 0, grossLosses = 0;
  let maxWin = -Infinity, maxLoss = Infinity;

  for (const t of trades) {
    const pnl = t.net_pnl ?? t.pnl ?? 0;
    totalPnl += pnl;
    totalCommission += t.commission || 0;
    if (pnl > 0) { wins++; grossWins += pnl; if (pnl > maxWin) maxWin = pnl; }
    else if (pnl < 0) { losses++; grossLosses += pnl; if (pnl < maxLoss) maxLoss = pnl; }

    // By hour
    const h = t.hour_of_day ?? new Date(t.entry_time).getHours();
    byHour[h].count++;
    byHour[h].pnl += pnl;
    if (pnl > 0) byHour[h].wins++;
    else if (pnl < 0) byHour[h].losses++;

    // By day of week
    const d = t.day_of_week ?? new Date(t.entry_time).getDay();
    byDay[d].count++;
    byDay[d].pnl += pnl;
    if (pnl > 0) byDay[d].wins++;
    else if (pnl < 0) byDay[d].losses++;

    // By symbol
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { count: 0, wins: 0, pnl: 0 };
    bySymbol[t.symbol].count++;
    bySymbol[t.symbol].pnl += pnl;
    if (pnl > 0) bySymbol[t.symbol].wins++;

    // By duration
    const dur = t.duration_sec || 0;
    let bucket;
    if (dur < 60) bucket = 'scalp';          // <1 min
    else if (dur < 300) bucket = 'short';    // 1-5 min
    else if (dur < 1800) bucket = 'medium';  // 5-30 min
    else bucket = 'long';                    // 30+ min
    byDuration[bucket].count++;
    byDuration[bucket].pnl += pnl;
    if (pnl > 0) byDuration[bucket].wins++;

    // By account
    const acctKey = `${t.firm}-${t.owner}-${t.account_name}`;
    if (!byAccount[acctKey]) byAccount[acctKey] = { count: 0, wins: 0, pnl: 0, firm: t.firm, owner: t.owner, name: t.account_name };
    byAccount[acctKey].count++;
    byAccount[acctKey].pnl += pnl;
    if (pnl > 0) byAccount[acctKey].wins++;

    // By date
    const dt = new Date(t.entry_time);
    const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    if (!byDate[dateStr]) byDate[dateStr] = { count: 0, pnl: 0 };
    byDate[dateStr].count++;
    byDate[dateStr].pnl += pnl;
  }

  // ─── Derived stats ───────────────────────────────────────────────────────

  const winRate = trades.length ? wins / trades.length : 0;
  const avgWin = wins ? grossWins / wins : 0;
  const avgLoss = losses ? grossLosses / losses : 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  const profitFactor = grossLosses !== 0 ? Math.abs(grossWins / grossLosses) : grossWins;

  // Best/worst hours
  const hourStats = byHour.map((s, h) => ({ hour: h, ...s, winRate: s.count ? s.wins / s.count : 0 }));
  const bestHours = [...hourStats].filter(h => h.count >= 3).sort((a, b) => b.pnl - a.pnl).slice(0, 3);
  const worstHours = [...hourStats].filter(h => h.count >= 3).sort((a, b) => a.pnl - b.pnl).slice(0, 3);

  // Best/worst days of week
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dayStats = byDay.map((s, d) => ({ day: dayNames[d], index: d, ...s, winRate: s.count ? s.wins / s.count : 0 }));
  const bestDays = [...dayStats].filter(d => d.count >= 3).sort((a, b) => b.pnl - a.pnl).slice(0, 3);
  const worstDays = [...dayStats].filter(d => d.count >= 3).sort((a, b) => a.pnl - b.pnl).slice(0, 3);

  // Best/worst symbols
  const symbolStats = Object.entries(bySymbol).map(([symbol, s]) => ({ symbol, ...s, winRate: s.count ? s.wins / s.count : 0 }));
  const bestSymbols = [...symbolStats].sort((a, b) => b.pnl - a.pnl).slice(0, 5);
  const worstSymbols = [...symbolStats].sort((a, b) => a.pnl - b.pnl).slice(0, 3).filter(s => s.pnl < 0);

  // Duration analysis
  const durationStats = Object.entries(byDuration).map(([bucket, s]) => ({
    bucket, ...s, winRate: s.count ? s.wins / s.count : 0
  }));

  // Consistency score: stdev of daily P&L / mean daily P&L
  const dailyPnls = Object.values(byDate).map(d => d.pnl);
  const meanDaily = dailyPnls.reduce((s, x) => s + x, 0) / (dailyPnls.length || 1);
  const variance = dailyPnls.reduce((s, x) => s + (x - meanDaily) ** 2, 0) / (dailyPnls.length || 1);
  const stdevDaily = Math.sqrt(variance);
  const consistencyScore = meanDaily !== 0 ? Math.max(0, Math.min(100, 100 - (stdevDaily / Math.abs(meanDaily)) * 20)) : 50;

  // Over-trading days (>20 trades)
  const overtradingDays = Object.entries(byDate)
    .filter(([, s]) => s.count > 20)
    .map(([date, s]) => ({ date, count: s.count, pnl: s.pnl }))
    .sort((a, b) => b.count - a.count);

  // Worst drawdown days (biggest single-day losses)
  const drawdownDays = Object.entries(byDate)
    .filter(([, s]) => s.pnl < 0)
    .map(([date, s]) => ({ date, count: s.count, pnl: s.pnl }))
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, 5);

  // Revenge trading detector: losing trade followed by new entry within 60s on same symbol
  const revengeEvents = [];
  const sortedTrades = [...trades].sort((a, b) => a.entry_time - b.entry_time);
  for (let i = 0; i < sortedTrades.length - 1; i++) {
    const a = sortedTrades[i];
    const aPnl = a.net_pnl ?? a.pnl ?? 0;
    if (aPnl >= 0) continue;
    const aExit = a.exit_time;
    for (let j = i + 1; j < sortedTrades.length; j++) {
      const b = sortedTrades[j];
      if (b.account_id !== a.account_id) continue;
      if (b.symbol !== a.symbol) continue;
      const gap = b.entry_time - aExit;
      if (gap > 60_000) break;
      if (gap >= 0) {
        revengeEvents.push({
          date: new Date(a.exit_time).toISOString(),
          symbol: a.symbol,
          lossPnl: aPnl,
          followPnl: b.net_pnl ?? b.pnl ?? 0,
          gapSec: Math.floor(gap / 1000),
        });
      }
    }
  }

  // ─── Risk-adjusted metrics from metrics.js ───────────────────────────────
  const allMetrics = metrics.computeAll(trades);

  // Recommendations
  const recs = [];
  if (worstHours.length && worstHours[0].pnl < 0) {
    recs.push({
      severity: 'warning',
      text: `Avoid trading at ${worstHours[0].hour}:00 — you've lost $${Math.abs(worstHours[0].pnl).toFixed(0)} over ${worstHours[0].count} trades (${(worstHours[0].winRate * 100).toFixed(0)}% win rate)`,
    });
  }
  if (bestHours.length && bestHours[0].pnl > 0) {
    recs.push({
      severity: 'success',
      text: `Your best hour is ${bestHours[0].hour}:00 — $${bestHours[0].pnl.toFixed(0)} profit over ${bestHours[0].count} trades (${(bestHours[0].winRate * 100).toFixed(0)}% win rate)`,
    });
  }
  if (revengeEvents.length > 3) {
    recs.push({
      severity: 'danger',
      text: `${revengeEvents.length} revenge-trade events detected (re-entered within 60s of a loss). Net impact is typically negative.`,
    });
  }
  if (overtradingDays.length > 0) {
    recs.push({
      severity: 'warning',
      text: `${overtradingDays.length} day(s) with >20 trades. Over-trading days averaged $${(overtradingDays.reduce((s, d) => s + d.pnl, 0) / overtradingDays.length).toFixed(0)} P&L.`,
    });
  }
  if (worstSymbols.length > 0) {
    recs.push({
      severity: 'warning',
      text: `${worstSymbols[0].symbol} is unprofitable — $${worstSymbols[0].pnl.toFixed(0)} over ${worstSymbols[0].count} trades`,
    });
  }
  if (consistencyScore < 40) {
    recs.push({
      severity: 'warning',
      text: `Low consistency score (${consistencyScore.toFixed(0)}/100). Daily P&L varies too widely — work on stable returns.`,
    });
  }

  // Risk-adjusted recommendations
  if (allMetrics.sharpe !== undefined) {
    if (allMetrics.sharpe > 2) {
      recs.push({ severity: 'success', text: `Excellent Sharpe ratio (${allMetrics.sharpe.toFixed(2)}). Risk-adjusted returns are strong.` });
    } else if (allMetrics.sharpe < 0.5 && allMetrics.tradingDays > 10) {
      recs.push({ severity: 'warning', text: `Low Sharpe ratio (${allMetrics.sharpe.toFixed(2)}). Returns aren't compensating for volatility.` });
    }
    if (allMetrics.profitFactor < 1 && allMetrics.tradeCount > 20) {
      recs.push({ severity: 'danger', text: `Profit factor below 1 (${allMetrics.profitFactor.toFixed(2)}). Strategy is losing money — review setups.` });
    } else if (allMetrics.profitFactor > 2) {
      recs.push({ severity: 'success', text: `Strong profit factor (${allMetrics.profitFactor.toFixed(2)}). Wins are outsizing losses well.` });
    }
    if (allMetrics.recoveryFactor < 1 && allMetrics.maxDrawdown > 0) {
      recs.push({ severity: 'warning', text: `Recovery factor (${allMetrics.recoveryFactor.toFixed(2)}) is low — drawdowns exceed total profits.` });
    }
    if (allMetrics.maxLossStreak >= 5) {
      recs.push({ severity: 'warning', text: `Max losing streak: ${allMetrics.maxLossStreak} trades ($${allMetrics.maxLossStreakValue.toFixed(0)}). Consider a daily loss circuit-breaker.` });
    }
    if (allMetrics.avgWinLossRatio < 1 && allMetrics.winRate < 0.5) {
      recs.push({ severity: 'danger', text: `Win rate (${(allMetrics.winRate * 100).toFixed(0)}%) AND avg win/loss ratio (${allMetrics.avgWinLossRatio.toFixed(2)}) are both poor. Strategy needs fundamental rework.` });
    }
  }

  return {
    metrics: allMetrics,
    tradeCount: trades.length,
    wins, losses,
    winRate,
    totalPnl,
    totalCommission,
    grossWins,
    grossLosses,
    avgWin,
    avgLoss,
    expectancy,
    profitFactor,
    maxWin: maxWin === -Infinity ? 0 : maxWin,
    maxLoss: maxLoss === Infinity ? 0 : maxLoss,
    consistencyScore,
    hourStats,
    dayStats,
    bestHours,
    worstHours,
    bestDays,
    worstDays,
    bestSymbols,
    worstSymbols,
    durationStats,
    byAccount: Object.values(byAccount).sort((a, b) => b.pnl - a.pnl),
    overtradingDays,
    drawdownDays,
    revengeEvents: revengeEvents.slice(0, 20),
    recommendations: recs,
  };
}

module.exports = { analyze };
