// topstepx-share.js — fetches trade data from a public TopstepX share URL
//
// How it works:
//   - The share URL is https://www.topstepx.com/share/stats?share={tradingAccountId}
//   - The tradingAccountId maps directly to the TopstepX/ProjectX public API
//     at https://userapi.topstepx.com
//   - No auth required for shared accounts
//
// API endpoints used:
//   GET  /Statistics/getAccountName?tradingAccountId={id}
//   POST /Statistics/lifetimestats       body { tradingAccountId }
//   POST /Statistics/daytrades           body { tradingAccountId, tradeDay }
//
// Output shape matches what csv-import produces, so downstream code is identical.

const API_BASE = 'https://userapi.topstepx.com';
const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Origin': 'https://www.topstepx.com',
  'Referer': 'https://www.topstepx.com/',
  'User-Agent': "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 AbhiJournal/1.0",
};

function parseShareInput(input) {
  // Accepts either a full URL like https://www.topstepx.com/share/stats?share=21446279
  // or just a numeric tradingAccountId
  const s = String(input || '').trim();
  if (!s) throw new Error('Empty TopstepX share input');
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  try {
    const u = new URL(s);
    const id = u.searchParams.get('share') || u.searchParams.get('tradingAccountId');
    if (id && /^\d+$/.test(id)) return parseInt(id, 10);
  } catch {}
  const m = s.match(/(\d{5,})/);
  if (m) return parseInt(m[1], 10);
  throw new Error(`Could not extract tradingAccountId from: ${s}`);
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path, { method: 'GET', headers: HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`TopstepX GET ${path} → ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`TopstepX POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ─── Symbol normalization ──────────────────────────────────────────────────
// TopstepX returns symbols like "F.US.MNQ". We strip the prefix so the
// existing csv-import point-value lookup (which expects "MNQ", "MNQM6", etc.)
// continues to work.
function normalizeSymbol(topstepxSymbol) {
  if (!topstepxSymbol) return 'UNKNOWN';
  const parts = String(topstepxSymbol).split('.');
  return parts[parts.length - 1] || topstepxSymbol;
}

// ─── Main fetcher ──────────────────────────────────────────────────────────

async function fetchShare(shareInput) {
  const tradingAccountId = parseShareInput(shareInput);

  // 1. Account name
  let accountName;
  try {
    const raw = await apiGet(`/Statistics/getAccountName?tradingAccountId=${tradingAccountId}`);
    accountName = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : String(raw);
  } catch (e) {
    accountName = `tsx-${tradingAccountId}`;
  }

  // 2. Lifetime day stats → gives us the list of trading days
  const dayStats = await apiPost('/Statistics/lifetimestats', { tradingAccountId });
  if (!Array.isArray(dayStats)) {
    throw new Error('Unexpected lifetimestats response shape');
  }

  // 3. For each trading day, fetch detailed trades
  const allTrades = [];
  for (const day of dayStats) {
    if (!day.tradeDate) continue;
    try {
      const trades = await apiPost('/Statistics/daytrades', {
        tradingAccountId,
        tradeDay: day.tradeDate,
      });
      if (Array.isArray(trades)) {
        for (const t of trades) allTrades.push(t);
      }
    } catch (e) {
      console.warn(`daytrades ${day.tradeDate} failed: ${e.message}`);
    }
  }

  return {
    tradingAccountId,
    accountName,
    dayStats,
    trades: allTrades,
  };
}

// ─── Convert to our normalized format (like csv-import output) ─────────────

function toNormalized(shareResult, connectionId) {
  const { tradingAccountId, accountName, dayStats, trades } = shareResult;
  const localAcct = `${connectionId}-${tradingAccountId}`;

  const normalizedTrades = trades.map((t, idx) => {
    const symbol = normalizeSymbol(t.symbolId);
    const entryTime = t.enteredAt && !t.enteredAt.startsWith('0001') ? new Date(t.enteredAt).getTime() : new Date(t.createdAt).getTime();
    const exitTime = t.createdAt ? new Date(t.createdAt).getTime() : entryTime;
    const qty = Math.abs(t.positionSize || 0);
    // TopstepX doesn't explicitly mark long/short in this payload, but we can
    // infer from entry vs exit price + sign of P&L.
    let side = 'long';
    if (t.entryPrice && t.exitPrice && qty > 0) {
      const direction = t.exitPrice > t.entryPrice ? 1 : -1;
      const pnlSign = (t.profitAndLoss || 0) > 0 ? 1 : -1;
      side = direction === pnlSign ? 'long' : 'short';
    }
    const pnl = t.profitAndLoss || 0;
    const fees = (t.fees || 0) + (t.commissions || 0);
    const dt = new Date(entryTime);
    return {
      id: `${connectionId}-TSX-${t.id || idx}`,
      account_id: localAcct,
      symbol,
      side,
      quantity: qty,
      entry_price: t.entryPrice || 0,
      exit_price: t.exitPrice || 0,
      entry_time: entryTime,
      exit_time: exitTime,
      duration_sec: Math.max(0, Math.floor((exitTime - entryTime) / 1000)),
      pnl,
      commission: fees,
      net_pnl: pnl - fees,
      hour_of_day: dt.getHours(),
      day_of_week: dt.getDay(),
    };
  });

  const totalPnl = normalizedTrades.reduce((s, t) => s + t.net_pnl, 0);

  return {
    accounts: [{
      id: localAcct,
      connection_id: connectionId,
      external_id: String(tradingAccountId),
      name: accountName,
      account_type: 'topstepx-share',
      balance: null,
      realized_pnl: totalPnl,
      unrealized_pnl: null,
      equity: null,
      trailing_drawdown: null,
      drawdown_lock: null,
      status: 'active',
      last_updated: Date.now(),
    }],
    fills: [],
    trades: normalizedTrades,
    accountName,
    tradingAccountId,
  };
}

module.exports = {
  parseShareInput,
  fetchShare,
  toNormalized,
  normalizeSymbol,
};
