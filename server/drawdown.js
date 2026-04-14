// drawdown.js — Trailing drawdown calculator for prop firm rules
//
// Three modes:
//   - static:           DD measured from starting balance (never moves)
//   - eod_trailing:     DD trails the highest end-of-day balance, locks at lock_at
//   - intraday_trailing:DD trails the highest intraday equity, locks at lock_at
//
// All return { current_equity, peak_balance, dd_threshold, distance_to_dd, locked, history }

function pnlOf(t) { return t.net_pnl ?? t.pnl ?? 0; }

function dateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function compute(trades, config) {
  const cfg = {
    starting_balance: 50000,
    drawdown_type: 'eod_trailing',
    drawdown_amount: 2000,
    drawdown_locks_at: null,
    ...config,
  };

  const sorted = [...trades].sort((a, b) => a.entry_time - b.entry_time);
  const start = cfg.starting_balance;
  const lockAt = cfg.drawdown_locks_at; // absolute balance value where DD stops trailing

  let equity = start;
  let peak = start;
  let locked = false;
  let lockedThreshold = null;
  const history = [];

  // ─── Static DD ───────────────────────────────────────────────────────────
  if (cfg.drawdown_type === 'static') {
    const threshold = start - cfg.drawdown_amount;
    let busted = false;
    for (const t of sorted) {
      equity += pnlOf(t);
      if (equity <= threshold) busted = true;
      history.push({
        time: t.exit_time || t.entry_time,
        equity,
        peak: start,
        threshold,
        distance: equity - threshold,
        locked: false,
        busted,
      });
    }
    return {
      type: 'static',
      starting_balance: start,
      drawdown_amount: cfg.drawdown_amount,
      current_equity: equity,
      peak_balance: start,
      dd_threshold: threshold,
      distance_to_dd: equity - threshold,
      locked: false,
      busted,
      history,
    };
  }

  // ─── EOD Trailing DD ─────────────────────────────────────────────────────
  if (cfg.drawdown_type === 'eod_trailing') {
    // Group trades by date. At the end of each day, update peak with EOD balance,
    // then recompute threshold from the new peak unless locked.
    const byDate = {};
    for (const t of sorted) {
      const k = dateKey(t.entry_time);
      if (!byDate[k]) byDate[k] = [];
      byDate[k].push(t);
    }
    const dates = Object.keys(byDate).sort();
    let busted = false;
    for (const date of dates) {
      const dayTrades = byDate[date];
      // Process intraday: equity moves but threshold does NOT trail until EOD
      for (const t of dayTrades) {
        equity += pnlOf(t);
        const threshold = locked ? lockedThreshold : (peak - cfg.drawdown_amount);
        if (equity <= threshold) busted = true;
        history.push({
          time: t.exit_time || t.entry_time,
          equity,
          peak,
          threshold,
          distance: equity - threshold,
          locked,
          busted,
        });
      }
      // EOD: update peak if equity > peak, check lock
      if (!locked && equity > peak) {
        peak = equity;
        if (lockAt !== null && peak >= lockAt) {
          locked = true;
          lockedThreshold = lockAt - cfg.drawdown_amount;
        }
      }
    }
    const currentThreshold = locked ? lockedThreshold : (peak - cfg.drawdown_amount);
    return {
      type: 'eod_trailing',
      starting_balance: start,
      drawdown_amount: cfg.drawdown_amount,
      current_equity: equity,
      peak_balance: peak,
      dd_threshold: currentThreshold,
      distance_to_dd: equity - currentThreshold,
      locked,
      locks_at: lockAt,
      busted,
      history,
    };
  }

  // ─── Intraday Trailing DD ────────────────────────────────────────────────
  if (cfg.drawdown_type === 'intraday_trailing') {
    let busted = false;
    for (const t of sorted) {
      equity += pnlOf(t);
      if (!locked && equity > peak) {
        peak = equity;
        if (lockAt !== null && peak >= lockAt) {
          locked = true;
          lockedThreshold = lockAt - cfg.drawdown_amount;
        }
      }
      const threshold = locked ? lockedThreshold : (peak - cfg.drawdown_amount);
      if (equity <= threshold) busted = true;
      history.push({
        time: t.exit_time || t.entry_time,
        equity,
        peak,
        threshold,
        distance: equity - threshold,
        locked,
        busted,
      });
    }
    const currentThreshold = locked ? lockedThreshold : (peak - cfg.drawdown_amount);
    return {
      type: 'intraday_trailing',
      starting_balance: start,
      drawdown_amount: cfg.drawdown_amount,
      current_equity: equity,
      peak_balance: peak,
      dd_threshold: currentThreshold,
      distance_to_dd: equity - currentThreshold,
      locked,
      locks_at: lockAt,
      busted,
      history,
    };
  }

  throw new Error(`Unknown drawdown type: ${cfg.drawdown_type}`);
}

module.exports = { compute };
