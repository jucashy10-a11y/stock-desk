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
    conviction: r.scores.composite >= 75 ? 'HIGH' : 'MODERATE',
    composite: r.scores.composite,
    technical: r.scores.technical,
    fundamental: r.scores.fundamental,
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

async function build() {
  const symbols = UNIVERSE.map((u) => u.symbol);
  // Yahoo here on purpose: the screen needs 52-week range + P/E, which
  // Kite's quote feed doesn't carry. Live prices still come via research().
  const quotes = await yahoo.quotes(symbols);

  // ---- stage 1: cheap screen ----
  const cands = [];
  for (const u of UNIVERSE) {
    const q = quotes[u.symbol];
    if (!q?.price || !q.yearHigh || !q.yearLow || q.yearHigh <= q.yearLow) continue;
    const posIn52w = (q.price - q.yearLow) / (q.yearHigh - q.yearLow); // 0 = at low, 1 = at high
    cands.push({
      symbol: u.symbol,
      name: u.name,
      sector: u.sector,
      momScore: posIn52w + (q.changePct > 0 ? 0.05 : 0),
      valScore: (q.pe > 0 && q.pe < 25 ? 1 : 0) + (1 - posIn52w) * 0.6,
    });
  }
  const byMom = [...cands].sort((a, b) => b.momScore - a.momScore).slice(0, 28);
  const byVal = [...cands].sort((a, b) => b.valScore - a.valScore).slice(0, 22);
  const unique = new Map();
  for (const c of [...byMom, ...byVal]) unique.set(c.symbol, c);
  const list = [...unique.values()];
  state.total = list.length;
  state.progress = 0;

  // ---- stage 2: full research on survivors ----
  const evaluated = [];
  const CONC = 5;
  for (let i = 0; i < list.length; i += CONC) {
    await Promise.all(
      list.slice(i, i + CONC).map(async (c) => {
        try {
          const r = await research.research(c.symbol);
          evaluated.push({ c, r });
        } catch {
          /* skip symbols with data issues */
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
      confirms >= 3 &&
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
      growth >= 10 &&
      (f.roe ?? 0) >= 12 &&
      profitable &&
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

  // additional named scanners (reuse the already-computed research)
  const scan = (label, subtitle, horizon, filter, rank) =>
    evaluated
      .filter(({ r }) => filter(r))
      .map(({ c, r }) => ({ ...mkPick(c, r, horizon), _rank: rank ? rank(r) : mkPick(c, r, horizon).rankScore }))
      .sort((a, b) => b._rank - a._rank)
      .slice(0, 6);

  const scanners = [
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
  ].filter((s) => s.picks.length);

  state = {
    status: 'ready',
    progress: state.total,
    total: state.total,
    builtAt: Date.now(),
    error: null,
    results: {
      shortTerm,
      longTerm,
      scanners,
      scanned: list.length,
      universe: symbols.length,
      minPotentialPct: POTENTIAL_MIN,
      disclaimer:
        'Algorithmic screen based on momentum, volatility, fundamentals and analyst data. "+25% potential" is a modelled bull-case/valuation-gap scenario, NOT a promised return. Equities can and do fall. This is not investment advice — do your own diligence or consult a SEBI-registered advisor.',
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
