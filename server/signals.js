/**
 * StockDesk Signals — rules-based technical setup scanner.
 *
 * Scans the universe (+ optionally holdings) for actionable chart setups and
 * attaches concrete trade levels: entry, stop-loss, target and risk:reward.
 * These are MECHANICAL signals from price/volume math — not advice. Reference
 * priors are explicitly unvalidated until backed by an outcome ledger.
 *
 * Runs on a schedule (pre-market / intraday / post-market) since the server is
 * always-on; results are cached and served to the Signals page.
 */

const yahoo = require('./yahoo');
const { UNIVERSE } = require('./symbols');

let state = { status: 'idle', progress: 0, total: 0, results: null, builtAt: 0, error: null };
const FRESH_MS = 18 * 60 * 1000;

// ---------- indicator math ----------
const sma = (a, p, end) => {
  end = end == null ? a.length : end;
  if (end < p) return null;
  let s = 0;
  for (let i = end - p; i < end; i++) s += a[i];
  return s / p;
};
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let a = 0;
  for (let i = tr.length - period; i < tr.length; i++) a += tr[i];
  return a / period;
}
const round2 = (n) => Math.round(n * 100) / 100;

// ---------- setup detectors ----------
// Each returns null or { type, label, referenceRate, reasons[], entry, stop, target, quality(0-100) }
// Stops sit below structure; targets use a >=2R measured move by default.

function levels(entry, stop, targetMult = 2) {
  const risk = entry - stop;
  const target = entry + risk * targetMult;
  return {
    entry: round2(entry),
    stop: round2(stop),
    target: round2(target),
    rr: round2(risk > 0 ? (target - entry) / risk : 0),
    stopPct: round2(((stop - entry) / entry) * 100),
    targetPct: round2(((target - entry) / entry) * 100),
  };
}

const MAX_STOP_PCT = 12;
const MIN_STOP_PCT = 1.5;
function safeStop(entry, candidates, maxRiskPct = MAX_STOP_PCT) {
  const valid = candidates.filter((v) => Number.isFinite(v) && v > 0 && v < entry);
  if (!valid.length) return entry * 0.97;
  // Use the nearest defensible technical level. Choosing the lowest candidate
  // creates very wide stops and hides excessive absolute risk behind a good R:R.
  const technical = Math.max(...valid);
  const capped = Math.max(technical, entry * (1 - maxRiskPct / 100));
  return Math.min(capped, entry * (1 - MIN_STOP_PCT / 100));
}

