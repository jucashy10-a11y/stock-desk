/**
 * StockDesk — MoneyControl x NSE style market terminal.
 * Express server: serves the SPA + JSON API.
 * Live quotes come from Kite Connect when connected, Yahoo Finance otherwise.
 */

const express = require('express');
const path = require('path');
const yahoo = require('./yahoo');
const screener = require('./screener');
const kite = require('./kite');
const research = require('./research');
const ideas = require('./ideas');
const commodities = require('./commodities');
const news = require('./news');
const gistsync = require('./gistsync');
const fs = require('fs');
const portfolio = require('./portfolio');
const { INDICES, UNIVERSE } = require('./symbols');

const app = express();
const PORT = process.env.PORT || 3210;

app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: 'text/csv', limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * Optional password gate for public hosting. Set APP_PASSWORD to enable —
 * without it (local use) everything stays open. Static shell stays public
 * (it holds no data); every /api route demands the auth cookie.
 */
const crypto = require('crypto');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_TOKEN = APP_PASSWORD
  ? crypto.createHash('sha256').update('stockdesk-v1:' + APP_PASSWORD).digest('hex')
  : null;

app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true, open: true });
  if (String(req.body?.password || '') === APP_PASSWORD) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `sd_auth=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${180 * 24 * 3600}${secure}`
    );
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD) return next();
  if (req.path === '/login' || req.path === '/kite/callback') return next();
  if ((req.headers.cookie || '').includes('sd_auth=' + AUTH_TOKEN)) return next();
  res.status(401).json({ error: 'auth required' });
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(`[api] ${req.method} ${req.originalUrl} -> ${e.message}`);
    res.status(500).json({ error: e.message });
  });

/**
 * Quotes: Kite first (live), Yahoo fallback, behind a short server-side cache
 * so overlapping polls (dashboard + portfolio + ticker) share one upstream fetch.
 */
const quoteCache = new Map(); // symbol -> { at, q }
const QUOTE_TTL_MS = 6000;

/**
 * Kite's feed only carries tradingsymbols ("HCLTECH"), no company names.
 * Keep a name map seeded from the built-in universe + the portfolio's
 * resolved symbols, and harvest names from Yahoo quotes as they pass through.
 */
const NAME_MAP = new Map(UNIVERSE.map((u) => [u.symbol, u.name]));
try {
  const symCache = require('fs').readFileSync(path.join(__dirname, '..', 'data', 'symbol-cache.json'), 'utf8');
  for (const v of Object.values(JSON.parse(symCache))) {
    if (v?.symbol && v?.name && !NAME_MAP.has(v.symbol)) NAME_MAP.set(v.symbol, v.name);
  }
} catch {}

function enrichNames(quotes) {
  for (const q of Object.values(quotes)) {
    if (q.source === 'kite') {
      const better = NAME_MAP.get(q.symbol);
      if (better) q.name = better;
    } else if (q.name && q.name !== q.symbol) {
      NAME_MAP.set(q.symbol, q.name);
    }
  }
  return quotes;
}

async function fetchQuotesUncached(symbols) {
  let out = {};
  if (kite.status().connected) {
    try {
      out = await kite.quotes(symbols);
    } catch (e) {
      console.warn('[kite] quote failed, falling back to Yahoo:', e.message);
    }
  }
  const missing = symbols.filter((s) => !out[s]);
  if (missing.length) {
    const y = await yahoo.quotes(missing);
    out = { ...y, ...out };
  }
  return enrichNames(out);
}

async function getQuotes(symbols) {
  const unique = [...new Set(symbols)].filter(Boolean);
  const out = {};
  const now = Date.now();
  const missing = [];
  for (const s of unique) {
    const hit = quoteCache.get(s);
    if (hit && now - hit.at < QUOTE_TTL_MS) out[s] = hit.q;
    else missing.push(s);
  }
  if (missing.length) {
    const fetched = await fetchQuotesUncached(missing);
    const at = Date.now();
    for (const [s, q] of Object.entries(fetched)) {
      quoteCache.set(s, { at, q });
      out[s] = q;
    }
    if (quoteCache.size > 2000) {
      // drop stale entries so the cache can't grow unbounded
      for (const [s, v] of quoteCache) if (at - v.at > QUOTE_TTL_MS) quoteCache.delete(s);
    }
  }
  return out;
}

