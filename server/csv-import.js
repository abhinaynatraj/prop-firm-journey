// csv-import.js — CSV import for TopstepX and generic CSV sources
// Parses uploaded CSVs and normalizes them into the same fill/trade format
// produced by the Tradovate client, so downstream code is identical.

// Minimal CSV parser — handles quoted fields with commas and newlines.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function rowsToObjects(rows) {
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length === headers.length && r.some(c => c.trim())).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i]; });
    return obj;
  });
}

// ─── TopstepX format detection ─────────────────────────────────────────────
// TopstepX trade export typically has columns like:
//   Id, AccountId, OrderId, ContractId, ContractName, Side, Size, Price,
//   Time, Fees, PnL, Type
// We also accept variants that Topstep's SPA produces.

function detectFormat(headers) {
  const h = headers.map(x => x.toLowerCase().trim());
  if (h.includes('contractname') && h.includes('pnl')) return 'topstepx-trades';
  if (h.includes('activity') && h.includes('message type') && h.includes('related id')) return 'tradovate-export';
  if (h.includes('orderid') && h.includes('b/s') && (h.includes('avgprice') || h.includes('avg fill price'))) return 'tradovate-orders';
  if (h.includes('symbol') && h.includes('entry price') && h.includes('exit price')) return 'generic-trades';
  return 'unknown';
}

// ─── Normalizers ───────────────────────────────────────────────────────────
// All normalizers return:
//   { accounts: [{external_id, name}], fills: [...], trades: [...] }
// (We leave connection_id empty — caller fills it.)

function parseTimestamp(s) {
  if (!s) return 0;
  // Try a few common formats
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getTime();
  return 0;
}

function normalizeTopstepXTrades(objs, connectionId) {
  const accountMap = {};
  const trades = [];
  for (const o of objs) {
    const extAcct = String(o.AccountId || o.accountId || o.Account || '').trim();
    if (!extAcct) continue;
    const localAcct = `${connectionId}-${extAcct}`;
    accountMap[extAcct] = {
      id: localAcct,
      external_id: extAcct,
      name: extAcct,
    };
    const symbol = o.ContractName || o.contractName || o.Symbol || 'UNKNOWN';
    const side = (o.Side || o.side || '').toLowerCase() === 'buy' ? 'long' : 'short';
    const size = parseFloat(o.Size || o.size || o.Quantity || 0) || 0;
    const price = parseFloat(o.Price || o.price || 0) || 0;
    const pnl = parseFloat(o.PnL || o.pnl || o.Profit || 0) || 0;
    const fees = parseFloat(o.Fees || o.fees || o.Commission || 0) || 0;
    const time = parseTimestamp(o.Time || o.time || o.Timestamp || o.EntryTime);
    const exit = parseTimestamp(o.ExitTime || o.exitTime) || time;

    trades.push({
      id: `${connectionId}-tsx-${o.Id || o.id || `${extAcct}-${time}-${symbol}`}`,
      account_id: localAcct,
      symbol,
      side,
      quantity: Math.abs(size),
      entry_price: price,
      exit_price: parseFloat(o.ExitPrice || o.exitPrice) || price,
      entry_time: time,
      exit_time: exit,
      duration_sec: Math.max(0, Math.floor((exit - time) / 1000)),
      pnl,
      commission: fees,
      net_pnl: pnl - fees,
      hour_of_day: new Date(time).getHours(),
      day_of_week: new Date(time).getDay(),
    });
  }
  return {
    accounts: Object.values(accountMap).map(a => ({
      ...a,
      connection_id: connectionId,
      account_type: 'topstepx',
      balance: null,
      realized_pnl: trades.filter(t => t.account_id === a.id).reduce((s, t) => s + t.net_pnl, 0),
      unrealized_pnl: null,
      equity: null,
      trailing_drawdown: null,
      drawdown_lock: null,
      status: 'active',
      last_updated: Date.now(),
    })),
    fills: [],
    trades,
  };
}

