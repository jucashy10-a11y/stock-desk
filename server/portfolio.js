/**
 * Portfolio storage + MoneyControl-style CSV import.
 * CSV format supported (header optional):
 *   ISIN Code, Stock Name, Date (MM/DD/YYYY), Buy/Sell, Exchange, Qty, Price
 * Holdings are netted from transactions (weighted average cost on buys).
 * Symbols are resolved from name/ISIN via Yahoo search and cached.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yahoo = require('./yahoo');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PF_FILE = path.join(DATA_DIR, 'portfolios.json');
const SYMCACHE_FILE = path.join(DATA_DIR, 'symbol-cache.json');

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

/**
 * Cloud persistence via a secret GitHub Gist (free) — needed on hosts like
 * Render whose free-tier disk is wiped on every restart. Enabled when
 * GIST_ID + GIST_TOKEN env vars are set; a no-op otherwise.
 */
const GIST_ID = process.env.GIST_ID || '';
const GIST_TOKEN = process.env.GIST_TOKEN || '';
const GIST_FILE = 'portfolios.json';
const gistHeaders = {
  Authorization: 'Bearer ' + GIST_TOKEN,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'stockdesk',
  'Content-Type': 'application/json',
};
let gistTimer = null;

async function cloudRestore() {
  if (!GIST_ID || !GIST_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: gistHeaders });
    if (!res.ok) throw new Error('gist fetch ' + res.status);
    const j = await res.json();
    let f = j?.files?.[GIST_FILE];
    if (f && f.truncated && f.raw_url) {
      const raw = await fetch(f.raw_url, { headers: gistHeaders });
      f = { content: await raw.text() };
    }
    if (f?.content) {
      const parsed = JSON.parse(f.content);
      if (parsed && Array.isArray(parsed.portfolios)) {
        saveJSON(PF_FILE, parsed);
        console.log(`[gist] restored ${parsed.portfolios.length} portfolios from cloud backup`);
      }
    }
  } catch (e) {
    console.warn('[gist] restore failed:', e.message);
  }
}

function cloudBackupSoon() {
  if (!GIST_ID || !GIST_TOKEN) return;
  clearTimeout(gistTimer);
  gistTimer = setTimeout(async () => {
    try {
      const content = fs.readFileSync(PF_FILE, 'utf8');
      const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: gistHeaders,
        body: JSON.stringify({ files: { [GIST_FILE]: { content } } }),
      });
      if (!res.ok) throw new Error('gist save ' + res.status);
      console.log('[gist] portfolio backed up to cloud');
    } catch (e) {
      console.warn('[gist] backup failed:', e.message);
    }
  }, 2000);
}

const SEED_FILE = path.join(__dirname, '..', 'data-seed', 'portfolios.seed.json');

function loadState() {
  const st = loadJSON(PF_FILE, null);
  if (st && Array.isArray(st.portfolios)) return st;
  // fresh/ephemeral host (e.g. Render free tier): fall back to the committed seed
  const seed = loadJSON(SEED_FILE, null);
  if (seed && Array.isArray(seed.portfolios)) {
    saveJSON(PF_FILE, seed);
    return seed;
  }
  return {
    portfolios: [{ id: 'default', name: 'My Portfolio', transactions: [], createdAt: Date.now() }],
  };
}
function saveState(st) {
  saveJSON(PF_FILE, st);
  cloudBackupSoon();
}

let symCache = loadJSON(SYMCACHE_FILE, {});
function saveSymCache() {
  saveJSON(SYMCACHE_FILE, symCache);
}

// ---------- symbol resolution ----------

