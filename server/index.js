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
const alerts = require('./alerts');
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
  if (req.path === '/login' || req.path === '/kite/callback' || req.path === '/health') return next();
  if ((req.headers.cookie || '').includes('sd_auth=' + AUTH_TOKEN)) return next();
  res.status(401).json({ error: 'auth required' });
});

/** Public heartbeat — used by the keep-alive self-ping and uptime monitors. */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, up: process.uptime(), at: Date.now() });
});

/**
 * Keep-alive: Render's free tier spins the instance down after ~15 idle
 * minutes. Pinging our own public URL every 10 minutes keeps it warm 24/7
 * (a full month ≈ 744h fits inside the 750 free instance-hours).
 * RENDER_EXTERNAL_URL is set automatically by Render — no-op locally.
 */
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL || '';
if (SELF_URL) {
  setInterval(() => {
    fetch(`${SELF_URL}/api/health`).catch(() => {});
  }, 10 * 60 * 1000);
  console.log(`[keepalive] self-ping enabled -> ${SELF_URL}/api/health every 10 min`);
}

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

// ---------- alerts ----------

app.get('/api/alerts', wrap(async (req, res) => {
  const rows = alerts.list();
  const quotes = rows.length ? await getQuotes([...new Set(rows.map((a) => a.symbol))]) : {};
  res.json(rows.map((a) => ({ ...a, quote: quotes[a.symbol] || null })));
}));
app.post('/api/alerts', wrap(async (req, res) => res.json(alerts.add(req.body || {}))));
app.delete('/api/alerts/:id', wrap(async (req, res) => { alerts.remove(req.params.id); res.json({ ok: true }); }));
app.post('/api/alerts/:id/reset', wrap(async (req, res) => { alerts.reset(req.params.id); res.json({ ok: true }); }));

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

const SECTOR_OF = new Map(UNIVERSE.map((u) => [u.symbol, u.sector]));

// Persistent sector cache for holdings outside the built-in universe.
const SECTOR_FILE = path.join(__dirname, '..', 'data', 'sector-cache.json');
try {
  const cached = JSON.parse(fs.readFileSync(SECTOR_FILE, 'utf8'));
  for (const [k, v] of Object.entries(cached)) if (!SECTOR_OF.has(k)) SECTOR_OF.set(k, v);
} catch {}
let sectorResolving = false;
function persistSectors() {
  try {
    const obj = {};
    for (const [k, v] of SECTOR_OF) if (!UNIVERSE.find((u) => u.symbol === k)) obj[k] = v;
    fs.mkdirSync(path.dirname(SECTOR_FILE), { recursive: true });
    fs.writeFileSync(SECTOR_FILE, JSON.stringify(obj));
  } catch {}
}
/** Fill in sectors for unknown symbols in the background (throttled, one pass). */
async function resolveSectors(symbols) {
  if (sectorResolving) return;
  const missing = [...new Set(symbols)].filter((s) => !SECTOR_OF.has(s)).slice(0, 40);
  if (!missing.length) return;
  sectorResolving = true;
  try {
    for (const s of missing) {
      try {
        const f = await yahoo.fundamentals(s);
        SECTOR_OF.set(s, f?.sector || 'Other');
      } catch {
        SECTOR_OF.set(s, 'Other');
      }
    }
    persistSectors();
  } finally {
    sectorResolving = false;
  }
}