function normalizeTradovateExport(objs, connectionId) {
  // This handles the order-activity CSV we used for the compliance response.
  // Each row is an order event; we only derive fills from Fill/Partial Fill rows.
  const accountMap = {};
  const fills = [];
  let fillCounter = 0;
  for (const o of objs) {
    const msgType = o['Message Type'] || '';
    if (!msgType.toLowerCase().includes('fill')) continue;
    const extAcct = String(o.Account || '').trim();
    if (!extAcct) continue;
    const localAcct = `${connectionId}-${extAcct}`;
    accountMap[extAcct] = { id: localAcct, external_id: extAcct, name: extAcct };
    const side = (o.Side || '').toLowerCase() === 'b' ? 'buy' : 'sell';
    fillCounter++;
    const ts = parseTimestamp(o.Time);
    // Deterministic fill ID keyed on raw source fields
    fills.push({
      id: `${localAcct}-F-${ts}-${o['Related ID'] || fillCounter}-${side}-${o.Price}`,
      account_id: localAcct,
      symbol: o.Symbol || o.Product || 'UNKNOWN',
      side,
      quantity: parseFloat(o.Quantity) || 0,
      price: parseFloat(o.Price) || 0,
      timestamp: ts,
      order_id: o['Related ID'] || null,
      commission: null,
      realized_pnl: null,
    });
  }
  // Pair fills into trades (FIFO)
  const trades = pairFillsIntoTrades(fills, connectionId);
  return {
    accounts: Object.values(accountMap).map(a => ({
      ...a,
      connection_id: connectionId,
      account_type: 'tradovate-csv',
      balance: null,
      realized_pnl: trades.filter(t => t.account_id === a.id).reduce((s, t) => s + t.net_pnl, 0),
      unrealized_pnl: null,
      equity: null,
      trailing_drawdown: null,
      drawdown_lock: null,
      status: 'active',
      last_updated: Date.now(),
    })),
    fills,
    trades,
  };
}

function normalizeTradovateOrders(objs, connectionId) {
  // Tradovate "Orders" export format. Each row is an order; we keep only
  // rows with status "Filled" and treat them as fills.
  const accountMap = {};
  const fills = [];
  let fillCounter = 0;
  for (const o of objs) {
    const status = (o.Status || '').trim();
    if (status.toLowerCase() !== 'filled') continue;

    const extAcct = String(o.Account || '').trim();
    if (!extAcct) continue;
    const localAcct = `${connectionId}-${extAcct}`;
    accountMap[extAcct] = { id: localAcct, external_id: extAcct, name: extAcct };

    const sideRaw = (o['B/S'] || o['Side'] || '').trim().toLowerCase();
    const side = sideRaw.startsWith('b') ? 'buy' : 'sell';

    // Quantity: prefer "Filled Qty", fall back to filledQty / Quantity
    const qty = parseFloat(o['Filled Qty']) || parseFloat(o.filledQty) || parseFloat(o.Quantity) || 0;

    // Price: prefer "Avg Fill Price", fall back to avgPrice
    const price = parseFloat(o['Avg Fill Price']) || parseFloat(o.avgPrice) || 0;

    // Timestamp: prefer "Fill Time", fall back to Timestamp
    const timeStr = o['Fill Time'] || o.Timestamp || o.Time || '';
    const timestamp = parseTimestamp(timeStr);

    if (qty === 0 || price === 0 || timestamp === 0) continue;

    const symbol = o.Contract || o.Product || 'UNKNOWN';
    const orderId = o['Order ID'] || o.orderId || null;

    fillCounter++;
    // Deterministic fill ID — same source row always produces the same ID
    fills.push({
      id: `${localAcct}-F-${timestamp}-${orderId || fillCounter}-${side}-${price}`,
      account_id: localAcct,
      symbol,
      side,
      quantity: qty,
      price,
      timestamp,
      order_id: orderId,
      commission: null,
      realized_pnl: null,
    });
  }
  // Pair fills into closed trades
  const trades = pairFillsIntoTrades(fills, connectionId);
  return {
    accounts: Object.values(accountMap).map(a => ({
      ...a,
      connection_id: connectionId,
      account_type: 'tradovate-orders',
      balance: null,
      realized_pnl: trades.filter(t => t.account_id === a.id).reduce((s, t) => s + t.net_pnl, 0),
      unrealized_pnl: null,
      equity: null,
      trailing_drawdown: null,
      drawdown_lock: null,
      status: 'active',
      last_updated: Date.now(),
    })),
    fills,
    trades,
  };
}

// ─── FIFO fill pairing ─────────────────────────────────────────────────────
// Matches open/close fills into closed trades, FIFO.