/** MoneyControl abbreviations -> proper searchable names / direct symbols. */
const NAME_ALIASES = {
  'rec': { symbol: 'RECLTD.NS', name: 'REC Limited' },
  'vst': { symbol: 'VSTIND.NS', name: 'VST Industries' },
  'siemens': { symbol: 'SIEMENS.NS', name: 'Siemens' },
  'siemens energy': { query: 'Siemens Energy India' },
  'lic india': { symbol: 'LICI.NS', name: 'Life Insurance Corporation' },
  'linc': { symbol: 'LINC.NS', name: 'Linc Limited' },
  'nalco': { symbol: 'NATIONALUM.NS', name: 'National Aluminium' },
  'punjab and sind': { symbol: 'PSB.NS', name: 'Punjab & Sind Bank' },
  'south ind bk': { symbol: 'SOUTHBANK.NS', name: 'South Indian Bank' },
  'heidelberg cem': { symbol: 'HEIDELBERG.NS', name: 'Heidelberg Cement India' },
  'epack durables': { query: 'EPACK Durable' },
  'tata motors com': { symbol: 'TMCV.NS', name: 'Tata Motors (Commercial Vehicles)' },
  'tatateleservice': { symbol: 'TTML.NS', name: 'Tata Teleservices (Maharashtra)' },
  'tata motors pv': { query: 'Tata Motors Passenger Vehicles' },
  'l&t finance': { symbol: 'LTF.NS', name: 'L&T Finance' },
  'mirae sp 500': { query: 'Mirae Asset S&P 500 Top 50 ETF' },
  'nipp nifty 100': { query: 'Nippon India ETF Nifty 100' },
  'mo defence': { query: 'Motilal Oswal Nifty India Defence ETF' },
  'tata silveretf': { query: 'Tata Silver ETF' },
  'zenith spi': { query: 'Zenith Steel Pipes' },
  'bannari a spg': { query: 'Bannari Amman Spinning' },
  'mirza intl': { query: 'Mirza International' },
  'generic pharmas': { query: 'Generic Pharmasec' },
};

async function resolveSymbol(name, isin, exchange) {
  const key = ((isin || '') + '|' + (name || '')).toLowerCase();
  if (symCache[key]) return symCache[key];
  const alias = NAME_ALIASES[(name || '').toLowerCase().trim()];
  if (alias?.symbol) {
    symCache[key] = { symbol: alias.symbol, name: alias.name || name };
    saveSymCache();
    return symCache[key];
  }
  const suffix = exchange === 'BSE' ? '.BO' : '.NS';
  // exact trading symbol (e.g. "TATSILV" from a broker statement)? verify directly —
  // even when an ISIN is supplied, the direct match is the most reliable signal
  if (name && /^[A-Z0-9&-]{2,20}$/.test(name.trim())) {
    try {
      const direct = name.trim() + suffix;
      const q = await yahoo.quoteFromChart(direct);
      if (q?.price) {
        symCache[key] = { symbol: direct, name: q.name || name };
        saveSymCache();
        return symCache[key];
      }
    } catch { /* fall through to search */ }
  }
  const tryQueries = [];
  if (alias?.query) tryQueries.push(alias.query);
  if (isin) tryQueries.push(isin);
  if (name) tryQueries.push(name);
  const base = (s) => s.replace(/\.(NS|BO)$/, '').toUpperCase();
  for (const q of tryQueries) {
    try {
      const results = await yahoo.search(q);
      // exact ticker match beats everything (SIYARAM must not become SIYSIL),
      // then requested exchange, then any Indian listing
      const pick =
        (name && results.find((r) => base(r.symbol) === name.trim().toUpperCase())) ||
        results.find((r) => r.symbol.endsWith(suffix)) ||
        results.find((r) => r.symbol.endsWith('.NS') || r.symbol.endsWith('.BO'));
      if (pick) {
        symCache[key] = { symbol: pick.symbol, name: pick.name };
        saveSymCache();
        return symCache[key];
      }
    } catch {
      /* keep trying */
    }
  }
  return null;
}

// ---------- CSV parsing ----------

