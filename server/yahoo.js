/**
 * Yahoo Finance data layer (free fallback + fundamentals source).
 * Handles the cookie+crumb dance Yahoo requires for some endpoints,
 * with in-memory caching to stay well under rate limits.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let crumbState = { cookie: null, crumb: null, fetchedAt: 0 };

const cache = new Map(); // key -> { at, ttl, data }

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data;
  return null;
}
function cacheSet(key, data, ttl) {
  cache.set(key, { at: Date.now(), ttl, data });
  if (cache.size > 3000) {
    // prune oldest entries
    const keys = [...cache.keys()].slice(0, 1000);
    for (const k of keys) cache.delete(k);
  }
  return data;
}

async function getCrumb(force = false) {
  if (!force && crumbState.crumb && Date.now() - crumbState.fetchedAt < 30 * 60 * 1000) {
    return crumbState;
  }
  const res = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': UA },
    redirect: 'manual',
  }).catch(() => null);
  let cookie = '';
  if (res) {
    const setCookie = res.headers.get('set-cookie') || '';
    cookie = setCookie.split(';')[0];
  }
  let crumb = null;
  if (cookie) {
    const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Cookie: cookie },
    }).catch(() => null);
    if (cr && cr.ok) {
      const text = (await cr.text()).trim();
      if (text && !text.includes('{')) crumb = text;
    }
  }
  crumbState = { cookie, crumb, fetchedAt: Date.now() };
  return crumbState;
}

async function yFetch(url, { withCrumb = false } = {}) {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  let finalUrl = url;
  if (withCrumb) {
    const { cookie, crumb } = await getCrumb();
    if (cookie) headers.Cookie = cookie;
    if (crumb) finalUrl += (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(crumb);
  }
  let res = await fetch(finalUrl, { headers });
  if (res.status === 401 || res.status === 403) {
    // stale crumb — refresh once and retry
    const { cookie, crumb } = await getCrumb(true);
    if (cookie) headers.Cookie = cookie;
    let retryUrl = url;
    if (withCrumb && crumb) {
      retryUrl += (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(crumb);
    }
    res = await fetch(retryUrl, { headers });
  }
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${url}`);
  return res.json();
}

/** Quote via v8 chart meta — no crumb needed, very reliable. */
async function quoteFromChart(symbol) {
  const key = `qc:${symbol}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const j = await yFetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=false`
  );
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('no meta for ' + symbol);
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const q = {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    exchange: symbol.endsWith('.BO') ? 'BSE' : symbol.endsWith('.NS') ? 'NSE' : meta.exchangeName,
    currency: meta.currency,
    price,
    prevClose: prev,
    change: price - prev,
    changePct: prev ? ((price - prev) / prev) * 100 : 0,
    dayHigh: meta.regularMarketDayHigh,
    dayLow: meta.regularMarketDayLow,
    volume: meta.regularMarketVolume,
    yearHigh: meta.fiftyTwoWeekHigh,
    yearLow: meta.fiftyTwoWeekLow,
    marketState: meta.marketState || null,
    time: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
    source: 'yahoo',
  };
  return cacheSet(key, q, 5000);
}

/** Batch quotes via v7 (crumb) with chart-meta fallback per symbol. */
async function quotes(symbols) {
  if (!symbols.length) return {};
  const out = {};
  const missing = [];
  for (const s of symbols) {
    const hit = cacheGet(`q7:${s}`);
    if (hit) out[s] = hit;
    else missing.push(s);
  }
  if (missing.length) {
    try {
      for (let i = 0; i < missing.length; i += 60) {
        const batch = missing.slice(i, i + 60);
        const j = await yFetch(
          `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(batch.join(','))}`,
          { withCrumb: true }
        );
        for (const r of j?.quoteResponse?.result || []) {
          const q = {
            symbol: r.symbol,
            name: r.longName || r.shortName || r.symbol,
            exchange: r.symbol.endsWith('.BO') ? 'BSE' : r.symbol.endsWith('.NS') ? 'NSE' : r.fullExchangeName,
            currency: r.currency,
            price: r.regularMarketPrice,
            prevClose: r.regularMarketPreviousClose,
            change: r.regularMarketChange,
            changePct: r.regularMarketChangePercent,
            dayHigh: r.regularMarketDayHigh,
            dayLow: r.regularMarketDayLow,
            open: r.regularMarketOpen,
            volume: r.regularMarketVolume,
            yearHigh: r.fiftyTwoWeekHigh,
            yearLow: r.fiftyTwoWeekLow,
            marketCap: r.marketCap,
            pe: r.trailingPE,
            eps: r.epsTrailingTwelveMonths,
            bookValue: r.bookValue,
            divYield: r.trailingAnnualDividendYield ? r.trailingAnnualDividendYield * 100 : null,
            avgVolume3m: r.averageDailyVolume3Month,
            fiftyDayAvg: r.fiftyDayAverage,
            twoHundredDayAvg: r.twoHundredDayAverage,
            marketState: r.marketState,
            time: r.regularMarketTime ? r.regularMarketTime * 1000 : Date.now(),
            source: 'yahoo',
          };
          out[r.symbol] = cacheSet(`q7:${r.symbol}`, q, 8000);
        }
      }
    } catch (e) {
      // v7 blocked — fall back to per-symbol chart meta (limited concurrency)
      const still = missing.filter((s) => !out[s]);
      const CONC = 8;
      for (let i = 0; i < still.length; i += CONC) {
        await Promise.all(
          still.slice(i, i + CONC).map(async (s) => {
            try {
              out[s] = await quoteFromChart(s);
            } catch {}
          })
        );
      }
    }
    // anything v7 skipped (bad symbols etc.) — try chart meta
    const skipped = missing.filter((s) => !out[s]);
    await Promise.all(
      skipped.slice(0, 20).map(async (s) => {
        try {
          out[s] = await quoteFromChart(s);
        } catch {}
      })
    );
  }
  return out;
}

