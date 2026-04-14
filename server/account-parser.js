// account-parser.js — converts OCR line output into structured account rows
//
// The OCR returns a flat list of detected text regions with normalized
// coordinates. We need to:
//   1. Group them into rows by Y position (text on the same horizontal band)
//   2. Sort each row by X position
//   3. Identify the header row (contains "ACCOUNT", "P L", "DRAWDOWN", etc.)
//   4. Map each subsequent row's columns to header fields
//   5. Detect the prop firm from account name patterns
//
// Supported firm patterns (extend as we encounter more):
//   MFFU*       → My Funded Futures
//   APX*        → Apex
//   PA*         → TopstepX
//   TPT*        → Take Profit Trader
//   numeric only→ Tradovate (TPT, Lucid, Tradeify, Day Traders)
//
// Output:
//   {
//     firm: 'mffu' | 'apex' | 'topstepx' | 'tpt' | 'unknown',
//     headers: ['account', 'pnl', 'drawdown', 'trailing', 'net_liq'],
//     rows: [
//       { account: 'MFFUEVRPD07430042', pnl: 1098.40, drawdown: 3098.40, ... },
//       ...
//     ],
//     rawText: 'multi-line OCR dump for debugging'
//   }

// ─── Group lines into rows by Y proximity ──────────────────────────────────

function groupIntoRows(lines, yTolerance = 0.018) {
  // Sort by Y, then merge into rows whose centers are within yTolerance
  const sorted = [...lines].sort((a, b) => a.y - b.y);
  const rows = [];
  for (const line of sorted) {
    const cy = line.y + line.h / 2;
    const last = rows[rows.length - 1];
    if (last && Math.abs((last.cy) - cy) < yTolerance) {
      last.items.push(line);
      // Update center as moving average
      last.cy = (last.cy * (last.items.length - 1) + cy) / last.items.length;
    } else {
      rows.push({ cy, items: [line] });
    }
  }
  // Sort items in each row by X
  rows.forEach(r => r.items.sort((a, b) => a.x - b.x));
  return rows;
}

// ─── Header detection ──────────────────────────────────────────────────────

const HEADER_KEYWORDS = {
  account:    /^account$/i,
  pnl:        /^(dollar\s*)?(total\s*)?p\s*[\\/&]?\s*l$|^pnl$|^profit$/i,
  drawdown:   /drawdown|dist\s*dd|distance/i,
  drawdown_auto: /drawdown\s*auto|auto\s*drawdown/i,
  trailing:   /^trailing$/i,
  net_liq:    /net\s*liq|liquid/i,
  open:       /^dollar\s*open$/i,
  status:     /^account\s*status$|^status$|^accoun$/i, // Tradovate truncates "ACCOUNT STATUS" to "ACCOUN"
};

function detectHeaderRow(rows) {
  // Find the row that contains "ACCOUNT" as a header (not as a value)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const texts = row.items.map(it => it.text.trim());
    const joined = texts.join(' ').toLowerCase();
    if (joined.includes('account') &&
        (joined.includes('drawdown') || joined.includes('p l') || joined.includes('p/l') || joined.includes('liq'))) {
      return i;
    }
  }
  return -1;
}

function classifyHeaderColumns(headerRow) {
  // For each item in the header row, figure out which field it represents
  return headerRow.items.map(item => {
    const text = item.text.trim();
    let field = null;
    for (const [name, pattern] of Object.entries(HEADER_KEYWORDS)) {
      if (pattern.test(text)) { field = name; break; }
    }
    return { ...item, field, text };
  });
}

// ─── Number parser ─────────────────────────────────────────────────────────

