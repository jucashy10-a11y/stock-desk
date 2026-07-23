/**
 * Gold & Silver desk — live prices in INR, short/long-term projections and
 * an accumulation signal ("when to buy") derived from the technical engine.
 *
 * Prices come from COMEX futures (GC=F gold $/oz, SI=F silver $/oz) converted
 * at live USDINR. MCX trades a few percent above the pure conversion because
 * of import duty + local premium — we show an approx MCX figure with that
 * clearly labelled, never pretending to be an exact exchange tick.
 */

const yahoo = require('./yahoo');
const kite = require('./kite');
const research = require('./research');

const OZ_TO_G = 31.1034768;
const MCX_FACTOR = 1.06; // ~import duty + local premium; labelled "approx"

let cache = { at: 0, data: null };

function buySignal(t) {
  const aboveTrend = t.sma200 != null && t.price > t.sma200;
  const rsi = t.rsi14;
  if (aboveTrend && rsi != null && rsi < 35) {
    return {
      action: 'STRONG BUY ZONE',
      color: 'green',
      text: 'Rare dip inside a long-term uptrend (RSI oversold while above the 200-day average). Historically good accumulation territory.',
    };
  }
  if (aboveTrend && rsi != null && rsi <= 60) {
    return {
      action: 'ACCUMULATE',
      color: 'green',
      text: 'Uptrend intact and momentum not stretched — sensible zone for staggered/SIP-style buying.',
    };
  }
  if (aboveTrend && rsi != null && rsi > 70) {
    return {
      action: 'OVERHEATED — WAIT',
      color: 'amber',
      text: 'Trend is up but momentum is stretched (RSI overbought). Chasing here risks buying a short-term top — wait for a pullback.',
    };
  }
  if (aboveTrend) {
    return {
      action: 'HOLD / BUY DIPS',
      color: 'amber',
      text: 'Uptrend intact but momentum is warm. Buy weakness rather than strength.',
    };
  }
  return {
    action: 'WAIT — TREND WEAK',
    color: 'red',
    text: 'Price is below its 200-day average. If you must add, use small tranches; better entries usually come when the trend turns.',
  };
}

async function build() {
  const [quoteMap, goldR, silverR] = await Promise.all([
    yahoo.quotes(['GC=F', 'SI=F', 'USDINR=X']),
    research.research('GC=F'),
    research.research('SI=F'),
  ]);
  const usdinr = quoteMap['USDINR=X']?.price;
  if (!usdinr) throw new Error('USDINR rate unavailable');

  // REAL MCX prices (Gold Mini ₹/10g, Silver Mini ₹/kg) when Kite is connected;
  // COMEX×USDINR approximation only as fallback.
  let mcx = null;
  if (kite.status().connected) {
    try {
      mcx = await kite.mcxMiniQuotes();
    } catch (e) {
      console.warn('[mcx] live quotes unavailable, using COMEX conversion:', e.message);
    }
  }

  const mk = (r, q, unitGrams, unitLabel, mcxQ) => {
    const factor = (usdinr / OZ_TO_G) * unitGrams; // $/oz -> ₹ per unit
    const intl = r.quote.price * factor;
    // scale COMEX-based projections onto the actual MCX price level
    const headline = mcxQ?.price ?? intl * MCX_FACTOR;
    const scale = headline / intl;
    const inr = (usd) => (usd != null ? usd * factor * scale : null);
    const t = r.technicals;
    return {
      usdPrice: r.quote.price,
      usdChangePct: mcxQ?.changePct ?? q?.changePct ?? r.quote.changePct ?? null,
      unitLabel,
      live: !!mcxQ,
      contract: mcxQ?.contract ?? null,
      expiry: mcxQ?.expiry ?? null,
      mcxVolume: mcxQ?.volume ?? null,
      mcxOi: mcxQ?.oi ?? null,
      mcxDayHigh: mcxQ?.dayHigh ?? null,
      mcxDayLow: mcxQ?.dayLow ?? null,
      localBasisPct: intl ? ((headline - intl) / intl) * 100 : null,
      inrIntl: intl,
      inrMcxApprox: headline,
      dayHigh: inr(q?.dayHigh),
      dayLow: inr(q?.dayLow),
      yearHighInr: inr(t.yearHigh),
      yearLowInr: inr(t.yearLow),
      technicals: {
        rsi14: t.rsi14,
        aboveSma200: t.sma200 != null ? t.price > t.sma200 : null,
        sma200Inr: inr(t.sma200),
        pctFromHigh: t.pctFromHigh,
        ret1m: t.ret1m,
        ret6m: t.ret6m,
        ret1y: t.ret1y,
        vol1y: t.vol1y,
      },
      score: r.scores.technical,
      shortTerm: {
        horizon: r.shortTerm.horizon,
        expected: inr(r.shortTerm.expected),
        bull: inr(r.shortTerm.bull),
        bear: inr(r.shortTerm.bear),
        expectedPct: r.shortTerm.expectedPct,
        bullPct: r.shortTerm.bullPct,
        bearPct: r.shortTerm.bearPct,
      },
      longTerm: {
        horizon: r.longTerm.horizon,
        expected: inr(r.longTerm.expected),
        bull: inr(r.longTerm.bull),
        bear: inr(r.longTerm.bear),
        expectedPct: r.longTerm.expectedPct,
        bullPct: r.longTerm.bullPct,
        bearPct: r.longTerm.bearPct,
      },
      signal: buySignal(t),
      positives: r.positives,
      negatives: r.negatives,
    };
  };

  return {
    usdinr,
    generatedAt: Date.now(),
    mcxLive: !!mcx,
    gold: mk(goldR, quoteMap['GC=F'], 10, 'per 10g', mcx?.gold),
    silver: mk(silverR, quoteMap['SI=F'], 1000, 'per kg', mcx?.silver),
    mcxFactorPct: (MCX_FACTOR - 1) * 100,
    disclaimer: mcx
      ? 'Prices are live MCX Gold Mini / Silver Mini futures via Zerodha Kite. Projections and buy signals are technical estimates derived from long price history, not guaranteed outcomes or investment advice.'
      : 'Kite is not connected, so INR prices are approximated from COMEX futures at live USDINR (+~6% duty). Connect Kite in Settings for real MCX Gold Mini / Silver Mini prices. Projections are technical estimates, not investment advice.',
  };
}

async function get() {
  if (cache.data && Date.now() - cache.at < 60 * 1000) return cache.data;
  const data = await build();
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { get };