/** Historical candles. range: 1d,5d,1mo,3mo,6mo,1y,2y,5y,max */
async function history(symbol, range = '1y', interval = '1d') {
  const key = `h:${symbol}:${range}:${interval}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const j = await yFetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`
  );
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error('no history for ' + symbol);
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null) continue;
    candles.push({
      time: ts[i],
      open: q.open?.[i] ?? q.close[i],
      high: q.high?.[i] ?? q.close[i],
      low: q.low?.[i] ?? q.close[i],
      close: q.close[i],
      volume: q.volume?.[i] ?? 0,
    });
  }
  const data = { symbol, range, interval, meta: r.meta, candles };
  const ttl = interval === '1m' || interval === '5m' ? 30 * 1000 : 5 * 60 * 1000;
  return cacheSet(key, data, ttl);
}

/** Company fundamentals via quoteSummary (crumb required). */
async function fundamentals(symbol) {
  const key = `f:${symbol}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const modules = [
    'summaryProfile',
    'summaryDetail',
    'defaultKeyStatistics',
    'financialData',
    'earnings',
    'price',
  ].join(',');
  const j = await yFetch(
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`,
    { withCrumb: true }
  );
  const r = j?.quoteSummary?.result?.[0];
  if (!r) throw new Error('no fundamentals for ' + symbol);
  const g = (obj, path) => {
    let cur = obj;
    for (const p of path.split('.')) {
      cur = cur?.[p];
      if (cur == null) return null;
    }
    // Yahoo wraps numbers as {raw, fmt} and sends {} for missing values
    if (typeof cur === 'object') {
      return typeof cur.raw === 'number' || typeof cur.raw === 'string' ? cur.raw : null;
    }
    return cur;
  };
  const data = {
    symbol,
    sector: g(r, 'summaryProfile.sector'),
    industry: g(r, 'summaryProfile.industry'),
    website: g(r, 'summaryProfile.website'),
    description: g(r, 'summaryProfile.longBusinessSummary'),
    employees: g(r, 'summaryProfile.fullTimeEmployees'),
    marketCap: g(r, 'summaryDetail.marketCap') ?? g(r, 'price.marketCap'),
    pe: g(r, 'summaryDetail.trailingPE'),
    forwardPE: g(r, 'summaryDetail.forwardPE') ?? g(r, 'defaultKeyStatistics.forwardPE'),
    pb: g(r, 'defaultKeyStatistics.priceToBook'),
    eps: g(r, 'defaultKeyStatistics.trailingEps'),
    beta: g(r, 'summaryDetail.beta') ?? g(r, 'defaultKeyStatistics.beta'),
    divYield: (() => {
      const y = g(r, 'summaryDetail.dividendYield');
      return y != null ? y * 100 : null;
    })(),
    roe: (() => {
      const v = g(r, 'financialData.returnOnEquity');
      return v != null ? v * 100 : null;
    })(),
    roa: (() => {
      const v = g(r, 'financialData.returnOnAssets');
      return v != null ? v * 100 : null;
    })(),
    profitMargin: (() => {
      const v = g(r, 'financialData.profitMargins');
      return v != null ? v * 100 : null;
    })(),
    operatingMargin: (() => {
      const v = g(r, 'financialData.operatingMargins');
      return v != null ? v * 100 : null;
    })(),
    revenueGrowth: (() => {
      const v = g(r, 'financialData.revenueGrowth');
      return v != null ? v * 100 : null;
    })(),
    earningsGrowth: (() => {
      const v = g(r, 'financialData.earningsGrowth');
      return v != null ? v * 100 : null;
    })(),
    debtToEquity: g(r, 'financialData.debtToEquity'),
    currentRatio: g(r, 'financialData.currentRatio'),
    totalRevenue: g(r, 'financialData.totalRevenue'),
    totalCash: g(r, 'financialData.totalCash'),
    totalDebt: g(r, 'financialData.totalDebt'),
    freeCashflow: g(r, 'financialData.freeCashflow'),
    analystTargetMean: g(r, 'financialData.targetMeanPrice'),
    analystTargetHigh: g(r, 'financialData.targetHighPrice'),
    analystTargetLow: g(r, 'financialData.targetLowPrice'),
    analystRecommendation: g(r, 'financialData.recommendationKey'),
    analystCount: g(r, 'financialData.numberOfAnalystOpinions'),
    heldByInsiders: (() => {
      const v = g(r, 'defaultKeyStatistics.heldPercentInsiders');
      return v != null ? v * 100 : null;
    })(),
    heldByInstitutions: (() => {
      const v = g(r, 'defaultKeyStatistics.heldPercentInstitutions');
      return v != null ? v * 100 : null;
    })(),
    source: 'yahoo',
  };
  return cacheSet(key, data, 60 * 60 * 1000);
}

