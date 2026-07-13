/**
 * Stock idea scanner — surfaces short-term (3-mo) and long-term (12-mo)
 * candidates whose modelled potential clears +25%.
 *
 * Stage 1: cheap screen over the whole universe using live quotes
 *          (momentum bucket: strength vs 52-week range; value bucket: low P/E + beaten down).
 * Stage 2: full research engine on ~45 survivors, ranked and filtered.
 *
 * Results are cached ~30 min and rebuilt on demand. These are statistical
 * screens, NOT guaranteed returns — the API says so and the UI repeats it.
 */

const research = require('./research');
const yahoo = require('./yahoo');
const kite = require('./kite');
const { UNIVERSE } = require('./symbols');

let state = { status: 'idle', progress: 0, total: 0, results: null, builtAt: 0, error: null };

const FRESH_MS = 30 * 60 * 1000;
const POTENTIAL_MIN = 25; // % — the user's bar

function mkPick(c, r, horizon) {
  const price = r.quote.price;
  const proj = horizon === 'short' ? r.shortTerm : r.longTerm;
  const valUpside = r.valuation?.fairValue != null ? r.valuation.upsidePct : null;
  // cap the valuation-gap contribution: beyond ~60% it's a model artifact, not a forecast
  const potential =
    horizon === 'short' ? proj.bullPct : Math.max(proj.bullPct, Math.min(valUpside ?? -Infinity, 60));
  return {
    symbol: c.symbol,
    name: c.name,
    sector: c.sector,
    price,
    dayChangePct: r.quote.changePct ?? null,
    verdict: r.verdict,
    verdictColor: r.verdictColor,
    conviction: r.scores.composite >= 75 && r.scores.confidence >= 75 && r.scores.risk < 45 ? 'HIGH' : 'MODERATE',
    composite: r.scores.composite,
    technical: r.scores.technical,
    fundamental: r.scores.fundamental,
    confidence: r.scores.confidence,
    risk: r.scores.risk,
    riskLabel: r.scores.riskLabel,
    expected: proj.expected,
    expectedPct: proj.expectedPct,
    bull: proj.bull,
    bullPct: proj.bullPct,
    bear: proj.bear,
    bearPct: proj.bearPct,
    potentialPct: potential,
    analystTarget: horizon === 'long' ? (r.longTerm.analystTarget ?? null) : null,
    fairValue: r.valuation?.fairValue ?? null,
    fairUpsidePct: valUpside,
    reasons: r.positives.slice(0, 3),
    topRisk: r.negatives[0] || null,
    rankScore:
      horizon === 'short'
        ? r.scores.technical * 0.6 + r.scores.composite * 0.4 + (proj.expectedPct || 0) * 2
        : (r.scores.fundamental ?? 50) * 0.7 + r.scores.composite * 0.3 + Math.min(valUpside ?? 0, 60) * 0.5,
  };
}

function mkTwoXPick(c, r) {
  const x = r.twoX;
  return {
    symbol: c.symbol,
    name: c.name,
    sector: c.sector,
    price: r.quote.price,
    dayChangePct: r.quote.changePct ?? null,
    verdict: '2X POTENTIAL / 4Y',
    verdictColor: 'amber',
    conviction: x.score >= 85 && r.scores.confidence >= 80 && r.scores.risk < 45 ? 'HIGH' : 'MODERATE',
    composite: x.score,
    technical: r.scores.technical,
    fundamental: r.scores.fundamental,
    confidence: r.scores.confidence,
    risk: r.scores.risk,
    riskLabel: r.scores.riskLabel,
    expected: x.baseTarget,
    expectedPct: x.baseUpsidePct,
    bull: x.bullTarget,
    bullPct: x.bullUpsidePct,
    bear: x.bearTarget,
    bearPct: x.bearUpsidePct,
    potentialPct: x.baseUpsidePct,
    requiredCagr: x.requiredCagr,
    growthAssumption: x.growthAssumption,
    exitPE: x.exitPE,
    twoX: true,
    reasons: x.checks.slice(0, 4),
    topRisk: r.whatCanGoWrong?.[0] || r.negatives[0] || null,
    rankScore: x.score + Math.min(x.baseUpsidePct || 0, 150) * 0.15 - r.scores.risk * 0.1,
  };
}