function detectSetups(sym, name, sector, candles) {
  if (!candles || candles.length < 220) return [];
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume || 0);
  const n = closes.length;
  const price = closes[n - 1];
  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const s50p = sma(closes, 50, n - 5), s200p = sma(closes, 200, n - 5);
  const vAvg20 = sma(vols, 20, n) || 0;
  const vToday = vols[n - 1];
  const volMult = vAvg20 > 0 ? vToday / vAvg20 : 0;
  const a = atr(candles) || price * 0.02;
  const r = rsi(closes);
  const ret = (d) => (n > d ? ((price - closes[n - 1 - d]) / closes[n - 1 - d]) * 100 : null);

  // structure levels
  const prior20High = Math.max(...highs.slice(n - 21, n - 1)); // resistance excl today
  const prior55High = Math.max(...highs.slice(n - 56, n - 1));
  const swingLow = Math.min(...lows.slice(n - 10)); // recent support for stops
  const yearHigh = Math.max(...highs.slice(-252));
  const yearLow = Math.min(...lows.slice(-252));
  const out = [];
  const trendUp = s50 != null && s200 != null && s50 > s200 && price > s200;

  // 1) Range / consolidation breakout on volume
  if (price > prior20High && volMult >= 1.4 && s50 != null && price > s50 && r != null && r < 78) {
    const stop = safeStop(price, [swingLow, price - 1.8 * a]);
    out.push({
      type: 'breakout', label: 'Range Breakout', referenceRate: 52,
      reasons: [
        `Broke above 20-day resistance ₹${round2(prior20High)}`,
        `Volume ${volMult.toFixed(1)}× the 20-day average — real participation`,
        `Above 50-DMA${trendUp ? ', long-term trend up' : ''}`,
      ],
      quality: 60 + Math.min(volMult * 6, 20) + (trendUp ? 10 : 0),
      ...levels(price, stop),
    });
  }

  // 2) 52-week high breakout
  if (price >= yearHigh * 0.995 && trendUp && volMult >= 1.1) {
    const stop = safeStop(price, [swingLow, price - 2 * a]);
    out.push({
      type: 'high52', label: '52-Week High Breakout', referenceRate: 55,
      reasons: [
        'Trading at / near a fresh 52-week high — no overhead supply',
        trendUp ? '50-DMA above 200-DMA (clean uptrend)' : 'Uptrend',
        volMult >= 1.4 ? `Strong volume (${volMult.toFixed(1)}×)` : 'Confirming volume',
      ],
      quality: 68 + Math.min(volMult * 5, 18),
      ...levels(price, stop, 2.5),
    });
  }

  // 3) Volume surge with price thrust (accumulation)
  const day = ret(1);
  if (volMult >= 2.2 && day != null && day >= 2.5 && price > (s20 || 0)) {
    const stop = safeStop(price, [lows[n - 1], price - 1.5 * a]);
    out.push({
      type: 'volume', label: 'Volume Surge', referenceRate: 47,
      reasons: [
        `Volume spiked ${volMult.toFixed(1)}× average`,
        `Price thrust +${day.toFixed(1)}% today`,
        'Above 20-DMA — buyers in control short-term',
      ],
      quality: 55 + Math.min(volMult * 4, 22),
      ...levels(price, stop),
    });
  }

  // 4) Golden cross (50 crosses above 200 recently)
  if (s50 != null && s200 != null && s50p != null && s200p != null &&
      s50 > s200 && s50p <= s200p && price > s200) {
    const stop = safeStop(price, [swingLow, price - 2.2 * a, s200 * 0.99]);
    out.push({
      type: 'goldencross', label: 'Golden Cross', referenceRate: 58,
      reasons: [
        '50-DMA just crossed above 200-DMA — classic trend-turn signal',
        `Price ₹${round2(price)} holding above the 200-DMA ₹${round2(s200)}`,
      ],
      quality: 66 + (price > s50 ? 8 : 0),
      ...levels(price, stop, 3),
    });
  }

  // 5) Moving-average reclaim / pullback bounce
  const s50pShort = sma(closes, 50, n - 3);
  if (s50 != null && s50pShort != null && closes[n - 3] < s50pShort && price > s50 &&
      price < prior20High && trendUp && r != null && r > 45 && r < 68) {
    const stop = safeStop(price, [swingLow, s50 * 0.985]);
    out.push({
      type: 'reclaim', label: 'Pullback / MA Reclaim', referenceRate: 50,
      reasons: [
        'Price pulled back to the 50-DMA and reclaimed it — trend continuation entry',
        'Long-term uptrend intact',
        `RSI ${r.toFixed(0)} — cooled off, not overbought`,
      ],
      quality: 58 + (trendUp ? 8 : 0),
      ...levels(price, stop),
    });
  }

  // 6) Momentum leader (strong, trending, not overbought)
  const r3 = ret(63), r6 = ret(126);
  if (r3 != null && r6 != null && r6 > 25 && r3 > 8 && trendUp && price > (s20 || 0) && r != null && r >= 55 && r <= 72) {
    const stop = safeStop(price, [swingLow, price - 2 * a]);
    out.push({
      type: 'momentum', label: 'Momentum Leader', referenceRate: 49,
      reasons: [
        `Up ${r6.toFixed(0)}% over 6 months, ${r3.toFixed(0)}% over 3 — sustained leadership`,
        'Above all key moving averages',
        `RSI ${r.toFixed(0)} — strong but with room`,
      ],
      quality: 56 + Math.min(r6 / 4, 20),
      ...levels(price, stop, 2.5),
    });
  }

  // attach common context
  for (const s of out) {
    s.symbol = sym; s.name = name; s.sector = sector; s.price = round2(price);
    s.rsi = r != null ? Math.round(r) : null;
    s.volMult = round2(volMult);
    s.pctFromHigh = round2(((price - yearHigh) / yearHigh) * 100);
    s.quality = Math.round(Math.min(s.quality, 99));
    s.trendUp = trendUp;
    s.riskPerShare = round2(s.entry - s.stop);
    s.riskPct = round2(Math.abs(s.stopPct));
    s.expirySessions = s.type === 'goldencross' || s.type === 'momentum' ? 10 : 5;
    s.dataAsOf = candles[n - 1]?.time ? candles[n - 1].time * 1000 : null;
    s.modelVersion = 'signals-v2';
  }
  return out.filter((s) => s.rr >= 1.4 && s.stop < s.entry && Math.abs(s.stopPct) <= MAX_STOP_PCT);
}