/**
 * Income statement / balance sheet / cash flow history via the
 * fundamentals-timeseries API (works without crumb). Values are in INR.
 */
async function financials(symbol) {
  const key = `fin:${symbol}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const types = [
    'annualTotalRevenue', 'annualOperatingIncome', 'annualNetIncome', 'annualBasicEPS',
    'annualGrossProfit', 'annualTotalDebt', 'annualStockholdersEquity',
    'annualOperatingCashFlow', 'annualFreeCashFlow',
    'quarterlyTotalRevenue', 'quarterlyOperatingIncome', 'quarterlyNetIncome', 'quarterlyBasicEPS',
  ];
  const period1 = Math.floor(Date.now() / 1000) - 8 * 365 * 24 * 3600;
  const period2 = Math.floor(Date.now() / 1000);
  const j = await yFetch(
    `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
      `?symbol=${encodeURIComponent(symbol)}&type=${types.join(',')}&period1=${period1}&period2=${period2}&merge=false&padTimeSeries=false`
  );
  const results = j?.timeseries?.result || [];
  const annualMap = new Map(); // date -> row
  const quarterMap = new Map();
  const fieldOf = {
    annualTotalRevenue: 'revenue', annualOperatingIncome: 'operatingIncome', annualNetIncome: 'netIncome',
    annualBasicEPS: 'eps', annualGrossProfit: 'grossProfit', annualTotalDebt: 'totalDebt',
    annualStockholdersEquity: 'equity', annualOperatingCashFlow: 'ocf', annualFreeCashFlow: 'fcf',
    quarterlyTotalRevenue: 'revenue', quarterlyOperatingIncome: 'operatingIncome',
    quarterlyNetIncome: 'netIncome', quarterlyBasicEPS: 'eps',
  };
  for (const r of results) {
    const type = r?.meta?.type?.[0];
    const field = fieldOf[type];
    if (!field || !Array.isArray(r[type])) continue;
    const map = type.startsWith('annual') ? annualMap : quarterMap;
    for (const point of r[type]) {
      if (!point || point.reportedValue?.raw == null) continue;
      const date = point.asOfDate;
      if (!map.has(date)) map.set(date, { date });
      map.get(date)[field] = point.reportedValue.raw;
    }
  }
  const sortRows = (m) => [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const annual = sortRows(annualMap).filter((r) => r.revenue != null || r.netIncome != null);
  const quarterly = sortRows(quarterMap).filter((r) => r.revenue != null || r.netIncome != null).slice(-8);
  for (const rows of [annual, quarterly]) {
    for (const r of rows) {
      r.netMargin = r.revenue > 0 && r.netIncome != null ? (r.netIncome / r.revenue) * 100 : null;
      r.opMargin = r.revenue > 0 && r.operatingIncome != null ? (r.operatingIncome / r.revenue) * 100 : null;
    }
  }
  const data = { symbol, annual, quarterly, source: 'yahoo' };
  return cacheSet(key, data, 60 * 60 * 1000);
}

/** Symbol / company search, filtered to Indian exchanges first. */
async function search(query) {
  const key = `s:${query.toLowerCase()}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const j = await yFetch(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=20&newsCount=0&listsCount=0`
  );
  const all = (j?.quotes || [])
    .filter((r) => r.symbol && (r.quoteType === 'EQUITY' || r.quoteType === 'ETF' || r.quoteType === 'INDEX'))
    .map((r) => ({
      symbol: r.symbol,
      name: r.longname || r.shortname || r.symbol,
      exchange: r.symbol.endsWith('.NS') ? 'NSE' : r.symbol.endsWith('.BO') ? 'BSE' : r.exchDisp || r.exchange,
      type: r.quoteType,
    }));
  const indian = all.filter((r) => r.exchange === 'NSE' || r.exchange === 'BSE');
  const rest = all.filter((r) => r.exchange !== 'NSE' && r.exchange !== 'BSE');
  const results = [...indian, ...rest].slice(0, 15);
  return cacheSet(key, results, 10 * 60 * 1000);
}

module.exports = { quotes, quoteFromChart, history, fundamentals, financials, search };