// ---------- market data ----------

app.get('/api/quotes', wrap(async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').filter(Boolean);
  if (!symbols.length) return res.json({});
  res.json(await getQuotes(symbols));
}));

app.get('/api/indices', wrap(async (req, res) => {
  const quotes = await yahoo.quotes(INDICES.map((i) => i.symbol));
  res.json(
    INDICES.map((i) => ({ ...i, quote: quotes[i.symbol] || null })).filter((i) => i.quote)
  );
}));

app.get('/api/market', wrap(async (req, res) => {
  const symbols = UNIVERSE.map((u) => u.symbol);
  const quotes = await getQuotes(symbols);
  const rows = UNIVERSE.map((u) => ({ ...u, quote: quotes[u.symbol] || null })).filter((r) => r.quote && r.quote.price != null);
  const sorted = [...rows].sort((a, b) => (b.quote.changePct ?? 0) - (a.quote.changePct ?? 0));
  const advances = rows.filter((r) => (r.quote.changePct ?? 0) > 0).length;
  const declines = rows.filter((r) => (r.quote.changePct ?? 0) < 0).length;
  res.json({
    rows,
    gainers: sorted.slice(0, 8),
    losers: sorted.slice(-8).reverse(),
    breadth: { advances, declines, unchanged: rows.length - advances - declines },
    source: rows.some((r) => r.quote.source === 'kite') ? 'kite' : 'yahoo',
  });
}));

app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  // local universe first for instant matches
  const ql = q.toLowerCase();
  const local = UNIVERSE.filter(
    (u) => u.name.toLowerCase().includes(ql) || u.symbol.toLowerCase().includes(ql)
  ).map((u) => ({ symbol: u.symbol, name: u.name, exchange: 'NSE', type: 'EQUITY', sector: u.sector }));
  let remote = [];
  try {
    remote = await yahoo.search(q);
  } catch {}
  const seen = new Set(local.map((r) => r.symbol));
  const merged = [...local, ...remote.filter((r) => !seen.has(r.symbol))].slice(0, 12);
  res.json(merged);
}));

app.get('/api/history/:symbol', wrap(async (req, res) => {
  const { range = '1y', interval = '1d' } = req.query;
  // Kite first (real-time, when connected + has historical permission), Yahoo fallback
  if (kite.status().connected) {
    try {
      return res.json(await kite.history(req.params.symbol, range));
    } catch (e) {
      // no historical addon / index symbol / unsupported range — fall through
    }
  }
  res.json(await yahoo.history(req.params.symbol, range, interval));
}));

app.get('/api/financials/:symbol', wrap(async (req, res) => {
  res.json(await screener.financials(req.params.symbol));
}));

app.get('/api/fundamentals/:symbol', wrap(async (req, res) => {
  res.json(await yahoo.fundamentals(req.params.symbol));
}));

app.get('/api/research/:symbol', wrap(async (req, res) => {
  res.json(await research.research(req.params.symbol));
}));

/** Per-stock news (Google News RSS). */
app.get('/api/news/:symbol', wrap(async (req, res) => {
  const sym = req.params.symbol;
  const name = String(req.query.q || '').trim() || NAME_MAP.get(sym) || sym.replace(/\.(NS|BO)$/, '');
  res.json(await news.forQuery(`"${name}" stock India`));
}));

// ---------- watchlist ----------

const WL_FILE = path.join(__dirname, '..', 'data', 'watchlist.json');
function loadWatchlist() {
  try { return JSON.parse(fs.readFileSync(WL_FILE, 'utf8')).symbols || []; } catch { return []; }
}
function saveWatchlist(symbols) {
  fs.mkdirSync(path.dirname(WL_FILE), { recursive: true });
  fs.writeFileSync(WL_FILE, JSON.stringify({ symbols }, null, 2));
  gistsync.backupSoon('watchlist.json', () => JSON.stringify({ symbols }, null, 2));
}