/** Sector allocation, concentration + trend insights for a valued portfolio. */
function portfolioInsights(rows) {
  const valued = rows.filter((h) => h.value != null && h.value > 0);
  const total = valued.reduce((a, h) => a + h.value, 0);
  if (!total) return { sectors: [], insights: [], best: null, worst: null };

  const bySector = new Map();
  for (const h of valued) {
    const sec = SECTOR_OF.get(h.symbol) || 'Other';
    bySector.set(sec, (bySector.get(sec) || 0) + h.value);
  }
  const sectors = [...bySector.entries()]
    .map(([name, value]) => ({ name, value, pct: (value / total) * 100 }))
    .sort((a, b) => b.value - a.value);

  const sorted = [...valued].sort((a, b) => b.value - a.value);
  // exclude corporate-action cost-basis artifacts (e.g. demerged shares at ~0 cost -> +40000%)
  const withPnl = valued.filter((h) => h.pnlPct != null && h.pnlPct > -99.5 && h.pnlPct < 500);
  const best = withPnl.length ? withPnl.reduce((a, b) => (b.pnlPct > a.pnlPct ? b : a)) : null;
  const worst = withPnl.length ? withPnl.reduce((a, b) => (b.pnlPct < a.pnlPct ? b : a)) : null;

  const insights = [];
  if (sorted[0] && sorted[0].value / total > 0.25) {
    insights.push({ level: 'warn', text: `${dispSymName(sorted[0])} alone is ${((sorted[0].value / total) * 100).toFixed(0)}% of the book — heavy single-stock concentration.` });
  }
  const top2 = (sorted[0]?.value || 0) + (sorted[1]?.value || 0);
  if (sorted.length >= 2 && top2 / total > 0.5) {
    insights.push({ level: 'warn', text: `Top 2 holdings are ${((top2 / total) * 100).toFixed(0)}% of the portfolio — highly concentrated.` });
  }
  const topRealSector = sectors.find((s) => s.name !== 'Other');
  if (topRealSector && topRealSector.pct > 30) {
    insights.push({ level: 'warn', text: `${topRealSector.pct.toFixed(0)}% is in ${topRealSector.name} — heavy exposure to one sector.` });
  }
  if (valued.length > 40) {
    insights.push({ level: 'info', text: `${valued.length} holdings — quite spread out; returns will track the index closely (over-diversified).` });
  } else if (valued.length > 0 && valued.length <= 5) {
    insights.push({ level: 'info', text: `Just ${valued.length} holdings — concentrated book, higher risk and higher reward.` });
  }
  const belowCost = withPnl.filter((h) => h.pnlPct < 0).length;
  if (withPnl.length && belowCost / withPnl.length > 0.5) {
    insights.push({ level: 'warn', text: `${belowCost} of ${withPnl.length} holdings are below cost — the book is under water on breadth.` });
  }
  if (!insights.length) insights.push({ level: 'ok', text: 'Reasonably balanced — no single position or sector is dominating.' });

  return {
    sectors: sectors.slice(0, 10),
    insights,
    best: best ? { symbol: best.symbol, name: best.quoteName || best.name, pnlPct: best.pnlPct } : null,
    worst: worst ? { symbol: worst.symbol, name: worst.quoteName || worst.name, pnlPct: worst.pnlPct } : null,
  };
}
function dispSymName(h) {
  return (h.symbol || '').replace(/\.(NS|BO)$/, '');
}

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
  resolveSectors(symbols).catch(() => {});
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
    insights: portfolioInsights(valued.rows),
  });
}));

/** Portfolio with live valuation. */
app.get('/api/portfolios/:id', wrap(async (req, res) => {
  const pf = portfolio.getPortfolio(req.params.id);
  const quotes = await getQuotes(pf.holdings.map((h) => h.symbol));
  const valued = valueHoldings(pf.holdings, quotes);
  resolveSectors(pf.holdings.map((h) => h.symbol)).catch(() => {});
  res.json({
    id: pf.id,
    name: pf.name,
    holdings: valued.rows,
    transactions: pf.transactions,
    summary: valued.summary,
    insights: portfolioInsights(valued.rows),
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

Promise.allSettled([portfolio.cloudRestore(), kite.cloudRestore(), watchlistCloudRestore(), alerts.cloudRestore()]).finally(() => {
  alerts.startChecker(getQuotes, 60 * 1000);
  app.listen(PORT, () => {
    console.log(`StockDesk running at http://localhost:${PORT}`);
  });
});