function parseMoney(s) {
  if (!s) return null;
  // Strip $, commas, parentheses (negative), whitespace
  const cleaned = s.replace(/[$,\s]/g, '').replace(/\((.+)\)/, '-$1');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// ─── Firm detection ────────────────────────────────────────────────────────

function detectFirmFromAccountName(name) {
  if (!name) return 'unknown';
  const u = name.toUpperCase();
  if (u.startsWith('MFFU') || u.startsWith('MFFUEV')) return 'mffu';
  if (u.startsWith('APEX') || /^APX/.test(u))         return 'apex';
  if (u.startsWith('PA') && /^PA\d/.test(u))          return 'topstepx';
  if (u.startsWith('TPT'))                             return 'tpt';
  if (/^\d{6,}$/.test(name))                           return 'tradovate'; // numeric → Tradovate-managed
  return 'unknown';
}

// ─── Main parser ───────────────────────────────────────────────────────────

function parseScreenshot(ocrOutput) {
  const lines = ocrOutput.lines || [];
  const rows = groupIntoRows(lines);
  const headerIdx = detectHeaderRow(rows);

  const result = {
    firm: 'unknown',
    headers: [],
    rows: [],
    headerFound: headerIdx !== -1,
    rawText: rows.map(r => r.items.map(i => i.text).join('  ')).join('\n'),
  };

  if (headerIdx === -1) {
    // No header found — fall back to looking for any rows that contain
    // an account-id-shaped string + at least one money value
    return fallbackParse(rows, result);
  }

  const headerCols = classifyHeaderColumns(rows[headerIdx]);
  result.headers = headerCols.map(c => c.field || c.text);

  // For each row after the header, assign each item to the closest header column by X
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const obj = {};
    for (const item of row.items) {
      let bestCol = null;
      let bestDist = Infinity;
      for (const col of headerCols) {
        const colCenter = col.x + col.w / 2;
        const itemCenter = item.x + item.w / 2;
        const d = Math.abs(colCenter - itemCenter);
        if (d < bestDist) { bestDist = d; bestCol = col; }
      }
      if (bestCol && bestCol.field) {
        // Only assign if reasonably close (within ~20% of image width)
        if (bestDist < 0.2) {
          if (bestCol.field === 'account') {
            obj.account = item.text.trim();
          } else if (['pnl', 'drawdown', 'drawdown_auto', 'trailing', 'net_liq', 'open'].includes(bestCol.field)) {
            obj[bestCol.field] = parseMoney(item.text);
          } else if (bestCol.field === 'status') {
            obj.status = item.text.trim();
          }
        }
      }
    }
    if (obj.account && /^[A-Z0-9]{4,}/i.test(obj.account)) {
      result.rows.push(obj);
    }
  }

  // Detect firm from the first account name
  if (result.rows.length > 0) {
    result.firm = detectFirmFromAccountName(result.rows[0].account);
  }

  return result;
}

// ─── Fallback parser (no header detected) ──────────────────────────────────

function fallbackParse(rows, result) {
  // Look for rows where the first item looks like an account ID
  // and there are multiple money values after it
  for (const row of rows) {
    if (row.items.length < 2) continue;
    const first = row.items[0].text.trim();
    if (!/^[A-Z0-9]{6,}$/i.test(first)) continue;

    const moneyValues = row.items.slice(1).map(it => parseMoney(it.text)).filter(v => v !== null);
    if (moneyValues.length < 1) continue;

    const obj = { account: first };
    // Heuristic: assign in order common to most prop firm screenshots
    // [open, pnl, distDD, autoDD, trailing, netLiq]
    const fields = ['open', 'pnl', 'drawdown', 'drawdown_auto', 'trailing', 'net_liq'];
    moneyValues.forEach((v, i) => { if (fields[i]) obj[fields[i]] = v; });
    result.rows.push(obj);
  }
  if (result.rows.length > 0) {
    result.firm = detectFirmFromAccountName(result.rows[0].account);
  }
  return result;
}

// ─── Computed helpers ──────────────────────────────────────────────────────

// Given a parsed row, derive starting balance and drawdown amount
//   net_liq          = current equity
//   pnl              = profit/loss since start
//   starting_balance = net_liq - pnl   (assumes no withdrawals)
//   drawdown_auto    = balance at which the trailing DD currently sits
//   trailing         = drawdown amount (the "buffer" — typically $2,000 or $2,500)

function deriveAccountConfig(row) {
  const cfg = {};
  if (row.net_liq != null && row.pnl != null) {
    cfg.starting_balance = row.net_liq - row.pnl;
  }
  if (row.trailing != null) {
    cfg.drawdown_amount = row.trailing;
    cfg.drawdown_type = 'eod_trailing';
  }
  if (row.drawdown_auto != null && cfg.starting_balance != null) {
    // drawdown_auto often shown as a balance threshold OR distance; we treat as threshold
    // If drawdown_auto looks like a balance (close to net_liq), use it as the locks_at
    // For MFFU it tends to be the locked threshold
  }
  return cfg;
}

module.exports = {
  parseScreenshot,
  groupIntoRows,
  detectHeaderRow,
  detectFirmFromAccountName,
  parseMoney,
  deriveAccountConfig,
};