async function watchlistCloudRestore() {
  const content = await gistsync.restore('watchlist.json');
  if (!content) return;
  try {
    const p = JSON.parse(content);
    if (Array.isArray(p.symbols)) {
      fs.mkdirSync(path.dirname(WL_FILE), { recursive: true });
      fs.writeFileSync(WL_FILE, content);
    }
  } catch {}
}

app.get('/api/watchlist', wrap(async (req, res) => {
  const symbols = loadWatchlist();
  const quotes = symbols.length ? await getQuotes(symbols) : {};
  res.json(symbols.map((s) => ({ symbol: s, quote: quotes[s] || null })));
}));

app.post('/api/watchlist/:symbol', wrap(async (req, res) => {
  const symbols = loadWatchlist();
  const s = req.params.symbol;
  const idx = symbols.indexOf(s);
  if (idx >= 0) symbols.splice(idx, 1);
  else symbols.unshift(s);
  saveWatchlist(symbols.slice(0, 50));
  res.json({ watching: idx < 0, symbols });
}));

/** Peer comparison within the built-in universe, by sector. */
app.get('/api/peers/:symbol', wrap(async (req, res) => {
  const sym = req.params.symbol;
  const self = UNIVERSE.find((u) => u.symbol === sym);
  let sector = self?.sector;
  if (!sector) {
    const f = await yahoo.fundamentals(sym).catch(() => null);
    sector = f?.sector || null;
  }
  const peers = sector
    ? UNIVERSE.filter((u) => u.sector === sector && u.symbol !== sym).slice(0, 6)
    : [];
  const symbols = [sym, ...peers.map((p) => p.symbol)];
  const quotes = await yahoo.quotes(symbols); // yahoo: has PE + mcap
  const rows = symbols
    .map((s) => {
      const q = quotes[s];
      if (!q) return null;
      return {
        symbol: s,
        name: NAME_MAP.get(s) || q.name,
        self: s === sym,
        price: q.price,
        changePct: q.changePct,
        pe: q.pe ?? null,
        marketCap: q.marketCap ?? null,
        yearHigh: q.yearHigh,
        yearLow: q.yearLow,
        pctFromHigh: q.yearHigh ? ((q.price - q.yearHigh) / q.yearHigh) * 100 : null,
      };
    })
    .filter(Boolean);
  res.json({ sector: sector || 'Unknown', rows });
}));

/** Gold & Silver desk: live INR prices, projections and accumulation signal. */
app.get('/api/commodities', wrap(async (req, res) => {
  res.json(await commodities.get());
}));

/** Idea scanner: returns picks when ready, or build progress while scanning. */
app.get('/api/ideas', wrap(async (req, res) => {
  if (req.query.peek === '1') return res.json(ideas.peek());
  res.json(ideas.ensure(req.query.force === '1'));
}));

// ---------- portfolio ----------

app.get('/api/portfolios', wrap(async (req, res) => res.json(portfolio.listPortfolios())));

app.post('/api/portfolios', wrap(async (req, res) => res.json(portfolio.createPortfolio(req.body?.name))));

app.put('/api/portfolios/:id', wrap(async (req, res) => {
  portfolio.renamePortfolio(req.params.id, req.body?.name || 'Portfolio');
  res.json({ ok: true });
}));

app.delete('/api/portfolios/:id', wrap(async (req, res) => {
  portfolio.deletePortfolio(req.params.id);
  res.json({ ok: true });
}));

function valueHoldings(holdings, quotes) {
  let invested = 0, current = 0, dayPnl = 0, realized = 0;
  const rows = holdings.map((h) => {
    const q = quotes[h.symbol];
    const ltp = q?.price ?? null;
    const value = ltp != null ? ltp * h.qty : null;
    const pnl = value != null ? value - h.invested : null;
    const dayChg = q?.change != null ? q.change * h.qty : null;
    invested += h.invested;
    current += value != null ? value : h.invested;
    if (dayChg != null) dayPnl += dayChg;
    realized += h.realized || 0;
    return {
      ...h,
      ltp,
      dayChangePct: q?.changePct ?? null,
      dayPnl: dayChg,
      value,
      pnl,
      pnlPct: pnl != null && h.invested > 0 ? (pnl / h.invested) * 100 : null,
      // stored name (from import resolution) beats Kite's bare tradingsymbol
      quoteName: (h.name && h.name !== h.symbol ? h.name : q?.name) || h.name,
      source: q?.source || null,
    };
  });
  return {
    rows,
    summary: {
      invested, current,
      pnl: current - invested,
      pnlPct: invested > 0 ? ((current - invested) / invested) * 100 : 0,
      dayPnl, realized,
      count: rows.length,
    },
  };
}

