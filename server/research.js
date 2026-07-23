/**
 * One-button company research engine.
 * Combines fundamentals (valuation, profitability, growth, leverage) with
 * technicals computed from 2y of daily candles (trend, momentum, volatility),
 * produces a 0-100 composite score, a verdict, and volatility-based
 * short-term (3 month) and long-term (12 month) projection ranges.
 *
 * Outputs are deterministic scenarios, not calibrated forecasts or financial advice.
 */

const yahoo = require('./yahoo');
const screener = require('./screener');
const kite = require('./kite');

// ---------- indicator math ----------

function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period,
    avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function macd(closes) {
  if (closes.length < 35) return null;
  const emaSeries = (period) => {
    const k = 2 / (period + 1);
    const out = [];
    let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out.length = period - 1;
    out.push(e);
    for (let i = period; i < closes.length; i++) {
      e = closes[i] * k + e * (1 - k);
      out.push(e);
    }
    return out;
  };
  const e12 = emaSeries(12);
  const e26 = emaSeries(26);
  const macdLine = [];
  for (let i = 25; i < closes.length; i++) macdLine.push(e12[i] - e26[i]);
  if (macdLine.length < 9) return null;
  const k = 2 / 10;
  let sig = macdLine.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdLine.length; i++) sig = macdLine[i] * k + sig * (1 - k);
  const m = macdLine[macdLine.length - 1];
  return { macd: m, signal: sig, histogram: m - sig };
}