function pairFillsIntoTrades(fills, connectionId) {
  const byAcctSymbol = {};
  for (const f of fills.sort((a, b) => a.timestamp - b.timestamp)) {
    const key = `${f.account_id}::${f.symbol}`;
    if (!byAcctSymbol[key]) byAcctSymbol[key] = [];
    byAcctSymbol[key].push(f);
  }
  const trades = [];
  let tradeCounter = 0;
  for (const [key, arr] of Object.entries(byAcctSymbol)) {
    const [accountId, symbol] = key.split('::');
    const open = []; // positions currently held
    let positionSide = 0; // +1 long, -1 short, 0 flat
    for (const f of arr) {
      const sideSign = f.side === 'buy' ? 1 : -1;
      let qtyRemaining = f.quantity;
      while (qtyRemaining > 0 && open.length > 0 && Math.sign(open[0].sideSign) !== sideSign) {
        const first = open[0];
        const matchQty = Math.min(qtyRemaining, first.qty);
        const entryPrice = first.price;
        const exitPrice = f.price;
        const longSide = first.sideSign > 0;
        const pnl = (longSide ? (exitPrice - entryPrice) : (entryPrice - exitPrice)) * matchQty * getPointValue(symbol);
        const entryTime = first.timestamp;
        const exitTime = f.timestamp;
        tradeCounter++;
        // Deterministic ID — same source trades always produce the same ID,
        // so re-importing the same CSV safely upserts (no duplicates).
        trades.push({
          id: `${accountId}-T-${entryTime}-${exitTime}-${symbol}-${matchQty}-${entryPrice}-${exitPrice}`,
          account_id: accountId,
          symbol,
          side: longSide ? 'long' : 'short',
          quantity: matchQty,
          entry_price: entryPrice,
          exit_price: exitPrice,
          entry_time: entryTime,
          exit_time: exitTime,
          duration_sec: Math.max(0, Math.floor((exitTime - entryTime) / 1000)),
          pnl,
          commission: 0,
          net_pnl: pnl,
          hour_of_day: new Date(entryTime).getHours(),
          day_of_week: new Date(entryTime).getDay(),
        });
        first.qty -= matchQty;
        qtyRemaining -= matchQty;
        if (first.qty <= 0) open.shift();
      }
      if (qtyRemaining > 0) {
        open.push({ id: f.id, qty: qtyRemaining, price: f.price, sideSign, timestamp: f.timestamp });
      }
    }
  }
  return trades;
}

// Rough point-value lookup for common CME futures.
// (Extend as needed; defaults to $1 if unknown.)
function getPointValue(symbol) {
  const s = (symbol || '').toUpperCase();
  if (s.startsWith('MNQ')) return 2;   // $2 per point
  if (s.startsWith('NQ'))  return 20;  // $20 per point
  if (s.startsWith('MES')) return 5;   // $5 per point
  if (s.startsWith('ES'))  return 50;  // $50 per point
  if (s.startsWith('MYM')) return 0.5;
  if (s.startsWith('YM'))  return 5;
  if (s.startsWith('M2K')) return 5;
  if (s.startsWith('RTY')) return 50;
  if (s.startsWith('MCL')) return 100;
  if (s.startsWith('CL'))  return 1000;
  if (s.startsWith('MGC')) return 10;
  if (s.startsWith('GC'))  return 100;
  return 1;
}

// ─── Entry point ───────────────────────────────────────────────────────────

function importCSV(text, connectionId) {
  const rows = parseCSV(text);
  if (rows.length === 0) throw new Error('Empty CSV');
  const headers = rows[0];
  const objs = rowsToObjects(rows);
  const format = detectFormat(headers);

  switch (format) {
    case 'topstepx-trades':  return normalizeTopstepXTrades(objs, connectionId);
    case 'tradovate-export': return normalizeTradovateExport(objs, connectionId);
    case 'tradovate-orders': return normalizeTradovateOrders(objs, connectionId);
    case 'generic-trades':   return normalizeTopstepXTrades(objs, connectionId); // reuse
    default:
      throw new Error(`Unknown CSV format. Headers: ${headers.slice(0, 5).join(', ')}...`);
  }
}

module.exports = {
  importCSV,
  parseCSV,
  rowsToObjects,
  detectFormat,
  pairFillsIntoTrades,
};