/** Combined view across every account. */
app.get('/api/portfolios/all', wrap(async (req, res) => {
  const agg = portfolio.getAllAccounts();
  const symbols = [...new Set([
    ...agg.holdings.map((h) => h.symbol),
    ...agg.accounts.flatMap((a) => a.holdings.map((h) => h.symbol)),
  ])];
  const quotes = await getQuotes(symbols);
  const valued = valueHoldings(agg.holdings, quotes);
  const accounts = agg.accounts.map((a) => {
    const v = valueHoldings(a.holdings, quotes);
    return { id: a.id, name: a.name, summary: v.summary };
  });
  res.json({
    id: 'all',
    name: 'All Accounts',
    holdings: valued.rows,
    accounts,
    transactions: [],
    summary: valued.summary,
  });
}));

/** Portfolio with live valuation. */
app.get('/api/portfolios/:id', wrap(async (req, res) => {
  const pf = portfolio.getPortfolio(req.params.id);
  const quotes = await getQuotes(pf.holdings.map((h) => h.symbol));
  const valued = valueHoldings(pf.holdings, quotes);
  res.json({
    id: pf.id,
    name: pf.name,
    holdings: valued.rows,
    transactions: pf.transactions,
    summary: valued.summary,
  });
}));

app.post('/api/portfolios/:id/transactions', wrap(async (req, res) => {
  res.json(portfolio.addTransaction(req.params.id, req.body));
}));

app.delete('/api/portfolios/:id/transactions/:txId', wrap(async (req, res) => {
  res.json(portfolio.deleteTransaction(req.params.id, req.params.txId));
}));

app.delete('/api/portfolios/:id/holdings/:symbol', wrap(async (req, res) => {
  res.json(portfolio.removeHolding(req.params.id, req.params.symbol));
}));

app.post('/api/portfolios/:id/import', wrap(async (req, res) => {
  let csv = typeof req.body === 'string' ? req.body : req.body?.csv;
  if (csv != null && typeof csv !== 'string') csv = String(csv);
  if (!csv) return res.status(400).json({ error: 'No CSV content' });
  res.json(await portfolio.importCSV(req.params.id, csv));
}));

// ---------- kite ----------

app.get('/api/kite/status', wrap(async (req, res) => res.json(kite.status())));

app.post('/api/kite/credentials', wrap(async (req, res) => {
  res.json(kite.setCredentials(req.body?.apiKey, req.body?.apiSecret));
}));

app.post('/api/kite/disconnect', wrap(async (req, res) => res.json(kite.disconnect())));

/** Kite redirects here after login (set redirect URL to http://localhost:3210/api/kite/callback). */
app.get('/api/kite/callback', wrap(async (req, res) => {
  const { request_token, status } = req.query;
  if (status === 'cancelled' || !request_token) {
    return res.redirect('/#/settings?kite=cancelled');
  }
  try {
    await kite.createSession(String(request_token));
    res.redirect('/#/settings?kite=connected');
  } catch (e) {
    res.redirect('/#/settings?kite=error&msg=' + encodeURIComponent(e.message));
  }
}));

/** Manual token exchange (paste request_token if redirect URL doesn't point here). */
app.post('/api/kite/session', wrap(async (req, res) => {
  res.json(await kite.createSession(String(req.body?.requestToken || '').trim()));
}));

/** Adopt today's access token generated on another instance (PC -> cloud sync). */
app.post('/api/kite/session-import', wrap(async (req, res) => {
  res.json(kite.importSession(req.body || {}));
}));

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

Promise.allSettled([portfolio.cloudRestore(), kite.cloudRestore(), watchlistCloudRestore()]).finally(() => {
  app.listen(PORT, () => {
    console.log(`StockDesk running at http://localhost:${PORT}`);
  });
});
