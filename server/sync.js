// sync.js — daily stats rollup (no live data sync since Tradovate removed)
//
// All data comes from manual CSV uploads, screenshot bulk imports, and the
// public TopstepX share URL. This module now only exposes `rebuildDailyStats`
// which is called after any data is added.

const db = require('./db');

function rebuildDailyStats(connectionId) {
  const accounts = db.listAccountsByConnection(connectionId);
  for (const acct of accounts) {
    const trades = db.query(
      'SELECT * FROM trades WHERE account_id = ? ORDER BY entry_time ASC',
      acct.id
    );
    const byDate = {};
    for (const t of trades) {
      const d = new Date(t.entry_time);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!byDate[dateStr]) {
        byDate[dateStr] = { trade_count: 0, win_count: 0, loss_count: 0, gross_pnl: 0, net_pnl: 0 };
      }
      const s = byDate[dateStr];
      s.trade_count++;
      if (t.net_pnl > 0) s.win_count++;
      else if (t.net_pnl < 0) s.loss_count++;
      s.gross_pnl += t.pnl;
      s.net_pnl += t.net_pnl || t.pnl;
    }
    for (const [date, s] of Object.entries(byDate)) {
      db.saveDailyStat({
        date,
        account_id: acct.id,
        trade_count: s.trade_count,
        win_count: s.win_count,
        loss_count: s.loss_count,
        gross_pnl: s.gross_pnl,
        net_pnl: s.net_pnl,
      });
    }
  }
}

module.exports = {
  rebuildDailyStats,
};