function parseCSV(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows = [];
  for (const line of lines) {
    // simple CSV (no embedded quoted commas expected in this format, but handle quotes)
    const cells = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) {
        cells.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

function parseDate(s) {
  // MM/DD/YYYY or DD-MM-YYYY or YYYY-MM-DD
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return validDate(+m[3], +m[1], +m[2]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return validDate(+m[3], +m[2], +m[1]);
  return null;
}

function validDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function sourceKey(tx) {
  const normalized = [
    String(tx.isin || '').trim().toUpperCase(),
    String(tx.symbol || '').trim().toUpperCase(),
    tx.symbol ? '' : String(tx.name || '').trim().toLowerCase().replace(/\s+/g, ' '),
    String(tx.date || ''),
    String(tx.type || '').toUpperCase(),
    Number(tx.qty).toFixed(6),
    Number(tx.price).toFixed(6),
  ].join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

/**
 * Import MoneyControl-format CSV into a portfolio.
 * Returns { imported, failed: [{name, reason}] }
 */
async function importCSV(portfolioId, csvText) {
  const st = loadState();
  const pf = st.portfolios.find((p) => p.id === portfolioId);
  if (!pf) throw new Error('Portfolio not found');
  const rows = parseCSV(csvText);
  // Broker exports are frequently newest-first. Accounting must be replayed
  // chronologically so a valid historical sell is not rejected before its buy.
  rows.sort((a, b) => {
    const da = parseDate(a[2]);
    const db = parseDate(b[2]);
    return da && db ? da.localeCompare(db) : 0;
  });
  let imported = 0;
  let skippedDuplicates = 0;
  const failed = [];
  const existingKeys = new Set();
  const existingOccurrences = new Map();
  for (const tx of pf.transactions) {
    const base = sourceKey(tx);
    const occurrence = (existingOccurrences.get(base) || 0) + 1;
    existingOccurrences.set(base, occurrence);
    existingKeys.add(tx.sourceId || `${base}-${occurrence}`);
    // Compatibility with the first idempotency version, which stored the
    // unsuffixed key for the first occurrence.
    if (tx.sourceId === base) existingKeys.add(`${base}-1`);
  }
  const incomingOccurrences = new Map();
  const available = new Map(computeHoldings(pf).map((h) => [h.symbol, h.qty]));
  for (const row of rows) {
    if (row.length < 6) continue;
    const [isin, name, date, txType, exchange, qty, price] = row;
    if (/isin/i.test(isin)) continue; // header row
    const q = parseFloat(qty);
    const p = parseFloat(price);
    const parsedDate = parseDate(date);
    if (!name || !isFinite(q) || !isFinite(p) || q <= 0 || p <= 0 || !parsedDate) {
      if (name && !/isin/i.test(isin)) {
        failed.push({
          name: name || isin,
          reason: !parsedDate ? 'invalid or missing date' : 'invalid quantity or price',
        });
      }
      continue;
    }
    const resolved = await resolveSymbol(name, isin, (exchange || 'NSE').toUpperCase());
    if (!resolved) {
      failed.push({ name, reason: 'could not resolve symbol' });
      continue;
    }
    const type = /sell/i.test(txType) ? 'SELL' : 'BUY';
    const candidate = {
      id: 'tx' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      symbol: resolved.symbol,
      name: resolved.name || name,
      type,
      qty: q,
      price: p,
      date: parsedDate,
      isin: isin || null,
      createdAt: Date.now(),
      importSource: 'csv',
    };
    const baseId = sourceKey(candidate);
    const occurrence = (incomingOccurrences.get(baseId) || 0) + 1;
    incomingOccurrences.set(baseId, occurrence);
    candidate.sourceId = `${baseId}-${occurrence}`;
    if (existingKeys.has(candidate.sourceId)) {
      skippedDuplicates++;
      continue;
    }
    const held = available.get(candidate.symbol) || 0;
    if (type === 'SELL' && q > held + 1e-8) {
      failed.push({ name, reason: `sell quantity ${q} exceeds available ${held}` });
      continue;
    }
    available.set(candidate.symbol, type === 'BUY' ? held + q : held - q);
    pf.transactions.push(candidate);
    existingKeys.add(candidate.sourceId);
    imported++;
  }
  saveState(st);
  return { imported, skippedDuplicates, failed };
}

// ---------- holdings computation ----------

function computeHoldings(pf) {
  const bySymbol = new Map();
  const txs = [...pf.transactions].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)) ||
    (+a.createdAt || 0) - (+b.createdAt || 0) ||
    String(a.id || '').localeCompare(String(b.id || ''))
  );
  for (const tx of txs) {
    let h = bySymbol.get(tx.symbol);
    if (!h) {
      h = { symbol: tx.symbol, name: tx.name, qty: 0, cost: 0, realized: 0 };
      bySymbol.set(tx.symbol, h);
    }
    if (tx.type === 'ADJUSTMENT') {
      // Preserve the transaction ledger while resetting the carrying cost of
      // the shares held at this point. Deleting this row cleanly undoes it.
      if (h.qty > 0 && Number.isFinite(+tx.price) && +tx.price > 0) {
        h.cost = h.qty * +tx.price;
      }
    } else if (tx.type === 'SPLIT') {
      const ratio = +tx.ratio;
      if (!(ratio > 0) || h.qty <= 0) throw new Error(`Invalid split for ${tx.symbol}`);
      h.qty *= ratio;
    } else if (tx.type === 'BONUS') {
      const ratio = +tx.ratio;
      if (!(ratio > 0) || h.qty <= 0) throw new Error(`Invalid bonus ratio for ${tx.symbol}`);
      h.qty *= 1 + ratio;
    } else if (tx.type === 'BUY') {
      h.cost += tx.qty * tx.price;
      h.qty += tx.qty;
    } else {
      const avg = h.qty > 0 ? h.cost / h.qty : 0;
      if (tx.qty > h.qty + 1e-8) {
        throw new Error(`Sell quantity ${tx.qty} exceeds available ${h.qty} for ${tx.symbol}`);
      }
      const sellQty = tx.qty;
      h.realized += sellQty * (tx.price - avg);
      h.cost -= sellQty * avg;
      h.qty -= sellQty;
    }
    h.name = tx.name || h.name;
  }
  return [...bySymbol.values()]
    .filter((h) => h.qty > 0.000001)
    .map((h) => ({
      symbol: h.symbol,
      name: h.name,
      qty: h.qty,
      avgPrice: h.cost / h.qty,
      invested: h.cost,
      realized: h.realized,
    }));
}

// ---------- public API ----------

function listPortfolios() {
  const st = loadState();
  return st.portfolios.map((p) => ({
    id: p.id,
    name: p.name,
    txCount: p.transactions.length,
    holdingsCount: computeHoldings(p).length,
  }));
}

function createPortfolio(name) {
  const st = loadState();
  const id = 'pf' + Date.now();
  st.portfolios.push({ id, name: name || 'Portfolio', transactions: [], createdAt: Date.now() });
  saveState(st);
  return { id, name };
}

function renamePortfolio(id, name) {
  const st = loadState();
  const pf = st.portfolios.find((p) => p.id === id);
  if (!pf) throw new Error('Portfolio not found');
  pf.name = name;
  saveState(st);
}

function deletePortfolio(id) {
  const st = loadState();
  st.portfolios = st.portfolios.filter((p) => p.id !== id);
  if (!st.portfolios.length) {
    st.portfolios.push({ id: 'default', name: 'My Portfolio', transactions: [], createdAt: Date.now() });
  }
  saveState(st);
}

function getPortfolio(id) {
  const st = loadState();
  const pf = st.portfolios.find((p) => p.id === id);
  if (!pf) throw new Error('Portfolio not found');
  const legacySnapshotRows = pf.transactions.filter((t) => !t.createdAt).length;
  return {
    id: pf.id,
    name: pf.name,
    transactions: pf.transactions,
    holdings: computeHoldings(pf),
    accounting: {
      mode: legacySnapshotRows ? 'mixed-snapshot' : 'transaction-ledger',
      legacySnapshotRows,
      performanceStartsAtBaseline: true,
    },
  };
}

function addTransaction(id, { symbol, name, type, qty, price, date }) {
  const st = loadState();
  const pf = st.portfolios.find((p) => p.id === id);
  if (!pf) throw new Error('Portfolio not found');
  const normalizedDate = parseDate(date || new Date().toISOString().slice(0, 10));
  if (!symbol || !isFinite(qty) || !isFinite(price) || qty <= 0 || price <= 0 || !normalizedDate) {
    throw new Error('Invalid transaction');
  }
  const normalizedType = type === 'SELL' ? 'SELL' : 'BUY';
  if (normalizedType === 'SELL') {
    const held = computeHoldings(pf).find((h) => h.symbol === symbol)?.qty || 0;
    if (+qty > held + 1e-8) throw new Error(`Sell quantity exceeds available holding (${held})`);
  }
  const tx = {
    id: 'tx' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    symbol,
    name: name || symbol,
    type: normalizedType,
    qty: +qty,
    price: +price,
    date: normalizedDate,
    createdAt: Date.now(),
    importSource: 'manual',
  };
  tx.sourceId = sourceKey(tx);
  pf.transactions.push(tx);
  saveState(st);
  return getPortfolio(id);
}

/**
 * Auditable quantity adjustment for a confirmed split or bonus issue.
 * ratio is "new shares per existing share": 2 for a 1:2 split, 1 for a 1:1
 * bonus. Original buys/sells and total carrying cost remain untouched.
 */
function applyCorporateAction(id, { symbol, type, ratio, date, note }) {
  const st = loadState();
  const pf = st.portfolios.find((p) => p.id === id);
  if (!pf) throw new Error('Portfolio not found');
  const normalizedType = String(type || '').toUpperCase();
  if (!['SPLIT', 'BONUS'].includes(normalizedType)) throw new Error('Unsupported corporate action');
  const normalizedDate = parseDate(date || new Date().toISOString().slice(0, 10));
  const actionRatio = +ratio;
  if (!symbol || !normalizedDate || !(actionRatio > 0)) throw new Error('Invalid corporate action');
  const holding = computeHoldings(pf).find((h) => h.symbol === symbol);
  if (!holding) throw new Error('Holding not found');
  const tx = {
    id: 'tx' + Date.now() + '_corp',
    symbol,
    name: holding.name || symbol,
    type: normalizedType,
    qty: holding.qty,
    price: 0,
    ratio: actionRatio,
    date: normalizedDate,
    createdAt: Date.now(),
    importSource: 'corporate-action',
    note: note || `User-confirmed ${normalizedType.toLowerCase()} adjustment`,
  };
  tx.sourceId = sourceKey({ ...tx, price: actionRatio });
  if (pf.transactions.some((t) => t.sourceId === tx.sourceId)) throw new Error('Corporate action already recorded');
  pf.transactions.push(tx);
  saveState(st);
  return getPortfolio(id);
}

/**
 * Net external capital added between two instants. Buys are contributions and
 * sells are withdrawals. Adjustments/splits/bonuses are internal and excluded.
 */
function externalFlowBetween(startMs, endMs) {
  const st = loadState();
  let total = 0;
  for (const pf of st.portfolios) {
    for (const tx of pf.transactions) {
      if (!['BUY', 'SELL'].includes(tx.type)) continue;
      // Legacy seed/import rows have no trustworthy ingestion timestamp. Counting
      // their trade date after a newly-created snapshot would manufacture a huge
      // cash flow and corrupt the benchmark. Only events recorded by the current
      // audited transaction pipeline participate in time-weighted returns.
      if (!tx.createdAt) continue;
      const at = tx.createdAt;
      if (!Number.isFinite(at) || at <= startMs || at > endMs) continue;
      const value = (+tx.qty || 0) * (+tx.price || 0);
      total += tx.type === 'BUY' ? value : -value;
    }
  }
  return total;
}

function deleteTransaction(id, txId) {
  const st = loadState();
  const pf = st.portfolios.find((p) => p.id === id);
  if (!pf) throw new Error('Portfolio not found');
  pf.transactions = pf.transactions.filter((t) => t.id !== txId);
  saveState(st);
  return getPortfolio(id);
}

/**
 * One-time cost-basis reconciliation for corporate-action distortions
 * (demergers/splits import at near-zero cost → +1,200% phantom gains).
 * Adds an auditable cost-basis adjustment while preserving every original
 * buy/sell. Removing the adjustment restores the original calculation.
 */
function reconcileCost(id, symbol, avgPrice) {
  const st = loadState();
  const pf = st.portfolios.find((p) => p.id === id);
  if (!pf) throw new Error('Portfolio not found');
  const price = +avgPrice;
  if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid average cost');
  const txs = pf.transactions.filter((t) => t.symbol === symbol);
  if (!txs.length) throw new Error('Holding not found');
  const netQty = computeHoldings(pf).find((h) => h.symbol === symbol)?.qty || 0;
  if (netQty <= 0) throw new Error('No net quantity to reconcile');
  const name = txs[txs.length - 1].name || symbol;
  pf.transactions.push({
    id: 'tx' + Date.now() + '_recon',
    symbol, name,
    type: 'ADJUSTMENT',
    qty: netQty,
    price,
    date: new Date().toISOString().slice(0, 10),
    reconciled: true,
    createdAt: Date.now(),
    note: 'User-confirmed cost-basis adjustment; original transactions preserved',
  });
  saveState(st);
  return getPortfolio(id);
}

function removeHolding(id, symbol) {
  const st = loadState();
  const pf = st.portfolios.find((p) => p.id === id);
  if (!pf) throw new Error('Portfolio not found');
  pf.transactions = pf.transactions.filter((t) => t.symbol !== symbol);
  saveState(st);
  return getPortfolio(id);
}

/** Aggregate every portfolio: holdings merged by symbol with per-account breakdown. */
function getAllAccounts() {
  const st = loadState();
  const merged = new Map();
  const accounts = [];
  let legacySnapshotRows = 0;
  for (const pf of st.portfolios) {
    legacySnapshotRows += pf.transactions.filter((t) => !t.createdAt).length;
    const holdings = computeHoldings(pf);
    accounts.push({ id: pf.id, name: pf.name, holdings });
    for (const h of holdings) {
      let m = merged.get(h.symbol);
      if (!m) {
        m = { symbol: h.symbol, name: h.name, qty: 0, invested: 0, realized: 0, accounts: [] };
        merged.set(h.symbol, m);
      }
      m.qty += h.qty;
      m.invested += h.invested;
      m.realized += h.realized;
      m.accounts.push({ id: pf.id, name: pf.name, qty: h.qty, invested: h.invested });
    }
  }
  const holdings = [...merged.values()].map((m) => ({
    ...m,
    avgPrice: m.qty > 0 ? m.invested / m.qty : 0,
  }));
  return {
    id: 'all',
    name: 'All Accounts',
    holdings,
    accounts,
    accounting: {
      mode: legacySnapshotRows ? 'mixed-snapshot' : 'transaction-ledger',
      legacySnapshotRows,
      performanceStartsAtBaseline: true,
    },
  };
}

/** Every symbol/name the user actually holds — used for OCR fuzzy-repair. */
function allSymbolNames() {
  const st = loadState();
  const out = new Map();
  for (const pf of st.portfolios) {
    for (const tx of pf.transactions) {
      if (tx.symbol && !out.has(tx.symbol)) out.set(tx.symbol, tx.name || tx.symbol);
    }
  }
  return [...out.entries()].map(([symbol, name]) => ({ symbol, name }));
}

module.exports = {
  allSymbolNames,
  cloudRestore,
  getAllAccounts,
  listPortfolios,
  createPortfolio,
  renamePortfolio,
  deletePortfolio,
  getPortfolio,
  reconcileCost,
  applyCorporateAction,
  externalFlowBetween,
  addTransaction,
  deleteTransaction,
  removeHolding,
  importCSV,
  computeHoldings,
};