async function build() {
  const symbols = UNIVERSE.map((u) => u.symbol);
  // Yahoo here on purpose: the screen needs 52-week range + P/E, which
  // Kite's quote feed doesn't carry. Live prices still come via research().
  const [quotes, kiteQuotes] = await Promise.all([
    yahoo.quotes(symbols),
    kite.status().connected ? kite.quotes(symbols).catch(() => ({})) : Promise.resolve({}),
  ]);

  // ---- stage 1: cheap screen ----
  const cands = [];
  for (const u of UNIVERSE) {
    const q = quotes[u.symbol];
    const live = kiteQuotes[u.symbol];
    if (!q?.price || !q.yearHigh || !q.yearLow || q.yearHigh <= q.yearLow) continue;
    const price = live?.price || q.price;
    const posIn52w = (price - q.yearLow) / (q.yearHigh - q.yearLow); // 0 = at low, 1 = at high
    cands.push({
      symbol: u.symbol,
      name: u.name,
      sector: u.sector,
      liveQuote: live || null,
      marketCap: q.marketCap ?? null,
      momScore: posIn52w + (q.changePct > 0 ? 0.05 : 0),
      valScore: (q.pe > 0 && q.pe < 25 ? 1 : 0) + (1 - posIn52w) * 0.6,
    });
  }
  const byMom = [...cands].sort((a, b) => b.momScore - a.momScore).slice(0, 28);
  const byVal = [...cands].sort((a, b) => b.valScore - a.valScore).slice(0, 22);
  // Include smaller liquid names from the curated universe; 2x candidates
  // are often missed by large-cap momentum/value-only preselection.
  const byEmerging = [...cands]
    .filter((c) => c.marketCap != null && c.marketCap >= 500e7)
    .sort((a, b) => a.marketCap - b.marketCap)
    .slice(0, 32);
  const unique = new Map();
  for (const c of [...byMom, ...byVal, ...byEmerging]) unique.set(c.symbol, c);
  const list = [...unique.values()];
  state.total = list.length;
  state.progress = 0;

  // ---- stage 2: full research on survivors ----
  const evaluated = [];
  let failed = 0;
  const CONC = 5;
  for (let i = 0; i < list.length; i += CONC) {
    await Promise.all(
      list.slice(i, i + CONC).map(async (c) => {
        try {
          const r = await research.research(c.symbol, { sector: c.sector, liveQuote: c.liveQuote });
          evaluated.push({ c, r });
        } catch {
          /* skip symbols with data issues */
          failed++;
        }
        state.progress++;
      })
    );
  }

  // Short-term: demand MULTIPLE confirming technical signals, not just a score.
  const shortOk = (r) => {
    const t = r.technicals;
    let confirms = 0;
    if (t.sma20 != null && t.price > t.sma20) confirms++; // above 20-DMA
    if (t.sma50 != null && t.sma200 != null && t.sma50 > t.sma200) confirms++; // uptrend structure
    if (t.macd && t.macd.histogram > 0) confirms++; // MACD bullish
    if (t.rsi14 != null && t.rsi14 >= 50 && t.rsi14 <= 72) confirms++; // momentum, not overbought
    return (
      r.scores.technical >= 65 &&
      r.scores.composite >= 60 &&
      r.scores.confidence >= 60 &&
      r.scores.risk <= 65 &&
      confirms >= 3 &&
      r.shortTerm.expectedPct >= 3 &&
      r.shortTerm.bullPct >= POTENTIAL_MIN &&
      r.negatives.length <= 2
    );
  };

  // Long-term: profitable, growing, decent ROE — quality first, upside second.
  const longOk = (r) => {
    const f = r.fundamentals || {};
    const s = r.statements || {};
    const growth = Math.max(s.profitCagr3y ?? -99, f.earningsGrowth ?? -99, s.revenueCagr3y ?? -99);
    const upside = Math.max(
      r.longTerm.bullPct ?? -99,
      Math.min(r.valuation?.fairValue != null ? r.valuation.upsidePct : -99, 60)
    );
    const profitable = (f.profitMargin ?? 1) > 0 && (r.valuation?.epsTtm ?? 1) > 0;
    return (
      (r.scores.fundamental ?? 0) >= 70 &&
      r.scores.composite >= 55 &&
      r.scores.confidence >= 65 &&
      r.scores.risk <= 60 &&
      growth >= 10 &&
      (f.roe ?? 0) >= 12 &&
      profitable &&
      r.longTerm.expectedPct >= 8 &&
      upside >= POTENTIAL_MIN
    );
  };

  const shortTerm = evaluated
    .filter(({ r }) => shortOk(r))
    .map(({ c, r }) => mkPick(c, r, 'short'))
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 5);

  const longTerm = evaluated
    .filter(({ r }) => longOk(r))
    .map(({ c, r }) => mkPick(c, r, 'long'))
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 5);

  const twoX = evaluated
    .filter(({ r }) => r.twoX?.clearsTwoX && r.scores.confidence >= 75 && r.scores.risk <= 60)
    .map(({ c, r }) => mkTwoXPick(c, r))
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 8);

  // additional named scanners (reuse the already-computed research)
  const scan = (label, subtitle, horizon, filter, rank) =>
    evaluated
      .filter(({ r }) => r.scores.confidence >= 55 && r.scores.risk <= 70 && filter(r))
      .map(({ c, r }) => ({ ...mkPick(c, r, horizon), _rank: rank ? rank(r) : mkPick(c, r, horizon).rankScore }))
      .sort((a, b) => b._rank - a._rank)
      .slice(0, 6);

  const scanners = [
    {
      key: 'two-x', label: '2X Research Watchlist', subtitle: 'strict base-case candidates over 4 years; never guaranteed', horizon: 'twoX',
      picks: twoX,
    },
    {
      key: 'breakout', label: 'Breakout Stocks', subtitle: 'near 52-week highs with momentum', horizon: 'short',
      picks: scan('breakout', '', 'short',
        (r) => r.technicals.pctFromHigh != null && r.technicals.pctFromHigh > -4 && r.scores.technical >= 60,
        (r) => -(r.technicals.pctFromHigh ?? -99)),
    },
    {
      key: 'oversold', label: 'Oversold Bounce', subtitle: 'RSI low but long-term trend still up', horizon: 'short',
      picks: scan('oversold', '', 'short',
        (r) => r.technicals.rsi14 != null && r.technicals.rsi14 < 38 && r.technicals.sma200 != null && r.technicals.price > r.technicals.sma200,
        (r) => -(r.technicals.rsi14 ?? 100)),
    },
    {
      key: 'value', label: 'Value Picks', subtitle: 'cheap vs earnings & fair value', horizon: 'long',
      picks: scan('value', '', 'long',
        (r) => (r.scores.valuation ?? 0) >= 65 && (r.fundamentals?.pe ?? 99) < 22 && (r.fundamentals?.profitMargin ?? -1) > 0,
        (r) => r.scores.valuation ?? 0),
    },
    {
      key: 'momentum', label: 'Momentum Picks', subtitle: 'strongest 6-month performers still trending', horizon: 'short',
      picks: scan('momentum', '', 'short',
        (r) => (r.technicals.ret6m ?? -99) > 20 && r.scores.technical >= 60,
        (r) => r.technicals.ret6m ?? 0),
    },
    {
      key: 'quality', label: 'Long-Term Compounders', subtitle: 'high ROE, growing, profitable', horizon: 'long',
      picks: longTerm,
    },
    {
      key: 'dividend', label: 'High Dividend', subtitle: 'yield with a healthy business', horizon: 'long',
      picks: scan('dividend', '', 'long',
        (r) => (r.fundamentals?.divYield ?? 0) >= 2.5 && (r.scores.fundamental ?? 0) >= 55,
        (r) => r.fundamentals?.divYield ?? 0),
    },
  ].filter((s) => s.key === 'two-x' || s.picks.length);

  state = {
    status: 'ready',
    progress: state.total,
    total: state.total,
    builtAt: Date.now(),
    error: null,
    results: {
      shortTerm,
      longTerm,
      twoX,
      scanners,
      scanned: list.length,
      researched: evaluated.length,
      failed,
      universe: symbols.length,
      minPotentialPct: POTENTIAL_MIN,
      liveSource: Object.keys(kiteQuotes).length ? 'kite' : 'yahoo',
      disclaimer:
        'Algorithmic research, not a tip or guaranteed return. A 2X candidate must clear the four-year base case using growth, cash flow, leverage, ownership, liquidity and conservative valuation gates; the assumptions can still fail. Do your own diligence or consult a SEBI-registered adviser.',
    },
  };
}

/** Return current state; kick off a (re)build when stale or forced. */
function ensure(force = false) {
  const fresh = state.status === 'ready' && Date.now() - state.builtAt < FRESH_MS;
  if (state.status !== 'building' && (force || !fresh)) {
    state = { status: 'building', progress: 0, total: 0, results: state.results, builtAt: state.builtAt, error: null };
    build().catch((e) => {
      console.error('[ideas] build failed:', e.message);
      state = { ...state, status: state.results ? 'ready' : 'error', error: e.message };
    });
  }
  return state;
}

/** Current state without triggering a build (cheap, for dashboard). */
function peek() {
  return state;
}

module.exports = { ensure, peek };