function annualizedVol(closes, days = 63) {
  const s = closes.slice(-days - 1);
  if (s.length < 20) return null;
  const rets = [];
  for (let i = 1; i < s.length; i++) rets.push(Math.log(s[i] / s[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100; // % annualized
}

function periodReturn(closes, days) {
  if (closes.length < days + 1) return null;
  const then = closes[closes.length - 1 - days];
  const now = closes[closes.length - 1];
  return ((now - then) / then) * 100;
}

// ---------- scoring helpers ----------

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function scoreBand(value, bands) {
  // bands: array of [threshold, score] evaluated in order; value <= threshold -> score
  for (const [t, s] of bands) if (value <= t) return s;
  return bands[bands.length - 1][1];
}

// ---------- main ----------

function cagr(first, last, years) {
  if (first == null || last == null || first <= 0 || last <= 0 || years <= 0) return null;
  return (Math.pow(last / first, 1 / years) - 1) * 100;
}

function buildSectorValuation({ price, fund, statements, sector = '', industry = '', name = '' }) {
  const context = `${sector} ${industry} ${name}`.toLowerCase();
  const epsTtm = fund?.eps ?? (statements?.annual?.length
    ? statements.annual[statements.annual.length - 1].eps
    : null);
  const currentPE = fund?.pe ?? (epsTtm > 0 ? price / epsTtm : null);
  const unavailable = (method, warning) => ({
    method,
    fairValue: null,
    fairLow: null,
    fairHigh: null,
    upsidePct: null,
    epsTtm,
    currentPE,
    applicability: 'not-applicable',
    warning,
    assumptions: [],
  });

  if (/insurance/.test(context)) {
    return unavailable(
      'Insurer appraisal-value model required',
      'P/E and P/B alone do not capture embedded value, solvency, product mix or new-business margins.'
    );
  }

  if (/bank|banking|nbfc|financial services|finance|lending|housing finance/.test(context)) {
    const bookValue = fund?.bookValue ?? null;
    const roe = fund?.roe ?? null;
    if (!(bookValue > 0) || roe == null) {
      return unavailable(
        'ROE-adjusted P/B reference',
        'Book value and ROE are required; lender asset quality and credit-cost data are not available.'
      );
    }
    // Conservative lender reference range. This is not a full residual-income
    // model: GNPA/NNPA, provision coverage, NIM and capital adequacy remain
    // explicit missing inputs.
    const targetPB = clamp(0.65 + Math.max(roe - 8, 0) * 0.075, 0.65, 2.5);
    const fairValue = bookValue * targetPB;
    return {
      method: 'ROE-adjusted price-to-book reference',
      metricLabel: 'Book value/share',
      metricValue: bookValue,
      multipleLabel: 'Reference P/B',
      multipleValue: targetPB,
      fairValue,
      fairLow: fairValue * 0.75,
      fairHigh: fairValue * 1.25,
      upsidePct: ((fairValue - price) / price) * 100,
      epsTtm,
      currentPE,
      applicability: 'limited',
      warning: 'Lender reference only; GNPA/NNPA, NIM, credit cost and capital adequacy are not modeled.',
      assumptions: [`ROE ${roe.toFixed(1)}%`, `book value/share ₹${bookValue.toFixed(2)}`],
    };
  }

  if (/conglomerate|diversified/.test(context)) {
    return unavailable(
      'Sum-of-the-parts model required',
      'A single earnings multiple is not reliable for a conglomerate with businesses that deserve different multiples.'
    );
  }

  if (/oil|gas|refin|metal|mining|steel|aluminium|cement|commodity|paper|sugar|fertili/.test(context)) {
    return unavailable(
      'Mid-cycle earnings / EV-EBITDA model required',
      'Current trailing earnings can sit at a commodity-cycle peak or trough, so a spot P/E target would be misleading.'
    );
  }

  if (/utility|utilities|power generation|electricity|infrastructure investment trust|reit/.test(context)) {
    return unavailable(
      'Regulated cash-flow / asset-value model required',
      'Debt maturity, regulated returns, project cash flows and asset values are required for a defensible reference value.'
    );
  }

  if (!(epsTtm > 0)) {
    return unavailable(
      'Earnings reference not meaningful',
      'The company has no positive trailing EPS; use revenue, unit economics, cash runway and a path-to-profitability model.'
    );
  }

  const growthCandidates = [statements?.profitCagr3y, fund?.earningsGrowth]
    .filter((v) => v != null && Number.isFinite(v));
  const growth = growthCandidates.length
    ? clamp(growthCandidates.reduce((a, b) => a + b, 0) / growthCandidates.length, -10, 30)
    : 6;
  // A deliberately narrower multiple than the old universal formula. Growth
  // above 30% is not extrapolated and the range remains visibly uncertain.
  const justifiedPE = clamp(12 + 0.65 * Math.max(growth, 0), 10, 32);
  const fairValue = epsTtm * justifiedPE;
  return {
    method: 'Growth-adjusted earnings reference',
    metricLabel: 'EPS (TTM)',
    metricValue: epsTtm,
    multipleLabel: 'Reference P/E',
    multipleValue: justifiedPE,
    epsTtm,
    growthUsed: growth,
    justifiedPE,
    fairValue,
    fairLow: fairValue * 0.75,
    fairHigh: fairValue * 1.25,
    upsidePct: ((fairValue - price) / price) * 100,
    currentPE,
    applicability: 'standard',
    warning: 'Reference range, not a target price. It excludes company-specific DCF and event risk.',
    assumptions: [`earnings growth input ${growth.toFixed(1)}%`, `reference P/E ${justifiedPE.toFixed(1)}x`],
  };
}

function buildTwoXCase(price, fund, statements, valuation, sector = '', market = {}) {
  const years = 4;
  const marketDoubleCagr = (Math.pow(2, 1 / years) - 1) * 100;
  const rev = statements?.revenueCagr3y;
  const profit = statements?.profitCagr3y;
  const earnings = fund?.earningsGrowth;
  const growthInputs = [
    rev != null && isFinite(rev) ? { value: clamp(rev, -10, 35), weight: 0.25 } : null,
    profit != null && isFinite(profit) ? { value: clamp(profit, -10, 35), weight: 0.65 } : null,
    earnings != null && isFinite(earnings) ? { value: clamp(earnings, -10, 35), weight: 0.1 } : null,
  ].filter(Boolean);
  const growthAssumption = growthInputs.length
    ? clamp(growthInputs.reduce((s, x) => s + x.value * x.weight, 0) / growthInputs.reduce((s, x) => s + x.weight, 0), 0, 30)
    : null;
  const currentPE = fund?.pe > 0 ? fund.pe : valuation?.currentPE > 0 ? valuation.currentPE : null;
  const justifiedPE = valuation?.justifiedPE > 0 ? valuation.justifiedPE : 20;
  // Conservative base case never assumes P/E expansion. A low-P/E cyclical
  // must double through earnings, not through a manufactured re-rating.
  const exitPE = currentPE ? Math.max(3, Math.min(currentPE, justifiedPE, 35)) : clamp(justifiedPE, 8, 30);
  const multipleChange = currentPE ? exitPE / currentPE : 0.85;
  const requiredCagr = (Math.pow(2 / multipleChange, 1 / years) - 1) * 100;
  const baseTarget = growthAssumption == null ? null : price * Math.pow(1 + growthAssumption / 100, years) * multipleChange;
  const bullGrowth = growthAssumption == null ? null : clamp(growthAssumption + 5, 0, 35);
  const bearGrowth = growthAssumption == null ? null : clamp(growthAssumption - 8, -5, 22);
  const bullTarget = bullGrowth == null ? null : price * Math.pow(1 + bullGrowth / 100, years) * (currentPE ? Math.min(1, 35 / currentPE) : 0.95);
  const bearTarget = bearGrowth == null ? null : price * Math.pow(1 + bearGrowth / 100, years) * multipleChange * 0.75;
  const isFinancial = /bank|nbfc|financial|insurance/i.test(sector);
  const specializedValuationRequired = valuation?.applicability != null && valuation.applicability !== 'standard';
  const cashSamples = (statements?.annual || []).slice(-3)
    .filter((x) => x.netIncome > 0 && x.ocf != null)
    .map((x) => x.ocf / x.netIncome)
    .filter((x) => isFinite(x));
  const cashConversion = cashSamples.length ? cashSamples.reduce((a, b) => a + b, 0) / cashSamples.length : null;
  const marketCapCr = fund?.marketCap != null ? fund.marketCap / 1e7 : null;
  const promoterTrend = statements?.shareholding?.promoterTrend;
  const historyComplete = (statements?.annual?.length || 0) >= 4 && (statements?.quarterly?.length || 0) >= 4;
  const liquidEnough = market.historyDays >= 252 && market.avgTradedValue >= 2e7;
  const supportedSector = !isFinancial && !specializedValuationRequired;
  const requiredFields = isFinancial
    ? [rev, profit, fund?.roe, fund?.profitMargin, promoterTrend, marketCapCr]
    : [rev, profit, fund?.roe, fund?.profitMargin, fund?.debtToEquity, cashConversion, promoterTrend, marketCapCr];
  const dataComplete = supportedSector && historyComplete && liquidEnough
    && requiredFields.every((x) => x != null && isFinite(x));
  const checks = [];
  let score = 0;
  const check = (pass, points, label) => { if (pass) { score += points; checks.push(label); } };
  check(rev >= 15, 18, `Revenue CAGR ${rev?.toFixed(1)}%`);
  check(profit >= 18, 18, `Profit CAGR ${profit?.toFixed(1)}%`);
  check((fund?.roe ?? 0) >= 15, 14, `ROE ${fund?.roe?.toFixed(1)}%`);
  check((fund?.roce ?? 0) >= 15, 8, `ROCE ${fund?.roce?.toFixed(1)}%`);
  check((fund?.profitMargin ?? -1) > 0, 8, 'Profitable business');
  check(isFinancial || (fund?.debtToEquity != null && fund.debtToEquity <= 80), 10, isFinancial ? 'Financial-sector leverage assessed separately' : 'Manageable debt');
  check(isFinancial || (cashConversion != null && cashConversion >= 0.8), 10, isFinancial ? 'Cash-flow test not applicable to lenders' : '3-year cash conversion supports profit');
  check(promoterTrend != null && promoterTrend >= -1, 5, 'Promoter holding stable');
  check(marketCapCr != null && marketCapCr >= 500 && marketCapCr <= 150000, 5, 'Scalable market-cap range');
  check(growthAssumption != null && growthAssumption >= requiredCagr, 4, 'Modeled growth clears 2x hurdle');
  if (currentPE && growthAssumption > 0 && currentPE / growthAssumption > 2.5) score -= 12;
  if ((fund?.debtToEquity ?? 0) > 150) score -= 15;
  if ((fund?.profitMargin ?? 1) < 0) score -= 20;
  score = clamp(Math.round(score), 0, 100);
  const baseUpsidePct = baseTarget == null ? null : ((baseTarget - price) / price) * 100;
  return {
    modelVersion: '2x-v2-sector-gated',
    asOf: Date.now(),
    horizon: `${years} years`,
    doublePrice: price * 2,
    marketDoubleCagr,
    requiredCagr,
    growthAssumption,
    currentPE,
    exitPE,
    earningsMultiplier: growthAssumption == null ? null : Math.pow(1 + growthAssumption / 100, years),
    multipleMultiplier: multipleChange,
    cashConversion,
    score,
    baseTarget,
    baseUpsidePct,
    bullTarget,
    bullUpsidePct: bullTarget == null ? null : ((bullTarget - price) / price) * 100,
    bearTarget,
    bearUpsidePct: bearTarget == null ? null : ((bearTarget - price) / price) * 100,
    dataComplete,
    historyComplete,
    liquidEnough,
    supportedSector,
    unsupportedReason: isFinancial
      ? 'Banks/NBFCs/insurers require a lender-specific asset-quality model'
      : specializedValuationRequired
        ? (valuation.warning || `${valuation.method || 'A specialist valuation model'} is required`)
        : null,
    clearsTwoX: dataComplete && growthAssumption >= requiredCagr
      && baseUpsidePct != null && baseUpsidePct >= 100 && score >= 70,
    checks,
  };
}

async function research(symbol, options = {}) {
  symbol = String(symbol || '').trim().toUpperCase();
  if (/^[A-Z0-9&-]+$/.test(symbol)) symbol += '.NS';
  let [hist, quoteMap, fund, fin] = await Promise.all([
    yahoo.history(symbol, '2y', '1d'),
    yahoo.quotes([symbol]),
    yahoo.fundamentals(symbol).catch(() => null),
    screener.financials(symbol).catch(() => null),
  ]);
  // Screener headline ratios fill Yahoo's gaps (common for Indian small/midcaps)
  if (fin?.ratios) {
    fund = fund || { symbol };
    if (fund.pe == null && fin.ratios.pe != null) fund.pe = fin.ratios.pe;
    if (fund.roe == null && fin.ratios.roe != null) fund.roe = fin.ratios.roe;
    if (fund.roce == null && fin.ratios.roce != null) fund.roce = fin.ratios.roce;
    if (fund.divYield == null && fin.ratios.divYield != null) fund.divYield = fin.ratios.divYield;
    if (fund.marketCap == null && fin.ratios.marketCap != null) fund.marketCap = fin.ratios.marketCap;
    if (fund.bookValue == null && fin.ratios.bookValue != null) fund.bookValue = fin.ratios.bookValue;
    if (fund.pb == null && fin.ratios.bookValue > 0 && fin.ratios.price > 0) {
      fund.pb = fin.ratios.price / fin.ratios.bookValue;
    }
  }
  const yahooQuote = quoteMap[symbol] || (await yahoo.quoteFromChart(symbol));
  let liveQuote = options.liveQuote || null;
  if (!liveQuote && kite.status().connected) {
    try { liveQuote = (await kite.quotes([symbol]))[symbol] || null; } catch { /* Yahoo remains available */ }
  }
  const quote = liveQuote
    ? { ...yahooQuote, ...liveQuote, name: yahooQuote.name || liveQuote.name, yearHigh: yahooQuote.yearHigh, yearLow: yahooQuote.yearLow }
    : yahooQuote;
  const candles = hist.candles;
  if (!candles || candles.length < 30) throw new Error('Not enough price history for ' + symbol);
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const price = quote.price ?? closes[closes.length - 1];

  // ----- technicals -----
  const t = {
    price,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    ema20: ema(closes, 20),
    rsi14: rsi(closes),
    macd: macd(closes),
    vol3m: annualizedVol(closes, 63),
    vol1y: annualizedVol(closes, 252),
    ret1m: periodReturn(closes, 21),
    ret3m: periodReturn(closes, 63),
    ret6m: periodReturn(closes, 126),
    ret1y: periodReturn(closes, 252),
    yearHigh: quote.yearHigh ?? Math.max(...closes.slice(-252)),
    yearLow: quote.yearLow ?? Math.min(...closes.slice(-252)),
    avgVol20: sma(vols, 20),
    avgVol60: sma(vols, 60),
  };
  t.pctFromHigh = t.yearHigh ? ((price - t.yearHigh) / t.yearHigh) * 100 : null;
  t.pctFromLow = t.yearLow ? ((price - t.yearLow) / t.yearLow) * 100 : null;
  t.volumeTrend = t.avgVol20 && t.avgVol60 ? (t.avgVol20 / t.avgVol60 - 1) * 100 : null;

  // ----- technical score (0-100) -----
  const tPoints = [];
  let tScore = 50;
  if (t.sma50 != null && t.sma200 != null) {
    if (t.sma50 > t.sma200) {
      tScore += 8;
      tPoints.push({ good: true, text: 'Golden structure: 50-DMA is above 200-DMA (long-term uptrend intact)' });
    } else {
      tScore -= 8;
      tPoints.push({ good: false, text: '50-DMA is below 200-DMA — long-term trend is weak' });
    }
  }
  if (t.sma20 != null) {
    if (price > t.sma20) { tScore += 5; tPoints.push({ good: true, text: 'Price trading above 20-DMA (short-term momentum positive)' }); }
    else { tScore -= 5; tPoints.push({ good: false, text: 'Price below 20-DMA (short-term momentum negative)' }); }
  }
  if (t.sma200 != null) {
    if (price > t.sma200) tScore += 7;
    else { tScore -= 7; tPoints.push({ good: false, text: 'Price is below its 200-DMA' }); }
  }
  if (t.rsi14 != null) {
    if (t.rsi14 >= 70) { tScore -= 4; tPoints.push({ good: false, text: `RSI ${t.rsi14.toFixed(0)} — overbought zone, pullback risk` }); }
    else if (t.rsi14 >= 55) { tScore += 6; tPoints.push({ good: true, text: `RSI ${t.rsi14.toFixed(0)} — healthy bullish momentum` }); }
    else if (t.rsi14 >= 45) { tScore += 1; }
    else if (t.rsi14 >= 30) { tScore -= 5; tPoints.push({ good: false, text: `RSI ${t.rsi14.toFixed(0)} — bearish momentum` }); }
    else { tScore += 2; tPoints.push({ good: true, text: `RSI ${t.rsi14.toFixed(0)} — oversold, bounce candidate (contrarian)` }); }
  }
  if (t.macd) {
    if (t.macd.histogram > 0) { tScore += 5; tPoints.push({ good: true, text: 'MACD above signal line (bullish crossover in effect)' }); }
    else { tScore -= 5; tPoints.push({ good: false, text: 'MACD below signal line (bearish)' }); }
  }
  if (t.ret6m != null) {
    if (t.ret6m > 15) { tScore += 6; tPoints.push({ good: true, text: `Strong 6-month return of ${t.ret6m.toFixed(1)}%` }); }
    else if (t.ret6m < -15) { tScore -= 6; tPoints.push({ good: false, text: `Weak 6-month return of ${t.ret6m.toFixed(1)}%` }); }
  }
  if (t.pctFromHigh != null && t.pctFromHigh > -5) {
    tScore += 4;
    tPoints.push({ good: true, text: 'Trading within 5% of its 52-week high — strength' });
  } else if (t.pctFromHigh != null && t.pctFromHigh < -35) {
    tScore -= 4;
    tPoints.push({ good: false, text: `Down ${Math.abs(t.pctFromHigh).toFixed(0)}% from 52-week high` });
  }
  if (t.volumeTrend != null && t.volumeTrend > 25 && (t.ret1m ?? 0) > 0) {
    tScore += 3;
    tPoints.push({ good: true, text: 'Rising volumes supporting the up-move' });
  }
  tScore = clamp(Math.round(tScore), 0, 100);

  // ----- fundamental score (0-100) -----
  const fPoints = [];
  let fScore = 50;
  let fSignals = 0;
  const companyContext = `${options.sector || ''} ${fund?.sector || ''} ${fund?.industry || ''} ${quote.name || ''}`.toLowerCase();
  const isLender = /bank|banking|nbfc|financial services|finance|lending|housing finance/.test(companyContext);
  const isInsurer = /insurance/.test(companyContext);
  const isCycleSensitive = /oil|gas|refin|metal|mining|steel|aluminium|cement|commodity|paper|sugar|fertili/.test(companyContext);
  const isConglomerate = /conglomerate|diversified/.test(companyContext);
  const trailingPEComparable = !isLender && !isInsurer && !isCycleSensitive && !isConglomerate;
  if (fund) {
    if (fund.roe != null) {
      fSignals++;
      const s = scoreBand(fund.roe, [[0, -8], [8, -3], [15, 3], [25, 8], [Infinity, 10]]);
      fScore += s;
      if (fund.roe >= 15) fPoints.push({ good: true, text: `Healthy return on equity of ${fund.roe.toFixed(1)}%` });
      else if (fund.roe < 8) fPoints.push({ good: false, text: `Low return on equity (${fund.roe.toFixed(1)}%)` });
    }
    if (fund.profitMargin != null && !isLender && !isInsurer) {
      fSignals++;
      const s = scoreBand(fund.profitMargin, [[0, -8], [5, -2], [12, 3], [20, 6], [Infinity, 8]]);
      fScore += s;
      if (fund.profitMargin < 0) fPoints.push({ good: false, text: 'Company is loss-making at the net level' });
      else if (fund.profitMargin >= 12) fPoints.push({ good: true, text: `Strong net profit margin of ${fund.profitMargin.toFixed(1)}%` });
    }
    if (fund.revenueGrowth != null) {
      fSignals++;
      const s = scoreBand(fund.revenueGrowth, [[-5, -6], [5, 0], [12, 4], [20, 7], [Infinity, 9]]);
      fScore += s;
      if (fund.revenueGrowth >= 12) fPoints.push({ good: true, text: `Revenue growing at ${fund.revenueGrowth.toFixed(1)}% YoY` });
      else if (fund.revenueGrowth < -5) fPoints.push({ good: false, text: `Revenue declining (${fund.revenueGrowth.toFixed(1)}% YoY)` });
    }
    if (fund.earningsGrowth != null) {
      fSignals++;
      fScore += scoreBand(fund.earningsGrowth, [[-10, -6], [0, -2], [15, 4], [30, 7], [Infinity, 8]]);
      if (fund.earningsGrowth >= 15) fPoints.push({ good: true, text: `Earnings growing at ${fund.earningsGrowth.toFixed(1)}% YoY` });
      else if (fund.earningsGrowth < -10) fPoints.push({ good: false, text: `Earnings shrinking (${fund.earningsGrowth.toFixed(1)}% YoY)` });
    }
    if (fund.debtToEquity != null && !isLender && !isInsurer) {
      fSignals++;
      const de = fund.debtToEquity; // Yahoo reports in % terms (e.g., 45 = 0.45x)
      fScore += scoreBand(de, [[30, 5], [80, 2], [150, -2], [Infinity, -7]]);
      if (de <= 30) fPoints.push({ good: true, text: 'Near debt-free balance sheet' });
      else if (de > 150) fPoints.push({ good: false, text: `High leverage — debt/equity ≈ ${(de / 100).toFixed(1)}x` });
    }
    if (trailingPEComparable && fund.pe != null && fund.pe > 0) {
      fSignals++;
      fScore += scoreBand(fund.pe, [[15, 5], [25, 2], [40, -1], [70, -4], [Infinity, -7]]);
      if (fund.pe <= 15) fPoints.push({ good: true, text: `Attractive valuation at ${fund.pe.toFixed(1)}x trailing P/E` });
      else if (fund.pe > 70) fPoints.push({ good: false, text: `Expensive at ${fund.pe.toFixed(0)}x trailing P/E — priced for perfection` });
    } else if (trailingPEComparable && fund.pe != null && fund.pe <= 0) {
      fScore -= 5;
    }
    if (fund.analystRecommendation) {
      fSignals++;
      const rec = fund.analystRecommendation;
      if (rec.includes('buy')) { fScore += 5; fPoints.push({ good: true, text: `Street consensus: ${rec.replace('_', ' ').toUpperCase()} (${fund.analystCount || '?'} analysts)` }); }
      else if (rec.includes('sell') || rec.includes('underperform')) { fScore -= 5; fPoints.push({ good: false, text: `Street consensus is negative (${rec})` }); }
    }
  }
  // ----- statement-history signals (multi-year track record) -----
  const annual = fin?.annual || [];
  const statements = {
    annual,
    quarterly: fin?.quarterly || [],
    shareholding: fin?.shareholding || null,
    revenueCagr3y: null,
    profitCagr3y: null,
    marginTrend: null,
  };
  const sh = statements.shareholding;
  if (sh?.promoterTrend != null && sh.promoterTrend <= -2) {
    fScore -= 4;
    fPoints.push({ good: false, text: `Promoters trimmed stake by ${Math.abs(sh.promoterTrend).toFixed(1)}% last quarter` });
  } else if (sh?.fiiTrend != null && sh.fiiTrend >= 1) {
    fScore += 3;
    fPoints.push({ good: true, text: `FIIs raised their stake by ${sh.fiiTrend.toFixed(1)}% last quarter` });
  }
  if (annual.length >= 3) {
    const yrs = Math.min(annual.length - 1, 4);
    const first = annual[annual.length - 1 - yrs];
    const last = annual[annual.length - 1];
    statements.revenueCagr3y = cagr(first.revenue, last.revenue, yrs);
    statements.profitCagr3y = cagr(first.netIncome, last.netIncome, yrs);
    if (first.netMargin != null && last.netMargin != null) {
      statements.marginTrend = last.netMargin - first.netMargin;
    }
    if (statements.revenueCagr3y != null) {
      fSignals++;
      fScore += scoreBand(statements.revenueCagr3y, [[0, -5], [8, 0], [15, 4], [Infinity, 7]]);
      if (statements.revenueCagr3y >= 15) fPoints.push({ good: true, text: `Revenue compounding at ${statements.revenueCagr3y.toFixed(1)}%/yr over ${yrs} years` });
      else if (statements.revenueCagr3y < 0) fPoints.push({ good: false, text: `Revenue has shrunk over the last ${yrs} years (${statements.revenueCagr3y.toFixed(1)}%/yr)` });
    }
    if (statements.profitCagr3y != null) {
      fSignals++;
      fScore += scoreBand(statements.profitCagr3y, [[0, -5], [10, 0], [18, 4], [Infinity, 7]]);
      if (statements.profitCagr3y >= 18) fPoints.push({ good: true, text: `Net profit compounding at ${statements.profitCagr3y.toFixed(1)}%/yr over ${yrs} years` });
    } else if (last.netIncome != null && last.netIncome < 0) {
      fScore -= 6;
      fPoints.push({ good: false, text: 'Company reported a net loss in the latest financial year' });
    }
    if (statements.marginTrend != null && Math.abs(statements.marginTrend) >= 1.5) {
      fScore += statements.marginTrend > 0 ? 3 : -3;
      fPoints.push({
        good: statements.marginTrend > 0,
        text: statements.marginTrend > 0
          ? `Net margin expanding (${first.netMargin.toFixed(1)}% → ${last.netMargin.toFixed(1)}%)`
          : `Net margin compressing (${first.netMargin.toFixed(1)}% → ${last.netMargin.toFixed(1)}%)`,
      });
    }
  }
  fScore = clamp(Math.round(fScore), 0, 100);
  const fundamentalsAvailable = (fund && fSignals >= 2) || annual.length >= 3;

  // ----- sector-aware valuation reference -----
  const priceNow = quote.price ?? closes[closes.length - 1];
  const valuation = buildSectorValuation({
    price: priceNow,
    fund,
    statements,
    sector: options.sector || fund?.sector || '',
    industry: fund?.industry || '',
    name: quote.name || '',
  });
  // Limited lender references stay visible but never manufacture a green
  // verdict. Only the standard model may influence the fundamental score.
  if (valuation.applicability === 'standard' && valuation.upsidePct > 20 && valuation.upsidePct < 100) {
    fScore = clamp(fScore + 3, 0, 100);
    fPoints.push({ good: true, text: 'Trading below the model reference-range midpoint (not a target price)' });
  } else if (valuation.applicability === 'standard' && valuation.upsidePct < -20) {
    fScore = clamp(fScore - 3, 0, 100);
    fPoints.push({ good: false, text: 'Trading above the model reference-range midpoint' });
  }

  // ----- composite + verdict -----
  const composite = fundamentalsAvailable ? Math.round(0.5 * tScore + 0.5 * fScore) : tScore;
  let verdict, verdictColor;
  if (composite >= 72) { verdict = 'STRONG OUTLOOK'; verdictColor = 'green'; }
  else if (composite >= 58) { verdict = 'POSITIVE'; verdictColor = 'green'; }
  else if (composite >= 44) { verdict = 'NEUTRAL / HOLD'; verdictColor = 'amber'; }
  else if (composite >= 30) { verdict = 'WEAK'; verdictColor = 'red'; }
  else { verdict = 'HIGH RISK / AVOID'; verdictColor = 'red'; }

  // one-line plain-language read
  const fStrong = fundamentalsAvailable && fScore >= 70;
  const fWeak = fundamentalsAvailable && fScore < 45;
  const tStrong = tScore >= 65;
  const tWeak = tScore < 40;
  const expensive = trailingPEComparable && fund?.pe != null && fund.pe > 45;
  let plainVerdict;
  if (fStrong && tStrong) plainVerdict = expensive ? 'Expensive but firing on all cylinders — quality momentum.' : 'Good business in an uptrend — rare combination, worth attention.';
  else if (fStrong && tWeak) plainVerdict = 'Good long-term compounder going through a weak price phase — one for patient accumulation, not quick gains.';
  else if (fStrong) plainVerdict = expensive ? 'Strong company, rich valuation — returns may need patience.' : 'Fundamentally solid; price action is undecided.';
  else if (fWeak && tStrong) plainVerdict = 'Momentum trade only — the price is running but the business numbers don\'t back it. Use stop-losses.';
  else if (fWeak && tWeak) plainVerdict = 'Weak business, weak chart — avoid until something changes.';
  else if (tWeak) plainVerdict = 'Avoid until the trend improves — no rush to catch this falling knife.';
  else plainVerdict = 'Middle of the pack — needs either better numbers or a stronger trend to be interesting.';

  // ----- valuation score (0-100): cheaper vs fair value + sane P/E = higher -----
  let valuationScore = null;
  if (valuation?.fairValue != null && valuation.applicability === 'standard') {
    let vs = 50 + clamp(valuation.upsidePct, -60, 60) * 0.6;
    if (fund?.pe != null && fund.pe > 0) {
      vs += scoreBand(fund.pe, [[15, 12], [25, 6], [40, 0], [70, -8], [Infinity, -16]]);
    }
    if (fund?.pb != null && fund.pb > 0) vs += scoreBand(fund.pb, [[1.5, 8], [3, 3], [6, -3], [Infinity, -8]]);
    valuationScore = clamp(Math.round(vs), 0, 100);
  }

  // ----- risk score (0-100, HIGHER = riskier) -----
  let riskPts = 30;
  const risks = [];
  if (t.vol1y != null) {
    if (t.vol1y > 55) { riskPts += 22; risks.push(`Very high volatility (${t.vol1y.toFixed(0)}% annualised) — sharp swings both ways`); }
    else if (t.vol1y > 38) { riskPts += 12; risks.push(`Elevated volatility (${t.vol1y.toFixed(0)}% annualised)`); }
    else if (t.vol1y < 22) riskPts -= 6;
  }
  if (!isLender && !isInsurer && fund?.debtToEquity != null && fund.debtToEquity > 150) { riskPts += 15; risks.push(`High leverage (debt/equity ≈ ${(fund.debtToEquity / 100).toFixed(1)}x) — vulnerable if rates rise or earnings dip`); }
  if (!isLender && !isInsurer && fund?.profitMargin != null && fund.profitMargin < 0) { riskPts += 15; risks.push('Loss-making — no earnings cushion if conditions worsen'); }
  if (t.sma200 != null && price < t.sma200) { riskPts += 10; risks.push('Below 200-day average — the primary trend is not on your side'); }
  if (expensive) { riskPts += 10; risks.push(`Rich valuation (${fund.pe.toFixed(0)}x P/E) leaves little room for disappointment`); }
  if (fund?.marketCap != null && fund.marketCap < 5000e7) { riskPts += 8; risks.push('Small-cap — thinner liquidity and bigger drawdowns in bad markets'); }
  if (t.pctFromHigh != null && t.pctFromHigh < -40) { riskPts += 6; risks.push(`Down ${Math.abs(t.pctFromHigh).toFixed(0)}% from its high — falling knives can keep falling`); }
  const riskScore = clamp(Math.round(riskPts), 5, 100);
  const riskLabel = riskScore >= 70 ? 'HIGH' : riskScore >= 45 ? 'MODERATE' : 'LOWER';
  if (riskScore >= 70 && verdictColor === 'green') {
    verdict = 'SPECULATIVE / HIGH RISK';
    verdictColor = 'red';
    plainVerdict = `The score looks positive, but risk is high (${riskScore}/100). Treat this as speculative, not a core recommendation.`;
  }

  // ----- data coverage: source completeness, never predictive confidence -----
  let conf = 40;
  if (fundamentalsAvailable) conf += 20;
  if (annual.length >= 4) conf += 12;
  if (fund?.analystCount) conf += Math.min(fund.analystCount, 15);
  if (statements.quarterly?.length >= 4) conf += 8;
  if (candles.length >= 400) conf += 5;
  const dataCoverage = clamp(Math.round(conf), 25, 95);

  // ----- projections -----
  // Short term (3 months): momentum tilt bounded by volatility.
  const vol3m = t.vol3m ?? 30;
  const qVol = (vol3m / 100) * Math.sqrt(63 / 252); // ~3-month sigma as fraction
  const momentumTilt = clamp((composite - 50) / 50, -1, 1); // -1..+1
  const stDrift = momentumTilt * qVol * 0.55; // expected drift scaled by conviction
  const shortTerm = {
    horizon: '3 months',
    expected: price * (1 + stDrift),
    bull: price * (1 + stDrift + qVol),
    bear: price * (1 + stDrift - qVol),
    expectedPct: stDrift * 100,
    bullPct: (stDrift + qVol) * 100,
    bearPct: (stDrift - qVol) * 100,
  };

  // Long term (12 months): blend of historical CAGR, analyst target and score tilt.
  const yVol = (t.vol1y ?? vol3m) / 100;
  let histDrift = clamp((t.ret1y ?? 0) / 100, -0.5, 0.6) * 0.4; // dampened last-year return
  let analystDrift = null;
  if (fund?.analystTargetMean && price > 0) {
    analystDrift = clamp((fund.analystTargetMean - price) / price, -0.6, 0.8);
  }
  const scoreDrift = momentumTilt * 0.18;
  let ltDrift;
  if (analystDrift != null) ltDrift = 0.45 * analystDrift + 0.3 * scoreDrift + 0.25 * histDrift;
  else ltDrift = 0.55 * scoreDrift + 0.45 * histDrift;
  const longTerm = {
    horizon: '12 months',
    expected: price * (1 + ltDrift),
    bull: price * (1 + ltDrift + yVol * 0.9),
    bear: price * (1 + ltDrift - yVol * 0.8),
    expectedPct: ltDrift * 100,
    bullPct: (ltDrift + yVol * 0.9) * 100,
    bearPct: (ltDrift - yVol * 0.8) * 100,
    analystTarget: fund?.analystTargetMean ?? null,
    analystHigh: fund?.analystTargetHigh ?? null,
    analystLow: fund?.analystTargetLow ?? null,
  };
  const twoX = buildTwoXCase(price, fund, statements, valuation, options.sector || fund?.sector || fund?.industry || '', {
    historyDays: candles.length,
    avgTradedValue: (t.avgVol60 || 0) * price,
  });

  return {
    symbol,
    name: quote.name,
    exchange: quote.exchange,
    generatedAt: Date.now(),
    quote,
    fundamentals: fund,
    fundamentalsAvailable,
    statements,
    valuation,
    technicals: t,
    scores: {
      technical: tScore,
      fundamental: fundamentalsAvailable ? fScore : null,
      valuation: valuationScore,
      risk: riskScore,
      riskLabel,
      confidence: dataCoverage,
      dataCoverage,
      composite,
    },
    verdict,
    verdictColor,
    plainVerdict,
    whatCanGoWrong: risks.slice(0, 4),
    positives: [...tPoints.filter((p) => p.good), ...fPoints.filter((p) => p.good)].map((p) => p.text),
    negatives: [...tPoints.filter((p) => !p.good), ...fPoints.filter((p) => !p.good)].map((p) => p.text),
    shortTerm,
    longTerm,
    twoX,
    analysisType: 'deterministic',
    disclaimer:
      'This is deterministic algorithmic research derived from historical price, volatility, fundamentals and analyst-consensus inputs. It is not AI analysis, a calibrated probability, a target price or investment advice. Markets can behave very differently; verify source data and consult a SEBI-registered adviser where appropriate.',
  };
}

module.exports = { research, buildTwoXCase, buildSectorValuation };
