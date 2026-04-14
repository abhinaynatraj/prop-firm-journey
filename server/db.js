// db.js — SQLite schema and query helpers
// One database file lives at .data/trades.db
// Holds connections, accounts, fills, trades, daily_stats.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '.data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const DB_PATH = path.join(DATA_DIR, 'trades.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    firm TEXT NOT NULL,
    owner TEXT NOT NULL,
    label TEXT NOT NULL,
    platform TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_sync_at INTEGER,
    status TEXT,
    status_message TEXT
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    name TEXT,
    account_type TEXT,
    balance REAL,
    realized_pnl REAL,
    unrealized_pnl REAL,
    equity REAL,
    trailing_drawdown REAL,
    drawdown_lock REAL,
    status TEXT,
    last_updated INTEGER,
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS fills (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    timestamp INTEGER NOT NULL,
    order_id TEXT,
    commission REAL,
    realized_pnl REAL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_fills_account ON fills(account_id);
  CREATE INDEX IF NOT EXISTS idx_fills_timestamp ON fills(timestamp);

  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL NOT NULL,
    entry_time INTEGER NOT NULL,
    exit_time INTEGER NOT NULL,
    duration_sec INTEGER,
    pnl REAL NOT NULL,
    commission REAL,
    net_pnl REAL,
    hour_of_day INTEGER,
    day_of_week INTEGER,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_trades_account ON trades(account_id);
  CREATE INDEX IF NOT EXISTS idx_trades_entry ON trades(entry_time);
  CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

  CREATE TABLE IF NOT EXISTS daily_stats (
    date TEXT NOT NULL,
    account_id TEXT NOT NULL,
    trade_count INTEGER,
    win_count INTEGER,
    loss_count INTEGER,
    gross_pnl REAL,
    net_pnl REAL,
    max_drawdown REAL,
    PRIMARY KEY (date, account_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Per-account drawdown rules and starting balance
  CREATE TABLE IF NOT EXISTS account_configs (
    account_id TEXT PRIMARY KEY,
    starting_balance REAL NOT NULL DEFAULT 50000,
    drawdown_type TEXT NOT NULL DEFAULT 'eod_trailing', -- 'static', 'eod_trailing', 'intraday_trailing'
    drawdown_amount REAL NOT NULL DEFAULT 2000,
    drawdown_locks_at REAL,                              -- balance at which DD stops trailing (e.g. starting + DD)
    profit_target REAL,                                  -- optional eval target
    daily_loss_limit REAL,                               -- optional DLL
    manual_status TEXT,                                  -- 'auto' | 'eval' | 'funded' | 'payout' | 'failed'
    notes TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Per-trade notes and tags
  CREATE TABLE IF NOT EXISTS trade_notes (
    trade_id TEXT PRIMARY KEY,
    note TEXT,
    tags TEXT,                                            -- comma-separated
    rating INTEGER,                                       -- 1-5 self-rating
    setup TEXT,                                           -- e.g. "breakout", "reversal"
    updated_at INTEGER,
    FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE
  );

  -- Per-day notes (journal entries)
  CREATE TABLE IF NOT EXISTS day_notes (
    date TEXT PRIMARY KEY,
    note TEXT,
    mood INTEGER,                                          -- 1-5
    tags TEXT,
    updated_at INTEGER
  );
`);

// Idempotent ALTER TABLE for schemas created by older versions
// (SQLite lacks "ADD COLUMN IF NOT EXISTS")
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumnIfMissing('account_configs', 'manual_status', 'TEXT');

// ─── Connections ───────────────────────────────────────────────────────────

const insertConnection = db.prepare(`
  INSERT OR REPLACE INTO connections (id, firm, owner, label, platform, created_at, last_sync_at, status, status_message)
  VALUES (@id, @firm, @owner, @label, @platform, @created_at, @last_sync_at, @status, @status_message)
`);

const getConnectionStmt = db.prepare('SELECT * FROM connections WHERE id = ?');
const listConnectionsStmt = db.prepare('SELECT * FROM connections ORDER BY firm, owner, label');
const deleteConnectionStmt = db.prepare('DELETE FROM connections WHERE id = ?');
const updateConnectionStatusStmt = db.prepare(`
  UPDATE connections SET status = ?, status_message = ?, last_sync_at = ? WHERE id = ?
`);

// ─── Accounts ──────────────────────────────────────────────────────────────

const upsertAccount = db.prepare(`
  INSERT INTO accounts (id, connection_id, external_id, name, account_type, balance, realized_pnl, unrealized_pnl, equity, trailing_drawdown, drawdown_lock, status, last_updated)
  VALUES (@id, @connection_id, @external_id, @name, @account_type, @balance, @realized_pnl, @unrealized_pnl, @equity, @trailing_drawdown, @drawdown_lock, @status, @last_updated)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    account_type = excluded.account_type,
    balance = excluded.balance,
    realized_pnl = excluded.realized_pnl,
    unrealized_pnl = excluded.unrealized_pnl,
    equity = excluded.equity,
    trailing_drawdown = excluded.trailing_drawdown,
    drawdown_lock = excluded.drawdown_lock,
    status = excluded.status,
    last_updated = excluded.last_updated
`);

const listAccountsStmt = db.prepare(`
  SELECT a.*, c.firm, c.owner, c.label AS connection_label, c.platform,
    COALESCE((SELECT SUM(t.net_pnl) FROM trades t WHERE t.account_id = a.id), 0) AS net_pnl_from_trades,
    COALESCE((SELECT COUNT(*)      FROM trades t WHERE t.account_id = a.id), 0) AS trade_count_from_trades
  FROM accounts a
  JOIN connections c ON a.connection_id = c.id
  ORDER BY c.firm, c.owner, a.name
`);

const listAccountsByConnectionStmt = db.prepare('SELECT * FROM accounts WHERE connection_id = ?');

// ─── Fills ─────────────────────────────────────────────────────────────────

const insertFill = db.prepare(`
  INSERT OR IGNORE INTO fills (id, account_id, symbol, side, quantity, price, timestamp, order_id, commission, realized_pnl)
  VALUES (@id, @account_id, @symbol, @side, @quantity, @price, @timestamp, @order_id, @commission, @realized_pnl)
`);

const listFillsByAccountStmt = db.prepare('SELECT * FROM fills WHERE account_id = ? ORDER BY timestamp ASC');

// ─── Trades ────────────────────────────────────────────────────────────────

const insertTrade = db.prepare(`
  INSERT OR REPLACE INTO trades (id, account_id, symbol, side, quantity, entry_price, exit_price, entry_time, exit_time, duration_sec, pnl, commission, net_pnl, hour_of_day, day_of_week)
  VALUES (@id, @account_id, @symbol, @side, @quantity, @entry_price, @exit_price, @entry_time, @exit_time, @duration_sec, @pnl, @commission, @net_pnl, @hour_of_day, @day_of_week)
`);

const listTradesStmt = db.prepare(`
  SELECT t.*, a.name AS account_name, c.firm, c.owner
  FROM trades t
  JOIN accounts a ON t.account_id = a.id
  JOIN connections c ON a.connection_id = c.id
  ORDER BY t.entry_time DESC
`);

const listTradesFilteredStmt = (where, params) => {
  const sql = `
    SELECT t.*, a.name AS account_name, c.firm, c.owner
    FROM trades t
    JOIN accounts a ON t.account_id = a.id
    JOIN connections c ON a.connection_id = c.id
    ${where}
    ORDER BY t.entry_time DESC
    LIMIT 5000
  `;
  return db.prepare(sql).all(params);
};

// ─── Daily stats ───────────────────────────────────────────────────────────

const upsertDailyStat = db.prepare(`
  INSERT OR REPLACE INTO daily_stats (date, account_id, trade_count, win_count, loss_count, gross_pnl, net_pnl, max_drawdown)
  VALUES (@date, @account_id, @trade_count, @win_count, @loss_count, @gross_pnl, @net_pnl, @max_drawdown)
`);

const listDailyStatsStmt = db.prepare(`
  SELECT date, SUM(trade_count) AS trade_count, SUM(win_count) AS win_count,
         SUM(loss_count) AS loss_count, SUM(gross_pnl) AS gross_pnl, SUM(net_pnl) AS net_pnl
  FROM daily_stats
  GROUP BY date
  ORDER BY date ASC
`);

const listDailyStatsByAccountStmt = db.prepare(`
  SELECT date, account_id, trade_count, win_count, loss_count, gross_pnl, net_pnl
  FROM daily_stats
  WHERE account_id = ?
  ORDER BY date ASC
`);

// ─── Account configs ───────────────────────────────────────────────────────

const upsertAccountConfig = db.prepare(`
  INSERT INTO account_configs (account_id, starting_balance, drawdown_type, drawdown_amount, drawdown_locks_at, profit_target, daily_loss_limit, manual_status, notes)
  VALUES (@account_id, @starting_balance, @drawdown_type, @drawdown_amount, @drawdown_locks_at, @profit_target, @daily_loss_limit, @manual_status, @notes)
  ON CONFLICT(account_id) DO UPDATE SET
    starting_balance = excluded.starting_balance,
    drawdown_type = excluded.drawdown_type,
    drawdown_amount = excluded.drawdown_amount,
    drawdown_locks_at = excluded.drawdown_locks_at,
    profit_target = excluded.profit_target,
    daily_loss_limit = excluded.daily_loss_limit,
    manual_status = excluded.manual_status,
    notes = excluded.notes
`);
const getAccountConfigStmt = db.prepare('SELECT * FROM account_configs WHERE account_id = ?');
const listAccountConfigsStmt = db.prepare('SELECT * FROM account_configs');

// ─── Trade notes ───────────────────────────────────────────────────────────

const upsertTradeNote = db.prepare(`
  INSERT INTO trade_notes (trade_id, note, tags, rating, setup, updated_at)
  VALUES (@trade_id, @note, @tags, @rating, @setup, @updated_at)
  ON CONFLICT(trade_id) DO UPDATE SET
    note = excluded.note,
    tags = excluded.tags,
    rating = excluded.rating,
    setup = excluded.setup,
    updated_at = excluded.updated_at
`);
const getTradeNoteStmt = db.prepare('SELECT * FROM trade_notes WHERE trade_id = ?');
const listTradeNotesStmt = db.prepare('SELECT * FROM trade_notes');

// ─── Day notes ─────────────────────────────────────────────────────────────

const upsertDayNote = db.prepare(`
  INSERT INTO day_notes (date, note, mood, tags, updated_at)
  VALUES (@date, @note, @mood, @tags, @updated_at)
  ON CONFLICT(date) DO UPDATE SET
    note = excluded.note,
    mood = excluded.mood,
    tags = excluded.tags,
    updated_at = excluded.updated_at
`);
const getDayNoteStmt = db.prepare('SELECT * FROM day_notes WHERE date = ?');
const listDayNotesStmt = db.prepare('SELECT * FROM day_notes ORDER BY date DESC');

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  db,

  // Connections
  saveConnection(conn) {
    insertConnection.run({
      id: conn.id,
      firm: conn.firm,
      owner: conn.owner,
      label: conn.label,
      platform: conn.platform,
      created_at: conn.created_at || Date.now(),
      last_sync_at: conn.last_sync_at || null,
      status: conn.status || 'new',
      status_message: conn.status_message || null,
    });
  },
  getConnection: (id) => getConnectionStmt.get(id),
  listConnections: () => listConnectionsStmt.all(),
  deleteConnection: (id) => deleteConnectionStmt.run(id),
  updateConnectionStatus(id, status, message) {
    updateConnectionStatusStmt.run(status, message || null, Date.now(), id);
  },

  // Accounts
  saveAccount(account) {
    upsertAccount.run({
      id: account.id,
      connection_id: account.connection_id,
      external_id: account.external_id,
      name: account.name || null,
      account_type: account.account_type || null,
      balance: account.balance ?? null,
      realized_pnl: account.realized_pnl ?? null,
      unrealized_pnl: account.unrealized_pnl ?? null,
      equity: account.equity ?? null,
      trailing_drawdown: account.trailing_drawdown ?? null,
      drawdown_lock: account.drawdown_lock ?? null,
      status: account.status || null,
      last_updated: account.last_updated || Date.now(),
    });
  },
  listAccounts: () => listAccountsStmt.all(),
  listAccountsByConnection: (cid) => listAccountsByConnectionStmt.all(cid),

  // Fills
  saveFill(fill) {
    insertFill.run({
      id: fill.id,
      account_id: fill.account_id,
      symbol: fill.symbol,
      side: fill.side,
      quantity: fill.quantity,
      price: fill.price,
      timestamp: fill.timestamp,
      order_id: fill.order_id || null,
      commission: fill.commission ?? null,
      realized_pnl: fill.realized_pnl ?? null,
    });
  },
  saveFills(fills) {
    const tx = db.transaction((fs) => { for (const f of fs) insertFill.run(f); });
    tx(fills.map(f => ({
      id: f.id,
      account_id: f.account_id,
      symbol: f.symbol,
      side: f.side,
      quantity: f.quantity,
      price: f.price,
      timestamp: f.timestamp,
      order_id: f.order_id || null,
      commission: f.commission ?? null,
      realized_pnl: f.realized_pnl ?? null,
    })));
  },
  listFillsByAccount: (aid) => listFillsByAccountStmt.all(aid),

  // Trades
  saveTrade(trade) {
    insertTrade.run({
      id: trade.id,
      account_id: trade.account_id,
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      entry_price: trade.entry_price,
      exit_price: trade.exit_price,
      entry_time: trade.entry_time,
      exit_time: trade.exit_time,
      duration_sec: trade.duration_sec ?? null,
      pnl: trade.pnl,
      commission: trade.commission ?? null,
      net_pnl: trade.net_pnl ?? trade.pnl,
      hour_of_day: trade.hour_of_day ?? null,
      day_of_week: trade.day_of_week ?? null,
    });
  },
  saveTrades(trades) {
    const tx = db.transaction((ts) => {
      for (const t of ts) insertTrade.run({
        id: t.id,
        account_id: t.account_id,
        symbol: t.symbol,
        side: t.side,
        quantity: t.quantity,
        entry_price: t.entry_price,
        exit_price: t.exit_price,
        entry_time: t.entry_time,
        exit_time: t.exit_time,
        duration_sec: t.duration_sec ?? null,
        pnl: t.pnl,
        commission: t.commission ?? null,
        net_pnl: t.net_pnl ?? t.pnl,
        hour_of_day: t.hour_of_day ?? null,
        day_of_week: t.day_of_week ?? null,
      });
    });
    tx(trades);
  },
  listTrades: () => listTradesStmt.all(),
  listTradesFiltered(filters = {}) {
    const conditions = [];
    const params = {};
    if (filters.firm)    { conditions.push('c.firm = @firm'); params.firm = filters.firm; }
    if (filters.owner)   { conditions.push('c.owner = @owner'); params.owner = filters.owner; }
    if (filters.symbol)  { conditions.push('t.symbol = @symbol'); params.symbol = filters.symbol; }
    if (filters.from)    { conditions.push('t.entry_time >= @from'); params.from = filters.from; }
    if (filters.to)      { conditions.push('t.entry_time <= @to'); params.to = filters.to; }
    if (Array.isArray(filters.account_ids) && filters.account_ids.length > 0) {
      // SQLite doesn't support array bindings with better-sqlite3; inline the IDs safely
      // by validating them as simple strings (letters, digits, dashes, underscores, dots)
      const safe = filters.account_ids.filter(id => /^[A-Za-z0-9_\-.:]+$/.test(id));
      if (safe.length === 0) {
        // Filter present but no valid IDs → match nothing
        conditions.push('1 = 0');
      } else {
        const list = safe.map(id => `'${id}'`).join(',');
        conditions.push(`t.account_id IN (${list})`);
      }
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    return listTradesFilteredStmt(where, params);
  },

  // Daily stats
  saveDailyStat(stat) {
    upsertDailyStat.run({
      date: stat.date,
      account_id: stat.account_id,
      trade_count: stat.trade_count,
      win_count: stat.win_count,
      loss_count: stat.loss_count,
      gross_pnl: stat.gross_pnl,
      net_pnl: stat.net_pnl,
      max_drawdown: stat.max_drawdown ?? null,
    });
  },
  listDailyStats: () => listDailyStatsStmt.all(),
  listDailyStatsByAccount: (id) => listDailyStatsByAccountStmt.all(id),

  // Account configs
  saveAccountConfig(cfg) {
    upsertAccountConfig.run({
      account_id: cfg.account_id,
      starting_balance: cfg.starting_balance ?? 50000,
      drawdown_type: cfg.drawdown_type ?? 'eod_trailing',
      drawdown_amount: cfg.drawdown_amount ?? 2000,
      drawdown_locks_at: cfg.drawdown_locks_at ?? null,
      profit_target: cfg.profit_target ?? null,
      daily_loss_limit: cfg.daily_loss_limit ?? null,
      manual_status: cfg.manual_status ?? null,
      notes: cfg.notes ?? null,
    });
  },
  getAccountConfig: (id) => getAccountConfigStmt.get(id),
  listAccountConfigs: () => listAccountConfigsStmt.all(),

  // Trade notes
  saveTradeNote(note) {
    upsertTradeNote.run({
      trade_id: note.trade_id,
      note: note.note ?? null,
      tags: note.tags ?? null,
      rating: note.rating ?? null,
      setup: note.setup ?? null,
      updated_at: Date.now(),
    });
  },
  getTradeNote: (id) => getTradeNoteStmt.get(id),
  listTradeNotes: () => listTradeNotesStmt.all(),

  // Day notes
  saveDayNote(note) {
    upsertDayNote.run({
      date: note.date,
      note: note.note ?? null,
      mood: note.mood ?? null,
      tags: note.tags ?? null,
      updated_at: Date.now(),
    });
  },
  getDayNote: (date) => getDayNoteStmt.get(date),
  listDayNotes: () => listDayNotesStmt.all(),

  // Raw query (SELECT)
  query(sql, ...args) {
    return db.prepare(sql).all(...args);
  },
  // Raw execute (UPDATE/INSERT/DELETE)
  exec(sql, ...args) {
    return db.prepare(sql).run(...args);
  },
};
