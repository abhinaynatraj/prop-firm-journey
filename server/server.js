// server.js — Express app
// Binds to 127.0.0.1 only. Provides REST endpoints for the funded-roadmap UI.

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const db = require('./db');
const csvImport = require('./csv-import');
const sync = require('./sync');
const patterns = require('./patterns');
const metrics = require('./metrics');
const drawdown = require('./drawdown');
const equity = require('./equity');
const ocr = require('./ocr');
const accountParser = require('./account-parser');
const topstepxShare = require('./topstepx-share');

const PORT = 3847;
const HOST = '127.0.0.1';

const app = express();
app.use(express.json({ limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage() });

// ─── CORS ─────────────────────────────────────────────────────────────────
// Allow file:// origins (funded-roadmap.html opened as a file) and localhost.

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Health ───────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now(), version: '1.0.0' });
});

// ─── Connections ──────────────────────────────────────────────────────────

app.get('/api/connections', (req, res) => {
  const connections = db.listConnections();
  res.json({ connections });
});

app.post('/api/connections', (req, res) => {
  try {
    const { firm, owner, label } = req.body || {};
    if (!firm || !owner || !label) {
      return res.status(400).json({ error: 'firm, owner, label required' });
    }
    const id = `${firm.toLowerCase()}-${owner.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`;
    db.saveConnection({
      id,
      firm,
      owner,
      label,
      platform: 'csv',
      created_at: Date.now(),
      status: 'new',
    });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/connections/:id', (req, res) => {
  try {
    db.deleteConnection(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Screenshot parsing ───────────────────────────────────────────────────

app.post('/api/parse-screenshot', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no image uploaded' });
    const ocrResult = await ocr.runOCR(req.file.buffer);
    const parsed = accountParser.parseScreenshot(ocrResult);
    // Compute derived starting balance + DD config per row
    parsed.rows = parsed.rows.map(r => ({
      ...r,
      derivedConfig: accountParser.deriveAccountConfig(r),
    }));
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Bulk import: create N accounts + clone trades from CSV or share URL ──
//
// Expects multipart/form-data with:
//   image        — screenshot file (parsed for accounts)
//   csv          — orders CSV (optional if shareUrl given)
//   shareUrl     — TopstepX share URL or tradingAccountId (optional if csv given)
//   firm, owner, label
//
// Returns: { ok, accounts: N, trades: M, connection_id }

const bulkUpload = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'csv', maxCount: 1 },
]);

app.post('/api/bulk-import', bulkUpload, async (req, res) => {
  try {
    const { firm, owner, label, shareUrl, connection_id: targetConnectionId } = req.body || {};
    const imageFile = req.files?.image?.[0];
    const csvFile = req.files?.csv?.[0];
    if (!csvFile && !shareUrl) {
      return res.status(400).json({ error: 'Either csv file or shareUrl required' });
    }

    // ─── Parse screenshot if provided (optional when updating existing) ──
    let parsed = { rows: [], firm: null };
    if (imageFile) {
      const ocrResult = await ocr.runOCR(imageFile.buffer);
      parsed = accountParser.parseScreenshot(ocrResult);
      if (parsed.rows.length === 0) {
        return res.status(400).json({ error: 'No accounts detected in screenshot' });
      }
    }

    // ─── Resolve target connection ──────────────────────────────────────
    let connectionId;
    let existingConnection = null;
    const crypto = require('crypto');
    if (targetConnectionId) {
      // Update existing connection
      existingConnection = db.getConnection(targetConnectionId);
      if (!existingConnection) {
        return res.status(404).json({ error: `Connection not found: ${targetConnectionId}` });
      }
      connectionId = targetConnectionId;
      db.updateConnectionStatus(connectionId, 'ok',
        `Re-imported ${parsed.rows.length || 'trades only'}${parsed.rows.length ? ' account(s)' : ''}`);
    } else {
      if (!firm || !owner || !label) {
        return res.status(400).json({ error: 'firm, owner, label required when creating new connection' });
      }
      if (!imageFile) {
        return res.status(400).json({ error: 'image file required when creating new connection' });
      }
      connectionId = `${firm.toLowerCase()}-${owner.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`;
      db.saveConnection({
        id: connectionId,
        firm,
        owner,
        label,
        platform: 'csv',
        created_at: Date.now(),
        status: 'ok',
        status_message: `Bulk imported ${parsed.rows.length} accounts`,
      });
    }

    // Fetch the source trades — either from CSV or TopstepX share URL
    let baseTrades;
    let sourceDescription;
    if (shareUrl) {
      const shareResult = await topstepxShare.fetchShare(shareUrl);
      const normalized = topstepxShare.toNormalized(shareResult, connectionId);
      baseTrades = normalized.trades;
      sourceDescription = `TopstepX share ${shareResult.tradingAccountId} (${shareResult.accountName})`;
    } else {
      const csvText = csvFile.buffer.toString('utf8');
      const csvParsed = csvImport.importCSV(csvText, connectionId);
      if (csvParsed.trades.length === 0 && csvParsed.fills.length === 0) {
        return res.status(400).json({ error: 'No trades found in CSV' });
      }
      baseTrades = csvParsed.trades;
      sourceDescription = `CSV ${csvFile.originalname || 'upload'}`;
    }
    if (!baseTrades || baseTrades.length === 0) {
      return res.status(400).json({ error: `No trades found in source (${sourceDescription})` });
    }

    let totalTradesCreated = 0;
    const createdAccounts = [];

    // Build the list of target accounts:
    //  - If screenshot provided, use detected rows (create or update)
    //  - Otherwise, use existing accounts under the connection
    let targets;
    if (parsed.rows.length > 0) {
      targets = parsed.rows.map(r => ({
        kind: 'from-screenshot',
        external_id: r.account,
        row: r,
      }));
    } else {
      const existing = db.listAccountsByConnection(connectionId);
      if (existing.length === 0) {
        return res.status(400).json({ error: 'No accounts found under this connection. Upload a screenshot to register accounts first.' });
      }
      targets = existing.map(a => ({
        kind: 'from-db',
        external_id: a.external_id,
        existing: a,
      }));
    }

    for (const tgt of targets) {
      const localId = `${connectionId}-${tgt.external_id}`;

      if (tgt.kind === 'from-screenshot') {
        const row = tgt.row;
        const cfg = accountParser.deriveAccountConfig(row);
        db.saveAccount({
          id: localId,
          connection_id: connectionId,
          external_id: row.account,
          name: row.account,
          account_type: 'bulk-imported',
          balance: row.net_liq ?? null,
          realized_pnl: row.pnl ?? null,
          unrealized_pnl: null,
          equity: row.net_liq ?? null,
          trailing_drawdown: row.trailing ?? null,
          drawdown_lock: null,
          status: 'active',
          last_updated: Date.now(),
        });
        // Save the account config — preserve existing manual_status
        if (cfg.starting_balance != null) {
          const existingCfg = db.getAccountConfig(localId) || {};
          db.saveAccountConfig({
            account_id: localId,
            starting_balance: cfg.starting_balance,
            drawdown_type: cfg.drawdown_type || 'eod_trailing',
            drawdown_amount: cfg.drawdown_amount || 2000,
            drawdown_locks_at: existingCfg.drawdown_locks_at,
            profit_target: existingCfg.profit_target,
            daily_loss_limit: existingCfg.daily_loss_limit,
            manual_status: existingCfg.manual_status,
          });
        }
      } else {
        // Existing DB account — just refresh last_updated, keep balance
        db.saveAccount({
          ...tgt.existing,
          last_updated: Date.now(),
        });
      }

      // Clone trades to this account (deterministic IDs = safe upsert).
      // We rebuild the ID from trade data so re-importing never duplicates.
      const cloned = baseTrades.map(t => ({
        ...t,
        id: `${localId}-T-${t.entry_time}-${t.exit_time}-${t.symbol}-${t.quantity}-${t.entry_price}-${t.exit_price}`,
        account_id: localId,
      }));
      if (cloned.length) db.saveTrades(cloned);
      totalTradesCreated += cloned.length;
      createdAccounts.push(localId);
    }

    sync.rebuildDailyStats(connectionId);

    res.json({
      ok: true,
      connection_id: connectionId,
      accounts: createdAccounts.length,
      trades: totalTradesCreated,
      detected_firm: parsed.firm,
      detected_rows: parsed.rows.length,
    });
  } catch (e) {
    console.error('Bulk import failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── CSV upload ───────────────────────────────────────────────────────────

app.post('/api/connections/:id/import-csv', upload.single('file'), (req, res) => {
  try {
    const conn = db.getConnection(req.params.id);
    if (!conn) return res.status(404).json({ error: 'connection not found' });
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
    const text = req.file.buffer.toString('utf8');
    const result = csvImport.importCSV(text, conn.id);

    for (const a of result.accounts) db.saveAccount(a);
    if (result.fills.length) db.saveFills(result.fills);
    if (result.trades.length) db.saveTrades(result.trades);
    sync.rebuildDailyStats(conn.id);
    db.updateConnectionStatus(conn.id, 'ok',
      `Imported ${result.trades.length} trades, ${result.accounts.length} accounts`);

    res.json({
      ok: true,
      accounts: result.accounts.length,
      fills: result.fills.length,
      trades: result.trades.length,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Accounts ─────────────────────────────────────────────────────────────

app.get('/api/accounts', (req, res) => {
  res.json({ accounts: db.listAccounts() });
});

// ─── Trades / Journal ─────────────────────────────────────────────────────

function parseAccountIdsParam(req) {
  const raw = req.query.account_ids;
  if (!raw) return null;
  const ids = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : null;
}

app.get('/api/trades', (req, res) => {
  const { firm, owner, symbol, from, to } = req.query;
  const filters = {};
  if (firm)   filters.firm = firm;
  if (owner)  filters.owner = owner;
  if (symbol) filters.symbol = symbol;
  if (from)   filters.from = parseInt(from);
  if (to)     filters.to = parseInt(to);
  const accountIds = parseAccountIdsParam(req);
  if (accountIds) filters.account_ids = accountIds;
  res.json({ trades: db.listTradesFiltered(filters) });
});

// ─── Daily stats for calendar ─────────────────────────────────────────────

app.get('/api/daily-stats', (req, res) => {
  const accountIds = parseAccountIdsParam(req);
  if (!accountIds) {
    return res.json({ stats: db.listDailyStats() });
  }
  // Filter: aggregate daily stats from the subset of trades
  const trades = db.listTradesFiltered({ account_ids: accountIds });
  const byDate = {};
  for (const t of trades) {
    const d = new Date(t.entry_time);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!byDate[key]) byDate[key] = { date: key, trade_count: 0, win_count: 0, loss_count: 0, gross_pnl: 0, net_pnl: 0 };
    const row = byDate[key];
    const pnl = t.net_pnl ?? t.pnl ?? 0;
    row.trade_count++;
    if (pnl > 0) row.win_count++;
    else if (pnl < 0) row.loss_count++;
    row.gross_pnl += (t.pnl || 0);
    row.net_pnl += pnl;
  }
  const stats = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  res.json({ stats });
});

// ─── Patterns / recommendations ───────────────────────────────────────────

app.get('/api/patterns', (req, res) => {
  const { firm, owner, symbol, from, to } = req.query;
  const filters = {};
  if (firm)   filters.firm = firm;
  if (owner)  filters.owner = owner;
  if (symbol) filters.symbol = symbol;
  if (from)   filters.from = parseInt(from);
  if (to)     filters.to = parseInt(to);
  const accountIds = parseAccountIdsParam(req);
  if (accountIds) filters.account_ids = accountIds;
  const result = patterns.analyze(filters);
  res.json(result);
});

// ─── Metrics (risk-adjusted) ──────────────────────────────────────────────

app.get('/api/metrics', (req, res) => {
  const { firm, owner, symbol, from, to } = req.query;
  const filters = {};
  if (firm)   filters.firm = firm;
  if (owner)  filters.owner = owner;
  if (symbol) filters.symbol = symbol;
  if (from)   filters.from = parseInt(from);
  if (to)     filters.to = parseInt(to);
  const accountIds = parseAccountIdsParam(req);
  if (accountIds) filters.account_ids = accountIds;
  const trades = db.listTradesFiltered(filters);
  res.json(metrics.computeAll(trades));
});

// ─── Account configs (drawdown rules) ─────────────────────────────────────

app.get('/api/account-configs', (req, res) => {
  res.json({ configs: db.listAccountConfigs() });
});

app.get('/api/accounts/:id/config', (req, res) => {
  const cfg = db.getAccountConfig(req.params.id) || null;
  res.json({ config: cfg });
});

app.post('/api/accounts/:id/config', (req, res) => {
  try {
    const body = req.body || {};
    db.saveAccountConfig({ ...body, account_id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Rename firm (updates all matching connections) ─────────────────────
//
// Replaces connections.firm for every connection matching the current firm
// (optionally filtered by owner). Use this to rename "other" → "bulenox".

app.post('/api/rename-firm', (req, res) => {
  try {
    const { from, to, owner } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });

    // Slug the target if it's not already
    const toSlug = String(to).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!toSlug) return res.status(400).json({ error: 'Invalid target firm name' });

    const where = owner ? 'WHERE firm = ? AND owner = ?' : 'WHERE firm = ?';
    const params = owner ? [toSlug, from, owner] : [toSlug, from];
    const result = db.exec(`UPDATE connections SET firm = ? ${where}`, ...params);

    res.json({ ok: true, to: toSlug, changed: result.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Bulk stage update ───────────────────────────────────────────────────
// Update manual_status (lifecycle stage) for every account matching a
// filter: by firm+owner, by connection_id, or a raw list of account IDs.
// Preserves any existing config values.

app.post('/api/bulk-stage', (req, res) => {
  try {
    const { stage, firm, owner, connection_id, account_ids } = req.body || {};
    if (stage === undefined) return res.status(400).json({ error: 'stage required (or null to reset to Auto)' });

    let targets;
    if (Array.isArray(account_ids) && account_ids.length > 0) {
      const all = db.listAccounts();
      const idSet = new Set(account_ids);
      targets = all.filter(a => idSet.has(a.id));
    } else if (connection_id) {
      targets = db.listAccountsByConnection(connection_id);
    } else if (firm || owner) {
      targets = db.listAccounts().filter(a =>
        (!firm  || a.firm  === firm) &&
        (!owner || a.owner === owner)
      );
    } else {
      return res.status(400).json({ error: 'Specify account_ids, connection_id, or firm/owner' });
    }

    if (targets.length === 0) {
      return res.json({ ok: true, updated: 0, message: 'No matching accounts' });
    }

    const manualStatus = (stage === null || stage === '' || stage === 'auto') ? null : stage;
    let updated = 0;
    for (const acct of targets) {
      const existing = db.getAccountConfig(acct.id) || {};
      db.saveAccountConfig({
        account_id: acct.id,
        starting_balance:  existing.starting_balance  ?? 50000,
        drawdown_type:     existing.drawdown_type     ?? 'eod_trailing',
        drawdown_amount:   existing.drawdown_amount   ?? 2000,
        drawdown_locks_at: existing.drawdown_locks_at ?? null,
        profit_target:     existing.profit_target     ?? null,
        daily_loss_limit:  existing.daily_loss_limit  ?? null,
        notes:             existing.notes             ?? null,
        manual_status:     manualStatus,
      });
      updated++;
    }
    res.json({ ok: true, updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Drawdown calculation ─────────────────────────────────────────────────

app.get('/api/accounts/:id/drawdown', (req, res) => {
  try {
    const accountId = req.params.id;
    const cfg = db.getAccountConfig(accountId);
    if (!cfg) return res.status(404).json({ error: 'No config set for this account. Configure starting balance and DD rules first.' });
    const trades = db.query('SELECT * FROM trades WHERE account_id = ? ORDER BY entry_time ASC', accountId);
    const result = drawdown.compute(trades, cfg);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Equity curves ────────────────────────────────────────────────────────

app.get('/api/accounts/:id/equity', (req, res) => {
  try {
    const accountId = req.params.id;
    const cfg = db.getAccountConfig(accountId);
    const start = cfg ? cfg.starting_balance : 0;
    const trades = db.query('SELECT * FROM trades WHERE account_id = ? ORDER BY entry_time ASC', accountId);
    res.json({
      curve: equity.buildCurve(trades, start),
      daily: equity.buildDailyCurve(trades, start),
      starting_balance: start,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/equity', (req, res) => {
  // Aggregate equity curve across all accounts (no starting balance)
  const trades = db.listTradesFiltered({});
  res.json({
    curve: equity.buildCurve(trades, 0),
    daily: equity.buildDailyCurve(trades, 0),
  });
});

// ─── Trade notes ──────────────────────────────────────────────────────────

app.get('/api/trades/:id/note', (req, res) => {
  const note = db.getTradeNote(req.params.id);
  res.json({ note: note || null });
});

app.post('/api/trades/:id/note', (req, res) => {
  try {
    db.saveTradeNote({ ...req.body, trade_id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/trade-notes', (req, res) => {
  res.json({ notes: db.listTradeNotes() });
});

// ─── Day notes ────────────────────────────────────────────────────────────

app.get('/api/days/:date/note', (req, res) => {
  const note = db.getDayNote(req.params.date);
  res.json({ note: note || null });
});

app.post('/api/days/:date/note', (req, res) => {
  try {
    db.saveDayNote({ ...req.body, date: req.params.date });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/day-notes', (req, res) => {
  res.json({ notes: db.listDayNotes() });
});

// ─── Serve funded-roadmap.html from parent dir ────────────────────────────

app.use('/', express.static(path.join(__dirname, '..')));

// ─── Start ────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`\n Prop Firm Journey server running`);
  console.log(`  http://${HOST}:${PORT}/index.html`);
  console.log(`  API: http://${HOST}:${PORT}/api/health`);
  console.log(`\n  Data dir: ${path.join(__dirname, '.data')}`);
  console.log(`  Mode: manual CSV upload`);
  console.log(`  Press Ctrl+C to stop\n`);
});
