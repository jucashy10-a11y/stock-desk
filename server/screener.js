/**
 * Screener.in financials source — covers EVERY Indian listed company
 * (Yahoo's statement data is empty for most Indian small/midcaps).
 * Parses Quarterly Results, annual P&L, balance sheet, cash flow and
 * headline ratios from the public company page. Cached 6h.
 * Falls back to Yahoo's fundamentals-timeseries when Screener has nothing.
 */

const yahoo = require('./yahoo');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const cache = new Map(); // symbol -> { at, data }
const TTL = 6 * 60 * 60 * 1000;

const CR = 1e7; // screener figures are in ₹ crores; keep raw INR like Yahoo

function strip(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s) {
  if (s == null) return null;
  const t = String(s).replace(/[^\d.\-]/g, '');
  if (t === '' || t === '-' || t === '--') return null;
  const v = parseFloat(t);
  return isFinite(v) ? v : null;
}

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

function periodToDate(p) {
  const m = p.match(/^([A-Z][a-z]{2})\s+(\d{4})$/);
  if (!m || !MONTHS[m[1]]) return null; // skips "TTM" etc.
  return `${m[2]}-${MONTHS[m[1]]}-28`;
}

/** Parse the first data-table inside <section id="...">. */
function parseSection(html, id) {
  const sec = html.match(new RegExp(`<section id="${id}"[\\s\\S]*?<\\/section>`));
  if (!sec) return null;
  const table = sec[0].match(/<table[^>]*data-table[\s\S]*?<\/table>/);
  if (!table) return null;
  const head = table[0].match(/<thead>[\s\S]*?<\/thead>/);
  if (!head) return null;
  const periods = [...head[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => strip(m[1])).slice(1);
  const rows = {};
  for (const tr of table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
    if (tds.length < 2) continue;
    const label = tds[0].replace(/\s*\+\s*$/, '').trim();
    if (label) rows[label] = tds.slice(1);
  }
  return { periods, rows };
}

function pick(rows, labels) {
  for (const l of labels) if (rows[l]) return rows[l];
  return null;
}

function buildSeries(pnl, bs, cf) {
  if (!pnl || !pnl.periods.length) return [];
  const sales = pick(pnl.rows, ['Sales', 'Revenue']);
  const op = pick(pnl.rows, ['Operating Profit', 'Financing Profit']);
  const opm = pick(pnl.rows, ['OPM %', 'Financing Margin %']);
  const np = pick(pnl.rows, ['Net Profit', 'Profit after tax']);
  const eps = pick(pnl.rows, ['EPS in Rs']);
  const borrow = bs ? pick(bs.rows, ['Borrowings']) : null;
  const eqCap = bs ? pick(bs.rows, ['Equity Capital']) : null;
  const reserves = bs ? pick(bs.rows, ['Reserves']) : null;
  const ocf = cf ? pick(cf.rows, ['Cash from Operating Activity']) : null;

  const bsIdx = (date) => (bs ? bs.periods.findIndex((p) => periodToDate(p) === date) : -1);
  const cfIdx = (date) => (cf ? cf.periods.findIndex((p) => periodToDate(p) === date) : -1);

  const out = [];
  pnl.periods.forEach((p, i) => {
    const date = periodToDate(p);
    if (!date) return;
    const revenue = parseNum(sales?.[i]);
    const netIncome = parseNum(np?.[i]);
    const bi = bsIdx(date);
    const ci = cfIdx(date);
    const eq = bi >= 0 ? (parseNum(eqCap?.[bi]) ?? 0) + (parseNum(reserves?.[bi]) ?? 0) : null;
    out.push({
      date,
      revenue: revenue != null ? revenue * CR : null,
      operatingIncome: parseNum(op?.[i]) != null ? parseNum(op[i]) * CR : null,
      netIncome: netIncome != null ? netIncome * CR : null,
      eps: parseNum(eps?.[i]),
      opMargin: parseNum(opm?.[i]),
      netMargin: revenue > 0 && netIncome != null ? (netIncome / revenue) * 100 : null,
      totalDebt: bi >= 0 && parseNum(borrow?.[bi]) != null ? parseNum(borrow[bi]) * CR : null,
      equity: eq != null && eq !== 0 ? eq * CR : null,
      ocf: ci >= 0 && parseNum(ocf?.[ci]) != null ? parseNum(ocf[ci]) * CR : null,
      fcf: null,
    });
  });
  return out;
}

function parseRatios(html) {
  const ul = html.match(/<ul id="top-ratios"[\s\S]*?<\/ul>/);
  if (!ul) return {};
  const out = {};
  for (const li of ul[0].matchAll(/<li[\s\S]*?<\/li>/g)) {
    const name = li[0].match(/<span class="name">([\s\S]*?)<\/span>/);
    const value = li[0].match(/<span class="nowrap value">([\s\S]*?)<\/span>\s*<\/li>/) ||
      li[0].match(/<span class="[^"]*value[^"]*">([\s\S]*?)<\/span>/);
    if (!name || !value) continue;
    const n = strip(name[1]);
    const v = parseNum(strip(value[1]));
    if (v == null) continue;
    if (n === 'Market Cap') out.marketCap = v * CR;
    else if (n === 'Stock P/E') out.pe = v;
    else if (n === 'ROE') out.roe = v;
    else if (n === 'ROCE') out.roce = v;
    else if (n === 'Dividend Yield') out.divYield = v;
    else if (n === 'Book Value') out.bookValue = v;
    else if (n === 'Current Price') out.price = v;
    else if (n === 'Face Value') out.faceValue = v;
  }
  return out;
}

async function fetchPage(base, consolidated) {
  const url = `https://www.screener.in/company/${encodeURIComponent(base)}/${consolidated ? 'consolidated/' : ''}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) return null;
  return res.text();
}

async function fromScreener(symbol) {
  const base = symbol.replace(/\.(NS|BO)$/, '');
  // consolidated numbers first (like MoneyControl), standalone as fallback
  let html = await fetchPage(base, true);
  let quarterly = html ? parseSection(html, 'quarters') : null;
  if (!quarterly || !quarterly.periods.length) {
    const alt = await fetchPage(base, false);
    if (alt) {
      const q2 = parseSection(alt, 'quarters');
      if (q2 && q2.periods.length) {
        html = alt;
        quarterly = q2;
      }
    }
  }
  if (!html || !quarterly || !quarterly.periods.length) return null;
  const pnl = parseSection(html, 'profit-loss');
  const bs = parseSection(html, 'balance-sheet');
  const cf = parseSection(html, 'cash-flow');
  const annual = buildSeries(pnl, bs, cf);
  const qSeries = buildSeries(quarterly, null, null).slice(-8);
  if (!annual.length && !qSeries.length) return null;
  return {
    symbol,
    annual,
    quarterly: qSeries,
    ratios: parseRatios(html),
    source: 'screener',
  };
}

/** Financial statements: Screener first (full Indian coverage), Yahoo fallback. */
async function financials(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  let data = null;
  if (/\.(NS|BO)$/.test(symbol)) {
    try {
      data = await fromScreener(symbol);
    } catch {
      data = null;
    }
  }
  if (!data || (!data.annual.length && !data.quarterly.length)) {
    const y = await yahoo.financials(symbol);
    // keep screener ratios even if statements came from yahoo
    if (data?.ratios) y.ratios = data.ratios;
    data = y;
  }
  cache.set(symbol, { at: Date.now(), data });
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at > TTL) cache.delete(k);
  }
  return data;
}

module.exports = { financials };
