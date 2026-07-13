/**
 * Portfolio storage + MoneyControl-style CSV import.
 * CSV format supported (header optional):
 *   ISIN Code, Stock Name, Date (MM/DD/YYYY), Buy/Sell, Exchange, Qty, Price
 * Holdings are netted from transactions (weighted average cost on buys).
 * Symbols are resolved from name/ISIN via Yahoo search and cached.
 */

const fs = require('fs');
const path = require('path');
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
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
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
  // exact trading symbol (e.g. "TATSILV" from a broker screenshot)? verify directly
  if (name && /^[A-Z0-9&-]{2,20}$/.test(name.trim()) && !isin) {
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
  for (const q of tryQueries) {
    try {
      const results = await yahoo.search(q);
      // prefer requested exchange, then any Indian listing
      const pick =
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
  if (!s) return new Date().toISOString().slice(0, 10);
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return new Date().toISOString().slice(0, 10);
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
  let imported = 0;
  const failed = [];
  for (const row of rows) {
    if (row.length < 6) continue;
    const [isin, name, date, txType, exchange, qty, price] = row;
    if (/isin/i.test(isin)) continue; // header row
    const q = parseFloat(qty);
    const p = parseFloat(price);
    if (!name || !isFinite(q) || !isFinite(p) || q <= 0) {
      if (name && !/isin/i.test(isin)) failed.push({ name: name || isin, reason: 'invalid qty/price' });
      continue;
    }
    const resolved = await resolveSymbol(name, isin, (exchange || 'NSE').toUpperCase());
    if (!resolved) {
      failed.push({ name, reason: 'could not resolve symbol' });
      continue;
    }
    pf.transactions.push({
      id: 'tx' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      symbol: resolved.symbol,
      name: resolved.name || name,
      type: /sell/i.test(txType) ? 'SELL' : 'BUY',
      qty: q,
      price: p,
      date: parseDate(date),
      isin: isin || null,
    });
    imported++;
  }
  saveState(st);
  return { imported, failed };
}

// ---------- holdings computation ----------

function computeHoldings(pf) {
  const bySymbol = new Map();
  const txs = [...pf.transactions].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const tx of txs) {
    let h = bySymbol.get(tx.symbol);
    if (!h) {
      h = { symbol: tx.symbol, name: tx.name, qty: 0, cost: 0, realized: 0 };
      bySymbol.set(tx.symbol, h);
    }
    if (tx.type === 'BUY') {
      h.cost += tx.qty * tx.price;
      h.qty += tx.qty;
    } else {
      const avg = h.qty > 0 ? h.cost / h.qty : 0;
      const sellQty = Math.min(tx.qty, h.qty);
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
  return { id: pf.id, name: pf.name, transactions: pf.transactions, holdings: computeHoldings(pf) };
}

function addTransaction(id, { symbol, name, type, qty, price, date }) {
  const st = loadState();
  const pf = st.portfolios.find((p) => p.id === id);
  if (!pf) throw new Error('Portfolio not found');
  if (!symbol || !isFinite(qty) || !isFinite(price) || qty <= 0 || price < 0) {
    throw new Error('Invalid transaction');
  }
  pf.transactions.push({
    id: 'tx' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    symbol,
    name: name || symbol,
    type: type === 'SELL' ? 'SELL' : 'BUY',
    qty: +qty,
    price: +price,
    date: date || new Date().toISOString().slice(0, 10),
  });
  saveState(st);
  return getPortfolio(id);
}

function deleteTransaction(id, txId) {
  const st = loadState();
  const pf = st.portfolios.find((p) => p.id === id);
  if (!pf) throw new Error('Portfolio not found');
  pf.transactions = pf.transactions.filter((t) => t.id !== txId);
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
  for (const pf of st.portfolios) {
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
  return { id: 'all', name: 'All Accounts', holdings, accounts };
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
  addTransaction,
  deleteTransaction,
  removeHolding,
  importCSV,
};