// ---------- scan ----------
async function build(extraSymbols = []) {
  const list = [...new Set([...UNIVERSE.map((u) => u.symbol), ...extraSymbols])];
  const meta = new Map(UNIVERSE.map((u) => [u.symbol, u]));
  state.total = list.length;
  state.progress = 0;
  const all = [];
  const CONC = 6;
  for (let i = 0; i < list.length; i += CONC) {
    await Promise.all(
      list.slice(i, i + CONC).map(async (sym) => {
        try {
          const h = await yahoo.history(sym, '1y', '1d');
          const m = meta.get(sym);
          const setups = detectSetups(sym, m?.name || sym, m?.sector || '', h.candles);
          all.push(...setups);
        } catch { /* skip */ }
        state.progress++;
      })
    );
  }

  // group by setup type, best-quality first
  const byType = {};
  for (const s of all) (byType[s.type] ||= []).push(s);
  for (const k of Object.keys(byType)) byType[k].sort((a, b) => b.quality - a.quality);

  const groups = [
    ['breakout', 'Range Breakouts', 'Price clearing recent resistance on volume'],
    ['high52', '52-Week High Breakouts', 'New highs — no overhead supply'],
    ['goldencross', 'Golden Crosses', '50-DMA crossing above 200-DMA'],
    ['momentum', 'Momentum Leaders', 'Sustained trending outperformers'],
    ['reclaim', 'Pullback Entries', 'Bounces off the 50-DMA in an uptrend'],
    ['volume', 'Volume Surges', 'Unusual volume with a price thrust'],
  ].map(([key, label, subtitle]) => ({ key, label, subtitle, setups: (byType[key] || []).slice(0, 12) }))
    .filter((g) => g.setups.length);

  const top = [...all].sort((a, b) => b.quality - a.quality).slice(0, 8);

  state = {
    status: 'ready', progress: state.total, total: state.total, builtAt: Date.now(), error: null,
    results: {
      groups, top, totalSetups: all.length, scanned: list.length,
      disclaimer:
        'Mechanical technical signals from price & volume — NOT investment advice or guaranteed trades. ' +
        'Entry/stop/target are suggested levels. Reference priors are unvalidated heuristics, not backtested performance. ' +
        'Setups fail regularly — always size positions to the stop-loss and do your own diligence.',
    },
  };
}

function ensure(extraSymbols = [], force = false) {
  const fresh = state.status === 'ready' && Date.now() - state.builtAt < FRESH_MS;
  if (state.status !== 'building' && (force || !fresh)) {
    state = { status: 'building', progress: 0, total: 0, results: state.results, builtAt: state.builtAt, error: null };
    build(extraSymbols).catch((e) => {
      console.error('[signals] build failed:', e.message);
      state = { ...state, status: state.results ? 'ready' : 'error', error: e.message };
    });
  }
  return state;
}
const peek = () => state;

module.exports = { ensure, peek, build, detectSetups, safeStop, MAX_STOP_PCT, MIN_STOP_PCT };
